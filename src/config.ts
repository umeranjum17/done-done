import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';

export class UsageError extends Error {
  // The exact next command, when the error has one.
  constructor(message: string, readonly help?: string) {
    super(message);
  }
}

export type Config = {
  agent: 'auto' | string[]; // the author agent: auto, or the user's fallback list
  agent_config: Record<string, { model?: string }>;
  app: string;
  skill: string;
  journeys: Record<string, { command: string; timeout?: string }>;
  evidence: { local_root: string; root: string; allow_dirty: boolean; ignore_paths: string[] };
  checks: { not_proven: 'inconclusive' | 'allow'; fix_title: string };
  judge: { enabled: boolean; model: string; bin: string; config_dir: string; route: string; allow_same: boolean };
  trusted: boolean; // project file came from --trusted-ref
};

// The coding agents done-done can start, in the order `agent: auto` looks for them on PATH.
export const AGENTS = ['claude', 'codex', 'opencode', 'pi', 'gemini'];
// Or acp:<target>, any agent the user's acpx bridge can start; the target is one argv word, so it never reads as a flag.
const isAgent = (v: unknown) => AGENTS.includes(v as string) || (typeof v === 'string' && /^acp:[A-Za-z0-9][\w.-]*$/.test(v));
// The cost guard is this table: a default model is always the agent's cheap one, never a flagship,
// whatever the vendor; any other model runs only when the user names it. pi and gemini get theirs with their adapters.
export const CHEAP_MODELS: Record<string, string> = { claude: 'claude-haiku-5-5', opencode: 'opencode-go/muse-spark-1.3-contributor' };

// Where each key may be set. Global-only keys describe the machine; repo-only keys describe the project; `any` may be in either.
const KEYS: Record<string, { scope: 'global' | 'repo' | 'any'; type: 'string' | 'boolean' | 'string[]' | 'journeys' | 'agent' | 'agent_config' }> = {
  agent: { scope: 'any', type: 'agent' },
  agent_config: { scope: 'global', type: 'agent_config' },
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
  'judge.bin': { scope: 'global', type: 'string' },
  'judge.config_dir': { scope: 'global', type: 'string' },
  'judge.route': { scope: 'global', type: 'string' },
  'judge.allow_same': { scope: 'global', type: 'boolean' },
};
const SECTIONS = new Set(['evidence', 'checks', 'judge']);

export const home = () => process.env.DONE_DONE_HOME || join(homedir(), '.done-done');

// A duration such as 90s or 30m, in milliseconds; null when the text is not one or is not a delay a timer can run.
export const parseDuration = (text: string): number | null => {
  const m = /^(\d+)(s|m)$/.exec(text);
  const ms = m ? Number(m[1]) * (m[2] === 'm' ? 60_000 : 1000) : 0;
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

function apply(target: Record<string, any>, text: string | undefined, file: string, scope: 'global' | 'repo') {
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
      : spec.type === 'agent' ? value === 'auto' || [value].flat().every(isAgent) && [value].flat().length > 0
      : spec.type === 'agent_config' ? !!value && typeof value === 'object' && Object.entries(value).every(([a, c]) => isAgent(a) && !!c && typeof c === 'object' && Object.entries(c).every(([k, m]) => k === 'model' && typeof m === 'string'))
      : !!value && typeof value === 'object' && Object.values(value).every((j: any) => j && typeof j.command === 'string');
    const want = { journeys: 'a map of name: {command: <string>}', agent: `auto, or one or a list of ${AGENTS.join(', ')}, acp:<target>`, agent_config: `a map of <agent>: {model: <string>} for ${AGENTS.join(', ')}, acp:<target>` } as Record<string, string>;
    if (!ok) throw new UsageError(`${file}: ${key} must be ${want[spec.type] ?? `a ${spec.type}`}`);
    if (key === 'checks.not_proven' && value !== 'inconclusive' && value !== 'allow') throw new UsageError(`${file}: checks.not_proven must be inconclusive or allow`);
    const [a, b] = key.split('.');
    if (b) target[a][b] = value;
    else if (key === 'agent') target.agent = value === 'auto' ? 'auto' : [value].flat();
    else if (key === 'agent_config') target.agent_config = { ...target.agent_config, ...(value as object) };
    else target[a] = value;
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
    agent: 'auto',
    agent_config: {},
    app: basename(repo),
    skill: '',
    journeys: {},
    evidence: { local_root: join(home(), 'evidence'), root: '', allow_dirty: false, ignore_paths: [] },
    checks: { not_proven: 'inconclusive', fix_title: '^(fix|bugfix|hotfix)\\b' },
    judge: { enabled: false, model: CHEAP_MODELS.claude, bin: '', config_dir: join(home(), 'claude'), route: '', allow_same: false },
    trusted: false,
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
  const tilde = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
  const local = tilde(cfg.evidence.local_root);
  cfg.judge.bin = tilde(cfg.judge.bin);
  cfg.judge.config_dir = tilde(cfg.judge.config_dir);
  // A relative root is under the repo (and dies with the checkout); an absolute one is used as-is.
  cfg.evidence.root = cfg.evidence.root ? resolve(repo, cfg.evidence.root) : join(local, cfg.app);
  return cfg;
}
