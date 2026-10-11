#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Config, home, loadConfig, UsageError } from './config.js';
import { checkMedia } from './media.js';

const PASS = 0, FAIL = 1, USAGE = 2, INCONCLUSIVE = 3;

const USAGE_TEXT = `usage:
  done-done init                                write a minimal .done-done.yaml and ignore the evidence root
  done-done run [<journey>] [-- <command...>]   run a journey (or command) and record the evidence it writes
  done-done run --open [<journey>]              open a run for a hand- or agent-driven proof; prints its id
  done-done run --close <run-id>                seal an open run
  done-done check --outcome "<claim>" <files...> [--trusted-ref <ref>]
  done-done check --from <file | PR URL> [--trusted-ref <ref>]
exit codes: 0 pass, 1 fail, 2 usage or config error, 3 inconclusive`;

type RunRecord = {
  schema: 1;
  run_id: string;
  journey: string | null;
  command: string | null;
  commit: string;
  tree: string;
  dirty: boolean;
  started_at: string;
  ended_at: string | null;
  exit: number | null;
  files: { path: string; sha256: string; bytes: number }[];
  before?: Record<string, string>;
};

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function repoRoot(): string {
  try {
    return git(process.cwd(), 'rev-parse', '--show-toplevel');
  } catch {
    throw new UsageError('not inside a git repository');
  }
}

function head(repo: string) {
  return {
    commit: git(repo, 'rev-parse', 'HEAD'),
    tree: git(repo, 'rev-parse', 'HEAD^{tree}'),
    dirty: git(repo, 'status', '--porcelain', '--untracked-files=no') !== '',
  };
}

const recordsDir = (cfg: Config) => join(cfg.evidence.root, '.done-done', 'runs');

// Every file under the evidence root (except done-done's own records), keyed by path, valued by mtime+size.
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const rel = relative(root, path);
    if (rel.startsWith('.done-done')) continue;
    const s = statSync(path);
    out[rel] = `${s.mtimeMs}:${s.size}`;
  }
  return out;
}

function writeRecord(cfg: Config, rec: RunRecord) {
  const path = join(recordsDir(cfg), `${rec.run_id}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return path;
}

function openRun(repo: string, cfg: Config, journey: string | null, command: string | null): RunRecord {
  const h = head(repo);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  mkdirSync(cfg.evidence.root, { recursive: true });
  return {
    schema: 1, run_id: `${stamp}-${h.commit.slice(0, 8)}`, journey, command, ...h,
    started_at: new Date().toISOString(), ended_at: null, exit: null, files: [], before: snapshot(cfg.evidence.root),
  };
}

function closeRun(repo: string, cfg: Config, rec: RunRecord): number {
  const now = head(repo);
  const after = snapshot(cfg.evidence.root);
  const before = rec.before ?? {};
  delete rec.before;
  rec.files = Object.keys(after)
    .filter((p) => before[p] !== after[p])
    .sort()
    .map((p) => {
      const b = readFileSync(join(cfg.evidence.root, p));
      return { path: p, sha256: sha256(b), bytes: b.length };
    });
  rec.ended_at = new Date().toISOString();
  const path = writeRecord(cfg, rec);
  console.log(`run: ${rec.run_id}\nrecord: ${path}\ncommit: ${rec.commit}${rec.dirty ? ' (dirty)' : ''}\nfiles: ${rec.files.length}`);
  for (const f of rec.files) console.log(`  ${join(cfg.evidence.root, f.path)}`);
  if (now.commit !== rec.commit) return fail(`HEAD moved from ${rec.commit} to ${now.commit} during the run; evidence is not tied to one commit`);
  if (rec.exit !== null && rec.exit !== 0) return fail(`the run command exited ${rec.exit}`);
  if (!rec.files.length) return fail(`the run wrote no files under ${cfg.evidence.root}`);
  console.log('result: PASS');
  return PASS;
}

function fail(why: string) {
  console.log(`result: FAIL: ${why}`);
  return FAIL;
}

function cmdRun(argv: string[]): number {
  const dash = argv.indexOf('--');
  const { values, positionals } = parseArgs({
    args: dash < 0 ? argv : argv.slice(0, dash),
    options: { open: { type: 'boolean' }, close: { type: 'string' } },
    allowPositionals: true,
  });
  const repo = repoRoot();
  const cfg = loadConfig(repo);
  if (values.close) {
    const path = join(recordsDir(cfg), `${values.close}.json`);
    if (!existsSync(path)) throw new UsageError(`no open run ${values.close} (looked for ${path})`);
    const rec: RunRecord = JSON.parse(readFileSync(path, 'utf8'));
    if (rec.ended_at) throw new UsageError(`run ${values.close} is already closed`);
    return closeRun(repo, cfg, rec);
  }
  const journey = positionals[0] ?? null;
  if (positionals.length > 1) throw new UsageError('run takes at most one journey name');
  let command = dash < 0 ? null : argv.slice(dash + 1).join(' ');
  if (journey && !command) {
    const j = cfg.journeys[journey];
    if (!j) throw new UsageError(`unknown journey ${journey}; .done-done.yaml defines: ${Object.keys(cfg.journeys).join(', ') || 'none'}`);
    command = j.command;
  }
  const rec = openRun(repo, cfg, journey, command);
  if (values.open) {
    if (command) throw new UsageError('--open takes no command; drive the proof, then run --close');
    writeRecord(cfg, rec);
    console.log(`run: ${rec.run_id}\nevidence_root: ${cfg.evidence.root}\nclose with: done-done run --close ${rec.run_id}`);
    return PASS;
  }
  if (!command) throw new UsageError('run needs a journey, a command after --, or --open');
  const expanded = command.replaceAll('${RUN_ID}', rec.run_id);
  rec.command = expanded;
  const r = spawnSync(expanded, {
    cwd: repo, shell: true, stdio: 'inherit',
    env: { ...process.env, DONE_DONE_RUN_ID: rec.run_id, DONE_DONE_EVIDENCE_ROOT: cfg.evidence.root },
  });
  rec.exit = r.status ?? 1;
  return closeRun(repo, cfg, rec);
}

type Claim = { outcome: string; files: string[]; title: string; notProven?: string };
type Finding = { level: 'fail' | 'inconclusive'; why: string };

// The newest "## Checks" block: outcome, repro, proof and evidence lines.
function claimFromChecks(body: string, title: string, repo: string, cfg: Config, out: Finding[]): Claim | undefined {
  const blocks = [...body.matchAll(/^##\s*Checks\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/gm)];
  if (!blocks.length) return void out.push({ level: 'fail', why: 'no "## Checks" block' });
  const text = blocks[blocks.length - 1][1].replace(/^\s*```.*$/gm, '');
  const f: Record<string, string> = {};
  for (const m of text.matchAll(/^\s*(outcome|repro|proof|evidence)\s*:\s*(.*)$/gm)) f[m[1]] = m[2].trim();
  const missing = ['outcome', 'repro', 'proof', 'evidence'].filter((k) => !f[k]);
  if (missing.length) return void out.push({ level: 'fail', why: `Checks block is missing ${missing.join(', ')}` });
  if (!/[/`]|\.\w+\b|\b(npm|pnpm|yarn|npx|node|bash|sh|python3?|cargo|go|gradle|make|adb|xcrun|done-done)\b/.test(f.proof))
    out.push({ level: 'fail', why: 'proof names no command or path' });
  const skill = cfg.skill.split('/').pop()!;
  if (existsSync(join(repo, cfg.skill))) {
    if (!f.proof.includes(skill)) out.push({ level: 'fail', why: `proof does not name the project's verify skill ${skill}` });
  } else if (!/verify-|no verify skill/i.test(f.proof)) out.push({ level: 'fail', why: 'proof names no verify skill and does not say "no verify skill"' });
  if (/^n\/?a\b/i.test(f.repro) && new RegExp(cfg.checks.fix_title, 'i').test(title)) out.push({ level: 'fail', why: 'a fix needs a repro, not n/a' });
  const np = f.evidence.match(/^not proven\s*:?\s*(.*)$/i);
  if (np) return { outcome: f.outcome, files: [], title, notProven: np[1] || 'no cause given' };
  const files = f.evidence.split(/[\s,]+/).map((t) => t.replace(/^[`'"(]+|[`'"),.;]+$/g, '')).filter((t) => /\.\w{1,10}$/.test(t));
  if (!files.length) out.push({ level: 'fail', why: 'evidence names no files' });
  return { outcome: f.outcome, files, title };
}

function readSource(from: string): { body: string; title: string } {
  if (/^https?:\/\//.test(from)) {
    const r = spawnSync('gh', ['pr', 'view', from, '--json', 'body,title'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new UsageError(`gh pr view ${from} failed: ${(r.error?.message || r.stderr).trim()}`);
    return JSON.parse(r.stdout);
  }
  try {
    return { body: readFileSync(from, 'utf8'), title: '' };
  } catch (e) {
    throw new UsageError(`cannot read ${from}: ${(e as Error).message}`);
  }
}

function loadRecords(cfg: Config): RunRecord[] {
  const dir = recordsDir(cfg);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as RunRecord).filter((r) => r.ended_at);
}

function cmdCheck(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { outcome: { type: 'string' }, from: { type: 'string' }, 'trusted-ref': { type: 'string' } },
    allowPositionals: true,
  });
  if (!!values.outcome === !!values.from) throw new UsageError('check needs exactly one of --outcome or --from');
  if (values.from && positionals.length) throw new UsageError('--from takes no file arguments; the Checks block names them');
  const repo = repoRoot();
  let projectText: string | null = null;
  if (values['trusted-ref']) {
    try {
      projectText = git(repo, 'show', `${values['trusted-ref']}:.done-done.yaml`);
    } catch (e) {
      const msg = (e as { stderr?: string }).stderr ?? '';
      if (!/does not exist|exists on disk, but not in/.test(msg)) throw new UsageError(`cannot read .done-done.yaml at ${values['trusted-ref']}: ${msg.trim()}`);
      projectText = '';
    }
  }
  const cfg = loadConfig(repo, projectText);
  const findings: Finding[] = [];
  let claim: Claim | undefined;
  if (values.outcome) {
    if (!positionals.length) throw new UsageError('--outcome needs at least one evidence file');
    claim = { outcome: values.outcome, files: positionals, title: '' };
  } else {
    const src = readSource(values.from!);
    claim = claimFromChecks(src.body, src.title, repo, cfg, findings);
  }
  if (claim?.notProven) {
    const allowed = cfg.checks.not_proven === 'allow' && cfg.trusted;
    return report(findings.concat(allowed ? [] : [{ level: 'inconclusive', why: `not proven: ${claim.notProven}` }]), 0, allowed ? 'not proven (allowed by trusted config)' : '');
  }
  const files = claim?.files ?? [];
  const now = head(repo);
  const records = loadRecords(cfg);
  const seen = new Map<string, string>();
  const hashes: string[] = [];
  for (const name of files) {
    const path = resolve(name);
    let bytes: Buffer;
    try {
      if (!statSync(path).isFile()) throw new Error('not a regular file');
      bytes = readFileSync(path);
    } catch (e) {
      findings.push({ level: 'fail', why: `${name}: missing (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` });
      continue;
    }
    const v = checkMedia(path, bytes);
    if (v.status !== 'ok') findings.push({ level: v.status === 'fail' ? 'fail' : 'inconclusive', why: `${name}: ${v.why}` });
    const hash = sha256(bytes);
    hashes.push(hash);
    if (seen.has(hash)) findings.push({ level: 'fail', why: `${name}: byte-identical to ${seen.get(hash)}` });
    seen.set(hash, name);
    if (v.status === 'fail') continue;
    const rec = records.filter((r) => r.files.some((f) => f.sha256 === hash)).sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    if (!rec) {
      findings.push({ level: 'inconclusive', why: `${name}: not in any done-done run record, so it is not tied to a commit` });
      continue;
    }
    const stale = staleness(repo, cfg, rec.commit, now.commit);
    if (stale) findings.push({ level: 'fail', why: `${name}: ${stale} (run ${rec.run_id})` });
    if (rec.dirty && !cfg.evidence.allow_dirty) findings.push({ level: 'fail', why: `${name}: captured from a tree with uncommitted changes (run ${rec.run_id})` });
    if (rec.exit !== null && rec.exit !== 0) findings.push({ level: 'fail', why: `${name}: its run command exited ${rec.exit} (run ${rec.run_id})` });
  }
  // Reuse: fail only when every cited file was already used for a different claim in this repo.
  const ledger = join(home(), 'hashes');
  const key = `${sha256(Buffer.from(repo)).slice(0, 12)}:${sha256(Buffer.from(claim?.outcome ?? '')).slice(0, 12)}`;
  const used = new Map<string, Set<string>>();
  if (existsSync(ledger))
    for (const line of readFileSync(ledger, 'utf8').split('\n')) {
      const [h, k] = line.split(' ');
      if (h && k) used.set(h, (used.get(h) ?? new Set()).add(k));
    }
  const reusedElsewhere = (h: string) => [...(used.get(h) ?? [])].some((k) => k !== key && k.startsWith(key.split(':')[0]));
  if (hashes.length && hashes.every(reusedElsewhere)) findings.push({ level: 'fail', why: 'every evidence file was already used as proof of a different claim' });
  const code = report(findings, files.length);
  if (code === PASS) {
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, hashes.filter((h) => !used.get(h)?.has(key)).map((h) => `${h} ${key}\n`).join(''));
  }
  return code;
}

// Why evidence from `from` no longer proves `to`, or '' if it still does.
function staleness(repo: string, cfg: Config, from: string, to: string): string {
  if (from === to) return '';
  let changed: string[];
  try {
    changed = git(repo, 'diff', '--name-only', from, to).split('\n').filter(Boolean);
  } catch {
    return `evidence is for commit ${from.slice(0, 12)}, which is not in this repository`;
  }
  const outside = changed.filter((p) => !cfg.evidence.ignore_paths.some((g) => matchesGlob(p, g)));
  if (changed.length && !outside.length) return '';
  return `evidence is for commit ${from.slice(0, 12)}, HEAD is ${to.slice(0, 12)}${outside.length ? ` (changed: ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', ...' : ''})` : ''}`;
}

function report(findings: Finding[], files: number, note = ''): number {
  for (const f of findings) console.log(`${f.level}: ${f.why}`);
  if (findings.some((f) => f.level === 'fail')) {
    console.log('result: FAIL');
    return FAIL;
  }
  if (findings.length) {
    console.log('result: INCONCLUSIVE');
    return INCONCLUSIVE;
  }
  console.log(`result: PASS (${note || `${files} evidence file${files === 1 ? '' : 's'}`})`);
  return PASS;
}

const INIT_EVIDENCE_ROOT = '.proof';

// Append `<rel>/` to .gitignore unless git already ignores it. Never rewrites existing bytes.
function ensureIgnored(repo: string, rel: string): boolean {
  const entry = `${rel.replace(/\/+$/, '')}/`;
  if (spawnSync('git', ['check-ignore', '--no-index', '-q', '--', entry], { cwd: repo }).status === 0) return false;
  const file = join(repo, '.gitignore');
  if (!existsSync(file)) {
    writeFileSync(file, `${entry}\n`);
    return true;
  }
  const text = readFileSync(file, 'utf8');
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`);
  return true;
}

function cmdInit(argv: string[]): number {
  parseArgs({ args: argv, options: {}, allowPositionals: false });
  const repo = repoRoot();
  const file = join(repo, '.done-done.yaml');
  const existed = existsSync(file);
  const cfg = loadConfig(repo); // validates the existing project config; malformed -> exit 2, no writes
  let rel: string;
  if (existed) {
    const r = relative(repo, cfg.evidence.root);
    rel = r && !r.startsWith('..') ? r : '';
    console.log('init: .done-done.yaml already exists; left unchanged');
  } else {
    const app = basename(repo);
    const body = `# done-done project config. \`done-done init\` never overwrites this file.\napp: ${JSON.stringify(app)}\nevidence:\n  root: ${INIT_EVIDENCE_ROOT}\n`;
    writeFileSync(`${file}.tmp`, body);
    renameSync(`${file}.tmp`, file);
    rel = INIT_EVIDENCE_ROOT;
    console.log(`init: wrote .done-done.yaml (app: ${app})`);
  }
  if (rel && ensureIgnored(repo, rel)) console.log(`init: added ${rel.replace(/\/+$/, '')}/ to .gitignore`);
  console.log('next: add a journey to .done-done.yaml, then `done-done run <journey>`');
  return PASS;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'init') return cmdInit(rest);
    if (cmd === 'run') return cmdRun(rest);
    if (cmd === 'check') return cmdCheck(rest);
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
      console.log(USAGE_TEXT);
      return PASS;
    }
    throw new UsageError(cmd ? `unknown command ${cmd}` : 'no command given');
  } catch (e) {
    const usage = e instanceof UsageError || !!(e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    const msg = ((e as { stderr?: string }).stderr || (e as Error).message || String(e)).trim();
    console.log(`error: ${msg}${usage ? `\n${USAGE_TEXT}` : ''}`);
    return USAGE;
  }
}

process.exitCode = main(process.argv.slice(2));
