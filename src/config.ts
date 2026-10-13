import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';

export class UsageError extends Error {
  // The exact next command, when the error has one.
  constructor(message: string, readonly help?: string) {
    super(message);
  }
}

export type Config = {
  agent: string; // the agent done-done starts, set by the user; '' until they do
  agent_config: Record<string, { model?: string; effort?: string }>;
  agent_args_override: Record<string, string[]>; // extra CLI flags, after done-done's own
  agent_path_override: Record<string, string>; // a binary per agent instead of the one on PATH
  acpx_path: string; // the acpx bridge for acp:<target> agents
  agent_timeout: string; // how long one agent call may run, e.g. 30m
  app: string;
  skill: string;
  journeys: Record<string, { command: string; timeout?: string }>;
  evidence: { local_root: string; root: string; allow_dirty: boolean; ignore_paths: string[] };
  checks: { not_proven: 'inconclusive' | 'allow'; fix_title: string };
  // route: auto, claude-code, answerer:<agent> or openai:key; model: '' for the route's cheap default; claude_code: that route's own config.
  judge: { enabled: boolean; route: string; model: string; allow_same: boolean; claude_code: { config_dir: string } };
  trusted: boolean; // project file came from --trusted-ref
  from: Record<string, 'global' | 'repo'>; // the file that set each key path; a key path not here is the built-in default
};

// The coding agents a user can set as agent.
export const AGENTS = ['claude', 'codex', 'opencode', 'pi', 'gemini'];
// The agents whose CLI can read an attached image with every tool off, so they judge through the answerer route;
// claude judges through claude-code. codex has no adapter yet, and an acp:<target> agent cannot be sent an image.
export const ANSWERER_JUDGES = ['opencode', 'pi', 'gemini'];
// BYOKit key routes: a judge on the user's own API key, read from this environment variable, with no agent CLI.
export const KEY_ROUTES: Record<string, string> = { 'openai:key': 'OPENAI_API_KEY' };
// Or acp:<target>, any agent the user's acpx bridge can start; the target is one argv word, so it never reads as a flag.
export const isAgent = (v: unknown) => AGENTS.includes(v as string) || (typeof v === 'string' && /^acp:[A-Za-z0-9][\w.-]*$/.test(v));
// The cost guard is this table: a default model for an agent here is always its cheap one, never a flagship,
// whatever the vendor; any other model runs only when the user names it. gemini's is the CLI's own
// `flash-lite` alias (its cli-reference.md: the fastest model for simple tasks). pi and acp:<target> have no public
// cheap alias, so they run their own configured default model, and agent_config.<agent>.model caps their cost.
export const CHEAP: Record<string, { model: string; effort?: string }> = {
  claude: { model: 'claude-haiku-5-5', effort: 'low' },
  opencode: { model: 'opencode-go/muse-spark-1.3-contributor', effort: 'low' },
  gemini: { model: 'flash-lite' },
};
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Each CLI's own reasoning-effort flag; an agent not here has none, so agent_config.<agent>.effort is refused for it.
export const EFFORT_FLAGS: Record<string, (level: string) => string[]> = {
  claude: (l) => ['--effort', l],
  codex: (l) => ['-c', `model_reasoning_effort="${l}"`],
  opencode: (l) => ['--variant', l],
  pi: (l) => ['--thinking', l],
};
const AGENT_TIMEOUT = '30m';

// Where each key may be set. Global-only keys describe the machine; repo-only keys describe the project; `any` may be in either.
const KEYS: Record<string, { scope: 'global' | 'repo' | 'any'; type: 'string' | 'boolean' | 'string[]' | 'journeys' | 'agent' | 'agent_config' | 'route' | 'claude_code' | 'args' | 'paths' | 'bin' | 'duration' }> = {
  agent: { scope: 'any', type: 'agent' },
  agent_config: { scope: 'global', type: 'agent_config' },
  agent_args_override: { scope: 'global', type: 'args' },
  agent_path_override: { scope: 'global', type: 'paths' },
  acpx_path: { scope: 'global', type: 'bin' },
  agent_timeout: { scope: 'global', type: 'duration' },
  'evidence.local_root': { scope: 'global', type: 'string' },
  app: { scope: 'repo', type: 'string' },
  skill: { scope: 'repo', type: 'string' },
  journeys: { scope: 'repo', type: 'journeys' },
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
const MAPS = new Set(['agent_config', 'agent_args_override', 'agent_path_override', 'judge.claude_code']);

export const home = () => process.env.DONE_DONE_HOME || join(homedir(), '.done-done');

// A duration such as 90s, 30m or 1h, in milliseconds; null when the text is not one or is not a delay a timer can run.
export const parseDuration = (text: string): number | null => {
  const m = /^(\d+)(s|m|h)$/.exec(text);
  const ms = m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'] : 0;
  return ms > 0 && ms <= 2_147_483_647 ? ms : null;
};

function flatten(doc: unknown, file: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (doc == null) return out;
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new UsageError(`${file}: top level must be a mapping`);
  for (const [k, v] of Object.entries(doc)) {
    if (SECTIONS.has(k)) {
      if (v == null) continue;
      if (typeof v !== 'object' || Array.isArray(v)) throw new UsageError(`${file}: ${k} must be a mapping`);
      for (const [k2, v2] of Object.entries(v)) out.set(`${k}.${k2}`, v2);
    } else out.set(k, v);
  }
  return out;
}

// A binary: a bare name looked up on PATH, or an absolute path (~ is the home folder).
const isBin = (v: unknown) => typeof v === 'string' && (/^[\w.-]+$/.test(v) || isAbsolute(tilde(v)));
const tilde = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function apply(target: Config, text: string | undefined, file: string, scope: 'global' | 'repo') {
  if (text === undefined) return;
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new UsageError(`${file}: ${(e as Error).message.split('\n')[0]}`);
  }
  for (const [key, value] of flatten(doc, file)) {
    const spec = KEYS[key];
    if (!spec) throw new UsageError(`${file}: unknown key ${key}`);
    if (spec.scope !== scope && spec.scope !== 'any') throw new UsageError(`${file}: ${key} may only be set in the ${spec.scope === 'global' ? 'global config' : 'project .done-done.yaml'}`);
    const ok =
      spec.type === 'string' ? typeof value === 'string'
      : spec.type === 'boolean' ? typeof value === 'boolean'
      : spec.type === 'string[]' ? Array.isArray(value) && value.every((v) => typeof v === 'string')
      : spec.type === 'agent' ? isAgent(value)
      : spec.type === 'route' ? typeof value === 'string' && (['', 'auto', 'claude-code'].includes(value) || Object.hasOwn(KEY_ROUTES, value) || ANSWERER_JUDGES.some((a) => value === `answerer:${a}`))
      : spec.type === 'claude_code' ? isMap(value) && Object.entries(value).every(([k, v]) => k === 'config_dir' && typeof v === 'string')
      : spec.type === 'agent_config' ? isMap(value) && Object.entries(value).every(([a, c]) => isAgent(a) && isMap(c) && Object.entries(c).every(([k, m]) => ['model', 'effort'].includes(k) && typeof m === 'string'))
      : spec.type === 'args' ? isMap(value) && Object.entries(value).every(([a, v]) => AGENTS.includes(a) && Array.isArray(v) && v.every((x) => typeof x === 'string'))
      : spec.type === 'paths' ? isMap(value) && Object.entries(value).every(([a, v]) => AGENTS.includes(a) && isBin(v))
      : spec.type === 'bin' ? isBin(value)
      : spec.type === 'duration' ? typeof value === 'string' && parseDuration(value) !== null
      : isMap(value) && Object.values(value).every((j: any) => j && typeof j.command === 'string');
    const want = {
      journeys: 'a map of name: {command: <string>}',
      agent: `one of ${AGENTS.join(', ')}, or acp:<target>`,
      agent_config: `a map of <agent>: {model: <string>, effort: <string>} for ${AGENTS.join(', ')}, acp:<target>`,
      args: `a map of <agent>: [<flag>, ...] for ${AGENTS.join(', ')}`,
      paths: `a map of <agent>: <binary name or absolute path> for ${AGENTS.join(', ')}`,
      bin: 'a binary name on PATH or an absolute path',
      duration: 'a duration such as 90s, 30m or 1h',
      route: `auto, claude-code (for claude), answerer:<agent> for one of ${ANSWERER_JUDGES.join(', ')}, or a key route (${Object.keys(KEY_ROUTES).join(', ')}); codex cannot judge yet (done-done cannot start it), nor can an acp:<target> agent (done-done cannot send it an image)`,
      claude_code: 'a map with config_dir, a string (the claude binary is agent_path_override.claude)',
    } as Record<string, string>;
    if (key === 'agent' && value === '') throw new UsageError(`${file}: agent must not be empty; to leave it unset, remove the key`);
    if (!ok) throw new UsageError(`${file}: ${key} must be ${want[spec.type] ?? `a ${spec.type}`}`);
    if (key === 'checks.not_proven' && value !== 'inconclusive' && value !== 'allow') throw new UsageError(`${file}: checks.not_proven must be inconclusive or allow`);
    if (key === 'agent_config')
      for (const [a, c] of Object.entries(value as Record<string, { model?: string; effort?: string }>)) {
        if (c.effort && !EFFORT_FLAGS[a]) throw new UsageError(`${file}: agent_config.${a}.effort: ${a} has no reasoning-effort flag, so remove effort for it`);
        if (c.effort && !EFFORTS.includes(c.effort)) throw new UsageError(`${file}: agent_config.${a}.effort must be one of ${EFFORTS.join(', ')}, or '' for the CLI's own`);
        if (a === 'opencode' && c.model && !c.model.includes('/')) throw new UsageError(`${file}: agent_config.opencode.model must be provider/model, e.g. ${CHEAP.opencode.model}`);
      }
    const t = target as Record<string, any>;
    const [a, b] = key.split('.');
    // A map key merges entry by entry (agent_config field by field), so each key path keeps the file that set it.
    if (MAPS.has(key)) {
      const into = b ? t[a][b] : t[a];
      for (const [k, v] of Object.entries(value as object)) {
        if (key === 'agent_config') for (const f of Object.keys(v)) target.from[`${key}.${k}.${f}`] = scope;
        else target.from[`${key}.${k}`] = scope;
        into[k] = key === 'agent_config' ? { ...into[k], ...v } : v;
      }
      continue;
    }
    target.from[key] = scope;
    if (b) t[a][b] = value;
    else t[a] = value;
  }
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new UsageError(`${path}: ${(e as Error).message}`);
  }
}

// The built-in defaults, before any config file is read.
function defaultConfig(repo: string): Config {
  return {
    agent: '',
    agent_config: Object.fromEntries(Object.entries(CHEAP).map(([a, c]) => [a, { ...c }])),
    agent_args_override: {},
    agent_path_override: {},
    acpx_path: 'acpx',
    agent_timeout: AGENT_TIMEOUT,
    app: basename(repo),
    skill: '',
    journeys: {},
    evidence: { local_root: join(home(), 'evidence'), root: '', allow_dirty: false, ignore_paths: [] },
    checks: { not_proven: 'inconclusive', fix_title: '^(fix|bugfix|hotfix)\\b' },
    judge: { enabled: false, route: 'auto', model: '', allow_same: false, claude_code: { config_dir: join(home(), 'claude') } },
    trusted: false,
    from: {},
  };
}

// Precedence: built-in defaults, then the global file, then the project file.
// `projectText` overrides reading <repo>/.done-done.yaml (used for --trusted-ref).
export function loadConfig(repo: string, projectText?: string | null): Config {
  const cfg = { ...defaultConfig(repo), trusted: projectText != null };
  const globalFile = join(home(), 'config.yaml');
  apply(cfg, readOptional(globalFile), globalFile, 'global');
  const projectFile = join(repo, '.done-done.yaml');
  apply(cfg, projectText ?? readOptional(projectFile), projectFile, 'repo');
  cfg.skill ||= `.agents/skills/verify-${cfg.app}`;
  cfg.judge.route ||= 'auto';
  const local = tilde(cfg.evidence.local_root);
  cfg.acpx_path = tilde(cfg.acpx_path);
  for (const a of Object.keys(cfg.agent_path_override)) cfg.agent_path_override[a] = tilde(cfg.agent_path_override[a]);
  cfg.judge.claude_code.config_dir = tilde(cfg.judge.claude_code.config_dir);
  // A relative root is under the repo (and dies with the checkout); an absolute one is used as-is.
  cfg.evidence.root = cfg.evidence.root ? resolve(repo, cfg.evidence.root) : join(local, cfg.app);
  return cfg;
}

// The commented global config `init` writes when there is none: every global key at its built-in default.
export function globalConfigText(): string {
  const short = (p: string) => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
  const agents = Object.entries(CHEAP).map(([a, c]) => `  ${a}:\n    model: ${c.model}\n${c.effort ? `    effort: ${c.effort}\n` : ''}`).join('');
  return `# done-done global config. \`done-done init\` writes it once; \`init --agent\` then sets agent and its model in place.
# A repo's .done-done.yaml may set agent (and the repo keys); every key here except agent is global-only.

# The coding agent done-done starts: one of ${AGENTS.join(', ')}, or acp:<target>. done-done never picks one: while none is set
# it asks you in a terminal, or stops with the command that sets it: done-done init --agent <agent> --model <model>.
# agent: opencode

# Model and reasoning effort per agent (effort: ${EFFORTS.join(', ')}; gemini and acp:<target> have no effort flag). These are the cheap defaults.
agent_config:
${agents}
# Extra CLI flags per agent, added after done-done's own, e.g. claude: [--permission-mode, plan].
agent_args_override: {}

# A binary per agent instead of the one on PATH, e.g. claude: /opt/claude/bin/claude.
agent_path_override: {}

# The acpx bridge that starts acp:<target> agents: a name on PATH or an absolute path.
acpx_path: acpx

# How long one agent call (a reader, the judge, the doctor probe) may run: 90s, 30m or 1h.
agent_timeout: ${AGENT_TIMEOUT}

# Evidence storage.
evidence:
  # Where evidence and receipts live, one folder per app, outside every checkout.
  local_root: ${short(join(home(), 'evidence'))}

# The judge that says whether each screenshot shows the outcome (on with --judge or judge.enabled in .done-done.yaml).
judge:
  # Which agent judges captures: auto (an installed agent that is not the author), claude-code, or answerer:opencode.
  route: auto
  # The judge's model with an explicit route; empty means that agent's agent_config model (its cheap one if it is the author's agent).
  model: ""
  # Accept a judge that is the author's own agent and model in a fresh session.
  allow_same: false
  claude_code:
    # The claude-code judge's own Claude sign-in folder, never your ~/.claude.
    config_dir: ${short(join(home(), 'claude'))}
`;
}
