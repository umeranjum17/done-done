#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { encode } from '@toon-format/toon';
import { Document, parseDocument } from 'yaml';
import { ACPX_INSTALL, agentChoices, askAgent, findBin, JUDGES, knownAgentOf, noAgent, selectAgent, selectJudge, supported, type AgentAnswer, type JudgeChoice } from './agents.js';
import { AGENTS, CHEAP, type Config, globalConfigText, home, isAgent, loadConfig, parseDuration, UsageError } from './config.js';
import { backend, type Capture, judge, judgeable, type Judged, onPath, quote } from './judge.js';
import { type Finding as MaintainFinding, maintainSteps, type MaintainResult } from './maintain.js';
import { design, KINDS } from './design.js';
import { checkMedia } from './media.js';

const PASS = 0, FAIL = 1, USAGE = 2, INCONCLUSIVE = 3, WAITING = 4;

// The shape of a journey, so a new user or agent can write one without opening the reference.
// done-done sets DONE_DONE_EVIDENCE_ROOT (the run's own folder) and replaces ${RUN_ID}, so the example works for any evidence root.
const journeyExample = 'journeys: { smoke: { command: "<drive the real app> > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log" } }';

const JOURNEYS_TEXT = `journeys (.done-done.yaml): the command runs with DONE_DONE_EVIDENCE_ROOT (this run's own new folder in the evidence
  root) and DONE_DONE_RUN_ID set, and \${RUN_ID} in it is replaced; it must write its files into that folder, e.g.
  ${journeyExample}
  timeout (journeys.<name>.timeout): how long a verify run may drive the journey, e.g. 90s or 30m (default 30m); past it the journey is killed and the run is inconclusive`;
const CHECKS_TEXT = `Checks block (--from): the newest "## Checks" heading, then these four keys, each at the start of a line:
  outcome: <what a user can now do>
  repro: <command that failed before and passes now, or n/a; a fix PR needs one>
  proof: <the command or path that drove the real product; name the repo's verify-<app> skill, or say "no verify skill">
  evidence: <the evidence file paths, or "not proven: <cause>">`;
const RUNS_TEXT = `runs: each verify or maintain run lives in $DONE_DONE_HOME/runs/<app>/<run-id> (run.json, events.jsonl, logs/<step>.log,
  agents/<n>-<name>.json for each agent call) and goes on when the command that started it ends;
  verify steps: resolve, drive (the journey), check, judge (with --judge), receipt, report; maintain steps: locate, hygiene, source-wave, reconcile, report`;
const MAINTAIN_TEXT = `maintain reads the verify skill and the source and edits nothing; HEAD, git status and the content of changed files must be the same before and after.
  locate: the verify skill (.agents/skills/verify-<app>/SKILL.md); none: blocked, create it with done-done init
  hygiene: every local link in the skill resolves; features/README.md lists each features/*.md file once
  source-wave: one fresh read-only reader per feature file at the configured agent (agent, agent_config) explains it from source
  reconcile: each file:line the skill or a reader cites must exist (a bare file name matches a tracked file); one tool-less call
  merges the recipes and names recently changed source (git log, 30 days) that no feature covers. Result: clean (exit 0),
  drift with findings (exit 1), or blocked (no skill, a reader that did not answer, a repo that changed, or no agent: the
  readers and the merge call do not run, the plain checks still do; exit 3)`;
const DOCTOR_TEXT = `doctor changes nothing except the --probe call record (the agent itself may keep its own session files) and exits 0 when every required item is ok, 2 otherwise.
  required: git (inside a repository), config (a valid .done-done.yaml), evidence_root (writable).
  optional: verify_skill (.agents/skills/verify-<app>/), agent (the agent the user set and its model; missing when none is
  set, with the command that saves the user's choice), agent_settings (agent, model, effort,
  args, path and agent_timeout, each with the file it came from: the global config, .done-done.yaml or default), judge (the judge route is ready: for claude-code an
  executable claude binary, a sign-in folder and the judge kit, for answerer:<agent> that agent's CLI and the kit; the model is never called),
  judge_choice (the judge, and how far it is from the author: another agent, another model, or session-only), ffprobe (video evidence only).
  --probe also asks the agent one JSON-schema question (one call at the agent's model: its cheap default where it has one, else its own; set agent_config.<agent>.model to choose; its record goes to
  $DONE_DONE_HOME/agents/) and then requires a valid answer.
  doctor lists every check; --full changes nothing. Missing optionals never fail the run.`;
const CONFIG_TEXT = `config: ~/.done-done/config.yaml (global; DONE_DONE_HOME moves it) and .done-done.yaml (the repo), repo over global.
  agent (either file): claude, codex, opencode, pi, gemini or acp:<target>, set by the user (done-done init --agent); done-done never picks one.
  global only: agent_config.<agent>.{model,effort} (effort: minimal, low, medium, high, xhigh, max), agent_args_override.<agent>
  (extra flags), agent_path_override.<agent> (binary), acpx_path, agent_timeout (one agent call, default 30m),
  evidence.local_root, judge.{route,model,allow_same,claude_code.config_dir}. done-done doctor shows where each agent setting came from.`;

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
  '--judge': 'a judge that is a different agent from the author (with only the author agent installed, a different cheap model) says whether each PNG/JPEG capture shows the outcome (off by default; or judge.enabled: true)',
  '--verify <head>': 'read-only: verify the receipt recorded for <head>',
  '--outcome "<what a user can now do>"': 'the outcome the run must prove',
  '--wait': 'wait until the run ends (the default)',
  '--no-wait': 'start the run and return at once (exit 4); read it later with done-done status',
  '--foreground': 'run every step in this process instead of a detached runner (use in CI)',
  '--run <run-id>': 'the run to show (default: the newest run of this checkout)',
  '--probe': 'ask the configured agent one JSON-schema question and require a valid answer (one call at the agent\'s model: its cheap default where it has one, else its own; set agent_config.<agent>.model to choose)',
  '--mock <screen>=<mock>': 'judge this screen next to its approved mock (repeat per screen; the screen is judged even when not listed)',
  '--step <name>': 'the step log to show (verify: resolve, drive, check, judge, receipt, report; maintain: locate, hygiene, source-wave, reconcile, report)',
  '--limit <n>': 'how many past runs to list (default all)',
  '--agent <agent>': 'the coding agent done-done starts (claude, opencode, pi, gemini or acp:<target>), saved as agent in ~/.done-done/config.yaml; without it, init asks in a terminal',
  '--model <model>': 'with --agent: that agent\'s model, saved as agent_config.<agent>.model (opencode: provider/model)',
  '--hook <agent>': 'also add a SessionStart hook to .claude/settings.json (claude), .codex/hooks.json (codex) or .gemini/settings.json (gemini) that shows `done-done` to each session, or a plugin to .opencode/plugins (opencode) or an extension to .pi/extensions (pi) that adds it to the first message of each session (opt-in)',
};
// `more` is the reference text a command needs beyond its flags, shared with the top-level help.
const COMMANDS: Record<string, { usage: [string, string][]; flags: string[]; more: string[] }> = {
  init: {
    usage: [
      ['done-done init', 'write a minimal .done-done.yaml (evidence lives outside the repo) and, when absent, a commented ~/.done-done/config.yaml'],
      ['done-done init', 'scaffold .agents/skills/verify-<app> from this repo (never overwrites)'],
      ['done-done init --agent opencode --model opencode-go/muse-spark-1.3-contributor', 'set the coding agent done-done starts and its model (in a terminal, init asks when none is set)'],
      ['done-done init --hook claude', 'also show this repo\'s done-done state at each Claude Code session start'],
      ['done-done init --hook codex', 'also show this repo\'s done-done state at each Codex session start'],
      ['done-done init --hook opencode', 'also add this repo\'s done-done state to the first message of each opencode session'],
      ['done-done init --hook pi', 'also add this repo\'s done-done state to the first prompt of each pi session'],
      ['done-done init --hook gemini', 'also show this repo\'s done-done state at each Gemini CLI session start'],
      ['done-done init --journey <name> -- <command...>', "record a journey's capture recipe in .done-done.yaml"],
    ],
    flags: ['--agent <agent>', '--model <model>', '--hook <agent>', '--journey <name>', '-- <command...>'],
    more: [JOURNEYS_TEXT, CONFIG_TEXT],
  },
  doctor: {
    usage: [
      ['done-done doctor', 'check this repo is worth driving: git, config, evidence root, skill, agent, judge, ffprobe'],
      ['done-done doctor --probe', 'also ask the configured agent one question to prove it answers'],
    ],
    flags: ['--probe'],
    more: [DOCTOR_TEXT, CONFIG_TEXT],
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
  verify: {
    usage: [
      ['done-done verify [<journey>] --outcome "<what a user can now do>" [--claim-id <id>] [--judge]', 'drive the journey in a run that outlives this command, check its evidence and record a receipt'],
      ['done-done verify [<journey>] --outcome "<claim>" --no-wait | --wait | --foreground', 'return at once, wait until the run ends (default), or run in this process (CI)'],
    ],
    flags: ['--outcome "<what a user can now do>"', '--claim-id <id>', '--judge', '--wait', '--no-wait', '--foreground'],
    more: [RUNS_TEXT],
  },
  maintain: {
    usage: [['done-done maintain [--no-wait | --wait | --foreground]', 'check the verify skill against the source in a run: links, index, cited file:line, one read-only reader per feature; edits nothing']],
    flags: ['--wait', '--no-wait', '--foreground'],
    more: [MAINTAIN_TEXT, RUNS_TEXT],
  },
  design: {
    usage: [['done-done design <screens...> [--mock <screen>=<mock>]', 'a judge looks at each PNG/JPEG screen, alone or next to its mock, and fails it on visual defects']],
    flags: ['--mock <screen>=<mock>'],
    more: [`design: one judge request per screen (the --judge route, never the author); it fails a screen on any defect it names:
  ${Object.keys(KINDS).join(', ')}; capture each variant (dark, small width, large font) as its own screen; exit 0 every screen
  passed, 1 a screen failed, 3 none failed but one is unsure`],
  },
  status: {
    usage: [['done-done status [--run <run-id>]', "show a run's steps, result, findings and next step"]],
    flags: ['--run <run-id>'],
    more: [RUNS_TEXT],
  },
  attach: {
    usage: [['done-done attach [--run <run-id>]', "stream a run's events until it ends, then show it"]],
    flags: ['--run <run-id>'],
    more: [RUNS_TEXT],
  },
  logs: {
    usage: [['done-done logs --step <name> [--run <run-id>] [--full]', 'show a step log (tail by default)']],
    flags: ['--step <name>', '--run <run-id>'],
    more: [RUNS_TEXT],
  },
  rerun: {
    usage: [['done-done rerun [--run <run-id>] [--wait | --no-wait]', 'run again from the failed step, reusing steps whose inputs did not change; wait (default) or return at once (exit 4)']],
    flags: ['--run <run-id>', '--wait', '--no-wait'],
    more: [RUNS_TEXT],
  },
  abort: {
    usage: [['done-done abort [--run <run-id>]', 'stop a live run and its journey, and mark it cancelled']],
    flags: ['--run <run-id>'],
    more: [RUNS_TEXT],
  },
  history: {
    usage: [['done-done history [--limit <n>]', 'list past runs, newest first']],
    flags: ['--limit <n>'],
    more: [RUNS_TEXT],
  },
};

const rows = (pairs: [string, string][], width = Math.max(...pairs.map(([a]) => a.length)) + 3) => pairs.map(([a, b]) => `  ${a}${' '.repeat(Math.max(3, width - a.length))}${b}`).join('\n');
const GLOBAL_TEXT = `global flags: --json (JSON instead of TOON), --full (do not truncate lists), --help (this command's usage)
exit codes: 0 pass, 1 fail, 2 usage or config error, 3 inconclusive, 4 the run is still running (verify, maintain, rerun, status)`;

const USAGE_TEXT = `install: npm install -g --prefix ~/.local --allow-git=all github:umeranjum17/done-done-axi (installs done-done-axi and done-done), or run npx -y --allow-git=all github:umeranjum17/done-done-axi <command>
usage:
${rows([['done-done', "show this repo's config state and the next step"], ...Object.values(COMMANDS).flatMap((c) => c.usage)], 46)}
${GLOBAL_TEXT}
--judge (or judge.enabled: true): a model on your own plan, through BYOKit, says whether each PNG/JPEG capture
  shows the outcome; a wrong screen fails, an unsure answer is inconclusive. Off by default. The judge is judge.route
  (claude-code, or answerer:<agent> through that agent's CLI), or with auto the first installed agent that is not the author; with only the author's agent, its cheap model (a fresh session of the author's own model only when that cheap model is the same).

${JOURNEYS_TEXT}
${CHECKS_TEXT}
${CONFIG_TEXT}

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

const emitted = (r: { code: number; result: Record<string, unknown> }) => (emit(r.result), r.code);

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

// The random suffix keeps two runs in the same second at one commit apart; mkdir without recursive refuses a reused id.
const newRunId = (commit: string) => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${commit.slice(0, 8)}-${randomBytes(3).toString('hex')}`;

function openRun(repo: string, cfg: Config, journey: string | null, command: string | null, id?: string): RunRecord {
  const h = head(repo);
  const runId = id ?? newRunId(h.commit);
  mkdirSync(cfg.evidence.root, { recursive: true });
  mkdirSync(runDir(cfg, runId));
  return { schema: 1, run_id: runId, journey, command, ...h, started_at: new Date().toISOString(), ended_at: null, exit: null, files: [] };
}

function closeRun(repo: string, cfg: Config, rec: RunRecord): { code: number; result: Record<string, unknown>; reason: string } {
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
  return { code: reason ? FAIL : PASS, result, reason };
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
    return emitted(closeRun(repo, cfg, rec));
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
  return emitted(closeRun(repo, cfg, rec));
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

// The judge block a receipt keeps: who judged, how apart from the author, and each judged capture's verdict.
type JudgeBlock = { route: string; model: string; independence: JudgeChoice['independence']; author: JudgeChoice['author']; verdicts: { path: string; sha256: string; verdict: string }[] };

type CheckOutcome = {
  code: number;
  judge?: Record<string, unknown>;
  judgeBlock?: JudgeBlock;
  result: Record<string, unknown>;
  claim?: string;
  files: string[];
  cited: { path: string; sha256: string }[];
  head: { commit: string; tree: string; dirty: boolean };
  findings: Finding[];
};

// Run a check and return its result without printing it, so `check` and `receipt` share one path.
// run: a verify run's folder (the judge's call records go to its agents/) and the hook that starts its judge step.
async function runCheck(argv: string[], run?: { dir: string; judging: (code: number, findings: Finding[]) => void }): Promise<CheckOutcome> {
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
    const all = findings.concat(allowed ? [] : [{ level: 'inconclusive', why: `not proven: ${claim.notProven}` }]);
    const rep = report(all, [], { cfg, repo, claim: claim.outcome, source: values.from, notProven: true }, allowed ? 'not proven (allowed by trusted config)' : '');
    return { code: rep.code, result: rep.result, claim: claim?.outcome, files: [], cited: [], head: now, findings: all };
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
  let judgeBlock: JudgeBlock | undefined;
  let judgeLevel: Finding['level'] | undefined;
  if ((values.judge || cfg.judge.enabled) && claim) {
    // A judge pass never overrides a failed deterministic check: on a fail, no capture is judged.
    if (findings.some((f) => f.level === 'fail')) judged = { skipped: 'the check already failed, so no capture was judged' };
    else {
      // Only a capture the judge reads needs the user's agent (the judge is kept apart from it).
      if (captures.some(judgeable)) await withAgent(cfg);
      if (captures.some(judgeable)) run?.judging(findings.length ? INCONCLUSIVE : PASS, [...findings]);
      const j = await judge(cfg, () => selectJudge(cfg, selectAgent(cfg)), claim.outcome, captures, run ? join(run.dir, 'agents') : join(home(), 'agents'));
      // The judge's next step leads the help when its verdict decides the result.
      if (j.judged.some((r) => r.verdict === 'fail')) judgeLevel = 'fail';
      else if (!findings.length && j.judged.some((r) => r.verdict === 'unsure')) judgeLevel = 'inconclusive';
      for (const r of j.judged.filter((r) => r.verdict !== 'pass'))
        findings.push({ level: r.verdict === 'fail' ? 'fail' : 'inconclusive', why: `${r.path}: judge says ${r.verdict === 'fail' ? 'wrong screen' : 'unsure'}: ${r.reason}` });
      const rows = cap<Judged>(j.judged);
      const { choice } = j;
      judged = { ...(choice && { route: choice.route, model: choice.model, independence: choice.independence, author: `${choice.author.agent} (model ${choice.author.model || 'none'})` }), judged: rows.items.map(({ sha256, ...r }) => r) };
      if (choice && j.judged.length) {
        const byName = new Map(captures.map((c) => [c.name, receiptPath(repo, cfg, resolve(c.name))]));
        judgeBlock = { route: choice.route, model: choice.model, independence: choice.independence, author: choice.author, verdicts: j.judged.map((r) => ({ path: byName.get(r.path)!, sha256: r.sha256, verdict: r.verdict })) };
      }
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
  return { code: rep.code, result: rep.result, judge: judged, judgeBlock, claim: claim?.outcome, files, cited, head: now, findings };
}

async function cmdCheck(argv: string[]): Promise<number> {
  const r = await runCheck(argv);
  emit(r.result);
  return r.code;
}

// A receipt ties one passing check to one commit and to the sha256 of every file it cited.
// Schema 2 adds the judge block, written when a judge passed the captures; a receipt without one stays schema 1.
type Receipt = {
  schema: 1 | 2;
  repo: string;
  head: string;
  tree: string;
  claim: string;
  result: 'pass';
  at: string;
  files: { path: string; sha256: string }[];
  judge?: JudgeBlock;
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
  if (!rec || typeof rec !== 'object' || (rec.schema !== 1 && rec.schema !== 2) || rec.result !== 'pass' || !Array.isArray(rec.files) || !rec.files.length) return fail(`receipt for ${short} is malformed`);
  if (!rec.files.every((f) => f && typeof f === 'object' && typeof f.path === 'string' && typeof f.sha256 === 'string')) return fail(`receipt for ${short} is malformed`);
  // A schema 2 judge block must name its judge, and pass only captures this receipt cites.
  const j = rec.judge;
  if (rec.schema === 2 && (!j || typeof j !== 'object' || typeof j.route !== 'string' || typeof j.model !== 'string' || !['agent', 'model', 'session-only'].includes(j.independence) || !Array.isArray(j.verdicts) || !j.verdicts.length
    || !j.verdicts.every((v) => v && v.verdict === 'pass' && rec.files.some((f) => f.path === v.path && f.sha256 === v.sha256))))
    return fail(`receipt for ${short} has a malformed judge block`);
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
  emit({ command: 'receipt', result: 'pass', head: commit, tree: rec.tree, claim: rec.claim, files: rec.files.length, at: rec.at, schema: rec.schema, ...(rec.schema === 2 && { judge: j }), help: ['This receipt is valid for this head.'] });
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
  return emitted(recordReceipt(repo, cfg, await runCheck(rest)));
}

// Write the receipt for a check that passed on a clean tree and cited evidence, or say why none was written.
function recordReceipt(repo: string, cfg: Config, r: CheckOutcome): { code: number; result: Record<string, unknown> } {
  if (r.code !== PASS) return { code: r.code, result: { ...r.result, command: 'receipt', reason: 'the check did not pass, so no receipt was written' } };
  if (r.head.dirty)
    return { code: FAIL, result: { command: 'receipt', result: 'fail', head: r.head.commit, claim: r.claim, reason: 'tracked files have uncommitted changes; commit or revert them, then re-run receipt', help: ['Commit the tracked changes, then: done-done receipt --from <file|->'] } };
  if (!r.cited.length)
    return { code: FAIL, result: { command: 'receipt', result: 'fail', head: r.head.commit, claim: r.claim, reason: 'the check cited no evidence files, so no receipt was written; a receipt must bind at least one cited evidence file', help: ['Cite real proof: done-done receipt --outcome "<claim>" <files...>'] } };
  const rec: Receipt = { schema: r.judgeBlock ? 2 : 1, repo: cfg.app, head: r.head.commit, tree: r.head.tree, claim: r.claim ?? '', result: 'pass', at: new Date().toISOString(), files: r.cited, ...(r.judgeBlock && { judge: r.judgeBlock }) };
  const path = writeReceipt(cfg, rec);
  const result = { command: 'receipt', result: 'pass', head: r.head.commit, tree: r.head.tree, claim: rec.claim, files: rec.files.length, receipt: shown(repo, path) };
  return { code: PASS, result: { ...result, ...(r.judge && { judge: r.judge }), help: [`Verify this receipt (CI or merge): done-done receipt --verify ${r.head.commit}`] } };
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

// The run store: one folder per run in $DONE_DONE_HOME/runs/<app>/<run-id>. The command that opens a run writes
// run.json before it starts the runner; from then on only that run's runner writes it, and status only reads it.
type StepState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
type Step = { name: string; status: StepState; started?: string; ended?: string; exit?: number; outputs?: string[]; findings?: unknown };
type Run = {
  schema: 2; run_id: string; kind: 'verify' | 'maintain'; app: string; repo: string; journey?: string; claim?: string; claim_id: string | null; judge?: boolean;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  runner?: { pid: number; started: string; heartbeat: string; journey_pgid?: number }; steps: Step[];
  result?: 'pass' | 'fail' | 'inconclusive' | MaintainResult; reason?: string; findings?: MaintainFinding[]; unverified?: string[]; git_status?: string;
  record?: string; receipt?: string; created: string; updated: string;
  inputs?: { head: string; journey: string; skill: string };
};

const CLI_PATH = fileURLToPath(import.meta.url);
const HEARTBEAT_MS = 5_000;
// A run that never recorded its runner's pid this long after it was created has no runner.
const STALE_MS = 60_000;
const runsRoot = (app: string) => join(home(), 'runs', app);
const STEPS = ['resolve', 'drive', 'check', 'judge', 'receipt', 'report'];
const now = () => new Date().toISOString();
const errorText = (e: unknown) => ((e as { stderr?: string }).stderr || (e as Error).message || String(e)).trim();
const killGroup = (pgid: number) => {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // The group already exited.
  }
};
const createOnce = (path: string) => {
  try {
    writeFileSync(path, '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
};
const evidenceOf = (repo: string, cfg: Config, rec: RunRecord) => rec.files.map((f) => citable(repo, join(cfg.evidence.root, f.path)));

// Default run: the newest run of this checkout, as status does.
function pickId(root: string, repo: string, cmd: string, cfg: Config, id?: string): string {
  const mine = existsSync(root) ? readdirSync(root).filter((n) => existsSync(join(root, n, 'run.json'))).map((n) => loadRun(join(root, n))).filter((r) => r.repo === repo) : [];
  const found = id ?? mine.sort((a, b) => a.created.localeCompare(b.created)).pop()?.run_id;
  if (!found) throw new UsageError(`no runs for ${cfg.app} in this checkout yet`, `Start one: done-done verify ${Object.keys(cfg.journeys).length > 1 ? '<journey> ' : ''}--outcome "<what a user can now do>"`);
  if (!/^[\w-]+$/.test(found) || !existsSync(join(root, found, 'run.json'))) throw new UsageError(`no run ${found} in ${root}`, `Show the newest run: done-done ${cmd}`);
  return found;
}

function skillHash(repo: string, cfg: Config): string {
  const dir = join(repo, cfg.skill);
  if (!existsSync(dir)) return '';
  try {
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
    const h = createHash('sha256');
    for (const f of files) h.update(readFileSync(f));
    return h.digest('hex');
  } catch {
    return '';
  }
}

function inputsOf(repo: string, cfg: Config, journey: string) {
  const h = head(repo);
  const j = cfg.journeys[journey];
  return { head: h.commit, journey: sha256(Buffer.from(`${j?.command ?? ''}\n${j?.timeout ?? '30m'}`)), skill: skillHash(repo, cfg) };
}

function saveRun(dir: string, run: Run) {
  run.updated = now();
  const tmp = join(dir, `run.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(tmp, join(dir, 'run.json'));
}
const loadRun = (dir: string): Run => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
const logEvent = (dir: string, e: Record<string, unknown>) => appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ at: now(), ...e })}\n`);

// A run's steps in its runner. verify is all plain code: resolve the head, drive the journey, check its evidence, record a
// receipt, report. maintain (maintain.ts) reads the verify skill and the source.
async function runSteps(dir: string): Promise<void> {
  const run = loadRun(dir);
  if (run.status === 'cancelled') return;
  const started = now();
  // The lock refuses a second runner on this run; it stays, so a finished run is never run again.
  writeFileSync(join(dir, 'runner.lock'), `${process.pid} ${started}\n`, { flag: 'wx' });
  run.status = 'running';
  run.runner = { pid: process.pid, started, heartbeat: started };
  saveRun(dir, run);
  logEvent(dir, { status: 'running', pid: process.pid });
  const beat = setInterval(() => {
    run.runner!.heartbeat = now();
    saveRun(dir, run);
  }, HEARTBEAT_MS);
  let step: Step | undefined;
  const set = (s: Step, status: StepState, extra: Partial<Step> = {}) => {
    Object.assign(s, { status, [status === 'running' ? 'started' : 'ended']: now() }, extra);
    logEvent(dir, { step: s.name, status });
    saveRun(dir, run);
  };
  const begin = (name: string) => (set((step = run.steps.find((s) => s.name === name)!), 'running'), step);
  const log = (name: string, result: Record<string, unknown>) => writeFileSync(join(dir, 'logs', `${name}.log`), `${encode(result)}\n`);
  const finish = (result: Run['result'], reason?: string) => {
    for (const s of run.steps) if (s.status === 'pending' && s.name !== 'report') s.status = 'skipped';
    begin('report');
    Object.assign(run, { result, reason, status: 'completed' });
    set(step!, 'completed');
  };
  try {
    const cfg = loadConfig(run.repo);
    if (run.kind === 'maintain') return await maintainSteps(run, dir, cfg, { begin, set, log, finish });
    const done = (n: string) => run.steps.find((s) => s.name === n)!.status === 'completed';
    const journey = cfg.journeys[run.journey!];
    const command = journey?.command;
    const timeout = journey?.timeout ?? '30m';
    const limit = parseDuration(timeout);
    const reused = done('resolve');
    if (reused) logEvent(dir, { step: 'resolve', status: 'completed', reused: true });
    else begin('resolve');
    if (!command) throw new Error(`journey ${run.journey} is not in .done-done.yaml`);
    if (limit === null) throw new Error(`journeys.${run.journey}.timeout must be a duration such as 30m or 90s, not ${timeout}`);
    if (!reused) set(step!, 'completed');

    let rec: RunRecord;
    if (done('drive') && run.record) {
      begin('drive');
      rec = JSON.parse(readFileSync(run.record, 'utf8'));
      set(step!, 'completed');
    } else {
      begin('drive');
      rec = openRun(run.repo, cfg, run.journey!, command!.replaceAll('${RUN_ID}', run.run_id), run.run_id);
      const fd = openSync(join(dir, 'logs', 'drive.log'), 'a');
    // An async child keeps the heartbeat going while the journey runs. The journey gets its own process group, so a
    // timeout or a dead runner can kill it and everything it started.
    const child = spawn(rec.command!, { cwd: run.repo, shell: true, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, DONE_DONE_RUN_ID: rec.run_id, DONE_DONE_EVIDENCE_ROOT: runDir(cfg, rec.run_id) } });
    run.runner!.journey_pgid = child.pid;
    saveRun(dir, run);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid!);
    }, limit!);
    rec.exit = await new Promise<number>((done) => child.on('close', (code) => done(code ?? 1)));
    clearTimeout(timer);
    closeSync(fd);
    const sealed = closeRun(run.repo, cfg, rec);
    run.record = join(recordsDir(cfg), `${rec.run_id}.json`);
    set(step!, sealed.code === PASS ? 'completed' : 'failed', { exit: rec.exit, outputs: evidenceOf(run.repo, cfg, rec) });
    if (timedOut) return finish('inconclusive', `drive: journey timed out after ${timeout}`);
    if (sealed.code !== PASS) return finish('fail', `drive: ${sealed.reason}`);
    }

    begin('check');
    const files = rec.files.map((f) => join(cfg.evidence.root, f.path));
    // The check's own findings end the check step; the judge, when on and the check did not fail, is its own step.
    let checkFindings = 0;
    const judging = (code: number, findings: Finding[]) => {
      checkFindings = findings.length;
      set(step!, code === PASS ? 'completed' : 'failed', { exit: code, findings });
      begin('judge');
    };
    const checked = await runCheck(['--outcome', run.claim!, ...files, ...(run.claim_id ? ['--claim-id', run.claim_id] : []), ...(run.judge ? ['--judge'] : [])], { dir, judging });
    const logged: Record<string, unknown> = { ...checked.result, findings: checked.findings };
    delete logged.findings_omitted;
    log('check', logged);
    const judgeRan = step!.name === 'judge';
    const judgeFindings = judgeRan ? checked.findings.slice(checkFindings) : [];
    if (judgeRan) {
      log('judge', checked.judge!);
      set(step!, judgeFindings.length ? 'failed' : 'completed', { exit: judgeFindings.length ? checked.code : PASS, findings: judgeFindings });
    } else set(step!, checked.code === PASS ? 'completed' : 'failed', { exit: checked.code, findings: checked.findings });
    if (checked.code !== PASS) return finish(checked.code === FAIL ? 'fail' : 'inconclusive', `${judgeFindings.length ? 'judge' : 'check'}: ${(judgeFindings[0] ?? checked.findings[0])?.why ?? 'did not pass'}`);

    begin('receipt');
    const receipt = recordReceipt(run.repo, cfg, checked);
    log('receipt', receipt.result);
    run.receipt = receipt.result.receipt as string | undefined;
    set(step!, receipt.code === PASS ? 'completed' : 'failed', { exit: receipt.code });
    if (receipt.code !== PASS) return finish('fail', `receipt: ${receipt.result.reason}`);
    finish('pass');
  } catch (e) {
    for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped';
    const name = step?.name ?? 'setup';
    const text = errorText(e);
    Object.assign(run, { status: 'failed', reason: text.startsWith(`${name}:`) ? text : `${name}: ${text}` });
    if (step) set(step, 'failed');
    else {
      logEvent(dir, { status: 'failed' });
      saveRun(dir, run);
    }
  } finally {
    clearInterval(beat);
  }
}

// EPERM: the pid is alive but not ours to signal. A pid reused by another process still reads as alive: the known limit of a pid check.
const alive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const runnerGone = (run: Run) => (run.runner ? !alive(run.runner.pid) : Date.now() - Date.parse(run.created) > STALE_MS);
const isOurRunner = (pid: number, dir: string) => {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes(`__runner ${dir}`);
};
const shownStatus = (run: Run): Run['status'] => ((run.status === 'pending' || run.status === 'running') && runnerGone(run) ? 'failed' : run.status);
const reapJourney = (dir: string, run: Run) => {
  if (run.runner?.journey_pgid && createOnce(join(dir, 'journey.killed'))) killGroup(run.runner.journey_pgid);
};

// One run as status shows it. A run still marked running whose runner is gone is shown as failed at its step.
// `gone`: the caller saw its runner child exit, which also covers a runner that died before it wrote its pid.
function showRun(dir: string, cfg: Config, command: string, gone = false): number {
  const run = loadRun(dir);
  const rec: RunRecord | undefined = run.record ? JSON.parse(readFileSync(run.record, 'utf8')) : undefined;
  const at = run.steps.find((s) => s.status === 'running') ?? run.steps.find((s) => s.status === 'pending');
  let { status, reason } = run;
  const open = status === 'pending' || status === 'running';
  if (open && (gone || runnerGone(run))) {
    status = 'failed';
    const beat = run.runner && Math.round((Date.now() - Date.parse(run.runner.heartbeat)) / 1000);
    reason = `the runner died at step ${at?.name}${run.runner ? ` (pid ${run.runner.pid}, last heartbeat ${beat}s ago)` : ' before it started'}`;
    reapJourney(dir, run);
  }
  const code = status === 'pending' || status === 'running' ? WAITING : status === 'cancelled' || status === 'failed' || run.result === 'fail' || run.result === 'drift' ? FAIL : run.result === 'inconclusive' || run.result === 'blocked' ? INCONCLUSIVE : PASS;
  const again = run.kind === 'maintain' ? 'done-done maintain' : `done-done verify ${run.journey} --outcome ${arg(run.claim!)}${run.claim_id ? ` --claim-id ${arg(run.claim_id)}` : ''}`;
  const findings = cap(run.findings ?? []);
  const ev = cap(rec ? evidenceOf(run.repo, cfg, rec) : []);
  const result: Record<string, unknown> = { command, run_id: run.run_id, kind: run.kind, status };
  if (code === WAITING) result.step = at?.name;
  if (run.result && status === 'completed') result.result = run.result;
  if (reason) result.reason = reason;
  Object.assign(result, { ...(run.kind === 'verify' && { claim: run.claim, journey: run.journey }), repo: run.repo, ...(rec && { head: rec.commit }), steps: run.steps.map((s) => ({ name: s.name, status: s === at && (status === 'failed' || (status === 'cancelled' && s.status === 'running')) ? status : s.status })) });
  if (ev.items.length) result.evidence = ev.items;
  if (ev.omitted) result.evidence_omitted = ev.omitted;
  if (run.receipt) result.receipt = run.receipt;
  if (run.git_status) result.git_status = run.git_status;
  if (findings.items.length) result.findings = findings.items;
  if (findings.omitted) result.findings_omitted = findings.omitted;
  const unverified = cap(run.unverified ?? []);
  if (unverified.items.length) result.unverified = unverified.items;
  if (unverified.omitted) result.unverified_omitted = unverified.omitted;
  result.run = shown(run.repo, dir);
  result.help =
    code === WAITING ? [`The run goes on without this command; read it later: done-done status --run ${run.run_id}`]
    : run.kind === 'maintain' && status === 'completed' ? (
      run.result === 'clean' ? [`The verify skill matches the source; read the readers' recipes: done-done logs --step reconcile --run ${run.run_id}`]
      : run.result === 'drift' ? [`Fix the findings in ${cfg.skill} (maintain edits nothing; --full lists them all), commit, then run again: ${again}`]
      : /^locate: no verify skill/.test(run.reason ?? '') ? ['Create the verify skill: done-done init']
      : /^locate:/.test(run.reason ?? '') ? [`Make ${cfg.skill} a real folder inside the repository (not a link), commit, then run again: ${again}`]
      : [`Read the step logs in ${shown(run.repo, join(dir, 'logs'))}`, `Fix the cause, then run again: ${again}`])
    : code === PASS ? [`Verify this receipt (CI or merge): done-done receipt --verify ${rec!.commit}`]
    : status === 'cancelled' ? [...(run.kind === 'maintain' ? [] : [`Start again from the failed step: done-done rerun --run ${run.run_id}`]), `List past runs: done-done history`]
    : [`Read the step logs in ${shown(run.repo, join(dir, 'logs'))}`, ...(run.kind === 'maintain' ? [] : [`Fix the cause, commit, then run again from the failed step: done-done rerun --run ${run.run_id}`]), `Or start a new run: ${again}`];
  emit(result);
  return code;
}

async function waitRun(dir: string, pid: number): Promise<void> {
  while (['pending', 'running'].includes(loadRun(dir).status) && alive(pid)) await new Promise((r) => setTimeout(r, 200));
}

async function cmdVerify(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { outcome: { type: 'string' }, 'claim-id': { type: 'string' }, judge: { type: 'boolean' }, wait: { type: 'boolean' }, 'no-wait': { type: 'boolean' }, foreground: { type: 'boolean' } },
    allowPositionals: true,
  });
  if (!values.outcome?.trim()) throw new UsageError('verify needs --outcome "<what a user can now do>"');
  if (positionals.length > 1) throw new UsageError('verify takes at most one journey name');
  if ([values.wait, values['no-wait'], values.foreground].filter(Boolean).length > 1) throw new UsageError('pass only one of --wait, --no-wait and --foreground');
  const repo = repoRoot();
  const cfg = loadConfig(repo);
  const names = Object.keys(cfg.journeys);
  const journey = positionals[0] ?? (names.length === 1 ? names[0] : undefined);
  if (!journey && names.length) throw new UsageError(`verify needs a journey name; .done-done.yaml defines: ${names.join(', ')}`, `Run: done-done verify <${names.join('|')}> --outcome "<what a user can now do>"`);
  if (!journey) throw new UsageError('verify needs a journey, and .done-done.yaml defines none', 'Record one: done-done init --journey <name> -- <command that drives the real app>');
  if (!cfg.journeys[journey]) throw new UsageError(`unknown journey ${journey}; .done-done.yaml defines: ${names.join(', ')}`);
  if (values['claim-id']?.trim() === '') throw new UsageError('--claim-id needs a non-empty id');
  if (!values['claim-id'] && !git(repo, 'branch', '--show-current')) throw new UsageError('HEAD is detached, so no branch names this claim; pass --claim-id <id>');
  const judging = !!values.judge || cfg.judge.enabled;
  // A judge that config forbids (the author's own agent and model) is a usage error now, not a failed run later.
  if (judging) await withAgent(cfg);
  if (judging && cfg.judge.route !== 'auto') selectJudge(cfg, selectAgent(cfg));
  const id = newRunId(git(repo, 'rev-parse', 'HEAD'));
  const dir = join(runsRoot(cfg.app), id);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const created = now();
  const run: Run = {
    schema: 2, run_id: id, kind: 'verify', app: cfg.app, repo, journey, claim: values.outcome, claim_id: values['claim-id'] ?? null, judge: judging, status: 'pending',
    steps: STEPS.map((name) => ({ name, status: 'pending' })), created, updated: created,
    inputs: inputsOf(repo, cfg, journey),
  };
  saveRun(dir, run);
  logEvent(dir, { status: 'pending' });
  return launch(dir, cfg, 'verify', values);
}

// Run the steps in this process (--foreground), or in a detached runner with no pipe back to this process, so the
// runner goes on when this command or its shell ends; --wait (the default) holds this command until the run ends.
async function launch(dir: string, cfg: Config, command: string, how: { foreground?: boolean; 'no-wait'?: boolean }): Promise<number> {
  if (how.foreground) {
    await runSteps(dir);
    return showRun(dir, cfg, command);
  }
  const fd = openSync(join(dir, 'logs', 'runner.log'), 'a');
  const child = spawn(process.execPath, [CLI_PATH, '__runner', dir], { cwd: loadRun(dir).repo, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  closeSync(fd);
  if (!how['no-wait']) await waitRun(dir, child.pid!);
  return showRun(dir, cfg, command, !alive(child.pid!));
}

async function cmdMaintain(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { wait: { type: 'boolean' }, 'no-wait': { type: 'boolean' }, foreground: { type: 'boolean' } } });
  if ([values.wait, values['no-wait'], values.foreground].filter(Boolean).length > 1) throw new UsageError('pass only one of --wait, --no-wait and --foreground');
  const repo = repoRoot();
  const cfg = loadConfig(repo);
  await withAgent(cfg);
  const id = newRunId(git(repo, 'rev-parse', 'HEAD'));
  const dir = join(runsRoot(cfg.app), id);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const created = now();
  const steps = ['locate', 'hygiene', 'source-wave', 'reconcile', 'report'].map((name) => ({ name, status: 'pending' as StepState }));
  saveRun(dir, { schema: 2, run_id: id, kind: 'maintain', app: cfg.app, repo, claim_id: null, status: 'pending', steps, created, updated: created });
  logEvent(dir, { status: 'pending' });
  return launch(dir, cfg, 'maintain', values);
}

function cmdStatus(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { run: { type: 'string' } } });
  const repo = repoRoot();
  const cfg = loadConfig(repo);
  const root = runsRoot(cfg.app);
  return showRun(join(root, pickId(root, repo, 'status', cfg, values.run)), cfg, 'status');
}

async function cmdAttach(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { run: { type: 'string' } } });
  const repo = repoRoot();
  const cfg = loadConfig(repo);
  const dir = join(runsRoot(cfg.app), pickId(runsRoot(cfg.app), repo, 'attach', cfg, values.run));
  let shown = 0;
  for (;;) {
    const run = loadRun(dir);
    const gone = runnerGone(run);
    const lines = existsSync(join(dir, 'events.jsonl')) ? readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').slice(0, -1) : [];
    for (; shown < lines.length; shown++) process.stderr.write(`${lines[shown]}\n`);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') break;
    if (gone) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return showRun(dir, cfg, 'attach');
}

function cmdLogs(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { step: { type: 'string' }, run: { type: 'string' } } });
  if (!values.step?.trim()) throw new UsageError('logs needs --step <name>', 'Run: done-done logs --step <drive|check|receipt> [--run <run-id>]');
  const repo = repoRoot();
  const cfg = loadConfig(repo);
  const id = pickId(runsRoot(cfg.app), repo, 'logs', cfg, values.run);
  const run = loadRun(join(runsRoot(cfg.app), id));
  if (!run.steps.some((s) => s.name === values.step)) throw new UsageError(`unknown step ${values.step}; this run has: ${run.steps.map((s) => s.name).join(', ')}`, `Read the run: done-done status --run ${id}`);
  const file = join(runsRoot(cfg.app), id, 'logs', `${values.step}.log`);
  if (!existsSync(file)) throw new UsageError(`no log for step ${values.step} yet`, `Read the run: done-done status --run ${id}`);
  const text = readFileSync(file, 'utf8');
  const all = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const items = FULL || all.length <= 50 ? all : all.slice(-50);
  emit({ command: 'logs', run_id: id, step: values.step, lines: items.length, log: items, ...(all.length > items.length && { log_omitted: all.length - items.length }), help: FULL ? [`Read the run: done-done status --run ${id}`] : [`Read the full log: done-done logs --step ${values.step} --run ${id} --full`] });
  return PASS;
}

const drivesClean = (record: string | undefined, head: string | undefined) => {
  try {
    const rec = record && JSON.parse(readFileSync(record, 'utf8'));
    return !!rec && rec.dirty === false && rec.commit === head;
  } catch {
    return false;
  }
};

async function cmdRerun(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { run: { type: 'string' }, wait: { type: 'boolean' }, 'no-wait': { type: 'boolean' } } });
  if (values.wait && values['no-wait']) throw new UsageError('pass only one of --wait and --no-wait');
  const repo = repoRoot();
  const cfg = loadConfig(repo);
  const root = runsRoot(cfg.app);
  const srcId = pickId(root, repo, 'rerun', cfg, values.run);
  const src = loadRun(join(root, srcId));
  if (src.kind === 'maintain') throw new UsageError(`run ${srcId} is a maintain run, which cannot be rerun`, 'Start a new one: done-done maintain');
  const open = shownStatus(src);
  if (open === 'pending' || open === 'running') throw new UsageError(`run ${srcId} is still ${open}, so it cannot be rerun while its runner lives`, `Read it: done-done status --run ${srcId}; stop it first: done-done abort --run ${srcId}`);
  const group = src.runner?.journey_pgid;
  if (['pending', 'running'].includes(src.status) && group && alive(-group)) throw new UsageError(`the journey of run ${srcId} is still running, so it cannot be rerun yet`, `Read it: done-done status --run ${srcId}`);
  const inputs = inputsOf(src.repo, loadConfig(src.repo), src.journey!);
  const same = !!src.inputs && (['head', 'journey', 'skill'] as const).every((k) => src.inputs![k] === inputs[k]);
  const driveReuse = same && drivesClean(src.record, src.inputs?.head);
  const reused = (name: string) => (name === 'resolve' && same) || (name === 'drive' && driveReuse);
  // A rerun judges when its source did or config now turns the judge on; a forbidden judge is a usage error here too.
  // Steps follow the current list, so a run from before the judge step gains it.
  const judging = !!src.judge || cfg.judge.enabled;
  if (judging) await withAgent(cfg);
  if (judging && cfg.judge.route !== 'auto') selectJudge(cfg, selectAgent(cfg));
  const id = newRunId(git(repo, 'rev-parse', 'HEAD'));
  const dir = join(root, id);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const steps = STEPS.map((name) => {
    const s = src.steps.find((x) => x.name === name);
    return s && reused(name) && s.status === 'completed' ? { ...s } : { name, status: 'pending' as StepState };
  });
  const created = now();
  const run: Run = { schema: 2, run_id: id, kind: src.kind, app: cfg.app, repo: src.repo, journey: src.journey, claim: src.claim, claim_id: src.claim_id, judge: judging, status: 'pending', inputs, steps, created, updated: created, ...(driveReuse && src.record && { record: src.record }) };
  saveRun(dir, run);
  for (const s of steps) {
    const f = join(root, srcId, 'logs', `${s.name}.log`);
    if (s.status === 'completed' && existsSync(f)) writeFileSync(join(dir, 'logs', `${s.name}.log`), readFileSync(f));
  }
  logEvent(dir, { status: 'pending', rerun_of: srcId, reused: steps.filter((s) => s.status === 'completed').map((s) => s.name) });
  return launch(dir, cfg, 'rerun', values);
}

async function waitGone(pid: number): Promise<void> {
  for (let i = 0; i < 25 && alive(pid); i++) await new Promise((r) => setTimeout(r, 200));
}

async function cmdAbort(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { run: { type: 'string' } } });
  const repo = repoRoot();
  const cfg = loadConfig(repo);
  const id = pickId(runsRoot(cfg.app), repo, 'abort', cfg, values.run);
  const dir = join(runsRoot(cfg.app), id);
  const startAgain = (r: Run) => (r.kind === 'maintain' ? [] : [`Start again: done-done rerun --run ${id}`]);
  const closed = (r: Run, status = shownStatus(r)) => {
    if (status === 'pending' || status === 'running') return false;
    emit({ command: 'abort', run_id: id, status, reason: `run ${id} is already ${status}`, help: [`List past runs: done-done history`, ...startAgain(r)] });
    return true;
  };
  const latest = loadRun(dir);
  if (['pending', 'running'].includes(latest.status) && runnerGone(latest)) reapJourney(dir, latest);
  if (closed(latest)) return FAIL;
  if (latest.runner && !isOurRunner(latest.runner.pid, dir)) {
    emit({ command: 'abort', run_id: id, status: latest.status, reason: `could not confirm pid ${latest.runner.pid} is this run's runner, so nothing was killed or cancelled`, help: [`Read the run: done-done status --run ${id}`] });
    return FAIL;
  }
  if (latest.runner) {
    try { process.kill(-latest.runner.pid, 'SIGKILL'); } catch {
      try { process.kill(latest.runner.pid, 'SIGKILL'); } catch { /* exited since the check */ }
    }
    await waitGone(latest.runner.pid);
  }
  const after = loadRun(dir);
  if (closed(after, after.status)) return FAIL;
  reapJourney(dir, after);
  after.status = 'cancelled';
  after.reason = 'aborted';
  logEvent(dir, { status: 'cancelled' });
  saveRun(dir, after);
  emit({ command: 'abort', run_id: id, status: 'cancelled', reason: after.reason, help: [`Read the run: done-done status --run ${id}`, ...startAgain(after)] });
  return PASS;
}

function cmdHistory(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { limit: { type: 'string' } } });
  if (values.limit !== undefined && (!/^\d+$/.test(values.limit) || Number(values.limit) <= 0)) throw new UsageError('--limit needs a positive integer', 'Run: done-done history --limit <n>');
  const n = values.limit === undefined ? Infinity : Number(values.limit);
  const repo = repoRoot();
  const cfg = loadConfig(repo);
  const root = runsRoot(cfg.app);
  const mine = existsSync(root) ? readdirSync(root).filter((x) => existsSync(join(root, x, 'run.json'))).map((x) => loadRun(join(root, x))).filter((r) => r.repo === repo).sort((a, b) => b.created.localeCompare(a.created)) : [];
  const matched = mine.slice(0, n);
  const rows = cap(matched.map((r) => ({ run_id: r.run_id, kind: r.kind, status: shownStatus(r), ...(r.result && { result: r.result }), ...(r.kind === 'verify' && { claim: r.claim, journey: r.journey }), created: r.created })));
  emit({ command: 'history', runs: matched.length, history: rows.items, ...(rows.omitted && { history_omitted: rows.omitted }), help: rows.items.length ? [`Read the newest run: done-done status --run ${rows.items[0].run_id}`] : ['Start one: done-done verify --outcome "<what a user can now do>"'] });
  return PASS;
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

// The session-start hook `init --hook <agent>` adds; the agent shows its stdout to the session.
// Without done-done on PATH it prints nothing and exits 0, so it never breaks a session.
// Claude Code reads it from the repo's .claude/settings.json, Codex from the repo's .codex/hooks.json
// (project scope; Codex docs: <repo>/.codex/hooks.json, SessionStart, matcher omitted matches every start).
const HOOK_COMMAND = 'command -v done-done >/dev/null && done-done || true';
// Gemini CLI reads a SessionStart hook from the repo's .gemini/settings.json (its hooks reference) but shows plain
// stdout only to the person, so the state goes to the model as JSON hookSpecificOutput.additionalContext.
// done-done runs on node, so node is on PATH whenever done-done is.
const GEMINI_HOOK = `command -v done-done >/dev/null && done-done 2>/dev/null | node -e 'process.stdin.setEncoding("utf8");let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>s.trim()&&process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:s.trim()}})))' || true`;

// A repo settings file with a SessionStart hook running `command` merged in, keeping every other key and hook; no text when it is already there.
function sessionStartSettings(repo: string, rel: string, command: string, agent: string): { file: string; text?: string } {
  const file = join(repo, rel);
  const bad = (why: string) => new UsageError(`${rel} ${why}`, `Fix ${rel}, then re-run: done-done init --hook ${agent}`);
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
  if (start.some((m) => Array.isArray(m?.hooks) && m.hooks.some((h: { command?: unknown }) => h?.command === command))) return { file };
  settings.hooks = { ...settings.hooks, SessionStart: [...start, { hooks: [{ type: 'command', command }] }] };
  return { file, text: `${JSON.stringify(settings, null, 2)}\n` };
}

// A file init owns outright: written once, unchanged when identical, never overwritten when someone else's.
function ownedFile(repo: string, rel: string, text: string, agent: string): { file: string; text?: string } {
  const file = join(repo, rel);
  if (!existsSync(file)) return { file, text };
  if (readFileSync(file, 'utf8') === text) return { file };
  throw new UsageError(`${rel} already exists with other content, so init will not overwrite it`, `Delete ${rel}, then re-run: done-done init --hook ${agent}`);
}

// The opencode session plugin `init --hook opencode` adds: a project-scope file in
// .opencode/plugins/ (auto-loaded; the home config is never touched) whose chat.message
// hook runs the session command below on the first message of each session and appends
// the bare `done-done` state to the message parts. The appended part carries the prt_ id
// plus the session id from the hook input and the message id from the hook output (opencode
// passes no messageID to the hook), because opencode validates every
// part before save and drops the whole first message when one is invalid. Without
// done-done on PATH it appends nothing and never throws, so it never breaks a session.
function opencodePlugin(repo: string): { file: string; text?: string } {
  const text = `// Written by \`done-done init --hook opencode\`: shows this repo's bare \`done-done\`
// state to each opencode session. On the first message of a session the chat.message
// hook runs \`${HOOK_COMMAND}\` and appends its output to the message parts.
// Without done-done on PATH it appends nothing and never throws, so it never breaks
// a session. Other files in .opencode/plugins/ are untouched; delete this file to opt out.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const COMMAND = "${HOOK_COMMAND}";

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
  return ownedFile(repo, '.opencode/plugins/done-done.js', text, 'opencode');
}

// The pi extension `init --hook pi` adds: a project-scope file in .pi/extensions/ (pi loads it once the project
// is trusted; its extensions.md) whose before_agent_start handler runs the session command on the first prompt of
// each session and adds the bare `done-done` state as a message the model reads. Without done-done on PATH it adds
// nothing and never throws, so it never breaks a session.
function piExtension(repo: string): { file: string; text?: string } {
  const text = `// Written by \`done-done init --hook pi\`: shows this repo's bare \`done-done\`
// state to each pi session. On the first prompt of a session the before_agent_start
// handler runs \`${HOOK_COMMAND}\` and adds its output as a message.
// Without done-done on PATH it adds nothing and never throws, so it never breaks
// a session. Other files in .pi/extensions/ are untouched; delete this file to opt out.
import { execFile } from "node:child_process";

const COMMAND = "${HOOK_COMMAND}";

const run = (cwd) => new Promise((resolve) => {
  execFile("sh", ["-c", COMMAND], { cwd, encoding: "utf8", timeout: 30000 }, (error, stdout) => resolve(error ? "" : stdout.trim()));
});

export default function doneDone(pi) {
  let shown = false;
  pi.on("session_start", () => {
    shown = false;
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (shown) return;
    shown = true;
    const state = await run(ctx.cwd);
    if (state) return { message: { customType: "done-done", content: state, display: true } };
  });
}
`;
  return ownedFile(repo, '.pi/extensions/done-done.js', text, 'pi');
}

// What `init --hook <agent>` writes, the init output key that names it, and what a session then gets.
const HOOKS: Record<string, { make: (repo: string) => { file: string; text?: string }; rel: string; key: string; gets: string }> = {
  claude: { make: (repo) => sessionStartSettings(repo, '.claude/settings.json', HOOK_COMMAND, 'claude'), rel: '.claude/settings.json', key: 'claude_hook', gets: 'each Claude Code session in this repo then starts with `done-done` output' },
  codex: { make: (repo) => sessionStartSettings(repo, '.codex/hooks.json', HOOK_COMMAND, 'codex'), rel: '.codex/hooks.json', key: 'codex_hook', gets: 'each Codex session in this repo then starts with `done-done` output' },
  opencode: { make: opencodePlugin, rel: '.opencode/plugins/done-done.js', key: 'opencode_plugin', gets: 'the first message of each opencode session in this repo then gets `done-done` output added' },
  pi: { make: piExtension, rel: '.pi/extensions/done-done.js', key: 'pi_extension', gets: 'the first prompt of each pi session in this repo (once you trust the project in pi) then gets `done-done` output added' },
  gemini: { make: (repo) => sessionStartSettings(repo, '.gemini/settings.json', GEMINI_HOOK, 'gemini'), rel: '.gemini/settings.json', key: 'gemini_hook', gets: 'each Gemini CLI session in this repo (a trusted folder) then starts with `done-done` output' },
};

// The commented global config, once: every global key at its default, for the user to edit.
function writeGlobal(): string {
  const file = join(home(), 'config.yaml');
  if (existsSync(file)) return 'unchanged';
  mkdirSync(home(), { recursive: true });
  writeFileSync(`${file}.tmp`, globalConfigText());
  renameSync(`${file}.tmp`, file);
  return `written ${file}`;
}

// The user's agent choice, checked before anything is written.
function checkChoice(agent: string, model: string) {
  if (!isAgent(agent) || !supported(agent)) throw new UsageError(`done-done cannot start ${agent}; it starts ${agentChoices().join(', ')}`, noAgent().help);
  if (agent === 'opencode' && model && !model.includes('/')) throw new UsageError(`--model ${model}: an opencode model is provider/model, e.g. ${CHEAP.opencode.model}`);
}

// Save the user's agent (and model) in the global config, in place, keeping its comments and every other key.
function saveAgent(agent: string, model: string): string {
  const file = join(home(), 'config.yaml');
  let text = readFileSync(file, 'utf8');
  const example = /^# agent: .*$/m;
  if (!parseDocument(text).has('agent')) text = example.test(text) ? text.replace(example, `agent: ${agent}`) : text.replace(/^(?=[a-z_]+:)/m, `agent: ${agent}\n`);
  const doc = parseDocument(text);
  doc.set('agent', doc.createNode(agent));
  if (model) doc.setIn(['agent_config', agent, 'model'], model);
  writeFileSync(`${file}.tmp`, doc.toString({ lineWidth: 0 }));
  renameSync(`${file}.tmp`, file);
  return `${agent}${model ? ` (model ${model})` : ''} saved to ${file}`;
}

const interactive = () => !!process.stdin.isTTY && !!process.stderr.isTTY;

// In a terminal the user picks the agent and its model from a list; done-done never picks for them.
async function pickAgent(): Promise<{ agent: string; model: string }> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const closed = new AbortController();
  rl.on('close', () => closed.abort());
  const ask = async (q: string) => (await rl.question(q, { signal: closed.signal })).trim();
  try {
    const list = AGENTS.filter(supported);
    process.stderr.write(`done-done starts a coding agent you choose, and none is set. Agents:\n${list.map((a, i) => `  ${i + 1}) ${a}\n`).join('')}  ${list.length + 1}) acp:<target> (an agent your acpx bridge starts)\n`);
    let agent = '';
    while (!agent) {
      const n = Number(await ask(`agent [1-${list.length + 1}]: `));
      if (n === list.length + 1) {
        const target = await ask('acp target, e.g. claude-code: ');
        if (isAgent(`acp:${target}`)) agent = `acp:${target}`;
      } else if (Number.isInteger(n) && n >= 1 && n <= list.length) agent = list[n - 1];
    }
    const cheap = CHEAP[agent]?.model;
    process.stderr.write(`Models for ${agent}:\n  1) ${cheap ? `${cheap} (cheap)` : `${agent}'s own default`}\n  2) another (type its name${agent === 'opencode' ? ' as provider/model' : ''})\n`);
    for (;;) {
      const n = await ask('model [1-2]: ');
      if (n === '1') return { agent, model: cheap ?? '' };
      if (n !== '2') continue;
      const model = await ask('model: ');
      if (model && (agent !== 'opencode' || model.includes('/'))) return { agent, model };
    }
  } catch {
    throw noAgent(); // the terminal closed before an answer
  } finally {
    rl.close();
  }
}

// A command that starts the agent needs the one the user set. With none, it asks in a terminal and saves the answer;
// anywhere else it stops with noAgent, so a calling agent asks its user instead of picking.
async function withAgent(cfg: Config): Promise<void> {
  if (cfg.agent) return;
  if (!interactive()) throw noAgent();
  const { agent, model } = await pickAgent();
  writeGlobal();
  process.stderr.write(`${saveAgent(agent, model)}\n`);
  cfg.agent = agent;
  if (model) cfg.agent_config[agent] = { ...cfg.agent_config[agent], model };
}

async function cmdInit(argv: string[]): Promise<number> {
  const dash = argv.indexOf('--');
  const { values } = parseArgs({
    args: dash < 0 ? argv : argv.slice(0, dash),
    options: { agent: { type: 'string' }, model: { type: 'string' }, hook: { type: 'string' }, journey: { type: 'string' } },
    allowPositionals: false,
  });
  const parts = dash < 0 ? [] : argv.slice(dash + 1);
  const journey = values.journey ?? null;
  if (values.hook !== undefined && !Object.hasOwn(HOOKS, values.hook))
    throw new UsageError(`--hook ${values.hook} is not supported; the supported values are ${Object.keys(HOOKS).join(', ')}`, `Run: done-done init --hook <${Object.keys(HOOKS).join('|')}>`);
  if (values.model !== undefined && values.agent === undefined) throw new UsageError('--model needs --agent', `Run: done-done init --agent <agent> --model ${values.model}`);
  if (values.agent !== undefined) checkChoice(values.agent, values.model ?? '');
  if (journey === null && parts.length) throw new UsageError('init needs --journey <name> to record a command after --');
  if (journey !== null && !parts.some((p) => p.trim())) throw new UsageError(`init --journey ${journey} needs a command after --`);
  if (journey !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(journey)) throw new UsageError(`invalid journey name ${journey}; use letters, digits, - or _`);
  const repo = repoRoot();
  const file = join(repo, '.done-done.yaml');
  const existed = existsSync(file);
  const cfg = loadConfig(repo); // validates the existing project config; malformed -> exit 2, no writes
  if (cfg.skill.split(/[\\/]/).includes('..')) throw new UsageError(`verify skill ${cfg.skill} has a .. segment; use a path inside the repo`, 'Set skill to a repo-relative path in .done-done.yaml');
  const spec = values.hook === undefined ? undefined : HOOKS[values.hook];
  const hook = spec?.make(repo); // likewise validated before any write
  // The agent: --agent, else with none set the user's pick in a terminal (asked before any write); never done-done's.
  const choice = values.agent !== undefined ? { agent: values.agent, model: values.model ?? '' } : !cfg.agent && interactive() ? await pickAgent() : undefined;
  const writeAgent = (): { out: Record<string, string>; help: string[]; code: number } => {
    if (choice) {
      const saved = saveAgent(choice.agent, choice.model);
      const overridden = cfg.from.agent === 'repo' && cfg.agent !== choice.agent;
      return { out: { agent: overridden ? `${saved}; .done-done.yaml overrides it with ${cfg.agent}` : saved }, help: [], code: PASS };
    }
    if (cfg.agent) return { out: { agent: `unchanged (${cfg.agent})` }, help: [], code: PASS };
    return { out: { agent: 'not set' }, help: [`${noAgent().message}. ${noAgent().help}`], code: USAGE };
  };
  // Written last on both paths, after the config; init reports it as <agent>_hook (or the plugin/extension key).
  const writeHook = (): { out: Record<string, string>; help: string[] } => {
    if (!spec || !hook) return { out: {}, help: [] };
    if (hook.text) {
      mkdirSync(dirname(hook.file), { recursive: true });
      writeFileSync(`${hook.file}.tmp`, hook.text);
      renameSync(`${hook.file}.tmp`, hook.file);
    }
    return { out: { [spec.key]: hook.text ? `added to ${spec.rel}` : 'unchanged' }, help: hook.text ? [`Commit ${spec.rel}: ${spec.gets} (it needs done-done on PATH)`] : [] };
  };
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
    const agentHook = writeHook();
    const globalConfig = writeGlobal();
    const ag = writeAgent();
    emit({
      command: 'init',
      result: ag.code === PASS ? 'pass' : 'fail',
      config: existed ? 'updated' : 'written',
      global_config: globalConfig,
      ...ag.out,
      journey,
      app: fresh.app,
      evidence_root: root,
      gitignore: added ? `added ${rel!.replace(/\/+$/, '')}/` : 'unchanged',
      verify_skill: verify,
      ...agentHook.out,
      help: [`Capture proof: done-done run ${journey}, then: ${check}`, ...agentHook.help, ...ag.help],
    });
    return ag.code;
  }
  if (!existed) {
    // No evidence.root: proof goes to <local_root>/<app>, outside the repo, so it outlives this checkout.
    // The pinned app name is what lets every checkout of the repo find the same evidence and receipts.
    const body = `# done-done project config. \`done-done init\` never overwrites this file.
# The app name finds this repo's evidence and receipts from every checkout.
app: ${JSON.stringify(cfg.app)}
# This repo's coding agent, over agent in ~/.done-done/config.yaml (model, effort and the other agent settings stay there).
# agent: opencode
`;
    writeFileSync(`${file}.tmp`, body);
    renameSync(`${file}.tmp`, file);
  }
  // An evidence root inside the repo (an older config's `root: .proof`) stays out of git.
  const rel = under(repo, cfg.evidence.root);
  const added = !!rel && ensureIgnored(repo, rel);
  const root = shown(repo, cfg.evidence.root);
  const check = 'done-done check --outcome "<what you proved>" <files it recorded>';
  const verify = scaffoldVerify(repo, cfg);
  const agentHook = writeHook();
  const globalConfig = writeGlobal();
  const ag = writeAgent();
  emit({
    command: 'init',
    result: ag.code === PASS ? 'pass' : 'fail',
    config: existed ? 'unchanged' : 'written',
    global_config: globalConfig,
    ...ag.out,
    app: cfg.app,
    evidence_root: root,
    gitignore: added ? `added ${rel!.replace(/\/+$/, '')}/` : 'unchanged',
    verify_skill: verify,
    ...agentHook.out,
    help: [
      ...(Object.keys(cfg.journeys).length
        ? [`Capture proof: ${captureHint(cfg)}, then: ${check}`]
        : [`Add a journey that drives the real app and saves proof under $DONE_DONE_EVIDENCE_ROOT (each run's own folder in ${root}), e.g. ${journeyExample}`, `Then commit, run \`done-done run smoke\`, and: ${check}`]),
      ...agentHook.help,
      ...ag.help,
    ],
  });
  return ag.code;
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
type DoctorCheck = { check: string; status: 'ok' | 'warning' | 'missing'; detail: string; fix: string };
const unknownRow = (check: string, detail = 'unknown without a valid config', fix = ''): DoctorCheck => ({ check, status: 'missing', detail, fix });
// Each effective setting of the agent and the file it came from: the global config, the repo's .done-done.yaml, or the built-in default.
function agentSettings(cfg: Config, agent: string): string {
  const rh = relative(homedir(), join(home(), 'config.yaml'));
  const globalFile = outside(rh) ? join(home(), 'config.yaml') : `~${sep}${rh}`;
  const where = (key: string) => ({ global: globalFile, repo: '.done-done.yaml' })[cfg.from[key] as 'global' | 'repo'] ?? 'default';
  const c = cfg.agent_config[agent] ?? {};
  const acp = agent.startsWith('acp:');
  const pathKey = acp ? 'acpx_path' : `agent_path_override.${agent}`;
  const args = cfg.agent_args_override[agent] ?? [];
  return [
    `agent ${cfg.agent} (${where('agent')})`,
    `model ${c.model || 'the CLI\'s own'} (${where(`agent_config.${agent}.model`)})`,
    `effort ${c.effort || 'the CLI\'s own'} (${where(`agent_config.${agent}.effort`)})`,
    `args ${args.length ? `${args.length} set` : 'none'} (${where(`agent_args_override.${agent}`)})`,
    `path ${acp ? cfg.acpx_path : cfg.agent_path_override[agent] || `${agent} on PATH`} (${where(pathKey)})`,
    `agent_timeout ${cfg.agent_timeout} (${where('agent_timeout')})`,
  ].join('; ');
}
const modelPhrase = (agent: string, model: string) => (model ? `model ${model}` : `its own default model; set agent_config.${agent}.model to choose one`);

// Is this repo worth driving: git, a valid config and a writable evidence root are
// required; the verify skill, an agent CLI, the judge binary and ffprobe are optional.
// doctor changes nothing except the --probe call record (the agent itself may keep its own session files): a missing repo or config is a finding, never a crash.
async function cmdDoctor(argv: string[]): Promise<number> {
  let values: { probe?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, options: { probe: { type: 'boolean' } }, allowPositionals: false }));
  } catch (e) {
    throw new UsageError((e as Error).message, 'Run `done-done doctor` (or `done-done doctor --probe`) with no other arguments');
  }
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
  } else {
    try {
      cfg = loadConfig(repo);
      if (existsSync(join(repo, '.done-done.yaml'))) {
        checks.push({ check: 'config', status: 'ok', detail: `.done-done.yaml is valid (app ${cfg.app})`, fix: '' });
      } else {
        checks.push({ check: 'config', status: 'missing', detail: 'no .done-done.yaml', fix: 'Run `done-done init` to write a minimal .done-done.yaml' });
      }
    } catch (e) {
      checks.push({ check: 'config', status: 'missing', detail: (e as Error).message, fix: 'Fix the config file named above, then re-run: done-done doctor' });
    }
  }
  if (!cfg || !repo) {
    checks.push(unknownRow('evidence_root'));
  } else if (writableDir(cfg.evidence.root)) {
    checks.push({ check: 'evidence_root', status: 'ok', detail: `writable: ${shown(repo, cfg.evidence.root)}`, fix: '' });
  } else {
    checks.push({ check: 'evidence_root', status: 'missing', detail: `not writable: ${shown(repo, cfg.evidence.root)}`, fix: `Make ${cfg.evidence.root} writable, or set evidence.root to a writable folder in .done-done.yaml` });
  }
  if (!cfg || !repo) {
    checks.push(unknownRow('verify_skill'));
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
  // A repo file that exists but is invalid makes the agent unknown; the global config alone resolves it only when there is no repo file.
  const repoFileInvalid = !cfg && !!repo && existsSync(join(repo, '.done-done.yaml'));
  let agentCfg = cfg;
  let agentError = '';
  if (!agentCfg && !repoFileInvalid) {
    try {
      agentCfg = loadConfig(repo ?? process.cwd(), '');
    } catch (e) {
      agentError = (e as Error).message;
    }
  }
  const agent = agentCfg?.agent ? selectAgent(agentCfg) : null;
  const startableList = AGENTS.filter(supported);
  const startable = startableList.length > 1 ? `${startableList.slice(0, -1).join(', ')} and ${startableList.at(-1)}` : (startableList[0] ?? 'no agent');
  // An acp:<target> agent is missing when its acpx bridge is: say which, and how to install it.
  const acpx = agent?.agent.startsWith('acp:') ? findBin(agentCfg!.acpx_path) : undefined;
  const override = agent && agentCfg!.agent_path_override[agent.agent];
  const notFound = acpx !== undefined ? `needs acpx, the ACP bridge, which is not startable (${acpx ? `${acpx} does not run` : isAbsolute(agentCfg!.acpx_path) ? `acpx_path ${agentCfg!.acpx_path} is not an executable file` : 'not on PATH'})`
    : override ? `is not startable: agent_path_override.${agent!.agent} ${override} is not an executable file` : 'is not on PATH';
  const askFix = `ask the user which agent to use and save it: done-done init --agent <agent> --model <model>`;
  const installFix = acpx === undefined ? `Install ${agent?.agent}, or ${askFix}` : ACPX_INSTALL;
  const switchFix = `done-done starts ${startable}: ${askFix}`;
  if (repoFileInvalid) {
    checks.push(unknownRow('agent'));
  } else if (!agentCfg) {
    checks.push({ check: 'agent', status: 'missing', detail: agentError, fix: 'Fix the config file named above, then re-run: done-done doctor' });
  } else if (!agent) {
    checks.push({ check: 'agent', status: 'missing', detail: noAgent().message, fix: noAgent().help! });
  } else {
    const what = `${agent.agent} (${modelPhrase(agent.agent, agent.model)}; from config)`;
    checks.push(
      !agent.path
        ? { check: 'agent', status: 'missing', detail: `${what} ${notFound}`, fix: installFix }
        : !supported(agent.agent)
          ? { check: 'agent', status: 'missing', detail: `${what} at ${agent.path}, but done-done cannot start ${agent.agent} yet (${startable} for now)`, fix: switchFix }
          : { check: 'agent', status: 'ok', detail: `${what} at ${agent.path}`, fix: '' },
    );
    if (agent.agent === 'pi') checks.push({ check: 'tool_gate', status: 'warning', detail: 'pi has no permission gate: every pi tool runs without approval', fix: '' });
  }
  // The judge --judge runs: judge.route, or with auto the first installed agent that can judge and is not the author.
  let choice: JudgeChoice | undefined;
  let choiceError: UsageError | undefined;
  if (cfg && agent)
    try {
      choice = selectJudge(cfg, agent);
    } catch (e) {
      choiceError = e as UsageError;
    }
  // With no agent set the judge is unknown too: it is kept apart from that agent.
  const noAuthorRow = (check: string) => (cfg && agentCfg && !agent ? unknownRow(check, 'unknown until the agent is set, since the judge is kept apart from it', noAgent().help) : unknownRow(check));
  const choiceRow = (check: string): DoctorCheck => ({ check, status: 'missing', detail: choiceError!.message, fix: choiceError!.help ?? 'Fix the judge config, then re-run: done-done doctor' });
  if (!cfg || !agent) {
    checks.push(noAuthorRow('judge'));
  } else if (!choice) {
    checks.push(choiceRow('judge'));
  } else {
    try {
      const { detail } = await backend(cfg, choice);
      checks.push({ check: 'judge', status: 'ok', detail: `${choice.route} (model ${choice.model}): ${detail}; the model is never called`, fix: '' });
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
  // How far the judge is from the author, as selectJudge picks it: another agent is ok; the author's agent at another
  // model or in a fresh session runs too, so it is a warning that never fails doctor.
  if (!cfg || !agent) {
    checks.push(noAuthorRow('judge_choice'));
  } else if (!choice) {
    checks.push(choiceRow('judge_choice'));
  } else {
    const apart = { agent: 'a different agent from the author', model: 'the author\'s agent at a different model', 'session-only': 'the author\'s agent and model in a fresh session (session-only independence)' }[choice.independence];
    const accepted = choice.independence === 'session-only' && cfg.judge.allow_same ? '; judge.allow_same accepts it' : '';
    const apartOk = choice.independence === 'agent';
    const modelIgnored = cfg.judge.route === 'auto' && !!cfg.judge.model;
    checks.push({
      check: 'judge_choice',
      status: apartOk && !modelIgnored ? 'ok' : 'warning',
      detail: `${choice.route} (model ${choice.model}; ${choice.from === 'auto' ? 'judge.route auto' : 'from config'}) judges the author ${choice.author.agent} (model ${choice.author.model || 'none'}): ${apart}${accepted}${modelIgnored ? `; judge.model ${cfg.judge.model} is ignored under judge.route auto` : ''}`,
      fix: !apartOk ? `Install another agent that can judge (${JUDGES.join(' or ')}) so the judge is apart from the author` : modelIgnored ? 'Set judge.route to claude-code or answerer:<agent> to use judge.model, or remove judge.model' : '',
    });
  }
  if (values.probe && !agent) checks.push(unknownRow('probe'));
  if (values.probe && agent) {
    const record = join(home(), 'agents', `probe-${new Date().toISOString().replace(/[:.]/g, '-')}-${agent.agent}.json`);
    const probe: AgentAnswer & { fix?: string } = !agent.path ? { ok: false, error: `${agent.agent} ${notFound}`, fix: installFix }
      : !supported(agent.agent) ? { ok: false, error: `done-done cannot start ${agent.agent} yet (${startable} for now)`, fix: switchFix }
      : askAgent({ ...agent, prompt: 'This is a connectivity probe from done-done doctor. Use no tools. Answer with ok set to true.', schema: PROBE_SCHEMA, cwd: repo ?? process.cwd(), tools: 'none', record });
    checks.push(
      probe.ok && probe.answer?.ok === true
        ? { check: 'probe', status: 'ok', detail: `${agent.agent} (${modelPhrase(agent.agent, agent.model)}) answered the schema question; ${probe.recordError ? `the call record could not be written: ${probe.recordError}` : `record ${record}`}`, fix: '' }
        : { check: 'probe', status: 'missing', detail: `${agent.agent} did not answer: ${probe.error ?? `answer ${JSON.stringify(probe.answer)}`}${probe.record ? `; record ${record}` : ''}${probe.recordError ? `; the call record could not be written: ${probe.recordError}` : ''}`, fix: probe.fix ?? `Check that ${agent.agent} is signed in${agent.model ? ` and can use model ${agent.model}` : ''}, or set agent_config.${agent.agent}.model` },
    );
  }
  if (agent) checks.push({ check: 'agent_settings', status: 'ok', detail: agentSettings(agentCfg!, agent.agent), fix: '' });
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
        : [`Add a journey to .done-done.yaml (${journeyExample}), commit, then \`done-done run smoke\` and ${check}`];
  } else {
    result.help = fixes;
  }
  emit(result);
  return missingRequired.length ? USAGE : PASS;
}

// The design check: every named screen, and each --mock screen, judged for visual defects.
async function cmdDesign(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: { mock: { type: 'string', multiple: true } }, allowPositionals: true });
  const mocks = new Map<string, string>();
  for (const m of values.mock ?? []) {
    const at = m.indexOf('=');
    if (at < 1 || at === m.length - 1) throw new UsageError(`--mock ${m} must be <screen>=<mock>`, 'Re-run with --mock <screen file>=<mock file>');
    mocks.set(resolve(m.slice(0, at)), m.slice(at + 1));
  }
  const names = [...new Set([...positionals, ...[...mocks.keys()].filter((p) => !positionals.some((n) => resolve(n) === p))])];
  if (!names.length) throw new UsageError('design needs at least one screen file', 'Re-run with the screens to check: done-done design <screens...>');
  const load = (name: string): Capture => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(name);
    } catch (e) {
      throw new UsageError(`${name}: cannot read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, 'Pass screen and mock files that exist');
    }
    return { name, bytes, sha256: sha256(bytes), media: checkMedia(name, bytes) };
  };
  const screens = names.map((n) => ({ ...load(n), ...(mocks.has(resolve(n)) && { mock: load(mocks.get(resolve(n))!) }) }));
  let repo: string;
  try {
    repo = repoRoot();
  } catch {
    repo = process.cwd();
  }
  const cfg = loadConfig(repo);
  const choice = selectJudge(cfg, selectAgent(cfg));
  const judged = await design(cfg, choice, screens, join(home(), 'agents'));
  const count = (v: string) => judged.filter((j) => j.verdict === v).length;
  const code = count('fail') ? FAIL : count('unsure') ? INCONCLUSIVE : PASS;
  const order = ['fail', 'unsure', 'pass'];
  const rows = cap([...judged].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict)));
  const again = `done-done design ${names.map(quote).join(' ')}${[...values.mock ?? []].map((m) => ` --mock ${quote(m)}`).join('')}`;
  emit({
    command: 'design',
    result: code === PASS ? 'pass' : code === FAIL ? 'fail' : 'inconclusive',
    judge: { route: choice.route, model: choice.model, independence: choice.independence, author: `${choice.author.agent} (model ${choice.author.model || 'none'})` },
    counts: { pass: count('pass'), fail: count('fail'), unsure: count('unsure') },
    screens: rows.items,
    ...(rows.omitted && { screens_omitted: rows.omitted }),
    help: code === PASS ? ['Every screen passed the design check'] : code === FAIL ? [`Fix each defect named above, capture the screens again, then re-run: ${again}`] : [`Look at the unsure screens yourself, or capture them as PNG and re-run: ${again}`],
  });
  return code;
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
    if (cmd === 'init') return await cmdInit(rest);
    if (cmd === 'doctor') return await cmdDoctor(rest);
    if (cmd === 'run') return cmdRun(rest);
    if (cmd === 'check') return await cmdCheck(rest);
    if (cmd === 'receipt') return await cmdReceipt(rest);
    if (cmd === 'verify') return await cmdVerify(rest);
    if (cmd === 'maintain') return await cmdMaintain(rest);
    if (cmd === 'design') return await cmdDesign(rest);
    if (cmd === 'status') return cmdStatus(rest);
    if (cmd === 'attach') return await cmdAttach(rest);
    if (cmd === 'logs') return cmdLogs(rest);
    if (cmd === 'rerun') return await cmdRerun(rest);
    if (cmd === 'abort') return cmdAbort(rest);
    if (cmd === 'history') return cmdHistory(rest);
    if (cmd === '__runner') {
      await runSteps(rest[0]);
      return PASS;
    }
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
