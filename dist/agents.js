import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENTS, CHEAP_MODELS } from './config.js';
import { onPath } from './judge.js';
// argv never carries the prompt: it goes on stdin, or (file: true) into a 0600 prompt file the argv points at.
// An adapter with schema: true has the CLI enforce the schema itself (one call); without it done-done
// parses the answer out of the model text, validates it, and asks again, at most ASK_ATTEMPTS calls.
const ASK_ATTEMPTS = 3;
// The one JSON object inside free model text (often fenced): shared by every adapter without a schema flag.
export function extractJsonObject(text) {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}
const ADAPTERS = {
    // claude -p: --json-schema puts the validated object in structured_output; --tools '' turns every tool off.
    claude: {
        schema: true,
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
            return extractJsonObject(text);
        },
        env: (c) => (c.tools === 'edit' ? {} : { OPENCODE_PERMISSION: JSON.stringify(c.tools === 'read' ? { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' } : { '*': 'deny' }) }),
    },
    // pi -p reads the prompt on stdin (probed 12 Oct: with no positional message, stdin becomes the user
    // message); --mode json streams JSONL events whose assistant message_end holds the answer text,
    // --no-session keeps the probe ephemeral. No schema flag: parse + validate + ask again.
    // Pi has no hard permission gate, so read/edit steps still see every tool pi loads.
    pi: {
        argv: (c) => ['-p', '--mode', 'json', '--no-session', ...(c.tools === 'none' ? ['--no-tools'] : c.tools === 'read' ? ['-t', 'read,grep,find,ls'] : []), '--model', c.model],
        answer: (out) => {
            let text = '';
            let failure = '';
            for (const line of out.split('\n')) {
                if (!line.startsWith('{'))
                    continue;
                let e;
                try {
                    e = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (e.type === 'error')
                    failure = JSON.stringify(e.error ?? e).slice(0, 500);
                if (e.type === 'message_end' && e.message?.role === 'assistant')
                    text += (e.message.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('');
            }
            if (!text && failure)
                throw new Error(failure);
            return extractJsonObject(text);
        },
    },
    // gemini -p text is appended to stdin, so -p carries only a fixed trailer and the prompt goes on stdin;
    // -o json prints one object {response, stats, error?} (its headless.md). plan mode is read-only, so a
    // headless call never blocks on an approval prompt; yolo is only for edit steps. --skip-trust is the
    // CLI's own documented headless path (its trusted-folders.md): done-done never runs interactively, so
    // the trust dialog could never be answered. No schema flag either: parse + validate + ask again.
    gemini: {
        argv: (c) => ['-p', 'Follow the instructions on stdin.', '-o', 'json', '-m', c.model, '--approval-mode', c.tools === 'edit' ? 'yolo' : 'plan', '--skip-trust'],
        answer: (out) => {
            const r = JSON.parse(out);
            if (!r.response && r.error)
                throw new Error(JSON.stringify(r.error).slice(0, 500));
            return extractJsonObject(String(r.response ?? ''));
        },
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
    let attempts = 0;
    let out;
    try {
        dir = mkdtempSync(join(tmpdir(), 'done-done-agent-'));
        cwd = c.tools === 'none' ? dir : c.cwd;
        if (!adapter)
            throw new Error(`no adapter for ${c.agent} yet`);
        if (!c.model)
            throw new Error(`no model for ${c.agent}; set agent_config.${c.agent}.model`);
        let lastError = '';
        for (;;) {
            attempts++;
            // An ask-again names what was wrong with the last answer; the first try is the prompt untouched.
            const promptText = attempts === 1 ? c.prompt : `${c.prompt}\n\nYour previous answer was not valid (${lastError}). Answer with only one JSON object that matches this JSON schema, and no other text:\n${JSON.stringify(c.schema)}\n`;
            if (adapter.file)
                writeFileSync(join(dir, 'prompt.md'), `${promptText}\n\nAnswer with only one JSON object that matches this JSON schema, and no other text:\n${JSON.stringify(c.schema)}\n`, { mode: 0o600 });
            res = spawnSync(onPath(c.agent) || c.agent, adapter.argv(c, dir), { cwd, input: adapter.file ? '' : promptText, env: { ...process.env, ...adapter.env?.(c) }, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: 64 << 20 });
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
            try {
                const answer = adapter.answer(String(res.stdout));
                if (!answer || typeof answer !== 'object' || Array.isArray(answer))
                    throw new Error(`the answer is not a JSON object: ${JSON.stringify(answer)}`);
                const missing = (c.schema.required ?? []).filter((k) => !(k in answer));
                if (missing.length)
                    throw new Error(`the answer does not match the schema (missing ${missing.join(', ')})`);
                out = { ok: true, answer: answer };
                break;
            }
            catch (e) {
                // A CLI that enforces the schema itself fails here for good; the rest get asked again.
                lastError = e.message;
                if (adapter.schema || attempts >= ASK_ATTEMPTS)
                    throw new Error(adapter.schema ? lastError : `the agent did not answer with valid JSON after ${attempts} ${attempts === 1 ? 'try' : 'tries'}: ${lastError}`);
            }
        }
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
        const record = { ...call, cwd, prompt_bytes: Buffer.byteLength(prompt), argv: adapter?.argv(c, '<tmp>') ?? [], ms: Date.now() - started, exit: res?.status ?? null, attempts, ...out, stderr: String(res?.stderr ?? '').slice(-2000) };
        mkdirSync(dirname(c.record), { recursive: true });
        writeFileSync(c.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        out = { ...out, record: c.record };
    }
    catch (e) {
        out = { ...out, recordError: e.message };
    }
    return out;
}
