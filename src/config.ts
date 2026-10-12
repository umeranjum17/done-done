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
  app: string;
  skill: string;
  journeys: Record<string, { command: string; timeout?: string }>;
  evidence: { local_root: string; root: string; allow_dirty: boolean; ignore_paths: string[] };
  checks: { not_proven: 'inconclusive' | 'allow'; fix_title: string };
  judge: { enabled: boolean; model: string; bin: string; config_dir: string };
  trusted: boolean; // project file came from --trusted-ref
};

// Where each key may be set. Global-only keys describe the machine; repo-only keys describe the project.
const KEYS: Record<string, { scope: 'global' | 'repo'; type: 'string' | 'boolean' | 'string[]' | 'journeys' }> = {
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
};
const SECTIONS = new Set(['evidence', 'checks', 'judge']);

// The judge default stays cheap: Haiku reads images (Anthropic vision docs list
// text-and-image input for Haiku, and the Bedrock model card marks image input
// supported), and the judge runs through the user's own `claude` binary, which
// only accepts Claude model ids — so an opencode model id can never be the default here.
// Users may still set any model they like via judge.model.
export const DEFAULT_JUDGE_MODEL = 'claude-haiku-5-5';
// Flagship models must never become a default again; the cheap-default test guards this.
export const FLAGSHIP_MODEL_PATTERN = /opus|sonnet/i;

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
    if (spec.scope !== scope) throw new UsageError(`${file}: ${key} may only be set in the ${spec.scope === 'global' ? 'global config' : 'project .done-done.yaml'}`);
    const ok =
      spec.type === 'string' ? typeof value === 'string'
      : spec.type === 'boolean' ? typeof value === 'boolean'
      : spec.type === 'string[]' ? Array.isArray(value) && value.every((v) => typeof v === 'string')
      : !!value && typeof value === 'object' && Object.values(value).every((j: any) => j && typeof j.command === 'string');
    if (!ok) throw new UsageError(`${file}: ${key} must be ${spec.type === 'journeys' ? 'a map of name: {command: <string>}' : `a ${spec.type}`}`);
    if (key === 'checks.not_proven' && value !== 'inconclusive' && value !== 'allow') throw new UsageError(`${file}: checks.not_proven must be inconclusive or allow`);
    const [a, b] = key.split('.');
    if (b) target[a][b] = value;
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

// Precedence: built-in defaults, then the global file, then the project file.
// `projectText` overrides reading <repo>/.done-done.yaml (used for --trusted-ref).
export function loadConfig(repo: string, projectText?: string | null): Config {
  const cfg: Config = {
    app: basename(repo),
    skill: '',
    journeys: {},
    evidence: { local_root: join(home(), 'evidence'), root: '', allow_dirty: false, ignore_paths: [] },
    checks: { not_proven: 'inconclusive', fix_title: '^(fix|bugfix|hotfix)\\b' },
    judge: { enabled: false, model: DEFAULT_JUDGE_MODEL, bin: '', config_dir: join(home(), 'claude') },
    trusted: projectText != null,
  };
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
