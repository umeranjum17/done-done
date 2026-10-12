import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { AGENTS, ANSWERER_JUDGES, CHEAP_MODELS, UsageError } from './config.js';
import { onPath } from './judge.js';
// argv never carries the prompt: it goes on stdin, or (file: true) into a 0600 prompt file the argv points at.
// done-done parses the answer, validates it against the schema, and asks a tool-less call again, at most ASK_ATTEMPTS calls.
const ASK_ATTEMPTS = 3;
// What a user sees of an agent's error: no colour codes, only the last line that names an error (not a
// stack frame, an indented field or a lone brace), at most 200 characters. The call record keeps the raw stderr.
const ERROR_WORD = /\b(error|failed|denied|cancelled|refused|not|invalid|unauthorized)\b/i;
function errorLine(text) {
    const lines = stripVTControlCharacters(text).split(/[\r\n]+/).filter((l) => /\w/.test(l));
    const top = lines.filter((l) => !/^\s/.test(l));
    const line = (top.findLast((l) => ERROR_WORD.test(l)) ?? top.at(-1) ?? lines.at(-1) ?? '').trim();
    return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
class ProviderError extends Error {
    detail;
    constructor(text, prefix = '', suffix = '') {
        super(`${prefix}${errorLine(text)}${suffix}`);
        this.detail = `${prefix}${text.slice(0, 500)}${suffix}`;
    }
}
// The one JSON object inside free model text (often fenced): shared by the adapters that answer in text.
export function extractJsonObject(text) {
    const end = text.lastIndexOf('}') + 1;
    let start = text.indexOf('{');
    for (;;) {
        try {
            return JSON.parse(text.slice(start, end));
        }
        catch (e) {
            const next = text.indexOf('{', start + 1);
            if (next === -1 || next >= end)
                throw e;
            start = next;
        }
    }
}
const ADAPTERS = {
    // claude -p: --json-schema puts the validated object in structured_output; --tools '' turns every tool off.
    claude: {
        argv: (c) => ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(c.schema), '--model', c.model, '--no-session-persistence',
            ...(c.tools === 'edit' ? ['--permission-mode', 'acceptEdits'] : ['--tools', c.tools === 'read' ? 'Read,Grep,Glob' : '']),
            ...(c.tools === 'none' ? ['--setting-sources', ''] : [])],
        answer: (out) => {
            const r = JSON.parse(out);
            if (r.is_error)
                throw new ProviderError(String(r.result || r.subtype));
            return r.structured_output;
        },
    },
    // opencode run reads no stdin: the prompt and the schema go in an attached file,
    // and the answer is the JSON object in the text parts of its JSON event stream.
    opencode: {
        file: true,
        argv: (c, dir) => ['run', 'Follow the attached instructions.', '--format', 'json', '-m', c.model, '-f', join(dir, 'prompt.md'), ...(c.files ?? []).flatMap((f) => ['-f', f])],
        answer: (out) => {
            const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
            const error = events.find((e) => e.type === 'error');
            if (error)
                throw new ProviderError(JSON.stringify(error.error ?? error));
            let text = '';
            for (const e of events) {
                if (e.type === 'step_start')
                    text = '';
                if (e.type === 'text')
                    text += e.part.text;
            }
            return extractJsonObject(text);
        },
        env: (c) => (c.tools === 'edit' ? {} : { OPENCODE_PERMISSION: JSON.stringify(c.tools === 'read' ? { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' } : { '*': 'deny' }) }),
    },
    // pi -p reads the prompt on stdin (probed 12 Oct: with no positional message, stdin becomes the user
    // message); --mode json streams JSONL events whose assistant message_end holds the answer text,
    // --no-session keeps the probe ephemeral.
    // Pi has no permission gate for edit steps, so doctor warns about it. Without a model, pi runs its own default.
    pi: {
        argv: (c) => ['-p', '--mode', 'json', '--no-session', ...(c.tools === 'none' ? ['--no-tools'] : c.tools === 'read' ? ['-t', 'read,grep,find,ls'] : []), ...(c.model ? ['--model', c.model] : [])],
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
                    failure = JSON.stringify(e.error ?? e);
                if (e.type === 'message_end' && e.message?.role === 'assistant')
                    text = (e.message.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('');
            }
            if (!text && failure)
                throw new ProviderError(failure);
            return extractJsonObject(text);
        },
    },
    // gemini -p text is appended to stdin, so -p carries only a fixed trailer and the prompt goes on stdin;
    // -o json prints one object {response, stats, error?} (its headless.md). plan mode is read-only, so a
    // headless call never blocks on an approval prompt; auto_edit (edits approved, shell still asks) is only for edit steps.
    // --skip-trust is only for the tool-less probe in its scratch folder (the headless path in its trusted-folders.md): done-done
    // never runs interactively, so the trust dialog could never be answered there. Repo calls keep Gemini's trust gate.
    gemini: {
        argv: (c) => ['-p', 'Follow the instructions on stdin.', '-o', 'json', '-m', c.model, '--approval-mode', c.tools === 'edit' ? 'auto_edit' : 'plan', ...(c.tools === 'none' ? ['--skip-trust'] : [])],
        hint: 'if gemini refused this folder as untrusted, trust it in Gemini CLI first, then retry',
        answer: (out) => {
            const r = JSON.parse(out);
            if (!r.response && r.error)
                throw new ProviderError(JSON.stringify(r.error));
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
export const claudeBin = (cfg) => cfg.judge.claude_code.bin || onPath('claude');
const routeOf = (agent) => (agent === 'claude' ? 'claude-code' : `answerer:${agent}`);
const canJudge = (agent) => agent === 'claude' || ANSWERER_JUDGES.includes(agent);
export const JUDGES = AGENTS.filter(canJudge);
export function selectJudge(cfg, found) {
    const author = found.path ? found : { agent: 'none', model: '', path: '' };
    const pick = (agent, model, from) => {
        const independence = agent !== author.agent ? 'agent' : model !== author.model ? 'model' : 'session-only';
        return { route: routeOf(agent), agent, model, independence, from, author: { agent: author.agent, model: author.model } };
    };
    const route = cfg.judge.route;
    if (route === 'auto') {
        // The first installed agent that can judge and is not the author, at its cheap model; else the author's agent.
        const ready = AGENTS.filter((a) => canJudge(a) && (a === 'claude' ? claudeBin(cfg) : onPath(a)));
        const other = ready.find((a) => a !== author.agent);
        if (other)
            return pick(other, CHEAP_MODELS[other], 'auto');
        if (ready.includes(author.agent))
            return pick(author.agent, CHEAP_MODELS[author.agent], 'auto');
        throw new UsageError(`judge: no installed agent can judge (judge.route auto looks for ${JUDGES.join(', ')})`, 'Install one of them, or set judge.route in ~/.done-done/config.yaml');
    }
    const agent = route === 'claude-code' ? 'claude' : route.slice('answerer:'.length);
    if (route !== 'claude-code' && !ANSWERER_JUDGES.includes(agent))
        throw new UsageError(`judge: done-done cannot judge through ${agent} yet (done-done cannot send its CLI an image)`, `Set judge.route to claude-code or answerer:<one of ${ANSWERER_JUDGES.join(', ')}>`);
    const model = cfg.judge.model || CHEAP_MODELS[agent] || '';
    if (!model)
        throw new UsageError(`judge: no model for ${route}`, `Set judge.model in ~/.done-done/config.yaml`);
    const choice = pick(agent, model, 'config');
    if (choice.independence === 'session-only' && !cfg.judge.allow_same)
        throw new UsageError(`judge: judge.route ${route} at model ${model} is the author's own agent and model (${author.agent}), and the judge is never the agent that did the work`, 'Set judge.route or judge.model to another agent or model, or set judge.allow_same: true in ~/.done-done/config.yaml to accept a fresh session of the same one');
    return choice;
}
export function askAgent(c) {
    const adapter = ADAPTERS[c.agent];
    const started = Date.now();
    let dir = '';
    let cwd = c.cwd;
    let res;
    let attempts = 0;
    let out;
    let failure;
    try {
        dir = mkdtempSync(join(tmpdir(), 'done-done-agent-'));
        cwd = c.tools === 'none' ? dir : c.cwd;
        if (!adapter)
            throw new Error(`no adapter for ${c.agent} yet`);
        let lastError = '';
        for (;;) {
            attempts++;
            // An ask-again names what was wrong with the last answer.
            const schemaTrailer = `\n\nAnswer with only one JSON object that matches this JSON schema, and no other text:\n${JSON.stringify(c.schema)}\n`;
            const promptText = (attempts === 1 ? c.prompt : `${c.prompt}\n\nYour previous answer was not valid (${lastError}).`) + schemaTrailer;
            if (adapter.file)
                writeFileSync(join(dir, 'prompt.md'), promptText, { mode: 0o600 });
            res = spawnSync(onPath(c.agent) || c.agent, adapter.argv(c, dir), { cwd, input: adapter.file ? '' : promptText, env: { ...process.env, ...adapter.env?.(c) }, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: 64 << 20 });
            if (res.error)
                throw res.error;
            if (res.status !== 0) {
                // An agent that exits non-zero may still say why in its own output (claude: a usage limit, a bad model).
                let text = String(res.stderr || res.stdout).trim().slice(-500);
                try {
                    adapter.answer(String(res.stdout));
                }
                catch (e) {
                    if (e instanceof ProviderError)
                        text = e.detail;
                    else if (!(e instanceof SyntaxError))
                        text = e.message;
                }
                throw new ProviderError(text, `${c.agent} exited ${res.status}: `, adapter.hint && c.tools !== 'none' ? `; ${adapter.hint}` : '');
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
                if (e instanceof ProviderError)
                    throw e;
                // Only a tool-less call is asked again: an edit or read step may already have changed the repo or read it.
                lastError = e.message;
                if (c.tools !== 'none' || attempts >= (c.attempts ?? ASK_ATTEMPTS))
                    throw new Error(`the agent did not answer with valid JSON after ${attempts} ${attempts === 1 ? 'try' : 'tries'}: ${lastError}`);
            }
        }
    }
    catch (e) {
        out = { ok: false, error: e.message };
        failure = e instanceof ProviderError ? e.detail : e.message;
    }
    finally {
        if (dir)
            rmSync(dir, { recursive: true, force: true });
    }
    // The record holds what ran and what came back, never the prompt text.
    const { prompt, ...call } = c;
    try {
        const record = { ...call, cwd, prompt_bytes: Buffer.byteLength(prompt), argv: adapter?.argv(c, '<tmp>') ?? [], ms: Date.now() - started, exit: res?.status ?? null, attempts, ...out, error: failure, stderr: String(res?.stderr ?? '').slice(-2000) };
        mkdirSync(dirname(c.record), { recursive: true });
        writeFileSync(c.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        out = { ...out, record: c.record };
    }
    catch (e) {
        out = { ...out, recordError: e.message };
    }
    return out;
}
