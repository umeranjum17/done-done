import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { checkMatrix } from './matrix.js';
import { parseDom } from './dom.js';
export class UsageError extends Error {
    help;
    // The exact next command, when the error has one.
    constructor(message, help) {
        super(message);
        this.help = help;
    }
}
// The coding agents a user can set as agent.
export const AGENTS = ['claude', 'codex', 'opencode', 'pi', 'gemini'];
// The agents whose CLI can read an attached image with every tool off, so they judge through the answerer route;
// claude judges through claude-code. An acp:<target> agent cannot be sent an image. codex cannot run tools-off, so it does not judge.
export const ANSWERER_JUDGES = ['opencode', 'pi', 'gemini'];
// BYOKit key routes: a judge on the user's own API key, read from this environment variable, with no agent CLI.
export const KEY_ROUTES = { 'openai:key': 'OPENAI_API_KEY' };
// Or acp:<target>, any agent the user's acpx bridge can start; the target is one argv word, so it never reads as a flag.
export const isAgent = (v) => AGENTS.includes(v) || (typeof v === 'string' && /^acp:[A-Za-z0-9][\w.-]*$/.test(v));
// The cost guard is this table: a default model for an agent here is always its cheap one, never a flagship,
// whatever the vendor; any other model runs only when the user names it. gemini's is the CLI's own
// `flash-lite` alias (its cli-reference.md: the fastest model for simple tasks). codex, pi and acp:<target> have no public
// cheap alias, so they run their own configured default model, and agent_config.<agent>.model caps their cost.
// As a judge, pi has no default: answerer:<agent> needs judge.model or agent_config.<agent>.model, a model that reads images.
export const CHEAP = {
    claude: { model: 'claude-haiku-5-5', effort: 'low' },
    opencode: { model: 'opencode-go/muse-spark-1.3-contributor', effort: 'low' },
    gemini: { model: 'flash-lite' },
};
// The steps auto_fix can name.
export const AUTO_FIX_STEPS = ['maintain', 'verify'];
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Each CLI's own reasoning-effort flag; an agent not here has none, so agent_config.<agent>.effort is refused for it.
export const EFFORT_FLAGS = {
    claude: (l) => ['--effort', l],
    codex: (l) => ['-c', `model_reasoning_effort="${l}"`],
    opencode: (l) => ['--variant', l],
    pi: (l) => ['--thinking', l],
};
const AGENT_TIMEOUT = '30m';
// Where each key may be set. Global-only keys describe the machine; repo-only keys describe the project; `any` may be in either.
const KEYS = {
    agent: { scope: 'any', type: 'agent' },
    auto_fix: { scope: 'any', type: 'auto_fix' },
    agent_config: { scope: 'global', type: 'agent_config' },
    agent_args_override: { scope: 'global', type: 'args' },
    agent_path_override: { scope: 'global', type: 'paths' },
    acpx_path: { scope: 'global', type: 'bin' },
    agent_timeout: { scope: 'global', type: 'duration' },
    'evidence.local_root': { scope: 'global', type: 'string' },
    app: { scope: 'repo', type: 'string' },
    skill: { scope: 'repo', type: 'string' },
    journeys: { scope: 'repo', type: 'journeys' },
    instance: { scope: 'repo', type: 'instance' },
    matrix: { scope: 'repo', type: 'matrix' },
    dom: { scope: 'repo', type: 'dom' },
    'evidence.root': { scope: 'repo', type: 'string' },
    'evidence.allow_dirty': { scope: 'repo', type: 'boolean' },
    'evidence.ignore_paths': { scope: 'repo', type: 'string[]' },
    'checks.not_proven': { scope: 'repo', type: 'string' },
    'checks.fix_title': { scope: 'repo', type: 'string' },
    'judge.enabled': { scope: 'repo', type: 'boolean' },
    'judge.model': { scope: 'global', type: 'string' },
    'judge.route': { scope: 'global', type: 'route' },
    'judge.claude_code': { scope: 'global', type: 'claude_code' },
    'judge.allow_same': { scope: 'global', type: 'boolean' },
};
const SECTIONS = new Set(['evidence', 'checks', 'judge']);
const MAPS = new Set(['auto_fix', 'agent_config', 'agent_args_override', 'agent_path_override', 'judge.claude_code']);
export const home = () => process.env.DONE_DONE_HOME || join(homedir(), '.done-done');
// A duration such as 90s, 30m or 1h, in milliseconds; null when the text is not one or is not a delay a timer can run.
export const parseDuration = (text) => {
    const m = /^(\d+)(s|m|h)$/.exec(text);
    const ms = m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]] : 0;
    return ms > 0 && ms <= 2_147_483_647 ? ms : null;
};
function flatten(doc, file) {
    const out = new Map();
    if (doc == null)
        return out;
    if (typeof doc !== 'object' || Array.isArray(doc))
        throw new UsageError(`${file}: top level must be a mapping`);
    for (const [k, v] of Object.entries(doc)) {
        if (SECTIONS.has(k)) {
            if (v == null)
                continue;
            if (typeof v !== 'object' || Array.isArray(v))
                throw new UsageError(`${file}: ${k} must be a mapping`);
            for (const [k2, v2] of Object.entries(v))
                out.set(`${k}.${k2}`, v2);
        }
        else
            out.set(k, v);
    }
    return out;
}
// A binary: a bare name looked up on PATH, or an absolute path (~ is the home folder).
const isBin = (v) => typeof v === 'string' && (/^[\w.-]+$/.test(v) || isAbsolute(tilde(v)));
const tilde = (p) => p.replace(/^~(?=\/|$)/, homedir());
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function apply(target, text, file, scope) {
    if (text === undefined)
        return;
    let doc;
    try {
        doc = parse(text);
    }
    catch (e) {
        throw new UsageError(`${file}: ${e.message.split('\n')[0]}`);
    }
    for (const [key, value] of flatten(doc, file)) {
        const spec = KEYS[key];
        if (!spec)
            throw new UsageError(`${file}: unknown key ${key}`);
        if (spec.scope !== scope && spec.scope !== 'any')
            throw new UsageError(`${file}: ${key} may only be set in the ${spec.scope === 'global' ? 'global config' : 'project .done-done.yaml'}`);
        const ok = spec.type === 'string' ? typeof value === 'string'
            : spec.type === 'boolean' ? typeof value === 'boolean'
                : spec.type === 'string[]' ? Array.isArray(value) && value.every((v) => typeof v === 'string')
                    : spec.type === 'agent' ? isAgent(value)
                        : spec.type === 'route' ? typeof value === 'string' && (value === 'claude-code' || Object.hasOwn(KEY_ROUTES, value) || ANSWERER_JUDGES.some((a) => value === `answerer:${a}`))
                            : spec.type === 'claude_code' ? isMap(value) && Object.entries(value).every(([k, v]) => k === 'config_dir' && typeof v === 'string')
                                : spec.type === 'agent_config' ? isMap(value) && Object.entries(value).every(([a, c]) => isAgent(a) && isMap(c) && Object.entries(c).every(([k, m]) => ['model', 'effort'].includes(k) && typeof m === 'string'))
                                    : spec.type === 'args' ? isMap(value) && Object.entries(value).every(([a, v]) => AGENTS.includes(a) && Array.isArray(v) && v.every((x) => typeof x === 'string'))
                                        : spec.type === 'paths' ? isMap(value) && Object.entries(value).every(([a, v]) => AGENTS.includes(a) && isBin(v))
                                            : spec.type === 'bin' ? isBin(value)
                                                : spec.type === 'duration' ? typeof value === 'string' && parseDuration(value) !== null
                                                    : spec.type === 'auto_fix' ? isMap(value) && Object.entries(value).every(([k, n]) => AUTO_FIX_STEPS.includes(k) && Number.isInteger(n) && n >= 0)
                                                        : spec.type === 'matrix' ? !checkMatrix(value)
                                                            : isMap(value) && Object.values(value).every((j) => j && typeof j.command === 'string');
        const want = {
            journeys: 'a map of name: {command: <string>}',
            instance: '{command: <string>, ready: {url: <http url>} or {command: <shell command>}, ready_timeout: <duration>}',
            matrix: 'a mapping with optional theme (a list of names), width (a list of CSS pixel widths) and form (a list of names), plus skip (a list of partial cells, each with a reason)',
            agent: `one of ${AGENTS.join(', ')}, or acp:<target>`,
            agent_config: `a map of <agent>: {model: <string>, effort: <string>} for ${AGENTS.join(', ')}, acp:<target>`,
            args: `a map of <agent>: [<flag>, ...] for ${AGENTS.join(', ')}`,
            paths: `a map of <agent>: <binary name or absolute path> for ${AGENTS.join(', ')}`,
            bin: 'a binary name on PATH or an absolute path',
            duration: 'a duration such as 90s, 30m or 1h',
            auto_fix: `a map of <step>: <attempts, 0 or more> for ${AUTO_FIX_STEPS.join(', ')}`,
            route: `claude-code (for claude), answerer:<agent> for one of ${ANSWERER_JUDGES.join(', ')}, or a key route (${Object.keys(KEY_ROUTES).join(', ')}); an acp:<target> agent cannot judge, since done-done cannot send it an image`,
            claude_code: 'a map with config_dir, a string (the claude binary is agent_path_override.claude)',
        };
        if (key === 'judge.route' && (value === 'auto' || value === ''))
            throw new UsageError(`${file}: judge.route ${value === '' ? 'must not be empty; to leave it unset, remove the key' : 'auto is gone: done-done never picks the judge, the user sets it'}`, `Delete the judge.route line in ${file}, then run: done-done init --judge <agent> --judge-model <model>`);
        if (key === 'agent' && value === '')
            throw new UsageError(`${file}: agent must not be empty; to leave it unset, remove the key`);
        if (key === 'instance') {
            // instance: {command, ready: {url} or {command}, ready_timeout}. Validated here; the harness owns the port.
            const v = value;
            const fail = (why) => { throw new UsageError(`${file}: instance ${why}`); };
            if (!isMap(value) || typeof v.command !== 'string' || !v.command)
                fail('needs a command string');
            if (!isMap(v.ready))
                fail('needs ready: {url: <http url>} or ready: {command: <shell command>}');
            const r = v.ready;
            const has = (x) => typeof x === 'string' && x !== '';
            if (has(r.url) === has(r.command))
                fail('needs exactly one of ready.url and ready.command');
            if (v.ready_timeout !== undefined && (typeof v.ready_timeout !== 'string' || parseDuration(v.ready_timeout) === null))
                fail('ready_timeout must be a duration such as 30s, 2m or 1h');
            target.from[key] = scope;
            target[key] = { command: v.command, ready: has(r.url) ? { url: r.url } : { command: r.command }, ready_timeout: v.ready_timeout ?? '30s' };
            continue;
        }
        if (key === 'dom') {
            const d = parseDom(value);
            if (typeof d === 'string')
                throw new UsageError(`${file}: dom ${d}`);
            target.from[key] = scope;
            target.dom = d;
            continue;
        }
        if (!ok)
            throw new UsageError(`${file}: ${key} must be ${want[spec.type] ?? `a ${spec.type}`}${key === 'matrix' ? `: ${checkMatrix(value)}` : ''}`);
        if (key === 'checks.not_proven' && value !== 'inconclusive' && value !== 'allow')
            throw new UsageError(`${file}: checks.not_proven must be inconclusive or allow`);
        if (key === 'agent_config')
            for (const [a, c] of Object.entries(value)) {
                if (c.effort && !EFFORT_FLAGS[a])
                    throw new UsageError(`${file}: agent_config.${a}.effort: ${a} has no reasoning-effort flag, so remove effort for it`);
                if (c.effort && !EFFORTS.includes(c.effort))
                    throw new UsageError(`${file}: agent_config.${a}.effort must be one of ${EFFORTS.join(', ')}, or '' for the CLI's own`);
                if (a === 'opencode' && c.model && !c.model.includes('/'))
                    throw new UsageError(`${file}: agent_config.opencode.model must be provider/model, e.g. ${CHEAP.opencode.model}`);
            }
        const t = target;
        const [a, b] = key.split('.');
        // A map key merges entry by entry (agent_config field by field), so each key path keeps the file that set it.
        if (MAPS.has(key)) {
            const into = b ? t[a][b] : t[a];
            for (const [k, v] of Object.entries(value)) {
                if (key === 'agent_config')
                    for (const f of Object.keys(v))
                        target.from[`${key}.${k}.${f}`] = scope;
                else
                    target.from[`${key}.${k}`] = scope;
                into[k] = key === 'agent_config' ? { ...into[k], ...v } : v;
            }
            continue;
        }
        target.from[key] = scope;
        if (b)
            t[a][b] = value;
        else
            t[a] = value;
    }
}
function readOptional(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return undefined;
        throw new UsageError(`${path}: ${e.message}`);
    }
}
// The built-in defaults, before any config file is read.
function defaultConfig(repo) {
    return {
        agent: '',
        agent_config: Object.fromEntries(Object.entries(CHEAP).map(([a, c]) => [a, { ...c }])),
        agent_args_override: {},
        agent_path_override: {},
        acpx_path: 'acpx',
        agent_timeout: AGENT_TIMEOUT,
        auto_fix: {},
        app: basename(repo),
        skill: '',
        journeys: {},
        instance: null,
        matrix: null,
        dom: null,
        evidence: { local_root: join(home(), 'evidence'), root: '', allow_dirty: false, ignore_paths: [] },
        checks: { not_proven: 'inconclusive', fix_title: '^(fix|bugfix|hotfix)\\b' },
        judge: { route: '', model: '', allow_same: false, claude_code: { config_dir: join(home(), 'claude') } },
        trusted: false,
        from: {},
    };
}
// Precedence: built-in defaults, then the global file, then the project file.
// `projectText` overrides reading <repo>/.done-done.yaml (used for --trusted-ref).
export function loadConfig(repo, projectText) {
    const cfg = { ...defaultConfig(repo), trusted: projectText != null };
    const globalFile = join(home(), 'config.yaml');
    apply(cfg, readOptional(globalFile), globalFile, 'global');
    const projectFile = join(repo, '.done-done.yaml');
    apply(cfg, projectText ?? readOptional(projectFile), projectFile, 'repo');
    cfg.skill ||= `.agents/skills/verify-${cfg.app}`;
    const local = tilde(cfg.evidence.local_root);
    cfg.acpx_path = tilde(cfg.acpx_path);
    for (const a of Object.keys(cfg.agent_path_override))
        cfg.agent_path_override[a] = tilde(cfg.agent_path_override[a]);
    cfg.judge.claude_code.config_dir = tilde(cfg.judge.claude_code.config_dir);
    // A relative root is under the repo (and dies with the checkout); an absolute one is used as-is.
    cfg.evidence.root = cfg.evidence.root ? resolve(repo, cfg.evidence.root) : join(local, cfg.app);
    return cfg;
}
// The commented global config `init` writes when there is none: every global key at its built-in default.
export function globalConfigText() {
    const short = (p) => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
    const agents = Object.entries(CHEAP).map(([a, c]) => `  ${a}:\n    model: ${c.model}\n${c.effort ? `    effort: ${c.effort}\n` : ''}`).join('');
    return `# done-done global config. \`done-done init\` writes it once; \`init --agent\` then sets agent and its model in place.
# A repo's .done-done.yaml may set agent (and the repo keys); every key here except agent is global-only.

# The coding agent done-done starts: one of ${AGENTS.join(', ')}, or acp:<target>. done-done never picks one: while none is set
# it asks you in a terminal, or stops with the command that sets it: done-done init --agent <agent> --model <model>.
# agent: opencode

# Model and reasoning effort per agent (effort: ${EFFORTS.join(', ')}; gemini and acp:<target> have no effort flag). These are the cheap defaults.
agent_config:
${agents}  # codex and pi have no cheap default: they run their own default model until you set one here, e.g.
  # codex:
  #   model: <model>
  #   effort: low

# Extra CLI flags per agent, added after done-done's own, e.g. claude: [--permission-mode, plan].
# A codex drive's commands write only the repo, the run's evidence and scratch folders, $TMPDIR and /tmp. A recipe tool that
# writes elsewhere needs your opt-in, and the drive's agent can then write there too. chrome-devtools-axi keeps its state in
# ~/.chrome-devtools-axi; install chrome-devtools-mcp to a fixed prefix and set CHROME_DEVTOOLS_AXI_MCP_PATH, so npx is not run:
#   codex: [--add-dir, ${homedir()}/.chrome-devtools-axi]
# Adding ${homedir()}/.npm instead lets npx run, but the agent can then change packages npx runs later outside the sandbox.
# Codex's commands cannot see your other processes, so a chrome-devtools-axi session you already use looks dead to them and the
# drive collides with it: have the recipe give each drive its own, export CHROME_DEVTOOLS_AXI_SESSION=done-done-$DONE_DONE_RUN_ID.
agent_args_override: {}

# A binary per agent instead of the one on PATH, e.g. claude: /opt/claude/bin/claude.
agent_path_override: {}

# The acpx bridge that starts acp:<target> agents: a name on PATH or an absolute path.
acpx_path: acpx

# How long one agent call (a reader, the judge, the doctor probe) may run: 90s, 30m or 1h.
agent_timeout: ${AGENT_TIMEOUT}

# How many times done-done's agent may fix a step's findings, per step (a repo's .done-done.yaml may set it too).
# 0 reports only. maintain: the agent edits only the verify skill, then maintain runs again; a clean end is one commit on
# a done-done/maintain-<run-id> branch, never on your branch.
auto_fix:
  maintain: 0
  verify: 0

# Evidence storage.
evidence:
  # Where evidence and receipts live, one folder per app, outside every checkout.
  local_root: ${short(join(home(), 'evidence'))}

# The judge: a fresh agent that says whether each screenshot shows the outcome. verify starts it by default (turn it
# off with --no-judge or judge.enabled: false in .done-done.yaml); check and receipt start it only with --judge.
# done-done never picks one: while none is set it asks you in a terminal, or stops with the command that sets it:
# done-done init --judge <agent> --judge-model <model>.
judge:
  # Which agent judges: claude-code (claude) or answerer:opencode. Never the agent and model that did the work.
  # route: answerer:opencode
  # The judge's model; empty means that agent's agent_config model.
  model: ""
  # Accept a judge that is the author's own agent and model in a fresh session.
  allow_same: false
  claude_code:
    # The claude-code judge's own Claude sign-in folder, never your ~/.claude.
    config_dir: ${short(join(home(), 'claude'))}
`;
}
