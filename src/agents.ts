import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENTS, CHEAP_MODELS, type Config } from './config.js';
import { onPath } from './judge.js';

// How done-done starts a coding agent for one step: a fresh, single-shot session that
// answers one JSON-schema question. The prompt goes on stdin or in a 0600 prompt file, never in
// argv, so it stays out of process listings; every call leaves a record. Each adapter only builds argv and
// reads the answer, so adding an agent is one table entry.

export type AgentCall = {
  agent: string;
  model: string;
  prompt: string;
  schema: { required?: string[] } & Record<string, unknown>;
  cwd: string;
  timeoutMs: number;
  tools: 'none' | 'read' | 'edit'; // none for the judge and readers
  record: string; // where the call record is written
};
export type AgentAnswer = { ok: boolean; answer?: Record<string, unknown>; error?: string; record?: string; recordError?: string };

// argv never carries the prompt: it goes on stdin, or (file: true) into a 0600 prompt file the argv points at.
type Adapter = { argv: (c: AgentCall, dir: string) => string[]; answer: (stdout: string) => unknown; file?: boolean; env?: (c: AgentCall) => Record<string, string> };

// acp:<target> runs any Agent Client Protocol agent through the user's acpx bridge (acpx's own registry names
// the targets): the prompt and the schema on stdin (exec --file -), and the answer is the JSON object in the agent's
// message chunks of acpx's JSON-RPC event stream. The tool policy maps to acpx's permission mode; a prompt that
// mode would raise is denied, since nobody can answer it. No model means the target's own default.
const ACP: Adapter = {
  argv: (c, dir) => ['--cwd', c.tools === 'none' ? dir : c.cwd, '--format', 'json', '--json-strict', c.tools === 'edit' ? '--approve-all' : c.tools === 'read' ? '--approve-reads' : '--deny-all',
    '--non-interactive-permissions', 'deny', ...(c.model ? ['--model', c.model] : []), c.agent.slice('acp:'.length), 'exec', '--file', '-'],
  answer: (out) => {
    const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const text = events.filter((e) => e.method === 'session/update' && e.params?.update?.sessionUpdate === 'agent_message_chunk')
      .map((e) => e.params.update.content?.text ?? '').join('');
    // An error response fails the call only when the agent said nothing: a refused side request is not the answer.
    const error = events.find((e) => e.error)?.error;
    if (!text && error) throw new Error(String(error.message ?? JSON.stringify(error)).slice(0, 500));
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  },
};
export const ACPX_INSTALL = 'Install the acpx ACP bridge (npm install -g acpx, https://github.com/openclaw/acpx), then re-run: done-done doctor';

const ADAPTERS: Record<string, Adapter> = {
  // claude -p: --json-schema puts the validated object in structured_output; --tools '' turns every tool off.
  claude: {
    argv: (c) => ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(c.schema), '--model', c.model, '--no-session-persistence',
      ...(c.tools === 'edit' ? ['--permission-mode', 'acceptEdits'] : ['--tools', c.tools === 'read' ? 'Read,Grep,Glob' : '']),
      ...(c.tools === 'none' ? ['--setting-sources', ''] : [])],
    answer: (out) => {
      const r = JSON.parse(out);
      if (r.is_error) throw new Error(String(r.result || r.subtype));
      return r.structured_output;
    },
  },
  // opencode run reads no stdin and has no schema flag: the prompt and the schema go in an attached file,
  // and the answer is the JSON object in the text parts of its JSON event stream.
  opencode: {
    file: true,
    argv: (c, dir) => ['run', 'Follow the attached instructions.', '--format', 'json', '-m', c.model, '-f', join(dir, 'prompt.md')],
    answer: (out) => {
      const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const error = events.find((e) => e.type === 'error');
      if (error) throw new Error(JSON.stringify(error.error ?? error).slice(0, 500));
      const text = events.filter((e) => e.type === 'text').map((e) => e.part.text).join('');
      return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    },
    env: (c): Record<string, string> => (c.tools === 'edit' ? {} : { OPENCODE_PERMISSION: JSON.stringify(c.tools === 'read' ? { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' } : { '*': 'deny' }) }),
  },
};

// The author agent: the first of the configured list (or of AGENTS for auto) that is on PATH and that
// done-done can start; the list moves on when an agent is not installed or done-done cannot start it yet.
// Its model is agent_config.<agent>.model, else the cheap default. skipped names the installed agents passed over.
export function selectAgent(cfg: Config): { agent: string; model: string; path: string; from: 'config' | 'auto'; skipped: string[] } {
  const list = cfg.agent === 'auto' ? AGENTS : cfg.agent;
  const found = list.map((agent) => ({ agent, path: agentPath(agent) })).filter((a) => a.path);
  const first = found.findIndex((a) => supported(a.agent));
  const pick = first >= 0 ? found[first] : found[0] ?? { agent: list[0], path: '' };
  const passed = first >= 0 ? found.slice(0, first) : found.slice(1);
  return { ...pick, model: modelFor(cfg, pick.agent), from: cfg.agent === 'auto' ? 'auto' : 'config', skipped: passed.map((a) => a.agent) };
}

export const modelFor = (cfg: Config, agent: string) => cfg.agent_config[agent]?.model || CHEAP_MODELS[agent] || '';

const adapterFor = (agent: string): Adapter | undefined => (agent.startsWith('acp:') ? ACP : Object.hasOwn(ADAPTERS, agent) ? ADAPTERS[agent] : undefined);

export function supported(agent: string) {
  return !!adapterFor(agent);
}

// The binary that starts an agent. An acp:<target> agent starts through acpx, which counts as installed only
// when it runs (a version-manager shim with no version set is on PATH but starts nothing).
export function agentPath(agent: string): string {
  if (!agent.startsWith('acp:')) return onPath(agent);
  const acpx = onPath('acpx');
  return acpx && spawnSync(acpx, ['--version'], { stdio: 'ignore', timeout: 30_000 }).status === 0 ? acpx : '';
}

export function askAgent(c: AgentCall): AgentAnswer {
  const adapter = adapterFor(c.agent);
  const started = Date.now();
  let dir = '';
  let cwd = c.cwd;
  let res: ReturnType<typeof spawnSync> | undefined;
  let out: AgentAnswer;
  try {
    dir = mkdtempSync(join(tmpdir(), 'done-done-agent-'));
    cwd = c.tools === 'none' ? dir : c.cwd;
    if (!adapter) throw new Error(`no adapter for ${c.agent} yet`);
    if (!c.model && adapter !== ACP) throw new Error(`no model for ${c.agent}; set agent_config.${c.agent}.model`);
    const promptText = `${c.prompt}\n\nAnswer with only one JSON object that matches this JSON schema, and no other text:\n${JSON.stringify(c.schema)}\n`;
    if (adapter.file) writeFileSync(join(dir, 'prompt.md'), promptText, { mode: 0o600 });
    const bin = agentPath(c.agent);
    if (!bin) throw new Error(c.agent.startsWith('acp:') ? `${c.agent} needs acpx, and acpx is not startable; ${ACPX_INSTALL}` : `${c.agent} is not on PATH`);
    res = spawnSync(bin, adapter.argv(c, dir), { cwd, input: adapter.file ? '' : promptText, env: { ...process.env, ...adapter.env?.(c) }, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: 64 << 20 });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      // An agent that exits non-zero may still say why in its own output (claude: a usage limit, a bad model).
      let why = String(res.stderr || res.stdout).trim().slice(-500);
      try {
        adapter.answer(String(res.stdout));
      } catch (e) {
        if (!(e instanceof SyntaxError)) why = (e as Error).message;
      }
      throw new Error(`${c.agent} exited ${res.status}: ${why}`);
    }
    const answer = adapter.answer(String(res.stdout));
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error(`the answer is not a JSON object: ${JSON.stringify(answer)}`);
    const missing = (c.schema.required ?? []).filter((k) => !(k in answer));
    if (missing.length) throw new Error(`the answer does not match the schema (missing ${missing.join(', ')})`);
    out = { ok: true, answer: answer as Record<string, unknown> };
  } catch (e) {
    out = { ok: false, error: (e as Error).message };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  // The record holds what ran and what came back, never the prompt text.
  const { prompt, ...call } = c;
  try {
    const record = { ...call, cwd, prompt_bytes: Buffer.byteLength(prompt), argv: adapter?.argv(c, '<tmp>') ?? [], ms: Date.now() - started, exit: res?.status ?? null, ...out, stderr: String(res?.stderr ?? '').slice(-2000) };
    mkdirSync(dirname(c.record), { recursive: true });
    writeFileSync(c.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    out = { ...out, record: c.record };
  } catch (e) {
    out = { ...out, recordError: (e as Error).message };
  }
  return out;
}
