import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { parseDuration } from './config.js';

// A run-instance harness: each run starts the app under test on its own port,
// with its own HOME/XDG folders, waits until ready, and kills it at run end.
export type Instance = { command: string; ready: { url: string }; ready_timeout: string };

// A free local port done-done owns: bind 127.0.0.1:0, read it back, release.
// A fixed port that is already taken can never be used.
export const pickPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const expand = (text: string, env: Record<string, string>) =>
  text.replaceAll('${RUN_ID}', env.DONE_DONE_RUN_ID ?? '').replace(/\$(DONE_DONE_PORT|DONE_DONE_BASE_URL)|\${(DONE_DONE_PORT|DONE_DONE_BASE_URL)}/g, (m, a, b) => env[a ?? b] ?? m);

// Run-scoped HOME and XDG folders under the run's scratch folder, so the app
// never touches the user's own config, cache or data.
export function instanceHome(scratch: string): Record<string, string> {
  const root = join(scratch, 'instance-home');
  const home = join(root, 'home');
  const config = join(root, 'config');
  const data = join(root, 'data');
  const cache = join(root, 'cache');
  for (const d of [home, config, data, cache]) mkdirSync(d, { recursive: true });
  return { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache };
}

async function waitUrl(url: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status >= 200 && r.status < 300) return true;
    } catch { /* not ready yet */ }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

export type Started = { pgid: number; env: Record<string, string> };

// Start the instance, wait for readiness, or kill it and throw a clear reason.
export async function startInstance(repo: string, inst: Instance, runId: string, scratch: string, baseEnv: NodeJS.ProcessEnv): Promise<Started> {
  const port = await pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const extra = { DONE_DONE_PORT: String(port), DONE_DONE_BASE_URL: baseUrl, DONE_DONE_RUN_ID: runId, ...instanceHome(scratch), TMPDIR: scratch };
  const env = { ...baseEnv, ...extra };
  const command = inst.command.replaceAll('${RUN_ID}', runId);
  const child = spawn(command, { cwd: repo, shell: true, detached: true, stdio: 'ignore', env });
  const pgid = child.pid!;
  const kill = () => {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already exited */ }
  };
  child.unref?.();
  const timeoutMs = parseDuration(inst.ready_timeout)!;
  const ready = await waitUrl(expand(inst.ready.url, extra as Record<string, string>), timeoutMs);
  if (!ready) {
    kill();
    throw new Error(`instance not ready within ${inst.ready_timeout}: GET ${inst.ready.url} never returned 2xx (port ${port} owned by this run; the instance was killed)`);
  }
  return { pgid, env: extra as Record<string, string> };
}

export const stopInstance = (pgid: number) => {
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* already exited */ }
};
