import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { AGENTS, ANSWERER_JUDGES, CHEAP, EFFORT_FLAGS, KEY_ROUTES, parseDuration, UsageError } from './config.js';
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
const PI_TOOL_LESS = ['--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files'];
const ADAPTERS = {
    // claude -p: --json-schema puts the validated object in structured_output; --tools '' turns every tool off.
    // An edit step accepts edits only in cwd and --add-dir folders, and may run commands (the drive launches the app).
    claude: {
        argv: (c) => ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(c.schema), '--model', c.model, '--no-session-persistence',
            ...(c.tools === 'edit' ? ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', ...(c.dirs ?? []).flatMap((d) => ['--add-dir', d])] : ['--tools', c.tools === 'read' ? 'Read,Grep,Glob' : '']),
            ...(c.tools === 'edit' ? [] : ['--setting-sources', '']), ...(c.tools === 'read' ? ['--strict-mcp-config'] : [])],
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
        argv: (c, dir) => ['run', 'Follow the attached instructions.', '--format', 'json', '-m', c.model, '-f', join(dir, 'prompt.md'), ...(c.images ?? []).flatMap((i) => ['-f', join(dir, i.name)])],
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
        // An edit step keeps the user's own permissions, where a folder outside cwd asks and so is refused in `run`; only the
        // run's own folders are allowed.
        env: (c) => ({ OPENCODE_PERMISSION: JSON.stringify(c.tools === 'edit' ? { external_directory: Object.fromEntries((c.dirs ?? []).flatMap((d) => [[d, 'allow'], [`${d}/*`, 'allow']])) } : { '*': 'deny' }) }),
    },
    // pi -p reads the prompt on stdin (probed 12 Oct: with no positional message, stdin becomes the user
    // message); --mode json streams JSONL events whose assistant message_end holds the answer text,
    // --no-session keeps the probe ephemeral. An @<file> argument attaches an image to that message.
    // --no-tools turns every built-in and extension tool off (probed 13 Oct: a canary file outside the cwd went unread).
    // A tool-less call also loads no extensions, skills, prompt templates or context files: they would add the user's own
    // context to a fresh judge, and extension loading took 2 minutes on a real setup (probed 13 Oct), past the judge's timeout.
    // Pi has no permission gate for edit steps, so doctor warns about it. Without a model, pi runs its own default.
    pi: {
        argv: (c, dir) => ['-p', '--mode', 'json', '--no-session', ...(c.tools === 'edit' ? [] : PI_TOOL_LESS), ...(c.model ? ['--model', c.model] : []), ...(c.images ?? []).map((i) => `@${join(dir, i.name)}`)],
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
    // codex exec with no prompt argument reads it on stdin; --json streams JSONL events whose last agent_message holds the
    // answer, and --ephemeral keeps no session. An edit step runs in codex's workspace-write sandbox, which writes only the
    // repo, the run's folders (--add-dir) and $TMPDIR; it may use the network, since the drive launches the app and talks
    // to it, and it keeps the user's config.toml. Without a model, codex runs its own default.
    // A tool-less call is refused: probed live 13 Oct, codex with the user's config.toml kept its MCP server, which read a
    // canary file outside the folder, and --disable does not turn off its multi-agent tools.
    codex: {
        editOnly: 'codex cannot run tool-less: with your config.toml it keeps its MCP tools, which read files outside the folder',
        argv: (c) => ['exec', '--json', '--ephemeral', ...(c.model ? ['-m', c.model] : []),
            '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', ...(c.dirs ?? []).flatMap((d) => ['--add-dir', d])],
        answer: (out, c) => {
            let text = '';
            let failed = '';
            let error = '';
            for (const line of out.split('\n')) {
                if (!line.startsWith('{'))
                    continue;
                const e = JSON.parse(line);
                if (e.type === 'item.completed' && e.item?.type === 'agent_message')
                    text = String(e.item.text ?? '');
                if (e.type === 'turn.failed')
                    failed = String(e.error?.message ?? JSON.stringify(e));
                if (e.type === 'error')
                    error = String(e.message ?? JSON.stringify(e));
            }
            // A failed turn has no answer; an error event (a retried stream) fails the call only when the agent said nothing.
            const why = failed || (text ? '' : error);
            if (why)
                throw new ProviderError(why);
            return extractJsonObject(text, c.schema.required);
        },
    },
    // gemini -p text is appended to stdin, so -p carries only a fixed trailer and the prompt goes on stdin;
    // -o json prints one object {response, stats, error?} (its headless.md). plan mode is read-only, so a
    // headless call never blocks on an approval prompt; auto_edit (edits approved) plus the shell tool is only for edit steps,
    // with the run's folders added to the workspace.
    // --skip-trust is only for the tool-less probe in its scratch folder (the headless path in its trusted-folders.md): done-done
    // never runs interactively, so the trust dialog could never be answered there. Repo calls keep Gemini's trust gate.
    // plan mode still reads files, so a tool-less call also loads a deny-all --policy, which replaces the user's own
    // policy folder and removes every tool, MCP ones too, from the model (its policy-engine.md). An @<file> in the -p text
    // attaches an image: per Gemini CLI's source, its own @-command code reads it, outside the tool policy, and only inside the cwd, the call's scratch folder; not yet proven live (Gemini CLI was not signed in on the test machine).
    gemini: {
        argv: (c, dir) => ['-p', ['Follow the instructions on stdin.', ...(c.images ?? []).map((i) => `@${i.name}`)].join(' '), '-o', 'json', '-m', c.model, '--approval-mode', c.tools === 'edit' ? 'auto_edit' : 'plan',
            ...(c.tools === 'none' ? ['--policy', join(dir, 'deny-all.toml'), '--skip-trust'] : []),
            ...(c.tools === 'edit' ? ['--allowed-tools', 'run_shell_command', ...(c.dirs ?? []).flatMap((d) => ['--include-directories', d])] : [])],
        files: (c) => (c.tools === 'none' ? { 'deny-all.toml': '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n' } : {}),
        hint: 'if gemini refused this folder as untrusted, trust it in Gemini CLI first, then retry',
        answer: (out, c) => {
            const r = JSON.parse(out);
            if (!r.response && r.error)
                throw new ProviderError(JSON.stringify(r.error));
            return extractJsonObject(String(r.response ?? ''), c.schema.required);
        },
    },
};
// The author agent: exactly the one the user set, never one done-done detects or falls back to. With none set,
// done-done asks the user (in a terminal) or stops with the command that saves their answer.
export function selectAgent(cfg) {
    if (!cfg.agent)
        throw noAgent();
    return agentRun(cfg, cfg.agent);
}
// The agents a user can pick, and the error that tells a calling agent to ask the user rather than pick one itself.
export const agentChoices = () => [...AGENTS, 'acp:<target>'];
// The error a command gives when the agent or the judge is not set: the ask, the choices, and the command that saves the answer.
const askError = (kind, choices, rule, save) => new UsageError(`no ${kind} is set: ask the user which ${kind} to use (${choices}); ${rule}`, `Save the user's answer: ${save}`);
export const noAgent = () => askError('agent', agentChoices().join(', '), 'never pick one for them', `done-done init --agent <agent> --model <model>, e.g. done-done init --agent opencode --model ${CHEAP.opencode.model}`);
export const modelFor = (cfg, agent) => cfg.agent_config[agent]?.model || CHEAP[agent]?.model || '';
export const agentRun = (cfg, agent, model = modelFor(cfg, agent)) => ({
    agent, model, effort: cfg.agent_config[agent]?.effort ?? '', args: cfg.agent_args_override[agent] ?? [], path: agentPath(agent, cfg), override: cfg.agent_path_override[agent] ?? '', timeoutMs: parseDuration(cfg.agent_timeout),
});
export const notStartable = (agent, override = '') => (override ? `agent_path_override.${agent} ${override} is not an executable file` : `${agent} is not on PATH`);
// The known agent an agent names, for the judge-independence check: acp:claude-code is claude; a target that
// names no known agent (acp:claudex, acp:foo) stays as named.
export function knownAgentOf(agent) {
    const target = agent.replace(/^acp:/, '');
    return AGENTS.find((a) => target === a || (target.startsWith(a) && !/[A-Za-z0-9]/.test(target[a.length]))) ?? agent;
}
const adapterFor = (agent) => (agent.startsWith('acp:') ? ACP : Object.hasOwn(ADAPTERS, agent) ? ADAPTERS[agent] : undefined);
// Why an agent cannot run a tool-less call, '' when it can.
export const editOnlyReason = (agent) => adapterFor(agent)?.editOnly ?? '';
// A binary from config: a bare name is looked up on PATH, an absolute path is used when it is an executable file.
export const findBin = (bin) => (isAbsolute(bin) ? (isExecutable(bin) ? bin : '') : onPath(bin));
// The binary that starts an agent: agent_path_override.<agent>, else its name on PATH. An acp:<target> agent starts
// through acpx (acpx_path), which counts as installed only when it runs (a version-manager shim with no version set
// is on PATH but starts nothing).
const acpxRuns = new Map();
export function agentPath(agent, cfg) {
    if (!agent.startsWith('acp:'))
        return findBin(cfg?.agent_path_override[agent] || agent);
    const acpx = findBin(cfg?.acpx_path || 'acpx');
    if (!acpx)
        return '';
    if (!acpxRuns.has(acpx))
        acpxRuns.set(acpx, spawnSync(acpx, ['--version'], { stdio: 'ignore', timeout: 5_000 }).status === 0);
    return acpxRuns.get(acpx) ? acpx : '';
}
export const claudeBin = (cfg) => agentPath('claude', cfg);
export const routeOf = (agent) => (agent === 'claude' ? 'claude-code' : `answerer:${agent}`);
export const JUDGES = AGENTS.filter((a) => a === 'claude' || ANSWERER_JUDGES.includes(a));
// Like the agent, the judge is exactly the one the user set; with none, done-done asks the user (in a terminal) or
// stops with this error, so a calling agent asks its user rather than picking one.
export const noJudge = () => askError('judge', JUDGES.join(', '), 'never pick one for them, and never the agent that did the work', `done-done init --judge <agent> --judge-model <model>, e.g. done-done init --judge opencode --judge-model ${CHEAP.opencode.model}`);
export function selectJudge(cfg, found) {
    const route = cfg.judge.route;
    if (!route)
        throw noJudge();
    // A key route judges on the user's own key at judge.model; an agent route judges through that agent at its model.
    const keyed = Object.hasOwn(KEY_ROUTES, route);
    if (keyed && !cfg.judge.model)
        throw new UsageError(`judge: judge.route ${route} needs judge.model, a model your key can use that reads images`, 'Set judge.model in ~/.done-done/config.yaml');
    const agent = keyed ? route : route === 'claude-code' ? 'claude' : route.slice('answerer:'.length);
    const model = cfg.judge.model || modelFor(cfg, agent);
    if (!model)
        throw new UsageError(`judge: no model for ${route}`, `Set judge.model in ~/.done-done/config.yaml`);
    // acp:claude-code is claude for independence; an author with no known model is never apart by model.
    const independence = keyed
        ? found.model && model === found.model ? 'session-only' : 'agent'
        : agent !== knownAgentOf(found.agent) ? 'agent' : found.model && model !== found.model ? 'model' : 'session-only';
    if (independence === 'session-only' && !cfg.judge.allow_same)
        throw new UsageError(`judge: the judge ${agent} (model ${model}) is the author's own agent and model (${found.agent}), and the judge is never the agent that did the work`, `Ask the user for another judge agent or model and save it: done-done init --judge <agent> --judge-model <model>; or set judge.allow_same: true in ~/.done-done/config.yaml to accept a fresh session of the same one`);
    return { route, agent, model, independence, author: { agent: found.agent, model: found.model } };
}
const DRAIN_MS = 500;
const OUTPUT_CAP = 64 << 20;
// One agent process. An edit step gets its own process group, so whatever it started (a dev server, a browser) is
// killed with it when it ends, times out or writes past the output cap.
function start(bin, argv, c, cwd, input, env) {
    const group = c.tools === 'edit';
    return new Promise((done) => {
        const child = spawn(bin, argv, { cwd, env, detached: group });
        let stdout = '';
        let stderr = '';
        let error;
        let drain;
        const kill = () => {
            try {
                if (group)
                    process.kill(-child.pid, 'SIGKILL');
                else
                    child.kill('SIGKILL');
            }
            catch {
                // Already gone.
            }
        };
        const overflow = () => {
            error ??= new Error(`${c.agent} wrote more than ${OUTPUT_CAP >> 20} MiB of output`);
            kill();
        };
        const timer = setTimeout(() => {
            error = new Error(`${c.agent} timed out after ${Math.round(c.timeoutMs / 1000)}s`);
            kill();
        }, c.timeoutMs);
        child.on('error', (e) => {
            clearTimeout(timer);
            done({ status: null, stdout, stderr, error: e });
        });
        if (!child.pid)
            return;
        if (group)
            c.onSpawn?.(child.pid);
        child.stdout.setEncoding('utf8').on('data', (d) => {
            stdout += d;
            if (stdout.length > OUTPUT_CAP)
                overflow();
        });
        child.stderr.setEncoding('utf8').on('data', (d) => {
            stderr += d;
            if (stderr.length > OUTPUT_CAP)
                overflow();
        });
        child.on('exit', () => {
            drain = setTimeout(() => {
                child.stdout.destroy();
                child.stderr.destroy();
            }, DRAIN_MS);
        });
        child.on('close', (status) => {
            clearTimeout(timer);
            clearTimeout(drain);
            if (group)
                kill();
            done({ status, stdout, stderr, error });
        });
        child.stdin.on('error', () => { }); // an agent that exits without reading its stdin
        child.stdin.end(input);
    });
}
export async function askAgent(c) {
    const adapter = adapterFor(c.agent);
    const argv = (d) => (adapter ? [...adapter.argv(c, d), ...(c.effort ? EFFORT_FLAGS[c.agent]?.(c.effort) ?? [] : []), ...(c.args ?? [])] : []);
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
        if (adapter.editOnly && c.tools !== 'edit')
            throw new Error(adapter.editOnly);
        for (const i of c.images ?? [])
            writeFileSync(join(dir, i.name), i.bytes, { mode: 0o600 });
        for (const [name, text] of Object.entries(adapter.files?.(c) ?? {}))
            writeFileSync(join(dir, name), text, { mode: 0o600 });
        const bin = c.path;
        if (!bin)
            throw new Error(c.agent.startsWith('acp:') ? `${c.agent} needs acpx, and acpx is not startable; ${ACPX_INSTALL}` : notStartable(c.agent, c.override));
        let lastError = '';
        for (;;) {
            attempts++;
            // An ask-again names what was wrong with the last answer.
            const schemaTrailer = `\n\nAnswer with only one JSON object that matches this JSON schema, and no other text:\n${JSON.stringify(c.schema)}\n`;
            const promptText = (attempts === 1 ? c.prompt : `${c.prompt}\n\nYour previous answer was not valid (${lastError}).`) + schemaTrailer;
            if (adapter.file)
                writeFileSync(join(dir, 'prompt.md'), promptText, { mode: 0o600 });
            res = await start(bin, argv(dir), c, cwd, adapter.file ? '' : promptText, { ...process.env, ...c.env, ...adapter.env?.(c) });
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
                    throw new Error(`the answer does not match the schema (missing ${missing.join(', ')}): ${JSON.stringify(answer).slice(0, 200)}`);
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
    // The record holds what ran and what came back, never the prompt text or an image.
    const { prompt, images, ...call } = c;
    try {
        const record = { ...call, ...(images && { images: images.map((i) => i.name) }), cwd, prompt_bytes: Buffer.byteLength(prompt), argv: argv('<tmp>'), ms: Date.now() - started, exit: res?.status ?? null, attempts, ...out, error: failure, stderr: String(res?.stderr ?? '').slice(-2000) };
        mkdirSync(dirname(c.record), { recursive: true });
        writeFileSync(c.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        out = { ...out, record: c.record };
    }
    catch (e) {
        out = { ...out, recordError: e.message };
    }
    return out;
}
