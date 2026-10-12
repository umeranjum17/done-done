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
            ...(c.tools === 'edit' ? ['--permission-mode', 'acceptEdits'] : ['--tools', c.tools === 'read' ? 'Read,Grep,Glob' : '']),
            ...(c.tools === 'none' ? ['--setting-sources', ''] : [])],
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
// The author agent: the first of the configured list (or of AGENTS for auto) that is on PATH and that
// done-done can start; the list moves on when an agent is not installed or done-done cannot start it yet.
// Its model is agent_config.<agent>.model, else the cheap default. skipped names the installed agents passed over.
export function selectAgent(cfg) {
    const list = cfg.agent === 'auto' ? AGENTS : cfg.agent;
    const found = list.map((agent) => ({ agent, path: onPath(agent) })).filter((a) => a.path);
    const first = found.findIndex((a) => supported(a.agent));
    const pick = first >= 0 ? found[first] : found[0] ?? { agent: list[0], path: '' };
    const passed = first >= 0 ? found.slice(0, first) : found.slice(1);
    return { ...pick, model: modelFor(cfg, pick.agent), from: cfg.agent === 'auto' ? 'auto' : 'config', skipped: passed.map((a) => a.agent) };
}
export const modelFor = (cfg, agent) => cfg.agent_config[agent]?.model || CHEAP_MODELS[agent] || '';
export function supported(agent) {
    return Object.hasOwn(ADAPTERS, agent);
}
export function askAgent(c) {
    const adapter = ADAPTERS[c.agent];
    const started = Date.now();
    let dir = '';
    let cwd = c.cwd;
    let res;
    let out;
    try {
        dir = mkdtempSync(join(tmpdir(), 'done-done-agent-'));
        cwd = c.tools === 'none' ? dir : c.cwd;
        if (!adapter)
            throw new Error(`no adapter for ${c.agent} yet`);
        if (!c.model)
            throw new Error(`no model for ${c.agent}; set agent_config.${c.agent}.model`);
        if (adapter.file)
            writeFileSync(join(dir, 'prompt.md'), `${c.prompt}\n\nAnswer with only one JSON object that matches this JSON schema, and no other text:\n${JSON.stringify(c.schema)}\n`, { mode: 0o600 });
        res = spawnSync(onPath(c.agent) || c.agent, adapter.argv(c, dir), { cwd, input: adapter.file ? '' : c.prompt, env: { ...process.env, ...adapter.env?.(c) }, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: 64 << 20 });
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
        if (!answer || typeof answer !== 'object' || Array.isArray(answer))
            throw new Error(`the answer is not a JSON object: ${JSON.stringify(answer)}`);
        const missing = (c.schema.required ?? []).filter((k) => !(k in answer));
        if (missing.length)
            throw new Error(`the answer does not match the schema (missing ${missing.join(', ')})`);
        out = { ok: true, answer: answer };
    }
    catch (e) {
        out = { ok: false, error: e.message };
    }
    finally {
        if (dir)
            rmSync(dir, { recursive: true, force: true });
    }
    // The record holds what ran and what came back, never the prompt text.
    const { prompt, ...call } = c;
    try {
        const record = { ...call, cwd, prompt_bytes: Buffer.byteLength(prompt), argv: adapter?.argv(c, '<tmp>') ?? [], ms: Date.now() - started, exit: res?.status ?? null, ...out, stderr: String(res?.stderr ?? '').slice(-2000) };
        mkdirSync(dirname(c.record), { recursive: true });
        writeFileSync(c.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        out = { ...out, record: c.record };
    }
    catch (e) {
        out = { ...out, recordError: e.message };
    }
    return out;
}
