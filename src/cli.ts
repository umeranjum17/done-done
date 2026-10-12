#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, appendFileSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { encode } from '@toon-format/toon';
import { Document, parseDocument } from 'yaml';
import { askAgent, selectAgent, selectJudge, supported } from './agents.js';
import { AGENTS as ALL_AGENTS, type Config, defaultConfig, home, loadConfig, UsageError } from './config.js';
import { backend, type Capture, judge, type Judged, onPath } from './judge.js';
import { checkMedia } from './media.js';

const PASS = 0, FAIL = 1, USAGE = 2, INCONCLUSIVE = 3;

// The shape of a journey, so a new user or agent can write one without opening the reference.
// done-done sets DONE_DONE_EVIDENCE_ROOT (the run's own folder) and replaces ${RUN_ID}, so the example works for any evidence root.
const journeyExample = 'journeys: { smoke: { command: "<drive the real app> > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log" } }';

const JOURNEYS_TEXT = `journeys (.done-done.yaml): the command runs with DONE_DONE_EVIDENCE_ROOT (this run's own new folder in the evidence
  root) and DONE_DONE_RUN_ID set, and \${RUN_ID} in it is replaced; it must write its files into that folder, e.g.
  ${journeyExample}`;
const CHECKS_TEXT = `Checks block (--from): the newest "## Checks" heading, then these four keys, each at the start of a line:
  outcome: <what a user can now do>
  repro: <command that failed before and passes now, or n/a; a fix PR needs one>
  proof: <the command or path that drove the real product; name the repo's verify-<app> skill, or say "no verify skill">
  evidence: <the evidence file paths, or "not proven: <cause>">`;
const AGENTS = ['claude', 'codex', 'opencode'];
const DOCTOR_TEXT = `doctor is read-only (--probe writes only its call record) and exits 0 when every required item is ok, 2 otherwise.
  required: git (inside a repository), config (a valid .done-done.yaml), evidence_root (writable).
  optional: verify_skill (.agents/skills/verify-<app>/), agent (the configured agent, or with agent: auto the first
  of claude, codex, opencode, pi, gemini on PATH, and its model), judge_choice (the claude judge, and whether it is
  apart from the author), judge (a claude binary, a Claude sign-in and the judge
  kit; the model is never called), ffprobe (video evidence only).
  --probe also asks the agent one JSON-schema question (one cheap model call; its record goes to
  $DONE_DONE_HOME/agents/) and then requires a valid answer.
  doctor lists every check; --full changes nothing. Missing optionals never fail the run.`;

// One table drives `--help` and every `<command> --help`: each command's usage lines and the flags it takes.
const FLAGS: Record<string, string> = {
  '-- <command...>': 'run this command instead of a journey; ${RUN_ID} in it becomes the run id',
  '--journey <name>': 'record this command as a journey in .done-done.yaml; ${RUN_ID} in it becomes the run id',
  '--open': 'open a run for a hand- or agent-driven proof; prints its id and folder',
  '--close <run-id>': 'seal an open run and record the files in its folder',
  '--outcome "<claim>"': 'the outcome the evidence files prove; the files follow as arguments',
  '--from <file | - | PR URL>': 'read the claim from the newest "## Checks" block of a file, stdin or a PR body',
  '--trusted-ref <ref>': 'read .done-done.yaml from this git ref instead of the working tree (use in CI)',
  '--claim-id <id>': 'the claim the evidence proves; evidence already used for another claim id is reuse (default: the current branch, or the PR branch with --from <PR URL>; required on a detached HEAD)',
  '--judge': 'a model says whether each PNG/JPEG capture shows the outcome (off by default; or judge.enabled: true)',
  '--verify <head>': 'read-only: verify the receipt recorded for <head>',
  '--probe': 'ask the configured agent one JSON-schema question and require a valid answer (one cheap model call)',
  '--agent <agent>': 'also add a SessionStart hook to .claude/settings.json (claude) or .codex/hooks.json (codex) that shows `done-done` to each session, or a plugin to .opencode/plugins that adds it to the first message of each opencode session (opt-in)',
};
// `more` is the reference text a command needs beyond its flags, shared with the top-level help.
const COMMANDS: Record<string, { usage: [string, string][]; flags: string[]; more: string[] }> = {
  init: {
    usage: [
      ['done-done init', 'write a minimal .done-done.yaml (evidence lives outside the repo)'],
      ['done-done init', 'scaffold .agents/skills/verify-<app> from this repo (never overwrites)'],
      ['done-done init --agent claude', 'also show this repo\'s done-done state at each Claude Code session start'],
      ['done-done init --agent codex', 'also show this repo\'s done-done state at each Codex session start'],
      ['done-done init --agent opencode', 'also add this repo\'s done-done state to the first message of each opencode session'],
      ['done-done init --journey <name> -- <command...>', "record a journey's capture recipe in .done-done.yaml"],
    ],
    flags: ['--agent <agent>', '--journey <name>', '-- <command...>'],
    more: [JOURNEYS_TEXT],
  },
  doctor: {
    usage: [
      ['done-done doctor', 'check this repo is worth driving: git, config, evidence root, skill, agent, judge, ffprobe'],
      ['done-done doctor --probe', 'also ask the configured agent one question to prove it answers'],
    ],
    flags: ['--probe'],
    more: [DOCTOR_TEXT],
  },
  run: {
    usage: [
      ['done-done run [<journey>] [-- <command...>]', 'run a journey (or command) and record the evidence it writes'],
      ['done-done run --open [<journey>]', 'open a run for a hand- or agent-driven proof; prints its id and folder'],
      ['done-done run --close <run-id>', 'seal an open run'],
    ],
    flags: ['-- <command...>', '--open', '--close <run-id>'],
    more: [JOURNEYS_TEXT],
  },
  check: {
    usage: [
      ['done-done check --outcome "<claim>" <files...> [--claim-id <id>] [--trusted-ref <ref>] [--judge]', 'check evidence files against a claim'],
      ['done-done check --from <file | - | PR URL> [--claim-id <id>] [--trusted-ref <ref>] [--judge]', "check a claim's Checks block"],
    ],
    flags: ['--outcome "<claim>"', '--from <file | - | PR URL>', '--claim-id <id>', '--trusted-ref <ref>', '--judge'],
    more: [CHECKS_TEXT],
  },
  receipt: {
    usage: [
      ['done-done receipt --outcome "<claim>" <files...> [--claim-id <id>] [--trusted-ref <ref>] [--judge]', 'record a passing check for HEAD'],
      ['done-done receipt --from <file | - | PR URL> [--claim-id <id>] [--trusted-ref <ref>] [--judge]', "record from a claim's Checks block"],
      ['done-done receipt --verify <head>', 'read-only: verify a recorded receipt'],
    ],
    flags: ['--outcome "<claim>"', '--from <file | - | PR URL>', '--claim-id <id>', '--trusted-ref <ref>', '--judge', '--verify <head>'],
    more: [CHECKS_TEXT],
  },
};

const rows = (pairs: [string, string][], width = Math.max(...pairs.map(([a]) => a.length)) + 3) => pairs.map(([a, b]) => `  ${a}${' '.repeat(Math.max(3, width - a.length))}${b}`).join('\n');
const GLOBAL_TEXT = `global flags: --json (JSON instead of TOON), --full (do not truncate lists), --help (this command's usage)
exit codes: 0 pass, 1 fail, 2 usage or config error, 3 inconclusive`;

const USAGE_TEXT = `install: npm install -g --prefix ~/.local --allow-git=all github:umeranjum17/done-done-axi (installs done-done-axi and done-done), or run npx -y --allow-git=all github:umeranjum17/done-done-axi <command>
usage:
${rows([['done-done', "show this repo's config state and the next step"], ...Object.values(COMMANDS).flatMap((c) => c.usage)], 46)}
${GLOBAL_TEXT}
--judge (or judge.enabled: true): a model on your Claude plan, through BYOKit, says whether each PNG/JPEG
  capture shows the outcome; a wrong screen fails, an unsure answer is inconclusive. Off by default.

${JOURNEYS_TEXT}
${CHECKS_TEXT}

Results are printed as one TOON document (the AXI convention); pass --json for JSON.
Run \`done-done <command> --help\` for that command's flags.`;

function commandHelp(cmd: string): string {
  const c = COMMANDS[cmd];
  const flags = c.flags.length ? rows(c.flags.map((f) => [f, FLAGS[f]])) : '  none';
  return [`usage:\n${rows(c.usage)}`, `flags:\n${flags}`, ...c.more, GLOBAL_TEXT].join('\n');
}

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
};

// A path as the user should see it: repo-relative inside the repo, else with the home directory as ~.
const outside = (r: string) => r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r);
const shown = (repo: string, p: string) => {
  const r = relative(repo, p);
  if (r && !outside(r)) return r;
  if (!r) return '.';
  const rh = relative(homedir(), p);
  return rh && !outside(rh) ? `~${sep}${rh}` : p;
};

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// `p` relative to `base` when it lies under it, else null.
function under(base: string, p: string): string | null {
  const r = relative(base, p);
  return r && !outside(r) ? r : null;
}

// A path to pass back to done-done (an evidence file to cite, a folder to capture into): exact, so no shell
// needs to expand `~`. Repo-relative inside the repo, absolute outside it (the default evidence root).
const citable = (repo: string, p: string) => under(repo, p) ?? p;

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

// Each run captures into its own new folder in the evidence root. Every checkout of a repo shares that root,
// so a run records only its own folder and never claims a file another, overlapping run wrote.
const runDir = (cfg: Config, runId: string) => join(cfg.evidence.root, runId);

// Every file in a run's folder, relative to the evidence root.
function captured(cfg: Config, runId: string): string[] {
  const dir = runDir(cfg, runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(cfg.evidence.root, join(e.parentPath, e.name)));
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
  // The random suffix keeps two runs in the same second at one commit apart; mkdir without recursive refuses a reused id.
  const runId = `${stamp}-${h.commit.slice(0, 8)}-${randomBytes(3).toString('hex')}`;
  mkdirSync(cfg.evidence.root, { recursive: true });
  mkdirSync(runDir(cfg, runId));
  return { schema: 1, run_id: runId, journey, command, ...h, started_at: new Date().toISOString(), ended_at: null, exit: null, files: [] };
}

function closeRun(repo: string, cfg: Config, rec: RunRecord): number {
  const now = head(repo);
  rec.files = captured(cfg, rec.run_id)
    .sort()
    .map((p) => {
      const b = readFileSync(join(cfg.evidence.root, p));
      return { path: p, sha256: sha256(b), bytes: b.length };
    });
  rec.ended_at = new Date().toISOString();
  const record = writeRecord(cfg, rec);
  const rel = (p: string) => citable(repo, join(cfg.evidence.root, p));
  let reason = '';
  if (now.commit !== rec.commit) reason = `HEAD moved from ${rec.commit} to ${now.commit} during the run; evidence is not tied to one commit`;
  else if (rec.exit !== null && rec.exit !== 0) reason = `the run command exited ${rec.exit}`;
  else if (!rec.files.length) reason = `the run wrote no files into its folder ${shown(repo, runDir(cfg, rec.run_id))}; the command gets it as $DONE_DONE_EVIDENCE_ROOT and its run id as $DONE_DONE_RUN_ID (or \${RUN_ID} in the command)`;
  const evidence: unknown[] = FULL ? rec.files.map((f) => ({ path: rel(f.path), sha256: f.sha256, bytes: f.bytes })) : rec.files.map((f) => rel(f.path));
  const rows = cap(evidence);
  const result: Record<string, unknown> = {
    command: 'run',
    result: reason ? 'fail' : 'pass',
    run_id: rec.run_id,
    commit: rec.commit,
    dirty: rec.dirty,
    files: rec.files.length,
    record: shown(repo, record),
  };
  if (reason) result.reason = reason;
  result.evidence = rows.items;
  if (rows.omitted) result.evidence_omitted = rows.omitted;
  result.help = [reason
    ? `Fix the capture, commit, then re-run: ${captureHint(cfg)}`
    : `Check this proof: done-done check --outcome "<what you proved>" ${rel(rec.files[0].path)}`];
  // A command that matches no repo-recorded journey cannot be re-run from the repo recipe.
  // A journey run expands ${RUN_ID} to the run id, so compare with the placeholder restored.
  if (rec.command) {
    const template = rec.command.replaceAll(rec.run_id, '${RUN_ID}');
    const recorded = Object.values(cfg.journeys).some((j) => j.command === template);
    if (!recorded) (result.help as string[]).push(`this command's recipe is not in the repo (.done-done.yaml journeys); record it with: done-done init --journey <name> -- <command>`);
  }
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
    if (!existsSync(path)) throw new UsageError(`no open run ${values.close} (looked for ${shown(repo, path)})`);
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
      evidence_root: citable(repo, runDir(cfg, rec.run_id)),
      help: [`Capture into evidence_root (this run's own folder), then seal the run: done-done run --close ${rec.run_id}`],
    });
    return PASS;
  }
  if (!command) throw new UsageError('run needs a journey, a command after --, or --open');
  const expanded = command.replaceAll('${RUN_ID}', rec.run_id);
  rec.command = expanded;
  // The journey's own stdout goes to our stderr, never our stdout: stdout carries only done-done's
  // result document (TOON or --json), so a noisy journey cannot break `run --json | JSON.parse`.
  const r = spawnSync(expanded, {
    cwd: repo, shell: true, stdio: ['inherit', process.stderr, 'inherit'],
    env: { ...process.env, DONE_DONE_RUN_ID: rec.run_id, DONE_DONE_EVIDENCE_ROOT: runDir(cfg, rec.run_id) },
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

// A PR body also names its head branch, which is the claim a CI checkout (a detached HEAD) is checking.
function readSource(from: string): { body: string; title: string; branch?: string } {
  if (from === '-') return { body: readFileSync(0, 'utf8'), title: '' };
  if (/^https?:\/\//.test(from)) {
    const r = spawnSync('gh', ['pr', 'view', from, '--json', 'body,title,headRefName'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new UsageError(`gh pr view ${from} failed: ${(r.error?.message || r.stderr).trim()}`);
    const pr = JSON.parse(r.stdout);
    return { body: pr.body, title: pr.title, branch: pr.headRefName };
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
    options: { outcome: { type: 'string' }, from: { type: 'string' }, 'claim-id': { type: 'string' }, 'trusted-ref': { type: 'string' }, judge: { type: 'boolean' } },
    allowPositionals: true,
  });
  if (!!values.outcome === !!values.from) throw new UsageError('check needs exactly one of --outcome or --from');
  if (values.from && positionals.length) throw new UsageError('--from takes no file arguments; the Checks block names them');
  if (values['claim-id']?.trim() === '') throw new UsageError('--claim-id needs a non-empty id');
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
  let prBranch: string | undefined;
  if (values.outcome) {
    if (!positionals.length) throw new UsageError('--outcome needs at least one evidence file');
    claim = { outcome: values.outcome, files: positionals, title: '' };
  } else {
    const src = readSource(values.from!);
    prBranch = src.branch;
    claim = claimFromChecks(src.body, src.title, repo, cfg, findings);
  }
  if (claim?.notProven) {
    const allowed = cfg.checks.not_proven === 'allow' && cfg.trusted;
    const rep = report(
      findings.concat(allowed ? [] : [{ level: 'inconclusive', why: `not proven: ${claim.notProven}` }]),
      [],
      { cfg, repo, claim: claim.outcome, source: values.from, notProven: true },
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
    cited.push({ path: receiptPath(repo, cfg, path), sha256: hash });
    if (seen.has(hash)) findings.push({ level: 'fail', why: `${name}: byte-identical to ${seen.get(hash)}` });
    seen.set(hash, name);
    // A file in the evidence root is claimed by the record that lists its path; a copy elsewhere, by its bytes.
    const inRoot = under(cfg.evidence.root, path);
    const claims = records.filter((r) => r.files.some((f) => f.sha256 === hash && (inRoot === null || f.path === inRoot)));
    if (!claims.length && inRoot !== null) {
      const edited = records.filter((r) => r.files.some((f) => f.path === inRoot));
      if (edited.length) {
        findings.push({ level: 'fail', why: `${name}: changed after run ${edited.map((r) => r.run_id).join(', ')}` });
        continue;
      }
    }
    if (v.status === 'fail') continue;
    if (!claims.length) {
      findings.push({ level: 'inconclusive', why: `${name}: not in any done-done run record, so it is not tied to a commit` });
      continue;
    }
    // Records from before runs had their own folders can both claim one file; never guess which run wrote it.
    if (claims.length > 1) {
      findings.push({ level: 'inconclusive', why: `${name}: claimed by more than one run (${claims.map((r) => r.run_id).join(', ')}), so it is not tied to one commit` });
      continue;
    }
    const rec = claims[0];
    // Only a capture tied to a run record can reach the judge, so a stray cited file is never sent.
    if (v.status === 'ok') captures.push({ name, bytes, sha256: hash, media: v });
    const stale = staleness(repo, cfg, rec.commit, now.commit);
    if (stale) findings.push({ level: 'fail', why: `${name}: ${stale} (run ${rec.run_id})` });
    if (rec.dirty && !cfg.evidence.allow_dirty) findings.push({ level: 'fail', why: `${name}: captured from a tree with uncommitted changes (run ${rec.run_id})` });
    if (rec.exit !== null && rec.exit !== 0) findings.push({ level: 'fail', why: `${name}: its run command exited ${rec.exit} (run ${rec.run_id})` });
  }
  // Reuse: fail only when every cited file was already used for a different claim id. The ledger lives in the
  // evidence root next to the run records it guards: one per app (repo), shared by every checkout of it, never in git.
  const ledger = join(cfg.evidence.root, '.done-done', 'ledger');
  const given = values['claim-id']?.replace(/\s+/g, ' ').trim();
  const claimId = given || prBranch || git(repo, 'branch', '--show-current');
  const idFrom = given ? '--claim-id' : prBranch ? 'the PR branch' : 'the current branch';
  if (!claimId && claim) throw new UsageError('HEAD is detached, so no branch names this claim; pass --claim-id <id>', 'Re-run with --claim-id <the branch or task this claim is for>');
  const used = new Map<string, Set<string>>();
  if (existsSync(ledger))
    for (const line of readFileSync(ledger, 'utf8').split('\n')) {
      const [h, k] = [line.slice(0, 64), line.slice(65)];
      if (k) used.set(h, (used.get(h) ?? new Set()).add(k));
    }
  const others = (h: string) => [...(used.get(h) ?? [])].filter((k) => k !== claimId);
  if (hashes.length && hashes.every((h) => others(h).length))
    findings.push({ level: 'fail', why: `every evidence file was already used as proof of a different claim (claim id ${[...new Set(hashes.flatMap(others))].join(', ')}), not this one (claim id ${claimId}, from ${idFrom}); if it is the same claim, pass --claim-id with its id` });
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
  const rep = report(findings, files, { cfg, repo, claim: claim?.outcome, source: values.from, judge: judged, judgeLevel });
  if (rep.code === PASS) {
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, hashes.filter((h) => !used.get(h)?.has(claimId)).map((h) => `${h} ${claimId}\n`).join(''));
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

// A receipt names a cited file relative to the repo, or to an evidence root outside it under this prefix,
// so any checkout of the repo (or a CI job that restored the evidence root) finds the same file.
const IN_EVIDENCE = '<evidence root>/';

function receiptPath(repo: string, cfg: Config, p: string): string {
  const inRepo = under(repo, p);
  if (inRepo !== null) return inRepo;
  const inRoot = under(cfg.evidence.root, p);
  return inRoot === null ? p : IN_EVIDENCE + inRoot;
}

function writeReceipt(cfg: Config, rec: Receipt): string {
  const path = join(receiptsDir(cfg), `${rec.head}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return path;
}

// Verify a recorded receipt for `headArg`, which may be a full sha or a ref (HEAD, a branch or a tag).
// Read-only, so a missing or changed record is a failure, not a usage error.
function verifyReceipt(repo: string, cfg: Config, headArg: string): number {
  let commit = headArg;
  try {
    commit = git(repo, 'rev-parse', '--verify', `${headArg}^{commit}`);
  } catch {
    // Unresolvable: keep the argument so the lookup below fails with the current "no receipt" shape.
  }
  const short = commit.slice(0, 12);
  const path = join(receiptsDir(cfg), `${commit}.json`);
  const fail = (reason: string) => {
    emit({ command: 'receipt', result: 'fail', head: commit, reason, help: ['Record a passing check for this head: done-done receipt --from <file|->'] });
    return FAIL;
  };
  if (!existsSync(path)) return fail(`no receipt for ${short} in ${receiptsDir(cfg)}`);
  let rec: Receipt;
  try {
    rec = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail(`receipt for ${short} is malformed (${(e as Error).message})`);
  }
  if (!rec || typeof rec !== 'object' || rec.schema !== 1 || rec.result !== 'pass' || !Array.isArray(rec.files) || !rec.files.length) return fail(`receipt for ${short} is malformed`);
  if (!rec.files.every((f) => f && typeof f === 'object' && typeof f.path === 'string' && typeof f.sha256 === 'string')) return fail(`receipt for ${short} is malformed`);
  if (rec.head !== commit) return fail(`receipt records head ${String(rec.head).slice(0, 12)}, not ${short}`);
  const now = head(repo);
  if (now.commit !== commit) return fail(`HEAD is ${now.commit.slice(0, 12)}, not ${short}`);
  const records = loadRecords(cfg);
  const bad: string[] = [];
  for (const f of rec.files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(f.path.startsWith(IN_EVIDENCE) ? join(cfg.evidence.root, f.path.slice(IN_EVIDENCE.length)) : resolve(repo, f.path));
    } catch {
      bad.push(`${f.path}: missing`);
      continue;
    }
    if (sha256(bytes) !== f.sha256) {
      // The receipt names a path a run recorded: the file was edited after its run.
      const inRoot = f.path.startsWith(IN_EVIDENCE) ? f.path.slice(IN_EVIDENCE.length) : under(cfg.evidence.root, resolve(repo, f.path));
      const edited = inRoot !== null ? records.filter((r) => r.files.some((rf) => rf.path === inRoot)) : [];
      bad.push(edited.length ? `${f.path}: changed after run ${edited.map((r) => r.run_id).join(', ')} (hash changed)` : `${f.path}: hash changed`);
    }
  }
  if (bad.length) return fail(`cited evidence no longer matches the receipt: ${bad.join('; ')}`);
  emit({ command: 'receipt', result: 'pass', head: commit, tree: rec.tree, claim: rec.claim, files: rec.files.length, at: rec.at, help: ['This receipt is valid for this head.'] });
  return PASS;
}

async function cmdReceipt(argv: string[]): Promise<number> {
  const vi = argv.indexOf('--verify');
  let verifyHead: string | null = null;
  let rest = argv;
  if (vi >= 0) {
    verifyHead = argv[vi + 1] ?? null;
    if (!verifyHead || verifyHead.startsWith('--')) throw new UsageError('receipt --verify needs a head sha or ref');
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
    receipt: shown(repo, path),
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

type ReportContext = { cfg: Config; repo: string; claim?: string; source?: string; notProven?: boolean; judge?: Record<string, unknown>; judgeLevel?: Finding['level'] };

// Quote an argument only when a shell would split it.
const arg = (a: string) => (/^[\w./@:+-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`);

function checkHelp(code: number, files: string[], { cfg, repo, claim, source, notProven, judgeLevel }: ReportContext): string[] {
  if (notProven) return ['Capture real proof and replace "not proven:", or set checks.not_proven: allow and re-check from a trusted ref'];
  if (judgeLevel === 'fail' && code === FAIL) return [`Capture the screen the outcome describes, then re-run this check: ${captureHint(cfg)}`];
  if (judgeLevel && code === INCONCLUSIVE) return ['Look at the capture yourself, or capture a clearer screen of the outcome and re-run this check'];
  if (code === PASS) {
    // The CI gate needs a PR on a remote; without one, a receipt records the pass locally.
    if (spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repo }).status === 0) return ['Gate CI on this proof: done-done check --from <PR URL> --trusted-ref origin/main'];
    const claimArgs = source ? ['--from', source] : ['--outcome', claim ?? '', ...files];
    return [`Record this pass for HEAD: done-done receipt ${claimArgs.map(arg).join(' ')}`];
  }
  const capture = captureHint(cfg);
  if (code === INCONCLUSIVE) return [`Capture this proof through a run so it is tied to a commit, then re-run this check: ${capture}`];
  return [`Commit your change, re-capture with ${capture}, then check the new files`];
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
  result.help = checkHelp(code, files, ctx);
  return { code, result };
}

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

// `init` also scaffolds the project's verify skill from the repo's own files: a port of the
// fleet create-verification-skill interview (surface, run, drive, observe, isolate).
// Scaffold only: where only a live drive can fill a blank, a TODO marker stands in place of
// an invented command. An existing skill is never overwritten, so re-run is idempotent.
function headText(p: string, max = 12000): string {
  try {
    if (!lstatSync(p).isFile()) return '';
    return readFileSync(p, 'utf8').slice(0, max);
  } catch {
    return '';
  }
}

type Detected = {
  surface: string;
  launch: string;
  ready: string;
  harness: string;
  observe: string;
  isolate: string;
  features: { slug: string; title: string; reach: string }[];
  omitted: number;
};

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'feature';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'coverage', 'target', 'venv', '__pycache__', 'bower_components']);
const SOURCE_FILE = /\.(m?[jt]s|py|go|rb|rs|php)$/;

// Source files under `dir`, skipping hidden dirs (.git, .venv, .next, ...) and dependency and build output. The cap
// applies while walking, so a large vendored tree never fills the sample before the app's own files are reached.
function sourceFiles(dir: string, max: number, out: string[] = []): string[] {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= max) break;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && !(e.name === 'components' && dir.endsWith(`${sep}src`))) sourceFiles(p, max, out);
      } else if (e.isFile() && SOURCE_FILE.test(e.name)) out.push(p);
    }
  } catch {
    // An unreadable directory contributes nothing; the scan runs on the rest.
  }
  return out;
}

// Surface, run, drive, observe and features read from package.json, Makefile, routes,
// CLI commands and docs: the repo's own files, never invention.
function detectApp(repo: string): Detected {
  let pkg: Record<string, any> = {};
  try {
    pkg = JSON.parse(headText(join(repo, 'package.json'), Infinity) || '{}');
  } catch {
    pkg = {};
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) pkg = {};
  const scripts: Record<string, string> = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  const has = (...names: string[]) => names.some((n) => deps.includes(n));
  const bins: string[] = typeof pkg.bin === 'string' ? [pkg.bin] : pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin).filter((v): v is string => typeof v === 'string') : [];
  const make = headText(join(repo, 'Makefile'), 4000);
  let text = `${scripts.dev ?? ''}\n${scripts.start ?? ''}\n${make}`;
  for (const f of sourceFiles(repo, 40)) text += `\n${headText(f, 6000)}`;
  const routes = [...text.matchAll(/\b(app|router|server|api|fastify|routes|r)\.(get|post|put|patch|delete|del|use)\(\s*['"`](\/[^'"`\s]*)/g)]
    .map((m) => `${m[2].toUpperCase()} ${m[3]}`)
    .filter((r, i, a) => a.indexOf(r) === i);
  const commands = [...text.matchAll(/\.command\(\s*['"`]([^'"`\s\]]+)/g)]
    .map((m) => m[1])
    .filter((c, i, a) => a.indexOf(c) === i);
  const web = has('react', 'next', 'vue', 'nuxt', 'svelte', 'solid', 'vite', 'webpack', 'playwright', '@playwright/test', 'cypress', 'puppeteer');
  const cliish = bins.length > 0 || commands.length > 0 || has('commander', 'yargs', 'oclif', 'cac');
  const api = routes.length > 0 || has('express', 'fastify', 'koa', 'hono');
  const surface = web ? 'web UI' : cliish ? 'CLI' : api ? 'API/service' : 'app (unrecognized surface)';
  const launch =
    scripts.dev ? `npm run dev (${scripts.dev})`
    : scripts.start ? `npm start (${scripts.start})`
    : bins.length ? `node ${bins[0]} --help`
    : make ? 'TODO(live drive): pick the dev target from the Makefile and record it here'
    : 'TODO(live drive): how the app starts locally (no npm script, bin or Makefile found)';
  const port = `${scripts.dev ?? ''} ${scripts.start ?? ''}`.match(/(?:localhost:|--port[= ])(\d{4,5})/)?.[1];
  const ready = port
    ? `http://localhost:${port} answers (TODO(live drive): confirm the ready log line)`
    : web || api
      ? 'TODO(live drive): the URL and ready log line the server prints'
      : 'TODO(live drive): how to tell the app is ready (log line, port, prompt)';
  const harness = has('playwright', '@playwright/test', 'cypress', 'puppeteer')
    ? 'browser/CDP (Playwright)'
    : cliish ? 'tmux/PTY'
    : api ? 'plain HTTP (curl)'
    : 'TODO(live drive)';
  const observe = web
    ? 'screenshots of the action and the resulting state, plus the console log'
    : cliish
      ? 'terminal transcripts, exit codes and side effects (files written, rows inserted)'
      : api
        ? 'response bodies, status codes and side effects (rows inserted, messages sent)'
        : 'TODO(live drive): what evidence this surface can capture';
  const isolate = web || port
    ? 'TODO(live drive): confirm two instances run side by side (ports, data dirs, profiles); until then drive one instance at a time'
    : 'each run uses its own invocation; never drive a shared session the user owns';
  const features: (Detected['features'][number] & { command: boolean })[] = [];
  for (const f of [
    ...routes.map((r) => ({ base: slug(r), title: r, reach: `the ${r} route`, command: false })),
    ...commands.map((c) => ({ base: slug(c), title: `\`${c}\` command`, reach: `the CLI run with \`${c}\``, command: true })),
  ]) {
    let s = f.base;
    for (let n = 2; features.some((g) => g.slug === s); n++) s = `${f.base}-${n}`;
    features.push({ slug: s, title: f.title, reach: f.reach, command: f.command });
  }
  const commandsFound = features.filter((f) => f.command);
  const shown = [...features.filter((f) => !f.command).slice(0, commandsFound.length ? 4 : 5), ...commandsFound].slice(0, 5);
  return { surface, launch, ready, harness, observe, isolate, features: shown, omitted: features.length - shown.length };
}

function verifySkillMd(app: string, d: Detected): string {
  const name = `verify-${app}`;
  const found = [
    ...(d.features.length ? d.features.map((f) => `- ${f.title}: ${f.reach}`) : ['- TODO(live drive): no routes or commands found; map the first feature on the first live drive']),
    ...(d.omitted ? [`- ${d.omitted} more found and not listed; add them by hand or run maintain later.`] : []),
  ];
  return `---
name: ${name}
description: Drive the ${app} ${d.surface} the way a user does and capture proof it works. Use when proving a ${app} change, capturing evidence, or keeping the feature map honest.
---

# ${name}

Scaffolded by \`done-done init\` from this repo's own files (surface: ${d.surface}). Lines marked TODO need one live drive before they can be trusted.

## Launch

${d.launch}

Ready when ${d.ready}. Tear down what you started; never kill by process name.

## Doctor

Read-only: is this instance worth driving? Process up, right build, port owned by us, auth valid. ${d.isolate}.

## Drive

Harness: ${d.harness}. Prefer the repo's real handles (routes, commands, labels) over coordinates:

${found.join('\n')}

## Evidence

Capture ${d.observe}. Exercise the real user path, not internal setters; capture the action and the resulting state, not just the final screen; verify side effects alongside what is visible. Evidence goes to the run folder \`done-done run\` prints.

## Cleanup

Stop the instances this run started and remove scratch state. Evidence survives cleanup: never delete the run folder.
`;
}

function verifyFeatureMd(app: string, d: Detected, f: Detected['features'][number]): string {
  return `# ${f.title}\n\nPart of the ${app} verification map; reached at ${f.reach}.\n\n## Sub-features\n\nTODO(live drive): list what this covers.\n\n## How to get to it (user POV)\n\n${f.reach}.\n\n## Driving it with ${d.harness}\n\nTODO(live drive): the exact selectors or commands that drive it.\n\n## Gotchas\n\nTODO(live drive): what surprised the first live drive.\n`;
}

function verifyFeaturesMd(app: string, d: Detected): string {
  const index = d.features.length
    ? d.features.map((f) => `- [${f.title}](${f.slug}.md): ${f.reach}`).join('\n')
    : 'TODO(live drive): no features found in source; map the first one here.';
  const more = d.omitted ? `\n\n${d.omitted} more found and not listed; add them by hand or run maintain later.` : '';
  return `# ${app} features\n\nThe repo's maintained verification map; a proof that drives one entry point is incomplete when this lists others.\n\n${index}${more}\n`;
}

// The first existing component on the way from the repo to `p` that is a symlink, if any: a cloned repo's symlink
// would redirect the scaffold's writes out of the repo.
function symlinkOnPath(repo: string, p: string): string | undefined {
  let cur = repo;
  for (const part of relative(repo, p).split(sep)) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return cur;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Writes only missing files; an existing skill is left byte-identical. SKILL.md is written last, so it marks a
// finished scaffold. Every write target is checked before the first write.
function scaffoldVerify(repo: string, cfg: Config): string {
  const dir = join(repo, cfg.skill);
  if (existsSync(join(dir, 'SKILL.md'))) return 'unchanged';
  const d = detectApp(repo);
  const files = new Map<string, string>([[join('features', 'README.md'), verifyFeaturesMd(cfg.app, d)]]);
  for (const f of d.features) files.set(join('features', `${f.slug}.md`), verifyFeatureMd(cfg.app, d, f));
  files.set('SKILL.md', verifySkillMd(cfg.app, d));
  const targets = [...files].map(([rel, body]) => ({ p: join(dir, rel), body }));
  const link = targets.map(({ p }) => symlinkOnPath(repo, p)).find((l) => l !== undefined);
  if (link !== undefined) return `skipped, ${shown(repo, link)} is a symlink; write it by hand or remove the link`;
  for (const { p, body } of targets) {
    if (existsSync(p)) continue;
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    } catch (e) {
      return `skipped, ${shown(repo, p)} could not be written (${(e as Error).message}); fix it and re-run init`;
    }
  }
  return 'written';
}

// The session-start hook `init --agent <agent>` adds; the agent shows its stdout to the session.
// Without done-done on PATH it prints nothing and exits 0, so it never breaks a session.
// Claude Code reads it from the repo's .claude/settings.json, Codex from the repo's .codex/hooks.json
// (project scope; Codex docs: <repo>/.codex/hooks.json, SessionStart, matcher omitted matches every start).
const HOOK_COMMAND = 'command -v done-done >/dev/null && done-done || true';
const CLAUDE_HOOK = HOOK_COMMAND;
const CODEX_HOOK = HOOK_COMMAND;

// The repo's .claude/settings.json with the hook merged in, keeping every other key and hook; no text when it is already there.
function claudeSettings(repo: string): { file: string; text?: string } {
  const file = join(repo, '.claude', 'settings.json');
  const bad = (why: string) => new UsageError(`.claude/settings.json ${why}`, 'Fix .claude/settings.json, then re-run: done-done init --agent claude');
  const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  let settings: Record<string, any> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw bad(`is not valid JSON (${(e as Error).message})`);
    }
  }
  if (!isObject(settings)) throw bad('is not a JSON object');
  if (settings.hooks !== undefined && !isObject(settings.hooks)) throw bad('has "hooks" that is not an object');
  const start = settings.hooks?.SessionStart ?? [];
  if (!Array.isArray(start)) throw bad('has "hooks.SessionStart" that is not a list');
  if (start.some((m) => Array.isArray(m?.hooks) && m.hooks.some((h: { command?: unknown }) => h?.command === CLAUDE_HOOK))) return { file };
  settings.hooks = { ...settings.hooks, SessionStart: [...start, { hooks: [{ type: 'command', command: CLAUDE_HOOK }] }] };
  return { file, text: `${JSON.stringify(settings, null, 2)}\n` };
}

// The repo's .codex/hooks.json with the hook merged in, keeping every other key and hook; no text when it is already there.
function codexSettings(repo: string): { file: string; text?: string } {
  const file = join(repo, '.codex', 'hooks.json');
  const bad = (why: string) => new UsageError(`.codex/hooks.json ${why}`, 'Fix .codex/hooks.json, then re-run: done-done init --agent codex');
  const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  let settings: Record<string, any> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw bad(`is not valid JSON (${(e as Error).message})`);
    }
  }
  if (!isObject(settings)) throw bad('is not a JSON object');
  if (settings.hooks !== undefined && !isObject(settings.hooks)) throw bad('has "hooks" that is not an object');
  const start = settings.hooks?.SessionStart ?? [];
  if (!Array.isArray(start)) throw bad('has "hooks.SessionStart" that is not a list');
  if (start.some((m) => Array.isArray(m?.hooks) && m.hooks.some((h: { command?: unknown }) => h?.command === CODEX_HOOK))) return { file };
  settings.hooks = { ...settings.hooks, SessionStart: [...start, { hooks: [{ type: 'command', command: CODEX_HOOK }] }] };
  return { file, text: `${JSON.stringify(settings, null, 2)}\n` };
}

// The opencode session plugin `init --agent opencode` adds: a project-scope file in
// .opencode/plugins/ (auto-loaded; the home config is never touched) whose chat.message
// hook runs the session command below on the first message of each session and appends
// the bare `done-done` state to the message parts. The appended part carries the prt_ id
// plus the session id from the hook input and the message id from the hook output (opencode
// passes no messageID to the hook), because opencode validates every
// part before save and drops the whole first message when one is invalid. Without
// done-done on PATH it appends nothing and never throws, so it never breaks a session.
function opencodePlugin(repo: string): { file: string; text?: string } {
  const file = join(repo, '.opencode', 'plugins', 'done-done.js');
  const text = `// Written by \`done-done init --agent opencode\`: shows this repo's bare \`done-done\`
// state to each opencode session. On the first message of a session the chat.message
// hook runs \`${CLAUDE_HOOK}\` and appends its output to the message parts.
// Without done-done on PATH it appends nothing and never throws, so it never breaks
// a session. Other files in .opencode/plugins/ are untouched; delete this file to opt out.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const COMMAND = "${CLAUDE_HOOK}";

const seen = new Set();
const firstMessage = (sessionID) => {
  if (seen.has(sessionID)) return false;
  seen.add(sessionID);
  return true;
};

const run = (cwd) => new Promise((resolve) => {
  execFile("sh", ["-c", COMMAND], { cwd, encoding: "utf8", timeout: 30000 }, (error, stdout) => resolve(error ? "" : stdout.trim()));
});

export const DoneDonePlugin = async ({ directory }) => {
  return {
    "chat.message": async (input, output) => {
      if (!firstMessage(input.sessionID)) return;
      const state = await run(directory);
      if (state) output.parts.push({ id: \`prt_\${randomUUID()}\`, messageID: output.message.id, sessionID: input.sessionID, type: "text", text: state });
    },
  };
};
`;
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8') === text) return { file };
    throw new UsageError('.opencode/plugins/done-done.js already exists with other content, so init will not overwrite it', 'Delete .opencode/plugins/done-done.js, then re-run: done-done init --agent opencode');
  }
  return { file, text };
}

function cmdInit(argv: string[]): number {
  const dash = argv.indexOf('--');
  const { values } = parseArgs({
    args: dash < 0 ? argv : argv.slice(0, dash),
    options: { agent: { type: 'string' }, journey: { type: 'string' } },
    allowPositionals: false,
  });
  const parts = dash < 0 ? [] : argv.slice(dash + 1);
  const journey = values.journey ?? null;
  if (values.agent !== undefined && !AGENTS.includes(values.agent))
    throw new UsageError(`--agent ${values.agent} is not supported; the supported values are claude, codex, opencode`, 'Run: done-done init --agent <claude|codex|opencode>');
  if (journey === null && parts.length) throw new UsageError('init needs --journey <name> to record a command after --');
  if (journey !== null && !parts.some((p) => p.trim())) throw new UsageError(`init --journey ${journey} needs a command after --`);
  if (journey !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(journey)) throw new UsageError(`invalid journey name ${journey}; use letters, digits, - or _`);
  const repo = repoRoot();
  const file = join(repo, '.done-done.yaml');
  const existed = existsSync(file);
  const cfg = loadConfig(repo); // validates the existing project config; malformed -> exit 2, no writes
  if (cfg.skill.split(/[\\/]/).includes('..')) throw new UsageError(`verify skill ${cfg.skill} has a .. segment; use a path inside the repo`, 'Set skill to a repo-relative path in .done-done.yaml');
  const hook = values.agent === 'claude' ? claudeSettings(repo) : values.agent === 'codex' ? codexSettings(repo) : values.agent === 'opencode' ? opencodePlugin(repo) : undefined; // likewise validated before any write
  if (journey !== null) {
    // Record the capture recipe in the repo so any checkout can re-run the proof.
    // The command is stored verbatim; ${RUN_ID} in it becomes the run id, like a run -- command.
    const command = parts.join(' ');
    const doc = existed ? parseDocument(readFileSync(file, 'utf8')) : new Document({ app: cfg.app });
    const top = (doc.toJS() ?? {}) as Record<string, any>;
    if (typeof top !== 'object' || Array.isArray(top)) throw new UsageError(`${file}: top level must be a mapping`);
    const journeys = top.journeys ?? {};
    if (typeof journeys !== 'object' || Array.isArray(journeys)) throw new UsageError(`${file}: journeys must be a mapping`);
    if (top.journeys == null) doc.set('journeys', doc.createNode({}));
    doc.setIn(['journeys', journey, 'command'], command);
    writeFileSync(`${file}.tmp`, doc.toString({ lineWidth: 0 }));
    renameSync(`${file}.tmp`, file);
    const fresh = loadConfig(repo);
    const rel = under(repo, fresh.evidence.root);
    const added = !!rel && ensureIgnored(repo, rel);
    const root = shown(repo, fresh.evidence.root);
    const check = 'done-done check --outcome "<what you proved>" <files it recorded>';
    const verify = scaffoldVerify(repo, fresh);
    emit({
      command: 'init',
      result: 'pass',
      config: existed ? 'updated' : 'written',
      journey,
      app: fresh.app,
      evidence_root: root,
      gitignore: added ? `added ${rel!.replace(/\/+$/, '')}/` : 'unchanged',
      verify_skill: verify,
      help: [`Capture proof: done-done run ${journey}, then: ${check}`],
    });
    return PASS;
  }
  if (!existed) {
    // No evidence.root: proof goes to <local_root>/<app>, outside the repo, so it outlives this checkout.
    // The pinned app name is what lets every checkout of the repo find the same evidence and receipts.
    const body = `# done-done project config. \`done-done init\` never overwrites this file.\napp: ${JSON.stringify(cfg.app)}\n`;
    writeFileSync(`${file}.tmp`, body);
    renameSync(`${file}.tmp`, file);
  }
  // An evidence root inside the repo (an older config's `root: .proof`) stays out of git.
  const rel = under(repo, cfg.evidence.root);
  const added = !!rel && ensureIgnored(repo, rel);
  if (hook?.text) {
    mkdirSync(dirname(hook.file), { recursive: true });
    writeFileSync(`${hook.file}.tmp`, hook.text);
    renameSync(`${hook.file}.tmp`, hook.file);
  }
  const root = shown(repo, cfg.evidence.root);
  const check = 'done-done check --outcome "<what you proved>" <files it recorded>';
  const verify = scaffoldVerify(repo, cfg);
  emit({
    command: 'init',
    result: 'pass',
    config: existed ? 'unchanged' : 'written',
    app: cfg.app,
    evidence_root: root,
    gitignore: added ? `added ${rel!.replace(/\/+$/, '')}/` : 'unchanged',
    verify_skill: verify,
    ...(hook &&
      (values.agent === 'codex'
        ? { codex_hook: hook.text ? 'added to .codex/hooks.json' : 'unchanged' }
        : values.agent === 'opencode'
          ? { opencode_plugin: hook.text ? 'added to .opencode/plugins/done-done.js' : 'unchanged' }
          : { claude_hook: hook.text ? 'added to .claude/settings.json' : 'unchanged' })),
    help: [
      ...(Object.keys(cfg.journeys).length
        ? [`Capture proof: ${captureHint(cfg)}, then: ${check}`]
        : [`Add a journey that drives the real app and saves proof under $DONE_DONE_EVIDENCE_ROOT (each run's own folder in ${root}), e.g. ${journeyExample}`, `Then commit, run \`done-done run smoke\`, and: ${check}`]),
      ...(hook?.text
        ? values.agent === 'codex'
          ? ['Commit .codex/hooks.json: each Codex session in this repo then starts with `done-done` output (it needs done-done on PATH)']
          : values.agent === 'opencode'
            ? ['Commit .opencode/plugins/done-done.js: the first message of each opencode session in this repo then gets `done-done` output added (it needs done-done on PATH)']
            : ['Commit .claude/settings.json: each Claude Code session in this repo then starts with `done-done` output (it needs done-done on PATH)']
        : []),
    ],
  });
  return PASS;
}

// The exact next command for a usage or config error, so an agent can recover without reading --help.
function errorHelp(msg: string, cmd?: string): string[] {
  if (/not inside a git repository/.test(msg)) return ['Run done-done from inside a git repository'];
  if (/unknown journey|run needs a journey/.test(msg)) return ['Run `done-done` to list journeys, or capture a one-off proof: done-done run -- <command>'];
  if (cmd && /Unknown option|Unexpected argument|argument missing/.test(msg))
    return [`Valid flags for ${cmd}: ${COMMANDS[cmd].flags.join(', ') || 'none'}. Run \`done-done ${cmd} --help\` for its usage`];
  // Config errors name their file (.done-done.yaml or the global config.yaml); init never rewrites one, so fixing it is the way out.
  if (/\.done-done\.yaml|config\.yaml:/.test(msg)) return [`Fix the config file named above, then re-run: done-done${cmd ? ` ${cmd}` : ''}`];
  if (!cmd) return ['Run `done-done --help` for every command and flag'];
  return [`Run \`done-done ${cmd} --help\` for its usage and flags`];
}

// Whether `p` could hold evidence without writing anything: the nearest existing
// ancestor must be a writable directory. Read-only, so doctor creates nothing.
function writableDir(p: string): boolean {
  let cur = p;
  for (;;) {
    try {
      if (!statSync(cur).isDirectory()) return false;
      accessSync(cur, constants.W_OK | constants.X_OK);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = dirname(cur);
      if (parent === cur) return false;
      cur = parent;
    }
  }
}

const PROBE_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
type DoctorCheck = { check: string; status: 'ok' | 'missing'; detail: string; fix: string };

// Is this repo worth driving: git, a valid config and a writable evidence root are
// required; the verify skill, an agent CLI, the judge binary and ffprobe are optional.
// Read-only: a missing repo or config is a finding, never a crash, and nothing is created.
async function cmdDoctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { probe: { type: 'boolean' } }, allowPositionals: false });
  let repo: string | null = null;
  try {
    repo = git(process.cwd(), 'rev-parse', '--show-toplevel');
  } catch {
    repo = null;
  }
  const checks: DoctorCheck[] = [];
  checks.push(
    repo
      ? { check: 'git', status: 'ok', detail: `inside a git repository at ${repo}`, fix: '' }
      : { check: 'git', status: 'missing', detail: 'not inside a git repository', fix: 'Run done-done from inside a git repository' },
  );
  let cfg: Config | null = null;
  if (!repo) {
    checks.push({ check: 'config', status: 'missing', detail: 'unknown without a git repository', fix: 'Run done-done from inside a git repository' });
  } else if (!existsSync(join(repo, '.done-done.yaml'))) {
    checks.push({ check: 'config', status: 'missing', detail: 'no .done-done.yaml', fix: 'Run `done-done init` to write a minimal .done-done.yaml' });
  } else {
    try {
      cfg = loadConfig(repo);
      checks.push({ check: 'config', status: 'ok', detail: `.done-done.yaml is valid (app ${cfg.app})`, fix: '' });
    } catch (e) {
      checks.push({ check: 'config', status: 'missing', detail: (e as Error).message, fix: 'Fix the config file named above, then re-run: done-done doctor' });
    }
  }
  if (!cfg || !repo) {
    checks.push({ check: 'evidence_root', status: 'missing', detail: 'unknown without a valid config', fix: '' });
  } else if (writableDir(cfg.evidence.root)) {
    checks.push({ check: 'evidence_root', status: 'ok', detail: `writable: ${shown(repo, cfg.evidence.root)}`, fix: '' });
  } else {
    checks.push({ check: 'evidence_root', status: 'missing', detail: `not writable: ${shown(repo, cfg.evidence.root)}`, fix: `Make ${cfg.evidence.root} writable, or set evidence.root to a writable folder in .done-done.yaml` });
  }
  if (!cfg || !repo) {
    checks.push({ check: 'verify_skill', status: 'missing', detail: 'unknown without a valid config', fix: '' });
  } else {
    const dir = join(repo, cfg.skill);
    const skillFile = join(dir, 'SKILL.md');
    if (existsSync(skillFile)) checks.push({ check: 'verify_skill', status: 'ok', detail: `present at ${shown(repo, skillFile)}`, fix: '' });
    else
      checks.push({
        check: 'verify_skill',
        status: 'missing',
        detail: `no ${shown(repo, skillFile)}; checks still pass with "no verify skill"`,
        fix: `Write ${shown(repo, skillFile)} describing how to drive this app (a later done-done init will scaffold it)`,
      });
  }
  // Without a usable repo config, the agent keys still come from the global config.
  let agentCfg = cfg;
  try {
    agentCfg ??= loadConfig(repo ?? process.cwd(), '');
  } catch {
    agentCfg = defaultConfig(repo ?? process.cwd());
  }
  const agent = selectAgent(agentCfg);
  const what = `${agent.agent} (model ${agent.model || 'none'}; ${agent.from === 'auto' ? 'agent: auto' : 'from config'})`;
  const startable = ALL_AGENTS.filter(supported).join(' and ');
  checks.push(
    !agent.path
      ? { check: 'agent', status: 'missing', detail: `${what} is not on PATH`, fix: `Install ${agent.agent}, or set agent: to an installed one of ${ALL_AGENTS.join(', ')}` }
      : !supported(agent.agent)
        ? { check: 'agent', status: 'missing', detail: `${what} at ${agent.path}, but done-done cannot start ${agent.agent} yet (${startable} for now)`, fix: `Set agent: to ${startable}` }
        : { check: 'agent', status: 'ok', detail: `${what} at ${agent.path}`, fix: '' },
  );
  if (!cfg) {
    checks.push({ check: 'judge', status: 'missing', detail: 'unknown without a valid config', fix: '' });
  } else {
    try {
      const { bin } = await backend(cfg);
      checks.push({ check: 'judge', status: 'ok', detail: `claude binary at ${bin} with a Claude sign-in and the judge kit; the model is never called`, fix: '' });
    } catch (e) {
      checks.push({ check: 'judge', status: 'missing', detail: (e as Error).message, fix: (e as UsageError).help ?? 'Re-run done-done doctor after fixing the error above' });
    }
  }
  const ffprobe = onPath('ffprobe');
  checks.push(
    ffprobe
      ? { check: 'ffprobe', status: 'ok', detail: `found at ${ffprobe}`, fix: '' }
      : { check: 'ffprobe', status: 'missing', detail: 'no ffprobe on PATH; video evidence is unverified, never a pass', fix: 'Install ffprobe (ffmpeg) to verify video evidence' },
  );
  // The judge --judge runs today is the claude judge; judge.route is recorded but not used until judge routes land.
  const judging = selectJudge(agentCfg, agent.agent);
  const planned = `claude judge (model ${judging.model || 'none'})`;
  const route = agentCfg.judge.route ? `; judge.route ${agentCfg.judge.route} is recorded, not used yet` : '';
  checks.push(
    judging.independence === 'other-agent'
      ? { check: 'judge_choice', status: 'ok', detail: `${planned}, a different agent from the author (${agent.agent})${route}`, fix: '' }
      : agentCfg.judge.allow_same
        ? { check: 'judge_choice', status: 'ok', detail: `${planned} in a fresh session, the same agent as the author; judge.allow_same accepts it (session-only independence)${route}`, fix: '' }
        : { check: 'judge_choice', status: 'missing', detail: `${planned} in a fresh session, the same agent as the author (session-only independence)${route}`, fix: 'Set agent: to an agent other than claude, or set judge.allow_same: true in the global config to accept it' },
  );
  if (values.probe) {
    const record = join(home(), 'agents', `probe-${new Date().toISOString().replace(/[:.]/g, '-')}-${agent.agent}.json`);
    const probe: { ok: boolean; answer?: Record<string, unknown>; error?: string; record?: string } = !agent.path ? { ok: false, error: `${agent.agent} is not on PATH` }
      : !supported(agent.agent) ? { ok: false, error: `done-done cannot start ${agent.agent} yet (${startable} for now)` }
      : askAgent({ agent: agent.agent, model: agent.model, prompt: 'This is a connectivity probe from done-done doctor. Use no tools. Answer with ok set to true.', schema: PROBE_SCHEMA, cwd: repo ?? process.cwd(), timeoutMs: 180_000, tools: 'none', record });
    checks.push(
      probe.ok && probe.answer?.ok === true
        ? { check: 'probe', status: 'ok', detail: `${agent.agent} (model ${agent.model}) answered the schema question; record ${record}`, fix: '' }
        : { check: 'probe', status: 'missing', detail: `${agent.agent} did not answer: ${probe.error ?? `answer ${JSON.stringify(probe.answer)}`}${probe.record ? `; record ${record}` : ''}`, fix: `Check that ${agent.agent} is signed in and can use model ${agent.model}, or set agent_config.${agent.agent}.model` },
    );
  }
  const required = ['git', 'config', 'evidence_root', ...(values.probe ? ['probe'] : [])];
  const missingRequired = checks.filter((c) => c.status === 'missing' && required.includes(c.check));
  const result: Record<string, unknown> = { command: 'doctor', result: missingRequired.length ? 'fail' : 'pass', checks };
  // Several missing items can share one fix (set up the config once); name each fix only once.
  const fixes = [...new Set(missingRequired.map((c) => c.fix).filter(Boolean))];
  if (cfg && repo) {
    const names = Object.keys(cfg.journeys);
    const check = '`done-done check --outcome "<what you proved>" <files it recorded>`';
    result.help = missingRequired.length
      ? fixes
      : names.length
        ? [`Capture proof with \`done-done run ${names[0]}\`, then check it with ${check}`]
        : [`Add a journey to .done-done.yaml, commit, then \`done-done run smoke\` and ${check}`];
  } else {
    result.help = missingRequired.length ? fixes : ['Run `done-done init` to write a minimal .done-done.yaml'];
  }
  emit(result);
  return missingRequired.length ? USAGE : PASS;
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
    evidence_root: shown(repo, cfg.evidence.root),
    journeys,
    runs: loadRecords(cfg).length,
  };
  const check = '`done-done check --outcome "<what you proved>" <files it recorded>`';
  result.help = journeys.length
    ? [`Capture proof with \`done-done run ${journeys[0]}\`, then check it with ${check}`]
    : [`Add a journey to .done-done.yaml (${journeyExample}), commit, then \`done-done run smoke\` and ${check}`];
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
  const sub = Object.hasOwn(COMMANDS, cmd) ? cmd : undefined;
  if (sub && (kept.includes('--help') || kept.includes('-h'))) {
    console.log(commandHelp(sub));
    return PASS;
  }
  try {
    if (cmd === 'init') return cmdInit(rest);
    if (cmd === 'doctor') return await cmdDoctor(rest);
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
    emit({ command: sub ?? 'done-done', error: msg, help: e instanceof UsageError && e.help ? [e.help] : errorHelp(msg, sub) });
    return USAGE;
  }
}

process.exitCode = await main(process.argv.slice(2));
