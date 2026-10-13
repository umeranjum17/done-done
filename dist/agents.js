import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { AGENTS, ANSWERER_JUDGES, CHEAP_MODELS, UsageError } from './config.js';
import { isExecutable, onPath } from './judge.js';
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
// The answer object in an agent's free text: the first top-level '{'..'}' span that parses to an object with every
// required key, skipping braces and quotes in narration. With no such span, the last span that parsed is returned, so
// the caller reports the missing keys. A span still open at the end of the text was a stray brace in narration, so the
// scan restarts one character after it; restarts are capped so the worst case stays bounded.
const MAX_SPAN_RESTARTS = 50;
function scanSpans(text, from, spans) {
    let depth = 0;
    let start = 0;
    let inString = false;
    for (let i = from; i < text.length; i++) {
        const ch = text[i];
        if (depth === 0) {
            if (ch === '{') {
                depth = 1;
                start = i;
            }
        }
        else if (inString) {
            if (ch === '\\')
                i++;
            else if (ch === '"')
                inString = false;
        }
        else if (ch === '"')
            inString = true;
        else if (ch === '{')
            depth++;
        else if (ch === '}' && --depth === 0)
            spans.push(text.slice(start, i + 1));
    }
    return depth > 0 ? start : -1;
}
// ponytail: a stray quote inside narration braces can hide the answer; the ask-again loop (a tool-less call is asked again up to ASK_ATTEMPTS times) covers it, so the scanner stops growing here.
export function extractJsonObject(text, required = []) {
    const spans = [];
    let open = scanSpans(text, 0, spans);
    for (let restarts = 0; open >= 0 && restarts < MAX_SPAN_RESTARTS; restarts++)
        open = scanSpans(text, open + 1, spans);
    const parsed = spans.flatMap((span) => { try {
        return [JSON.parse(span)];
    }
    catch {
        return [];
    } });
    const answer = parsed.find((v) => required.every((k) => k in v)) ?? parsed[parsed.length - 1];
    if (!answer)
        throw new Error(`no JSON object in the answer: ${text.slice(0, 200)}`);
    return answer;
}
// acp:<target> runs any Agent Client Protocol agent through the user's acpx bridge (acpx's own registry names
// the targets): the prompt and the schema on stdin (exec --file -), and the answer is the JSON object in the agent's
// message chunks of acpx's JSON-RPC event stream. Every tool is denied, and a permission prompt is denied too, since
// nobody can answer it. No model means the target's own default.
const ACP = {
    argv: (c, dir) => ['--cwd', c.tools === 'none' ? dir : c.cwd, '--format', 'json', '--json-strict', '--deny-all',
        '--non-interactive-permissions', 'deny', ...(c.model ? ['--model', c.model] : []), c.agent.slice('acp:'.length), 'exec', '--file', '-'],
    answer: (out, c) => {
        const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
        const text = events.filter((e) => e.method === 'session/update' && e.params?.update?.sessionUpdate === 'agent_message_chunk')
            .map((e) => e.params.update.content?.text ?? '').join('');
        // An error response fails the call only when the agent said nothing: a refused side request is not the answer.
        const error = events.find((e) => e.error)?.error;
        if (!text && error)
            throw new ProviderError(String(error.message ?? JSON.stringify(error)).slice(0, 500));
        return extractJsonObject(text, c.schema.required);
    },
};
export const ACPX_INSTALL = 'Install the acpx ACP bridge (npm install -g acpx, https://github.com/openclaw/acpx), then re-run: done-done doctor';
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
        answer: (out, c) => {
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
            return extractJsonObject(text, c.schema.required);
        },
        env: (c) => (c.tools === 'edit' ? {} : { OPENCODE_PERMISSION: JSON.stringify(c.tools === 'read' ? { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' } : { '*': 'deny' }) }),
    },
    // pi -p reads the prompt on stdin (probed 12 Oct: with no positional message, stdin becomes the user
    // message); --mode json streams JSONL events whose assistant message_end holds the answer text,
    // --no-session keeps the probe ephemeral.
    // Pi has no permission gate for edit steps, so doctor warns about it. Without a model, pi runs its own default.
    pi: {
        argv: (c) => ['-p', '--mode', 'json', '--no-session', ...(c.tools === 'none' ? ['--no-tools'] : c.tools === 'read' ? ['-t', 'read,grep,find,ls'] : []), ...(c.model ? ['--model', c.model] : [])],
        answer: (out, c) => {
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
            return extractJsonObject(text, c.schema.required);
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
        answer: (out, c) => {
            const r = JSON.parse(out);
            if (!r.response && r.error)
                throw new ProviderError(JSON.stringify(r.error));
            return extractJsonObject(String(r.response ?? ''), c.schema.required);
        },
    },
};
// The author agent: the first of the configured list (or of AGENTS for auto) that is on PATH and that
// done-done can start; the list moves on when an agent is not installed or done-done cannot start it yet.
// Its model is agent_config.<agent>.model, else the cheap default. skipped names the installed agents passed over.
export function selectAgent(cfg) {
    const list = cfg.agent === 'auto' ? AGENTS : cfg.agent;
    const found = list.map((agent) => ({ agent, path: agentPath(agent) })).filter((a) => a.path);
    const first = found.findIndex((a) => supported(a.agent));
    const pick = first >= 0 ? found[first] : found[0] ?? { agent: list[0], path: '' };
    const passed = first >= 0 ? found.slice(0, first) : found.slice(1);
    return { ...pick, model: modelFor(cfg, pick.agent), from: cfg.agent === 'auto' ? 'auto' : 'config', skipped: passed.map((a) => a.agent) };
}
export const modelFor = (cfg, agent) => cfg.agent_config[agent]?.model || CHEAP_MODELS[agent] || '';
// The known agent an agent names, for the judge-independence check: acp:claude-code is claude; a target that
// names no known agent (acp:claudex, acp:foo) stays as named.
export function knownAgentOf(agent) {
    const target = agent.replace(/^acp:/, '');
    return AGENTS.find((a) => target === a || (target.startsWith(a) && !/[A-Za-z0-9]/.test(target[a.length]))) ?? agent;
}
const adapterFor = (agent) => (agent.startsWith('acp:') ? ACP : Object.hasOwn(ADAPTERS, agent) ? ADAPTERS[agent] : undefined);
export function supported(agent) {
    return !!adapterFor(agent);
}
// The binary that starts an agent. An acp:<target> agent starts through acpx, which counts as installed only
// when it runs (a version-manager shim with no version set is on PATH but starts nothing).
const acpxRuns = new Map();
export function agentPath(agent) {
    if (!agent.startsWith('acp:'))
        return onPath(agent);
    const acpx = onPath('acpx');
    if (!acpx)
        return '';
    if (!acpxRuns.has(acpx))
        acpxRuns.set(acpx, spawnSync(acpx, ['--version'], { stdio: 'ignore', timeout: 5_000 }).status === 0);
    return acpxRuns.get(acpx) ? acpx : '';
}
export const claudeBin = (cfg) => cfg.judge.claude_code.bin || onPath('claude');
const claudeReady = (cfg) => {
    const bin = claudeBin(cfg);
    const dir = cfg.judge.claude_code.config_dir;
    return !!bin && isAbsolute(bin) && isExecutable(bin) && isAbsolute(dir) && existsSync(dir);
};
const routeOf = (agent) => (agent === 'claude' ? 'claude-code' : `answerer:${agent}`);
const canJudge = (agent) => agent === 'claude' || ANSWERER_JUDGES.includes(agent);
export const JUDGES = AGENTS.filter(canJudge);
export function selectJudge(cfg, found) {
    const author = found.path ? found : { agent: 'none', model: '', path: '' };
    // acp:claude-code is claude for independence; an author with no known model is never apart by model.
    const same = knownAgentOf(author.agent);
    const pick = (agent, model, from) => {
        const independence = agent !== same ? 'agent' : author.model && model !== author.model ? 'model' : 'session-only';
        return { route: routeOf(agent), agent, model, independence, from, author: { agent: author.agent, model: author.model } };
    };
    const route = cfg.judge.route;
    if (route === 'auto') {
        // The first installed agent that can judge and is not the author, at its cheap model; else the author's agent.
        const ready = AGENTS.filter((a) => canJudge(a) && (a === 'claude' ? claudeReady(cfg) : onPath(a)));
        const other = ready.find((a) => a !== same);
        if (other)
            return pick(other, CHEAP_MODELS[other], 'auto');
        if (ready.includes(same))
            return pick(same, CHEAP_MODELS[same], 'auto');
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
    const adapter = adapterFor(c.agent);
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
        const bin = agentPath(c.agent);
        if (!bin)
            throw new Error(c.agent.startsWith('acp:') ? `${c.agent} needs acpx, and acpx is not startable; ${ACPX_INSTALL}` : `${c.agent} is not on PATH`);
        let lastError = '';
        for (;;) {
            attempts++;
            // An ask-again names what was wrong with the last answer.
            const schemaTrailer = `\n\nAnswer with only one JSON object that matches this JSON schema, and no other text:\n${JSON.stringify(c.schema)}\n`;
            const promptText = (attempts === 1 ? c.prompt : `${c.prompt}\n\nYour previous answer was not valid (${lastError}).`) + schemaTrailer;
            if (adapter.file)
                writeFileSync(join(dir, 'prompt.md'), promptText, { mode: 0o600 });
            res = spawnSync(bin, adapter.argv(c, dir), { cwd, input: adapter.file ? '' : promptText, env: { ...process.env, ...adapter.env?.(c) }, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: 64 << 20 });
            if (res.error)
                throw res.error;
            if (res.status !== 0) {
                // An agent that exits non-zero may still say why in its own output (claude: a usage limit, a bad model).
                let text = String(res.stderr || res.stdout).trim().slice(-500);
                try {
                    adapter.answer(String(res.stdout), c);
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
                const answer = adapter.answer(String(res.stdout), c);
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
