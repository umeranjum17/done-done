import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { parseDuration } from './config.js';

// A run-instance harness: each run starts the app under test on its own port,
// with its own HOME/XDG folders, waits until ready, and kills it at run end.
export type Instance = { command: string; ready: { url?: string; command?: string }; ready_timeout: string };

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

// One readiness probe, killed when its time is up: async, so the runner's
// event loop (and heartbeat) keeps running while it waits, and a hung
// command can never hang the run past the remaining ready_timeout.
function tryCommand(command: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Its own group, so the kill also stops what the shell started.
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: 'ignore', env });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ }
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function waitCommand(command: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await tryCommand(command, env, cwd, Math.max(1, end - Date.now()))) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

export type Started = { pgid: number; env: Record<string, string> };

// Start the instance, wait for readiness, or kill it and throw a clear reason.
// The app's output goes to logFile (in the run folder, never with the evidence),
// so a failed readiness wait shows what the app said.
export async function startInstance(repo: string, inst: Instance, runId: string, scratch: string, baseEnv: NodeJS.ProcessEnv, logFile?: string): Promise<Started> {
  const port = await pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const extra = { DONE_DONE_PORT: String(port), DONE_DONE_BASE_URL: baseUrl, DONE_DONE_RUN_ID: runId, ...instanceHome(scratch), TMPDIR: scratch };
  const env = { ...baseEnv, ...extra };
  const command = inst.command.replaceAll('${RUN_ID}', runId);
  let fd: number | undefined;
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
    fd = openSync(logFile, 'a');
  }
  const child = spawn(command, { cwd: repo, shell: true, detached: true, stdio: fd === undefined ? 'ignore' : ['ignore', fd, fd], env });
  if (fd !== undefined) closeSync(fd);
  const pgid = child.pid!;
  const kill = () => {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already exited */ }
  };
  child.unref?.();
  const timeoutMs = parseDuration(inst.ready_timeout)!;
  const byUrl = inst.ready.url !== undefined;
  const ready = byUrl
    ? await waitUrl(expand(inst.ready.url!, extra as Record<string, string>), timeoutMs)
    : await waitCommand(inst.ready.command!.replaceAll('${RUN_ID}', runId), env, repo, timeoutMs);
  if (!ready) {
    kill();
    const what = byUrl ? `GET ${inst.ready.url} never returned 2xx` : 'readiness command never exited 0';
    throw new Error(`instance not ready within ${inst.ready_timeout}: ${what} (port ${port} owned by this run; the instance was killed)`);
  }
  return { pgid, env: extra as Record<string, string> };
}

export const stopInstance = (pgid: number) => {
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* already exited */ }
};
