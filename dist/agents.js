import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENTS, CHEAP_MODELS } from './config.js';
import { onPath } from './judge.js';
const ADAPTERS = {
    // claude -p: --json-schema puts the validated object in structured_output; --tools '' turns every tool off.
    claude: {
        argv: (c) => ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(c.schema), '--model', c.model, '--no-session-persistence',
            ...(c.tools === 'edit' ? ['--permission-mode', 'acceptEdits'] : ['--tools', c.tools === 'read' ? 'Read,Grep,Glob' : ''])],
        answer: (out) => {
            const r = JSON.parse(out);
            if (r.is_error)
                throw new Error(String(r.result || r.subtype));
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
            if (error)
                throw new Error(JSON.stringify(error.error ?? error).slice(0, 500));
            const text = events.filter((e) => e.type === 'text').map((e) => e.part.text).join('');
            return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        },
        env: (c) => (c.tools === 'edit' ? {} : { OPENCODE_PERMISSION: JSON.stringify(c.tools === 'read' ? { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' } : { '*': 'deny' }) }),
    },
};
// The author agent: the first of the configured list (or of AGENTS for auto) found on PATH;
// the list moves on only when an agent is not installed. Its model is agent_config.<agent>.model, else the cheap default.
export function selectAgent(cfg) {
    const list = cfg.agent === 'auto' ? AGENTS : cfg.agent;
    const pick = list.map((agent) => ({ agent, path: onPath(agent) })).find((a) => a.path) ?? { agent: list[0], path: '' };
    return { ...pick, model: modelFor(cfg, pick.agent), from: cfg.agent === 'auto' ? 'auto' : 'config' };
}
export const modelFor = (cfg, agent) => cfg.agent_config[agent]?.model || CHEAP_MODELS[agent] || '';
// The judge kept apart from the author: an explicit route, else (`judge: auto`) the first other
// agent on PATH at its own model, else the author's agent in a fresh session (session-only independence).
export function selectJudge(cfg, author) {
    if (cfg.judge.route)
        return { judge: cfg.judge.route, model: cfg.judge.model, independence: 'route' };
    const other = AGENTS.find((a) => a !== author && onPath(a) && modelFor(cfg, a));
    return other ? { judge: other, model: modelFor(cfg, other), independence: 'other-agent' } : { judge: author, model: modelFor(cfg, author), independence: 'session-only' };
}
export const supported = (agent) => Object.hasOwn(ADAPTERS, agent);
export function askAgent(c) {
    const adapter = ADAPTERS[c.agent];
    const dir = mkdtempSync(join(tmpdir(), 'done-done-agent-'));
    const started = Date.now();
    let res;
    let out;
    try {
        if (!adapter)
            throw new Error(`no adapter for ${c.agent} yet`);
        if (!c.model)
            throw new Error(`no model for ${c.agent}; set agent_config.${c.agent}.model`);
        if (adapter.file)
            writeFileSync(join(dir, 'prompt.md'), `${c.prompt}\n\nAnswer with only one JSON object that matches this JSON schema, and no other text:\n${JSON.stringify(c.schema)}\n`, { mode: 0o600 });
        res = spawnSync(onPath(c.agent) || c.agent, adapter.argv(c, dir), { cwd: c.cwd, input: adapter.file ? '' : c.prompt, env: { ...process.env, ...adapter.env?.(c) }, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: 64 << 20 });
        if (res.error)
            throw res.error;
        if (res.status !== 0) {
            // An agent that exits non-zero may still say why in its own output (claude: a usage limit, a bad model).
            let why = String(res.stderr || res.stdout).trim().slice(-500);
            try {
                adapter.answer(String(res.stdout));
            }
            catch (e) {
                if (!(e instanceof SyntaxError))
                    why = e.message;
            }
            throw new Error(`${c.agent} exited ${res.status}: ${why}`);
        }
        const answer = adapter.answer(String(res.stdout));
        const missing = (c.schema.required ?? []).filter((k) => !(answer && typeof answer === 'object' && k in answer));
        if (missing.length)
            throw new Error(`the answer does not match the schema (missing ${missing.join(', ')})`);
        out = { ok: true, answer: answer, record: c.record };
    }
    catch (e) {
        out = { ok: false, error: e.message, record: c.record };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
    // The record holds what ran and what came back, never the prompt text.
    const { prompt, ...call } = c;
    mkdirSync(dirname(c.record), { recursive: true });
    const record = { ...call, prompt_bytes: Buffer.byteLength(prompt), argv: adapter?.argv(c, '<tmp>') ?? [], ms: Date.now() - started, exit: res?.status ?? null, ...out, stderr: String(res?.stderr ?? '').slice(-2000) };
    writeFileSync(c.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return out;
}
