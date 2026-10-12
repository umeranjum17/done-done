import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { askAgent, selectAgent, supported } from './agents.js';
// Plan 1.5 shared rules: a per-run call cap and a per-call timeout stop runaway cost.
const MAX_CALLS = 30;
const CALL_MS = 20 * 60_000;
const CHURN_SINCE = '30.days.ago';
const FEATURE_CHARS = 20_000;
const SOURCE_FILE = /\.(m?[jt]sx?|py|go|rb|rs|php|swift|kt|java|dart)$/;
// Findings that mean the pass could not finish, so the result is blocked, not drift.
const BLOCKING = new Set(['coverage', 'repo-changed']);
// Notices are listed in the run but do not make the result drift.
const NOTICE = new Set(['truncated']);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const repoState = (repo) => `${git(repo, 'rev-parse', 'HEAD')}\n${git(repo, 'status', '--porcelain', '--untracked-files=all')}`;
const lines = (p) => readFileSync(p, 'utf8').split('\n');
const mdFiles = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => join(e.parentPath, e.name)).sort();
// A markdown link's local target without its #anchor, or '' for a URL, mail link or bare anchor.
const LINK = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const localTarget = (t) => (/^[a-z][\w+.-]*:/i.test(t) ? '' : t.split('#')[0]);
// A repo-relative path:line or path:line-line. It is checked only when the path has a / or names a repo file,
// so host:port text is never read as a citation.
const CITE = /(?<![\w/.-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z]\w*):(\d+)(?:-(\d+))?\b/g;
// Why repo-relative `file` has no line `line` (through `end`), or '' when it has.
function citeProblem(repo, file, line, end = line) {
    const p = resolve(repo, file);
    const r = relative(repo, p);
    if (!r || r.startsWith('..') || isAbsolute(r))
        return `${file} is outside the repository`;
    let n;
    try {
        const text = readFileSync(p, 'utf8');
        n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    }
    catch {
        return `${file} is not a file in the repository`;
    }
    return line < 1 || end < line || end > n ? `${file} has ${n} lines` : '';
}
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
const items = (v, ok) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && ok(x)) : []);
const isCite = (x) => typeof x.file === 'string' && Number.isInteger(x.line);
export async function maintainSteps(run, dir, cfg, h) {
    const repo = run.repo;
    const before = repoState(repo);
    const findings = (run.findings = []);
    const add = (f) => findings.push({ id: `F${findings.length + 1}`, ...f });
    const rel = (p) => relative(repo, p);
    // 1 locate
    let step = h.begin('locate');
    const skill = join(repo, cfg.skill);
    if (!existsSync(join(skill, 'SKILL.md'))) {
        h.set(step, 'failed');
        return h.finish('blocked', `locate: no verify skill at ${cfg.skill}/SKILL.md`);
    }
    h.set(step, 'completed', { outputs: [cfg.skill] });
    // 2 hygiene: every local link in the skill resolves; the index lists each feature file once.
    step = h.begin('hygiene');
    for (const f of mdFiles(skill))
        lines(f).forEach((text, i) => {
            for (const m of text.matchAll(LINK)) {
                const t = localTarget(m[1]);
                if (t && !existsSync(resolve(dirname(f), t)))
                    add({ kind: 'dead-link', file: rel(f), line: i + 1, what: `links to ${m[1]}, which does not exist` });
            }
        });
    const featDir = join(skill, 'features');
    const index = join(featDir, 'README.md');
    const features = existsSync(featDir) ? readdirSync(featDir).filter((n) => n.endsWith('.md') && n !== 'README.md').sort() : [];
    if (!existsSync(index))
        add({ kind: 'index', file: rel(index), what: 'the feature map has no index' });
    else {
        const listed = new Map();
        lines(index).forEach((text, i) => {
            for (const m of text.matchAll(LINK)) {
                const t = localTarget(m[1]);
                if (!t)
                    continue;
                const p = resolve(featDir, t);
                if (listed.has(p))
                    add({ kind: 'duplicate', file: rel(index), line: i + 1, what: `lists ${t} again (first on line ${listed.get(p)})` });
                else
                    listed.set(p, i + 1);
            }
        });
        for (const n of features)
            if (!listed.has(join(featDir, n)))
                add({ kind: 'unlisted', file: rel(index), what: `does not list features/${n}` });
    }
    if (!features.length)
        add({ kind: 'index', file: rel(featDir), what: 'the feature map has no feature files' });
    h.log('hygiene', { features, findings: [...findings] });
    h.set(step, 'completed');
    // 3 source wave: one fresh, read-only reader per feature file, at the configured agent.
    // ponytail: readers run one after another (askAgent is synchronous); run them in parallel when it is not.
    step = h.begin('source-wave');
    const agent = selectAgent(cfg);
    const agentBlock = !agent.path || !supported(agent.agent) ? `source-wave: no agent done-done can start (${agent.agent}${agent.path ? ' is not supported yet' : ' is not on PATH'}); run done-done doctor` : '';
    let calls = 0;
    const record = (name) => join(dir, 'agents', `${++calls}-${name}.json`);
    const read = agentBlock ? [] : features.slice(0, MAX_CALLS - 1);
    if (!agentBlock && read.length < features.length)
        add({ kind: 'coverage', file: rel(featDir), what: `${features.length - read.length} feature files not read: the run's call cap is ${MAX_CALLS}` });
    const readers = read.map((name) => {
        const file = join(featDir, name);
        const text = readFileSync(file, 'utf8');
        if (text.length > FEATURE_CHARS)
            add({ kind: 'truncated', file: rel(file), what: `the reader saw only the first ${FEATURE_CHARS} characters of this feature file` });
        const prompt = `You are a read-only source reader for done-done maintain. Do not edit, create or delete any file, and do not run the app or any command.
The repository is your working directory. Below is one feature file from the verification skill at ${cfg.skill} (app ${cfg.app}).
Read the product's source code, not the skill, and explain how this user-facing feature works today.
- drift: each statement in the feature file that the source contradicts or no longer supports, each {claim: the feature file's words, why: what the source does instead, file, line: the source location that shows it}. Empty when the file is right.
- recipe: one short recipe to verify the feature live, the way a user reaches it.

Feature file ${rel(file)}:
${text.slice(0, FEATURE_CHARS)}`;
        const a = askAgent({ agent: agent.agent, model: agent.model, prompt, schema: READER_SCHEMA, cwd: repo, timeoutMs: CALL_MS, tools: 'read', record: record(`reader-${name.replace(/\.md$/, '')}`) });
        if (!a.ok)
            add({ kind: 'coverage', file: rel(file), what: `the reader did not answer: ${a.error}` });
        return { feature: rel(file), ok: a.ok, drift: a.answer?.drift, recipe: a.answer?.recipe, ...(a.error && { error: a.error }), record: a.record, ...(a.recordError && { record_error: a.recordError }) };
    });
    h.log('source-wave', { agent: agent.agent, model: agent.model, readers });
    h.set(step, agentBlock ? 'failed' : 'completed', { outputs: readers.flatMap((r) => r.record ?? []) });
    // 4 reconcile: plain code checks each file:line the skill and the readers cite; churn comes from git log.
    step = h.begin('reconcile');
    const tracked = git(repo, 'ls-files', '-z').split('\0').filter(Boolean);
    for (const f of mdFiles(skill))
        lines(f).forEach((text, i) => {
            for (const m of text.matchAll(CITE)) {
                const path = m[1];
                // A bare file name is checked against the tracked files it ends; the line must exist in one of them.
                const cited = path.includes('/') ? [path] : tracked.filter((p) => p === path || p.endsWith(`/${path}`));
                const whys = cited.map((p) => citeProblem(repo, p, Number(m[2]), Number(m[3] ?? m[2])));
                const why = !cited.length ? `no tracked file is named ${path}` : whys.includes('') ? '' : whys[0];
                if (why)
                    add({ kind: 'citation', file: rel(f), line: i + 1, what: `cites ${m[0]}, but ${why}` });
            }
        });
    const unverified = [];
    for (const r of readers.filter((r) => r.ok)) {
        for (const d of items(r.drift, (x) => isCite(x) && typeof x.claim === 'string' && typeof x.why === 'string')) {
            const why = citeProblem(repo, d.file, d.line);
            if (why)
                unverified.push(`${r.feature}: drift "${d.claim}" cites ${d.file}:${d.line}: ${why}`);
            else
                add({ kind: 'drift', file: r.feature, what: `"${d.claim}": ${d.why} (source ${d.file}:${d.line})` });
        }
    }
    const skillDir = rel(skill);
    const churn = [...new Set(git(repo, 'log', `--since=${CHURN_SINCE}`, '--name-only', '-z', '--format=').split('\0'))]
        .filter((p) => p && SOURCE_FILE.test(p) && !p.startsWith(`${skillDir}/`) && existsSync(join(repo, p)))
        .sort();
    let recipes = [];
    const answered = readers.filter((r) => r.ok);
    if (answered.length && calls < MAX_CALLS) {
        const prompt = `You reconcile the source readers of done-done maintain for the verification skill of ${cfg.app}. Use no tools.
- recipes: merge the readers' recipes below into as few app states as practical, each {state: what to set up once, features: the feature files it covers, steps: the drive steps in order}.
- missing: from the recently changed source files listed below, each one that is a user-facing surface no feature covers, as {file: the path exactly as listed, why}. Empty when none.

Features (JSON): ${JSON.stringify(answered.map((r) => ({ feature: r.feature, recipe: r.recipe })))}

Recently changed source files (git log since ${CHURN_SINCE}): ${churn.length ? churn.join(', ') : 'none'}`;
        const a = askAgent({ agent: agent.agent, model: agent.model, prompt, schema: RECONCILE_SCHEMA, cwd: repo, timeoutMs: CALL_MS, tools: 'none', record: record('reconcile') });
        if (!a.ok)
            add({ kind: 'coverage', file: skillDir, what: `the reconcile call did not answer: ${a.error}` });
        recipes = items(a.answer?.recipes, (x) => typeof x.state === 'string');
        for (const m of items(a.answer?.missing, (x) => typeof x.file === 'string' && typeof x.why === 'string')) {
            if (churn.includes(m.file))
                add({ kind: 'unmapped', file: m.file, what: `changed recently and no feature covers it: ${m.why}` });
            else
                unverified.push(`missing ${m.file}: not in the churn list`);
        }
    }
    run.git_status = repoState(repo) === before ? 'same' : 'changed';
    if (run.git_status === 'changed')
        add({ kind: 'repo-changed', file: '.', what: 'HEAD or git status changed during the run, though maintain only reads' });
    h.log('reconcile', { recipes, churn, unverified, git_status: run.git_status, findings });
    h.set(step, 'completed');
    const stop = findings.find((f) => BLOCKING.has(f.kind));
    if (stop)
        return h.finish('blocked', `${stop.kind}: ${stop.file}: ${stop.what}`);
    if (agentBlock)
        return h.finish('blocked', agentBlock);
    const counted = findings.filter((f) => !NOTICE.has(f.kind));
    h.finish(counted.length ? 'drift' : 'clean', counted.length ? `${counted.length} findings` : undefined);
}
