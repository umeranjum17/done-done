import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Question } from '@byokit/decide';
import { type AgentAnswer, askAgent, editOnlyReason, type JudgeChoice, notStartable, selectAgent, selectJudge } from './agents.js';
import { type Config } from './config.js';
import { askJudge, backend } from './judge.js';

// `done-done maintain`, part 1 and read only: locate the verify skill, check its feature index in plain code, send one
// fresh read-only reader per feature file through the configured agent, then reconcile: plain code checks every cited
// file:line, and one tool-less call merges the recipes and names recently changed source that no feature covers.
// Nothing here writes into the repo, and the run compares HEAD and git status before and after to prove it.
// Part 2, only with auto_fix.maintain above 0: the judge sorts each drift finding (the skill is out of date, or the
// product may be wrong and the user decides), the user's agent fixes the skill in a done-done worktree, plain code checks
// that only the skill folder changed, and maintain runs again there, up to auto_fix.maintain times. A clean re-run ends
// changed with one commit on a done-done/maintain-<run-id> branch; the user's branch and checkout are never touched.

// action ask-user: the user must decide, so nothing fixes it.
export type Finding = { id: string; kind: string; file: string; line?: number; what: string; action?: 'ask-user' };
type Source = { file: string; line: number };
export type MaintainResult = 'clean' | 'drift' | 'blocked' | 'changed';
type Harness<S> = {
  begin: (name: string) => S;
  set: (step: S, status: 'completed' | 'failed', extra?: { outputs?: string[] }) => void;
  log: (name: string, value: Record<string, unknown>) => void;
  finish: (result: MaintainResult, reason?: string) => void;
  spawned: (pgid: number) => void; // the fixer's process group, so an abort ends it too
};
// sources: the file:line a reader cited for each drift finding, by finding id, for the triage judge.
type Pass = { result: MaintainResult; reason?: string; sources?: Map<string, Source> };
type MaintainRun = { run_id: string; repo: string; findings?: Finding[]; git_status?: string; unverified?: string[]; fix?: { branch?: string; commit: string; files?: string[]; attempts?: number } };

// Plan 1.5 shared rules: a per-run call cap and a per-call timeout (agent_timeout) stop runaway cost.
const MAX_CALLS = 30;
const CHURN_SINCE = '30.days.ago';
const CHURN_MAX = 500;
const FEATURE_CHARS = 20_000;
// ponytail: a bare name can match many tracked files, so one feature's cited source is capped at 60,000 characters; upgrade to ranking files by citation count when a repo needs more.
const CITED_CHARS = 60_000;
// ponytail: the left-out notice names the first 20 files it skipped and counts the rest; list them all if a reader needs them.
const LEFT_NAMED = 20;
// Findings that mean the pass could not finish, so the result is blocked, not drift.
const BLOCKING = new Set(['coverage', 'repo-changed']);
// Notices are listed in the run but do not make the result drift.
const NOTICE = new Set(['truncated']);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
// The read-only proof: HEAD, the status, and the content of every changed or untracked path. Regular files are hashed
// with sha256 as they are read, and symlinks are fingerprinted by their target text, never read through.
const readable = (p: string) => {
  try {
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};
const digest = (abs: string) => {
  const hash = createHash('sha256');
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n: number;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
};
// skip: repo paths left out (done-done's own folders in the repo), as git pathspecs.
export const pathspec = (skip: string[]) => ['--', '.', ...skip.map((p) => `:(exclude)${p}`)];
export const repoState = (repo: string, skip: string[] = []) => {
  const paths = [...new Set([...git(repo, 'diff', '--name-only', '-z', 'HEAD', ...pathspec(skip)).split('\0'), ...git(repo, 'ls-files', '-z', '--others', '--exclude-standard', ...pathspec(skip)).split('\0')])].filter(Boolean);
  const files: string[] = [];
  const extra: string[] = [];
  for (const p of paths) {
    const abs = join(repo, p);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs, { throwIfNoEntry: false });
    } catch {
      extra.push(`${p} unreadable`);
      continue;
    }
    if (st?.isSymbolicLink()) extra.push(`${p} -> ${readlinkSync(abs)}`);
    else if (st?.isFile() && readable(abs)) files.push(p);
    else if (st?.isFile()) extra.push(`${p} unreadable ${st.mode}`);
  }
  return [git(repo, 'rev-parse', 'HEAD'), git(repo, 'status', '--porcelain', '--untracked-files=all', ...pathspec(skip)), ...extra, ...files.map((p) => `${p} ${digest(join(repo, p))}`)].join('\n');
};
const lines = (p: string) => readFileSync(p, 'utf8').split('\n');

// A markdown link's local target without its #anchor, or '' for a URL, mail link or bare anchor.
const LINK = /\[[^\]]*\]\(((?:[^()\s]|\([^()\s]*\))+)[^)]*\)/g;
const localTarget = (t: string) => (/^[a-z][\w+.-]*:/i.test(t) ? '' : t.split('#')[0]);

// A path:line or path:line-line. A path with a / is checked; a bare name is checked only when its extension is one
// of the tracked files', so host:port text is never read as a citation.
// ponytail: a file name after a / may open with one bracket or paren group (pages/[id].tsx); [[...rest]].tsx is not a citation, add when a repo cites one.
const CITE = /(?<![\w/.-])((?:(?:[\w.-]+|\([\w.-]+\)|\[[\w.-]+\])\/)*(?:[\w-][\w.-]*|(?<=\/)(?:\[[\w.-]+\]|\([\w.-]+\))[\w.-]*)\.[A-Za-z]\w*):(\d+)(?:-(\d+))?\b/g;

// Whether the file at `p` really lies under the repo: a symlinked folder on the way to it is followed, so it counts by where it points.
const realInside = (repo: string, p: string) => realpathSync(p).startsWith(`${realpathSync(repo)}${sep}`);

// Why repo-relative `file` has no line `line` (through `end`), or '' when it has.
function citeProblem(repo: string, file: string, line: number, end = line): string {
  const p = resolve(repo, file);
  const r = relative(repo, p);
  if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return `${file} is outside the repository`;
  let n: number;
  try {
    if (!realInside(repo, p)) return `${file} is outside the repository`;
    if (!statSync(p, { throwIfNoEntry: false })?.isFile()) return `${file} is not a file in the repository`;
    const text = readFileSync(p, 'utf8');
    n = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return `${file} is not a file in the repository`;
  }
  return line < 1 || end < line || end > n ? `${file} has ${n} lines` : '';
}

// The tracked files a cited `name` (a repo-relative path or a bare file name) names: the path itself when it is tracked,
// or each tracked file whose path ends with a bare name.
const citedFiles = (repo: string, tracked: string[], name: string) =>
  name.includes('/') ? tracked.filter((t) => t === relative(repo, resolve(repo, name))) : tracked.filter((p) => p === name || p.endsWith(`/${name}`));

// Why the cited `name` has no line `line` through `end`, or '' when one of its tracked files has them.
function citeWhy(repo: string, tracked: string[], name: string, line: number, end = line): string {
  const files = citedFiles(repo, tracked, name);
  if (!files.length) return name.includes('/') ? citeProblem(repo, name, line, end) || `${name} is not a tracked file` : `no tracked file is named ${name}`;
  let first: string | undefined;
  for (const p of files) {
    const why = citeProblem(repo, p, line, end);
    if (!why) return '';
    first ??= why;
  }
  return first ?? '';
}

// The text of a tracked file that a feature cites, when it is a regular file inside the repo that can be read.
const citedText = (repo: string, p: string) => {
  try {
    const abs = join(repo, p);
    return statSync(abs, { throwIfNoEntry: false })?.isFile() && realInside(repo, abs) ? readFileSync(abs, 'utf8') : undefined;
  } catch {
    return undefined;
  }
};

const READER_SCHEMA = {
  type: 'object',
  properties: {
    drift: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, why: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' } }, required: ['claim', 'why', 'file', 'line'], additionalProperties: false } },
    recipe: { type: 'string' },
  },
  required: ['drift', 'recipe'],
  additionalProperties: false,
};
const RECONCILE_SCHEMA = {
  type: 'object',
  properties: {
    recipes: { type: 'array', items: { type: 'object', properties: { state: { type: 'string' }, features: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string' } } }, required: ['state', 'features', 'steps'], additionalProperties: false } },
    missing: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, why: { type: 'string' } }, required: ['file', 'why'], additionalProperties: false } },
  },
  required: ['recipes', 'missing'],
  additionalProperties: false,
};

// Model answers are input from outside: keep only the items with the shape the schema asked for.
const isCite = (x: any) => typeof x.file === 'string' && Number.isInteger(x.line);

export async function maintainSteps<S>(run: MaintainRun, dir: string, cfg: Config, h: Harness<S>): Promise<void> {
  const first = await pass(run, dir, cfg, h);
  const tries = cfg.auto_fix.maintain ?? 0;
  const end = first.result === 'drift' && tries ? await fix(run, dir, cfg, h, tries, first.sources!) : first;
  h.finish(end.result, end.reason);
}

// One read-only maintain pass over the skill in `run.repo`; prefix names its agent call records apart from other passes.
async function pass<S>(run: Pick<MaintainRun, 'repo' | 'findings' | 'git_status' | 'unverified'>, dir: string, cfg: Config, h: Pick<Harness<S>, 'begin' | 'set' | 'log'>, prefix = ''): Promise<Pass> {
  const repo = run.repo;
  const before = repoState(repo);
  const findings: Finding[] = (run.findings = []);
  // One finding per kind, file, line and text: a symlink found by two checks is reported once.
  const add = (f: Omit<Finding, 'id'>) => {
    let found = findings.find((x) => x.kind === f.kind && x.file === f.file && x.line === f.line && x.what === f.what);
    if (!found) findings.push((found = { id: `F${findings.length + 1}`, ...f }));
    return found.id;
  };
  const rel = (p: string) => relative(repo, p);
  // A skill path that cannot be read is blocking coverage, not a crash.
  const tryRead = <T>(p: string, fallback: T, read: () => T): T => {
    try {
      return read();
    } catch (e) {
      add({ kind: 'coverage', file: rel(p), what: `cannot be read: ${(e as NodeJS.ErrnoException).code ?? 'an error'}` });
      return fallback;
    }
  };

  const linked = (p: string) => {
    if (!tryRead(p, false, () => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())) return false;
    add({ kind: 'coverage', file: rel(p), what: 'a symlink on the skill path, so maintain does not read through it' });
    return true;
  };

  // 1 locate
  let step = h.begin('locate');
  const skill = join(repo, cfg.skill);
  if (!existsSync(join(skill, 'SKILL.md'))) {
    h.set(step, 'failed');
    return { result: 'blocked', reason: `locate: no verify skill at ${cfg.skill}/SKILL.md` };
  }
  if (realpathSync(skill) !== resolve(realpathSync(repo), cfg.skill)) {
    h.set(step, 'failed');
    return { result: 'blocked', reason: `locate: ${cfg.skill} is reached through a symlink; maintain does not read through it` };
  }
  if (!realInside(repo, skill)) {
    h.set(step, 'failed');
    return { result: 'blocked', reason: `locate: ${cfg.skill} is outside the repository; maintain does not read outside it` };
  }
  h.set(step, 'completed', { outputs: [cfg.skill] });

  // 2 hygiene: every local link in the skill resolves; the index lists each feature file once.
  // A symlinked .md file or directory anywhere in the skill is blocking coverage, and nothing is read through it.
  const docFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = statSync(p, { throwIfNoEntry: false });
        if (e.name.endsWith('.md') || !target || target.isDirectory()) linked(p);
        return [];
      }
      if (e.isDirectory()) return docFiles(p);
      return e.isFile() && e.name.endsWith('.md') ? [p] : [];
    });
  const docs = tryRead<string[]>(skill, [], () => docFiles(skill).sort()).map((f) => ({ f, ls: tryRead<string[]>(f, [], () => lines(f)) }));
  step = h.begin('hygiene');
  for (const { f, ls } of docs)
    ls.forEach((text, i) => {
      for (const m of text.matchAll(LINK)) {
        const t = localTarget(m[1]);
        if (t && !existsSync(resolve(dirname(f), t))) add({ kind: 'dead-link', file: rel(f), line: i + 1, what: `links to ${m[1]}, which does not exist` });
      }
    });
  const featDir = join(skill, 'features');
  const index = join(featDir, 'README.md');
  // A features folder that is a symlink is never read through, so its index is not checked either.
  const featLinked = linked(featDir);
  const features = existsSync(featDir) && !featLinked ? tryRead<string[]>(featDir, [], () => readdirSync(featDir)).filter((n) => n.endsWith('.md') && n !== 'README.md').sort() : [];
  if (!featLinked) {
    if (!tryRead(index, true, () => !!statSync(index, { throwIfNoEntry: false })?.isFile())) add({ kind: 'index', file: rel(index), what: 'the feature map has no index' });
    else if (!linked(index)) {
      const listed = new Map<string, number>();
      tryRead<string[]>(index, [], () => lines(index)).forEach((text, i) => {
        for (const m of text.matchAll(LINK)) {
          const t = localTarget(m[1]);
          if (!t) continue;
          const p = resolve(featDir, t);
          if (listed.has(p)) add({ kind: 'duplicate', file: rel(index), line: i + 1, what: `lists ${t} again (first on line ${listed.get(p)})` });
          else listed.set(p, i + 1);
        }
      });
      for (const n of features) if (!listed.has(join(featDir, n))) add({ kind: 'unlisted', file: rel(index), what: `does not list features/${n}` });
    }
  }
  if (!features.length) add({ kind: 'index', file: rel(featDir), what: 'the feature map has no feature files' });
  h.log('hygiene', { features, findings: [...findings] });
  h.set(step, 'completed');

  // 3 source wave: one fresh, read-only reader per feature file, at the configured agent.
  // ponytail: readers run one after another; run them in parallel if a run with many feature files is too slow.
  step = h.begin('source-wave');
  const tracked = git(repo, 'ls-files', '-z').split('\0').filter(Boolean);
  const exts = new Set(tracked.map((p) => extname(p)));
  // A citation in the text: a bare name counts only when its extension is one of the tracked files'.
  const cites = (text: string) => [...text.matchAll(CITE)].filter((m) => m[1].includes('/') || exts.has(extname(m[1])));
  // The text of each tracked file the feature file cites, for a reader with no tools. A file that cannot be read, or that
  // falls past the cap, is left out and named.
  const citedSource = (feature: string, text: string) => {
    const seen = new Map<string, string>();
    const left = new Set<string>();
    let total = 0;
    let capped = false;
    for (const m of cites(text)) {
      for (const p of citedFiles(repo, tracked, m[1])) {
        if (seen.has(p) || left.has(p)) continue;
        if (capped) {
          left.add(p);
          continue;
        }
        const body = citedText(repo, p);
        if (body === undefined) {
          left.add(p);
          continue;
        }
        // Numbered lines, so a reader with no tools cites the line it read rather than a guess; the caps count this text.
        const numbered = body.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        const cut = numbered.length > FEATURE_CHARS ? `\n[truncated after ${FEATURE_CHARS} characters]` : '';
        const kept = `${numbered.slice(0, FEATURE_CHARS)}${cut}`;
        if (total + kept.length > CITED_CHARS) {
          capped = true;
          left.add(p);
          continue;
        }
        total += kept.length;
        seen.set(p, kept);
      }
    }
    const parts = [...seen].map(([p, body]) => `\n\nCited source ${p}:\n${body}`);
    if (left.size) {
      const shown = [...left].slice(0, LEFT_NAMED);
      const names = left.size > shown.length ? `${shown.join(', ')}, +${left.size - shown.length} more` : shown.join(', ');
      add({ kind: 'truncated', file: feature, what: `${left.size} cited files were left out (${names}): they cannot be read, or the cited source is capped at ${CITED_CHARS} characters` });
      parts.push(`\n\n[truncated: the cited source for ${feature} is capped at ${CITED_CHARS} characters and skips unreadable files, so ${left.size} cited files are left out: ${names}]`);
    }
    return parts.join('');
  };
  const agent = selectAgent(cfg);
  // Only claude reads the repo with its own tools: its read tools refuse paths outside it, while the other agents'
  // tools cannot be trusted that way, so they get the cited source from plain code.
  const toolless = agent.agent !== 'claude';
  // maintain checks this before the run starts; an agent that went away since still ends the run blocked.
  const agentBlock = readerProblem(agent);
  if (agentBlock && agent.path) add({ kind: 'coverage', file: rel(featDir), what: agentBlock });
  let calls = 0;
  const record = (name: string) => join(dir, 'agents', `${prefix}${++calls}-${name}.json`);
  const read = agentBlock ? [] : features.slice(0, MAX_CALLS - 1);
  if (!agentBlock && read.length < features.length) add({ kind: 'coverage', file: rel(featDir), what: `${features.length - read.length} feature files not read: the run's call cap is ${MAX_CALLS}` });
  const regular = read.flatMap((name) => {
    const file = join(featDir, name);
    const text = tryRead<string | undefined>(file, undefined, () => {
      if (lstatSync(file, { throwIfNoEntry: false })?.isFile()) return readFileSync(file, 'utf8');
      if (!linked(file)) add({ kind: 'coverage', file: rel(file), what: 'the feature entry is not a readable file, so no reader covers it' });
      return undefined;
    });
    return text === undefined ? [] : [{ name, text }];
  });
  const readers: ({ feature: string; ok: boolean; record?: string } & Record<string, unknown>)[] = [];
  for (const { name, text } of regular) {
    const file = join(featDir, name);
    if (text.length > FEATURE_CHARS) add({ kind: 'truncated', file: rel(file), what: `the reader saw only the first ${FEATURE_CHARS} characters of this feature file` });
    const prompt = `You are a read-only source reader for done-done maintain. Do not edit, create or delete any file, and do not run the app or any command.
${toolless ? 'You have no tools: the source that the feature file cites is below, each line after its line number, and it is all you can read.' : 'The repository is your working directory.'} Below is one feature file from the verification skill at ${cfg.skill} (app ${cfg.app}).
${toolless ? 'Use the cited source, not the skill, and explain' : "Read the product's source code, not the skill, and explain"} how this user-facing feature works today.
- drift: each statement in the feature file that the source contradicts or no longer supports, each {claim: the feature file's words, why: what the source does instead, file, line: the source location that shows it}. Empty when the file is right.
- recipe: one short recipe to verify the feature live, the way a user reaches it.

Feature file ${rel(file)}:
${text.slice(0, FEATURE_CHARS)}${toolless ? citedSource(rel(file), text.slice(0, FEATURE_CHARS)) : ''}`;
    const a = await askAgent({ ...agent, prompt, schema: READER_SCHEMA, cwd: repo, tools: toolless ? 'none' : 'read', record: record(`reader-${name.replace(/\.md$/, '')}`) });
    if (!a.ok) add({ kind: 'coverage', file: rel(file), what: `the reader did not answer: ${a.error}` });
    readers.push({ feature: rel(file), ok: a.ok, drift: a.answer?.drift, recipe: a.answer?.recipe, ...(a.error && { error: a.error }), record: a.record, ...(a.recordError && { record_error: a.recordError }) });
  }
  h.log('source-wave', { agent: agent.agent, model: agent.model, readers });
  h.set(step, agentBlock ? 'failed' : 'completed', { outputs: readers.flatMap((r) => r.record ?? []) });

  // 4 reconcile: plain code checks each file:line the skill and the readers cite; churn comes from git log.
  step = h.begin('reconcile');
  for (const { f, ls } of docs)
    ls.forEach((text, i) => {
      for (const m of cites(text)) {
        const why = citeWhy(repo, tracked, m[1], Number(m[2]), Number(m[3] ?? m[2]));
        if (why) add({ kind: 'citation', file: rel(f), line: i + 1, what: `cites ${m[0]}, but ${why}` });
      }
    });
  const unverified: string[] = (run.unverified = []);
  const sources = new Map<string, Source>();
  const shaped = <T>(v: unknown, ok: (x: any) => boolean, where: string): T[] => {
    if (!Array.isArray(v)) {
      unverified.push(`${where} is not a list, so none of it is checked`);
      return [];
    }
    return v.flatMap((x) => {
      if (x && typeof x === 'object' && ok(x)) return [x as T];
      unverified.push(`${where} has an item in an unexpected shape, so it is not checked`);
      return [];
    });
  };
  for (const r of readers.filter((r) => r.ok)) {
    for (const d of shaped<{ claim: string; why: string; file: string; line: number }>(r.drift, (x) => isCite(x) && typeof x.claim === 'string' && typeof x.why === 'string', `${r.feature} drift`)) {
      const why = citeWhy(repo, tracked, d.file, d.line);
      if (why) unverified.push(`${r.feature}: drift "${d.claim}" cites ${d.file}:${d.line}: ${why}`);
      else sources.set(add({ kind: 'drift', file: r.feature, what: `"${d.claim}": ${d.why} (source ${d.file}:${d.line})` }), { file: d.file, line: d.line });
    }
  }
  const skillDir = rel(skill);
  // ponytail: the reconcile prompt names only the CHURN_MAX most recently changed paths; older ones get no coverage check.
  const trackedSet = new Set(tracked);
  const churnAll = [...new Set(git(repo, 'log', `--since=${CHURN_SINCE}`, '--name-only', '-z', '--format=').split('\0'))]
    .filter((p) => p && !p.startsWith(`${skillDir}/`) && trackedSet.has(p));
  const churn = churnAll.slice(0, CHURN_MAX);
  let recipes: unknown[] = [];
  const answered = readers.filter((r) => r.ok);
  if (answered.length) {
    const prompt = `You reconcile the source readers of done-done maintain for the verification skill of ${cfg.app}. Use no tools.
- recipes: merge the readers' recipes below into as few app states as practical, each {state: what to set up once, features: the feature files it covers, steps: the drive steps in order}.
- missing: from the recently changed files listed below, each one that is a user-facing surface no feature covers, as {file: the path exactly as listed, why}. Empty when none.

Features (JSON): ${JSON.stringify(answered.map((r) => ({ feature: r.feature, recipe: r.recipe })))}

Recently changed files (git log since ${CHURN_SINCE}, most recent first${churnAll.length > churn.length ? `; ${churnAll.length - churn.length} older paths left out` : ''}): ${churn.length ? churn.join(', ') : 'none'}`;
    const a = await askAgent({ ...agent, prompt, schema: RECONCILE_SCHEMA, cwd: repo, tools: 'none', record: record('reconcile') });
    if (!a.ok) add({ kind: 'coverage', file: skillDir, what: `the reconcile call did not answer: ${a.error}` });
    if (a.answer) {
      recipes = shaped<unknown>(a.answer.recipes, (x) => typeof x.state === 'string' && Array.isArray(x.features) && Array.isArray(x.steps), 'reconcile recipes');
      for (const m of shaped<{ file: string; why: string }>(a.answer.missing, (x) => typeof x.file === 'string' && typeof x.why === 'string', 'reconcile missing')) {
        if (churn.includes(m.file)) add({ kind: 'unmapped', file: m.file, what: `changed recently and no feature covers it: ${m.why}` });
        else unverified.push(`missing ${m.file}: not in the churn list`);
      }
    }
  }
  run.git_status = repoState(repo) === before ? 'same' : 'changed';
  if (run.git_status === 'changed') add({ kind: 'repo-changed', file: '.', what: 'HEAD or git status changed during the run, though maintain only reads' });
  h.log('reconcile', { recipes, churn, unverified, git_status: run.git_status, findings });
  h.set(step, 'completed');

  const stop = findings.find((f) => BLOCKING.has(f.kind));
  if (stop) return { result: 'blocked', reason: `${stop.kind}: ${stop.file}: ${stop.what}` };
  if (agentBlock) return { result: 'blocked', reason: agentBlock };
  const counted = findings.filter((f) => !NOTICE.has(f.kind));
  return counted.length ? { result: 'drift', reason: `${counted.length} findings`, sources } : { result: 'clean' };
}

// Why the agent the user set cannot read the source for maintain, or '' when it can.
export function readerProblem(agent: ReturnType<typeof selectAgent>): string {
  if (!agent.path) return `source-wave: no agent done-done can start (${notStartable(agent.agent, agent.override)}); run done-done doctor`;
  const why = agent.agent === 'gemini' ? 'gemini cannot read tool-less yet, since its none mode is read-only plan mode, not tool-free' : editOnlyReason(agent.agent);
  return why ? `source-wave: ${why}; use claude, opencode, pi or acp` : '';
}

// Triage: the judge (the user's, never the author or the fixer) answers each finding's question; only the `fix` answer,
// given with sureness, leaves the finding to the fixer. Any other answer, or an unsure one, asks the user, with the judge's reason.
export type Triage = { question: string; options: Record<string, string>; fix: string };
const TRIAGE_ATTEMPTS = 3;
const EXCERPT_LINES = 20;
export const FIX_SCHEMA = { type: 'object', properties: { summary: { type: 'string' }, blocker: { type: 'string' } }, required: ['summary', 'blocker'] };

// The lines around a cited source line (a repo path or a bare file name, as a reader cites it), numbered, for the judge.
// A bare name can match several files: the excerpt is from the first one that has the cited line, as citeWhy accepts.
const excerpt = (repo: string, tracked: string[], s: Source | undefined) => {
  const file = s && citedFiles(repo, tracked, s.file).find((p) => !citeProblem(repo, p, s.line));
  const text = file && citedText(repo, file);
  if (!s || !text) return '';
  return text.split('\n').slice(Math.max(0, s.line - 1 - EXCERPT_LINES), s.line + EXCERPT_LINES).map((l, i) => `${Math.max(1, s.line - EXCERPT_LINES) + i}: ${l}`).join('\n');
};

// Triage (see Triage): the findings the judge does not answer `fix` for, each marked ask-user. A judge that does not answer throws.
export async function triage(cfg: Config, choice: JudgeChoice, findings: Finding[], flow: Triage, state: unknown, record: string): Promise<Finding[]> {
  if (!findings.length) return [];
  const questions: Record<string, Question> = Object.fromEntries(findings.map((f) => [f.id, { kind: 'choice', instructions: `Finding ${f.id} ${flow.question}`, options: flow.options, floor: 0.8, personReason: true }]));
  const answers = await askJudge(cfg, await backend(cfg, choice, () => record, questions, TRIAGE_ATTEMPTS), choice, state, questions, {});
  return findings.flatMap((f) => {
    const a = answers[f.id];
    if (!a.abstained && a.answer === flow.fix) return [];
    const why = a.abstained ? `the judge was not sure (${a.reason})` : a.personReason || a.rationale || flow.options[String(a.answer)];
    return [{ ...f, action: 'ask-user' as const, what: `${f.what}; judge: ${why}` }];
  });
}

// Maintain's triage: is each drift finding a skill that is out of date, or a product that may be wrong (the judge sees the
// feature file and the cited source)?
const SKILL_TRIAGE: Triage = {
  question: "in the state is a statement in a verification skill (the steps a coding agent follows to drive and prove the real app) that the product's source no longer supports. Which side should change? The source is the truth for the skill unless the source looks broken.",
  options: {
    skill: 'The skill is out of date: it should be rewritten to match what the source does now.',
    product: 'The source looks broken or regressed against what the skill describes (a crash, a lost step, a typo, a half-done change), so the product may need a fix and a person must decide.',
    unclear: 'The text cannot settle which side is wrong.',
  },
  fix: 'skill',
};
async function triageDrift(cfg: Config, choice: JudgeChoice, repo: string, findings: Finding[], sources: Map<string, Source>, record: string): Promise<Finding[]> {
  const drift = findings.filter((f) => f.kind === 'drift');
  if (!drift.length) return [];
  const tracked = git(repo, 'ls-files', '-z').split('\0').filter(Boolean);
  const state = { app: cfg.app, findings: Object.fromEntries(drift.map((f) => [f.id, { feature_file: f.file, finding: f.what, feature_text: tryText(join(repo, f.file)).slice(0, FEATURE_CHARS), source: excerpt(repo, tracked, sources.get(f.id)) }])) };
  return triage(cfg, choice, drift, SKILL_TRIAGE, state, record);
}
const tryText = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

// The fix-branch flow every auto_fix step shares: the user's agent edits a detached done-done worktree, plain code
// checks each attempt, and done-done makes the commit; the user's branch and checkout are never touched.

// Every path the fixer changed in the worktree since `base`: tracked edits (and commits) and new files; ignored ones unless `ignored` is false.
export const changedSince = (wt: string, base: string, ignored = true) => [...new Set([...git(wt, 'diff', '--name-only', '--no-renames', '-z', base).split('\0'), ...git(wt, 'ls-files', '--others', ...(ignored ? [] : ['--exclude-standard']), '-z').split('\0')])].filter(Boolean);
export const named = (paths: string[]) => `${paths.slice(0, LEFT_NAMED).join(', ')}${paths.length > LEFT_NAMED ? `, +${paths.length - LEFT_NAMED} more` : ''}`;
export const dirtyTracked = (repo: string) => git(repo, 'diff', '--name-only', '--no-renames', '-z', 'HEAD').split('\0').filter(Boolean);

// A detached done-done worktree at `commit` for the body, removed after it whatever happens; a branch made from it stays.
export async function inWorktree<T>(repo: string, wt: string, body: (base: string) => Promise<T>, commit = 'HEAD'): Promise<T> {
  // ponytail: a runner killed mid-fix leaves the worktree registered; `git worktree prune` clears it once the run folder is gone.
  git(repo, 'worktree', 'add', '-q', '--detach', wt, commit);
  try {
    return await body(git(wt, 'rev-parse', 'HEAD').trim());
  } finally {
    try {
      git(repo, 'worktree', 'remove', '--force', wt);
    } catch {
      // Already gone.
    }
  }
}

// Why plain code drops one fix attempt, or '' when it may go on. bad: the changed paths the step forbids, named as badWhat.
export function attemptProblem(repo: string, checkout: string, wt: string, base: string, who: string, a: AgentAnswer, changed: string[], bad: string[], badWhat: string, target: string, skip: string[] = []): string {
  if (repoState(repo, skip) !== checkout) return `${who} changed your checkout at ${repo} during the fix; done-done does not undo changes there, so check git status`;
  if (git(wt, 'rev-parse', 'HEAD').trim() !== base) return `${who} made a commit; done-done makes the commit itself, so the attempt is dropped`;
  if (bad.length) return `${who} changed ${badWhat} (${named(bad)}), so the attempt is dropped with the done-done worktree; your branch is untouched`;
  // A lost answer after edits still gets the re-run: the re-run, not the agent's word, says whether the fix holds.
  if (!a.ok && !changed.length) return `${who} did not finish the fix: ${a.error}`;
  const blocker = a.ok ? String(a.answer?.blocker ?? '').trim() : '';
  return blocker ? `${who} could not fix ${target}: ${blocker}` : '';
}

// done-done's commit of `paths` in the worktree: the commit and the files it holds since `base`, or why it failed.
export function commitFix(wt: string, base: string, message: string, paths: string[]): { commit: string; files: string[] } | string {
  try {
    git(wt, 'add', '-A', '--', ...paths);
    git(wt, 'commit', '-q', '-m', message, '--', ...paths);
  } catch (e) {
    return `git commit failed: ${((e as { stderr?: string }).stderr || (e as Error).message).trim()}`;
  }
  const commit = git(wt, 'rev-parse', 'HEAD').trim();
  return { commit, files: git(wt, 'diff', '--name-only', '--no-renames', '-z', base, commit).split('\0').filter(Boolean) };
}

async function fix<S>(run: MaintainRun, dir: string, cfg: Config, h: Harness<S>, tries: number, sources: Map<string, Source>): Promise<Pass> {
  const repo = run.repo;
  const skill = relative(repo, join(repo, cfg.skill));
  const inSkill = (p: string) => p.startsWith(`${skill}/`);
  if (git(repo, 'status', '--porcelain', '--untracked-files=all', '--', skill)) return { result: 'blocked', reason: `fix: ${skill} has uncommitted changes, and maintain fixes the committed skill; commit them, then run again` };
  const dirty = dirtyTracked(repo);
  if (dirty.length) {
    run.findings = [...(run.findings ?? []), { id: `F${(run.findings?.length ?? 0) + 1}`, kind: 'dirty', file: '.', what: `uncommitted changes to tracked files (${named(dirty)}): the drift was found in them, and a fix at HEAD would not match them; commit them, or set auto_fix: { maintain: 0 }, then run again` }];
    return { result: 'blocked', reason: `dirty: uncommitted changes to tracked files (${named(dirty)}); commit them, or set auto_fix: { maintain: 0 }, then run again` };
  }
  const agent = selectAgent(cfg);
  const choice = selectJudge(cfg, agent);
  const checkout = repoState(repo);
  const wt = join(dir, 'fix');
  const scratch = join(dir, 'tmp');
  const rounds: Record<string, unknown>[] = [];
  const judged: Record<string, unknown>[] = [];
  let open = (run.findings ?? []).filter((f) => !NOTICE.has(f.kind));
  return inWorktree(repo, wt, async (base) => {
    for (let k = 1; k <= tries; k++) {
      let step = h.begin('triage');
      const asks = await triageDrift(cfg, choice, wt, open, sources, join(dir, 'agents', `triage-${k}.json`));
      judged.push({ attempt: k, ask_user: asks });
      h.log('triage', { judge: { route: choice.route, model: choice.model, independence: choice.independence }, rounds: judged });
      h.set(step, 'completed');
      if (asks.length) {
        run.findings = open.map((f) => asks.find((a) => a.id === f.id) ?? f);
        return { result: 'blocked', reason: `ask-user: the judge did not call ${asks.length} ${asks.length === 1 ? 'finding' : 'findings'} (${asks.map((a) => a.id).join(', ')}) a skill that is out of date, so the user decides` };
      }

      step = h.begin('fix');
      const round: Record<string, unknown> = { attempt: k, findings: open.map((f) => f.id) };
      rounds.push(round);
      const blocked = (reason: string): Pass => {
        round.blocked = reason;
        h.log('fix', { agent: agent.agent, model: agent.model, worktree: wt, rounds });
        h.set(step, 'failed');
        run.findings = open;
        return { result: 'blocked', reason: `fix: ${reason}` };
      };
      const prompt = `You fix the verification skill of the ${cfg.app} app at ${skill}/ in this checkout, your working directory. The skill tells a coding agent how to launch, drive and prove the real app; done-done maintain checked it against the product's source and found the findings below.
Change only files inside ${skill}/ so that each finding is gone: make the skill match the source. Never change product code or any file outside ${skill}/, do not commit, and do not run done-done. Put scratch files in ${scratch} (also in $TMPDIR).

Findings (JSON): ${JSON.stringify(open.map(({ id, kind, file, line, what }) => ({ id, kind, file, line, what })))}

Answer with summary (what you changed, in one line) and blocker ("" when you fixed them all, else why you could not).`;
      mkdirSync(scratch, { recursive: true });
      const a = await askAgent({ ...agent, prompt, schema: FIX_SCHEMA, cwd: wt, tools: 'edit', record: join(dir, 'agents', `fix-${k}.json`), dirs: [scratch], env: { DONE_DONE_DRIVE: run.run_id, TMPDIR: scratch }, onSpawn: h.spawned });
      Object.assign(round, { record: a.record ?? a.recordError, ...(a.ok ? { summary: a.answer?.summary, blocker: a.answer?.blocker } : { error: a.error }) });
      // The diff guard: only the skill folder may change, in the worktree only; anything else drops the attempt with the worktree.
      const changed = changedSince(wt, base);
      round.changed = changed;
      const problem = attemptProblem(repo, checkout, wt, base, agent.agent, a, changed, changed.filter((p) => !inSkill(p)), `files outside ${skill}/`, 'the skill');
      if (problem) return blocked(problem);

      // Re-run maintain on the fixed skill in the worktree; its steps are this fix step, and its records are named fix<k>-.
      const again: Pick<MaintainRun, 'repo' | 'findings' | 'git_status' | 'unverified'> = { repo: wt };
      const rerun = await pass(again, dir, cfg, { begin: () => null, set: () => {}, log: () => {} }, `fix${k}-`);
      round.rerun = { result: rerun.result, reason: rerun.reason, findings: again.findings, unverified: again.unverified };
      if (rerun.result === 'blocked') return blocked(`the re-run after attempt ${k} is blocked: ${rerun.reason}`);
      if (rerun.result === 'clean') {
        if (!changed.length) return blocked(`${agent.agent} changed nothing, yet the re-run is clean, so there is nothing to commit`);
        const made = commitFix(wt, base, `fix(verify): done-done maintain fixes ${skill}`, [skill]);
        if (typeof made === 'string') return blocked(made);
        if (made.files.some((p) => !inSkill(p))) return blocked(`the commit holds files outside ${skill}/ (a commit hook added them), so no branch is made`);
        const branch = `done-done/maintain-${run.run_id}`;
        git(repo, 'branch', branch, made.commit);
        run.fix = { branch, commit: made.commit, files: made.files, attempts: k };
        round.commit = made.commit;
        h.log('fix', { agent: agent.agent, model: agent.model, worktree: wt, rounds });
        h.set(step, 'completed', { outputs: made.files });
        return { result: 'changed', reason: `the skill is clean after ${k} fix ${k === 1 ? 'attempt' : 'attempts'}, in one commit on ${branch}` };
      }
      open = (again.findings ?? []).filter((f) => !NOTICE.has(f.kind));
      sources = rerun.sources ?? new Map();
      h.log('fix', { agent: agent.agent, model: agent.model, worktree: wt, rounds });
      h.set(step, 'completed');
    }
    run.findings = open;
    return { result: 'blocked', reason: `fix: auto_fix.maintain allows ${tries} ${tries === 1 ? 'attempt' : 'attempts'}, and ${open.length} findings remain after them` };
  });
}
