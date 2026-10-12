#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { encode } from '@toon-format/toon';
import { type Config, home, loadConfig, UsageError } from './config.js';
import { type Capture, judge, type Judged } from './judge.js';
import { checkMedia } from './media.js';

const PASS = 0, FAIL = 1, USAGE = 2, INCONCLUSIVE = 3;

const USAGE_TEXT = `usage:
  done-done                                     show this repo's config state and the next step
  done-done init                                write a minimal .done-done.yaml and ignore the evidence root
  done-done run [<journey>] [-- <command...>]   run a journey (or command) and record the evidence it writes
  done-done run --open [<journey>]              open a run for a hand- or agent-driven proof; prints its id
  done-done run --close <run-id>                seal an open run
  done-done check --outcome "<claim>" <files...> [--trusted-ref <ref>] [--judge]
  done-done check --from <file | - | PR URL> [--trusted-ref <ref>] [--judge]
  done-done receipt --outcome "<claim>" <files...> [--judge]   record a passing check for HEAD
  done-done receipt --from <file | - | PR URL> [--judge]       record from a claim's Checks block
  done-done receipt --verify <head>                  read-only: verify a recorded receipt
global flags: --json (JSON instead of TOON), --full (do not truncate lists)
--judge (or judge.enabled: true): a model on your Claude plan, through BYOKit, says whether each PNG/JPEG
  capture shows the outcome; a wrong screen fails, an unsure answer is inconclusive. Off by default.
exit codes: 0 pass, 1 fail, 2 usage or config error, 3 inconclusive

Results are printed as one TOON document (the AXI convention); pass --json for JSON.`;

// How many list rows a compact result shows before it reports the rest as omitted.
const COMPACT_LIST = 5;

type OutputMode = 'toon' | 'json';
let OUT: OutputMode = 'toon';
let FULL = false;

// One machine-readable result on stdout: TOON by default (the AXI convention), JSON with --json.
function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${OUT === 'json' ? JSON.stringify(value, null, 2) : encode(value)}\n`);
}

// Compact results cap long lists; --full returns every row.
function cap<T>(items: T[]): { items: T[]; omitted: number } {
  return FULL || items.length <= COMPACT_LIST ? { items, omitted: 0 } : { items: items.slice(0, COMPACT_LIST), omitted: items.length - COMPACT_LIST };
}

// A hint that names the exact command that moves the work forward, naming the journey when there is one.
function captureHint(cfg: Config): string {
  const names = Object.keys(cfg.journeys);
  if (names.length === 1) return `done-done run ${names[0]}`;
  if (names.length > 1) return `done-done run <journey> (${names.join(', ')})`;
  return 'done-done run -- <capture command>';
}

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
  const record = writeRecord(cfg, rec);
  const rel = (p: string) => relative(repo, join(cfg.evidence.root, p));
  let reason = '';
  if (now.commit !== rec.commit) reason = `HEAD moved from ${rec.commit} to ${now.commit} during the run; evidence is not tied to one commit`;
  else if (rec.exit !== null && rec.exit !== 0) reason = `the run command exited ${rec.exit}`;
  else if (!rec.files.length) reason = `the run wrote no files under ${cfg.evidence.root}`;
  const evidence: unknown[] = FULL ? rec.files.map((f) => ({ path: rel(f.path), sha256: f.sha256, bytes: f.bytes })) : rec.files.map((f) => rel(f.path));
  const rows = cap(evidence);
  const result: Record<string, unknown> = {
    command: 'run',
    result: reason ? 'fail' : 'pass',
    run_id: rec.run_id,
    commit: rec.commit,
    dirty: rec.dirty,
    files: rec.files.length,
    record: relative(repo, record) || record,
  };
  if (reason) result.reason = reason;
  result.evidence = rows.items;
  if (rows.omitted) result.evidence_omitted = rows.omitted;
  result.help = [reason
    ? `Fix the capture, commit, then re-run: ${captureHint(cfg)}`
    : `Check this proof: done-done check --outcome "<what you proved>" ${rel(rec.files[0].path)}`];
  emit(result);
  return reason ? FAIL : PASS;
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
    emit({
      command: 'run',
      result: 'open',
      run_id: rec.run_id,
      commit: rec.commit,
      evidence_root: relative(repo, cfg.evidence.root) || cfg.evidence.root,
      help: [`Capture into the evidence root, then seal the run: done-done run --close ${rec.run_id}`],
    });
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
  if (from === '-') return { body: readFileSync(0, 'utf8'), title: '' };
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

type CheckOutcome = {
  code: number;
  judge?: Record<string, unknown>;
  result: Record<string, unknown>;
  claim?: string;
  files: string[];
  cited: { path: string; sha256: string }[];
  head: { commit: string; tree: string; dirty: boolean };
};

// Run a check and return its result without printing it, so `check` and `receipt` share one path.
async function runCheck(argv: string[]): Promise<CheckOutcome> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { outcome: { type: 'string' }, from: { type: 'string' }, 'trusted-ref': { type: 'string' }, judge: { type: 'boolean' } },
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
  const now = head(repo);
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
    const rep = report(
      findings.concat(allowed ? [] : [{ level: 'inconclusive', why: `not proven: ${claim.notProven}` }]),
      [],
      { cfg, claim: claim.outcome, source: values.from, notProven: true },
      allowed ? 'not proven (allowed by trusted config)' : '',
    );
    return { code: rep.code, result: rep.result, claim: claim?.outcome, files: [], cited: [], head: now };
  }
  const files = claim?.files ?? [];
  const records = loadRecords(cfg);
  const seen = new Map<string, string>();
  const hashes: string[] = [];
  const cited: { path: string; sha256: string }[] = [];
  const captures: Capture[] = [];
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
    cited.push({ path: relative(repo, path), sha256: hash });
    if (seen.has(hash)) findings.push({ level: 'fail', why: `${name}: byte-identical to ${seen.get(hash)}` });
    seen.set(hash, name);
    if (v.status === 'fail') continue;
    const rec = records.filter((r) => r.files.some((f) => f.sha256 === hash)).sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    if (!rec) {
      findings.push({ level: 'inconclusive', why: `${name}: not in any done-done run record, so it is not tied to a commit` });
      continue;
    }
    // Only a capture tied to a run record can reach the judge, so a stray cited file is never sent.
    if (v.status === 'ok') captures.push({ name, bytes, sha256: hash, media: v });
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
  let judged: Record<string, unknown> | undefined;
  let judgeLevel: Finding['level'] | undefined;
  if ((values.judge || cfg.judge.enabled) && claim) {
    if (findings.some((f) => f.level === 'fail')) judged = { skipped: 'the check already failed, so no capture was judged' };
    else {
      const j = await judge(cfg, claim.outcome, captures);
      // The judge's next step leads the help when its verdict decides the result.
      if (j.judged.some((r) => r.verdict === 'fail')) judgeLevel = 'fail';
      else if (!findings.length && j.judged.some((r) => r.verdict === 'unsure')) judgeLevel = 'inconclusive';
      for (const r of j.judged.filter((r) => r.verdict !== 'pass'))
        findings.push({ level: r.verdict === 'fail' ? 'fail' : 'inconclusive', why: `${r.path}: judge says ${r.verdict === 'fail' ? 'wrong screen' : 'unsure'}: ${r.reason}` });
      const rows = cap<Judged>(j.judged);
      judged = { model: j.model, judged: rows.items };
      if (rows.omitted) judged.judged_omitted = rows.omitted;
      if (j.notJudged.length) judged.not_judged = j.notJudged;
      judged.note = 'only PNG and JPEG captures are judged; text, log and video evidence are not';
    }
  }
  const rep = report(findings, files, { cfg, claim: claim?.outcome, source: values.from, judge: judged, judgeLevel });
  if (rep.code === PASS) {
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, hashes.filter((h) => !used.get(h)?.has(key)).map((h) => `${h} ${key}\n`).join(''));
  }
  return { code: rep.code, result: rep.result, judge: judged, claim: claim?.outcome, files, cited, head: now };
}

async function cmdCheck(argv: string[]): Promise<number> {
  const r = await runCheck(argv);
  emit(r.result);
  return r.code;
}

// A receipt ties one passing check to one commit and to the sha256 of every file it cited.
type Receipt = {
  schema: 1;
  repo: string;
  head: string;
  tree: string;
  claim: string;
  result: 'pass';
  at: string;
  files: { path: string; sha256: string }[];
};

const receiptsDir = (cfg: Config) => join(cfg.evidence.root, '.done-done', 'receipts');

function writeReceipt(cfg: Config, rec: Receipt): string {
  const path = join(receiptsDir(cfg), `${rec.head}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return path;
}

// Verify a recorded receipt for `head`; read-only, so a missing or changed record is a failure, not a usage error.
function verifyReceipt(repo: string, cfg: Config, headArg: string): number {
  const short = headArg.slice(0, 12);
  const path = join(receiptsDir(cfg), `${headArg}.json`);
  const fail = (reason: string) => {
    emit({ command: 'receipt', result: 'fail', head: headArg, reason, help: ['Record a passing check for this head: done-done receipt --from <file|->'] });
    return FAIL;
  };
  if (!existsSync(path)) return fail(`no receipt for ${short}`);
  let rec: Receipt;
  try {
    rec = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail(`receipt for ${short} is malformed (${(e as Error).message})`);
  }
  if (!rec || typeof rec !== 'object' || rec.schema !== 1 || rec.result !== 'pass' || !Array.isArray(rec.files) || !rec.files.length) return fail(`receipt for ${short} is malformed`);
  if (!rec.files.every((f) => f && typeof f === 'object' && typeof f.path === 'string' && typeof f.sha256 === 'string')) return fail(`receipt for ${short} is malformed`);
  if (rec.head !== headArg) return fail(`receipt records head ${String(rec.head).slice(0, 12)}, not ${short}`);
  const now = head(repo);
  if (now.commit !== headArg) return fail(`HEAD is ${now.commit.slice(0, 12)}, not ${short}`);
  const bad: string[] = [];
  for (const f of rec.files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolve(repo, f.path));
    } catch {
      bad.push(`${f.path}: missing`);
      continue;
    }
    if (sha256(bytes) !== f.sha256) bad.push(`${f.path}: hash changed`);
  }
  if (bad.length) return fail(`cited evidence no longer matches the receipt: ${bad.join('; ')}`);
  emit({ command: 'receipt', result: 'pass', head: headArg, tree: rec.tree, claim: rec.claim, files: rec.files.length, at: rec.at, help: ['This receipt is valid for this head.'] });
  return PASS;
}

async function cmdReceipt(argv: string[]): Promise<number> {
  const vi = argv.indexOf('--verify');
  let verifyHead: string | null = null;
  let rest = argv;
  if (vi >= 0) {
    verifyHead = argv[vi + 1] ?? null;
    if (!verifyHead || verifyHead.startsWith('--')) throw new UsageError('receipt --verify needs a head sha');
    rest = [...argv.slice(0, vi), ...argv.slice(vi + 2)];
  }
  const repo = repoRoot();
  const cfg = loadConfig(repo);
  if (verifyHead) {
    if (rest.length) throw new UsageError('receipt --verify takes no other arguments');
    return verifyReceipt(repo, cfg, verifyHead);
  }
  if (!rest.length) throw new UsageError('receipt needs a claim (--outcome "<claim>" <files...> or --from <file|->) or --verify <head>');
  const r = await runCheck(rest);
  if (r.code !== PASS) {
    emit({ ...r.result, command: 'receipt', reason: 'the check did not pass, so no receipt was written' });
    return r.code;
  }
  if (r.head.dirty) {
    emit({ command: 'receipt', result: 'fail', head: r.head.commit, claim: r.claim, reason: 'tracked files have uncommitted changes; commit or revert them, then re-run receipt', help: ['Commit the tracked changes, then: done-done receipt --from <file|->'] });
    return FAIL;
  }
  if (!r.cited.length) {
    emit({ command: 'receipt', result: 'fail', head: r.head.commit, claim: r.claim, reason: 'the check cited no evidence files, so no receipt was written; a receipt must bind at least one cited evidence file', help: ['Cite real proof: done-done receipt --outcome "<claim>" <files...>'] });
    return FAIL;
  }
  const rec: Receipt = { schema: 1, repo: cfg.app, head: r.head.commit, tree: r.head.tree, claim: r.claim ?? '', result: 'pass', at: new Date().toISOString(), files: r.cited };
  const path = writeReceipt(cfg, rec);
  emit({
    command: 'receipt',
    result: 'pass',
    head: r.head.commit,
    tree: r.head.tree,
    claim: rec.claim,
    files: rec.files.length,
    receipt: relative(repo, path) || path,
    ...(r.judge && { judge: r.judge }),
    help: [`Verify this receipt (CI or merge): done-done receipt --verify ${r.head.commit}`],
  });
  return PASS;
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

type ReportContext = { cfg: Config; claim?: string; source?: string; notProven?: boolean; judge?: Record<string, unknown>; judgeLevel?: Finding['level'] };

function checkHelp(cfg: Config, code: number, notProven = false, judgeLevel?: Finding['level']): string[] {
  if (notProven) return ['Capture real proof and replace "not proven:", or set checks.not_proven: allow and re-check from a trusted ref'];
  if (judgeLevel === 'fail' && code === FAIL) return [`Capture the screen the outcome describes, then re-run this check: ${captureHint(cfg)}`];
  if (judgeLevel && code === INCONCLUSIVE) return ['Look at the capture yourself, or capture a clearer screen of the outcome and re-run this check'];
  if (code === PASS) return ['Gate CI on this proof: done-done check --from <PR URL> --trusted-ref origin/main'];
  const capture = captureHint(cfg);
  if (code === INCONCLUSIVE) return [`Capture this proof through a run so it is tied to a commit, then re-run this check: ${capture}`];
  return [`Capture fresh proof, commit it, then re-run this check: ${capture}`];
}

function report(findings: Finding[], files: string[], ctx: ReportContext, note = ''): { code: number; result: Record<string, unknown> } {
  const code = findings.some((f) => f.level === 'fail') ? FAIL : findings.length ? INCONCLUSIVE : PASS;
  const result: Record<string, unknown> = {
    command: 'check',
    result: code === PASS ? 'pass' : code === FAIL ? 'fail' : 'inconclusive',
  };
  if (ctx.claim) result.claim = ctx.claim;
  if (ctx.source) result.source = ctx.source;
  if (note) result.note = note;
  if (files.length) {
    const ev = cap(files);
    result.files = files.length;
    result.evidence = ev.items;
    if (ev.omitted) result.evidence_omitted = ev.omitted;
  }
  if (ctx.judge) result.judge = ctx.judge;
  const rows = cap(findings.map((f) => ({ level: f.level, why: f.why })));
  if (rows.items.length) result.findings = rows.items;
  if (rows.omitted) result.findings_omitted = rows.omitted;
  result.help = checkHelp(ctx.cfg, code, ctx.notProven, ctx.judgeLevel);
  return { code, result };
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

// The exact next command for a usage or config error, so an agent can recover without reading --help.
function errorHelp(msg: string): string[] {
  if (/not inside a git repository/.test(msg)) return ['Run done-done from inside a git repository'];
  if (/unknown journey|run needs a journey/.test(msg)) return ['Run `done-done` to list journeys, or capture a one-off proof: done-done run -- <command>'];
  if (/\.yaml|unknown key|must be|may only be set in the global config|in the project .done-done.yaml/.test(msg))
    return ['Fix the config above, or run `done-done init` to write a minimal .done-done.yaml'];
  return ['Run `done-done --help` for every command and flag'];
}

// Bare `done-done`: orient a new user or agent with the config state and the next step.
function cmdBare(): number {
  let repo: string;
  try {
    repo = repoRoot();
  } catch {
    emit({ command: 'done-done', config: 'none', help: ['Run done-done inside a git repository, then `done-done init` to set up proof'] });
    return PASS;
  }
  if (!existsSync(join(repo, '.done-done.yaml'))) {
    emit({ command: 'done-done', config: 'missing', help: ['Run `done-done init` to write a minimal .done-done.yaml'] });
    return PASS;
  }
  const cfg = loadConfig(repo);
  const journeys = Object.keys(cfg.journeys);
  const result: Record<string, unknown> = {
    command: 'done-done',
    config: 'present',
    app: cfg.app,
    evidence_root: relative(repo, cfg.evidence.root) || cfg.evidence.root,
    journeys,
    runs: loadRecords(cfg).length,
  };
  result.help = journeys.length
    ? [`Capture proof with \`done-done run ${journeys[0]}\`, then check it with \`done-done check\``]
    : ['Add a journey to .done-done.yaml, or capture a one-off proof with `done-done run -- <command>`, then `done-done check`'];
  emit(result);
  return PASS;
}

async function main(argv: string[]): Promise<number> {
  const dash = argv.indexOf('--');
  const head = dash < 0 ? argv : argv.slice(0, dash);
  const kept: string[] = [];
  for (const a of head) {
    if (a === '--json') OUT = 'json';
    else if (a === '--full') FULL = true;
    else kept.push(a);
  }
  const [cmd, ...rest] = [...kept, ...(dash < 0 ? [] : argv.slice(dash))];
  try {
    if (cmd === 'init') return cmdInit(rest);
    if (cmd === 'run') return cmdRun(rest);
    if (cmd === 'check') return await cmdCheck(rest);
    if (cmd === 'receipt') return await cmdReceipt(rest);
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
      console.log(USAGE_TEXT);
      return PASS;
    }
    if (cmd === undefined) return cmdBare();
    throw new UsageError(`unknown command ${cmd}`);
  } catch (e) {
    const msg = ((e as { stderr?: string }).stderr || (e as Error).message || String(e)).trim();
    emit({ command: 'done-done', error: msg, help: e instanceof UsageError && e.help ? [e.help] : errorHelp(msg) });
    return USAGE;
  }
}

process.exitCode = await main(process.argv.slice(2));
