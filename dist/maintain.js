import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { askAgent, selectAgent, supported } from './agents.js';
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
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
// The read-only proof: HEAD, the status, and the content of every changed or untracked path. Regular files are hashed
// with sha256 as they are read, and symlinks are fingerprinted by their target text, never read through.
const readable = (p) => {
    try {
        accessSync(p, constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
};
const digest = (abs) => {
    const hash = createHash('sha256');
    const fd = openSync(abs, 'r');
    try {
        const buf = Buffer.alloc(1 << 20);
        let n;
        while ((n = readSync(fd, buf, 0, buf.length, null)) > 0)
            hash.update(buf.subarray(0, n));
    }
    finally {
        closeSync(fd);
    }
    return hash.digest('hex');
};
const repoState = (repo) => {
    const paths = [...new Set([...git(repo, 'diff', '--name-only', '-z', 'HEAD').split('\0'), ...git(repo, 'ls-files', '-z', '--others', '--exclude-standard').split('\0')])].filter(Boolean);
    const files = [];
    const extra = [];
    for (const p of paths) {
        const abs = join(repo, p);
        let st;
        try {
            st = lstatSync(abs, { throwIfNoEntry: false });
        }
        catch {
            extra.push(`${p} unreadable`);
            continue;
        }
        if (st?.isSymbolicLink())
            extra.push(`${p} -> ${readlinkSync(abs)}`);
        else if (st?.isFile() && readable(abs))
            files.push(p);
        else if (st?.isFile())
            extra.push(`${p} unreadable ${st.mode}`);
    }
    return [git(repo, 'rev-parse', 'HEAD'), git(repo, 'status', '--porcelain', '--untracked-files=all'), ...extra, ...files.map((p) => `${p} ${digest(join(repo, p))}`)].join('\n');
};
const lines = (p) => readFileSync(p, 'utf8').split('\n');
// A markdown link's local target without its #anchor, or '' for a URL, mail link or bare anchor.
const LINK = /\[[^\]]*\]\(((?:[^()\s]|\([^()\s]*\))+)[^)]*\)/g;
const localTarget = (t) => (/^[a-z][\w+.-]*:/i.test(t) ? '' : t.split('#')[0]);
// A path:line or path:line-line. A path with a / is checked; a bare name is checked only when its extension is one
// of the tracked files', so host:port text is never read as a citation.
// ponytail: a file name after a / may open with one bracket or paren group (pages/[id].tsx); [[...rest]].tsx is not a citation, add when a repo cites one.
const CITE = /(?<![\w/.-])((?:(?:[\w.-]+|\([\w.-]+\)|\[[\w.-]+\])\/)*(?:[\w-][\w.-]*|(?<=\/)(?:\[[\w.-]+\]|\([\w.-]+\))[\w.-]*)\.[A-Za-z]\w*):(\d+)(?:-(\d+))?\b/g;
// Whether the file at `p` really lies under the repo: a symlinked folder on the way to it is followed, so it counts by where it points.
const realInside = (repo, p) => realpathSync(p).startsWith(`${realpathSync(repo)}${sep}`);
// Why repo-relative `file` has no line `line` (through `end`), or '' when it has.
function citeProblem(repo, file, line, end = line) {
    const p = resolve(repo, file);
    const r = relative(repo, p);
    if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r))
        return `${file} is outside the repository`;
    let n;
    try {
        if (!realInside(repo, p))
            return `${file} is outside the repository`;
        if (!statSync(p, { throwIfNoEntry: false })?.isFile())
            return `${file} is not a file in the repository`;
        const text = readFileSync(p, 'utf8');
        n = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    }
    catch {
        return `${file} is not a file in the repository`;
    }
    return line < 1 || end < line || end > n ? `${file} has ${n} lines` : '';
}
// The tracked files a cited `name` (a repo-relative path or a bare file name) names: the path itself when it is tracked,
// or each tracked file whose path ends with a bare name.
const citedFiles = (repo, tracked, name) => name.includes('/') ? tracked.filter((t) => t === relative(repo, resolve(repo, name))) : tracked.filter((p) => p === name || p.endsWith(`/${name}`));
// Why the cited `name` has no line `line` through `end`, or '' when one of its tracked files has them.
function citeWhy(repo, tracked, name, line, end = line) {
    const files = citedFiles(repo, tracked, name);
    if (!files.length)
        return name.includes('/') ? citeProblem(repo, name, line, end) || `${name} is not a tracked file` : `no tracked file is named ${name}`;
    let first;
    for (const p of files) {
        const why = citeProblem(repo, p, line, end);
        if (!why)
            return '';
        first ??= why;
    }
    return first ?? '';
}
// The text of a tracked file that a feature cites, when it is a regular file inside the repo that can be read.
const citedText = (repo, p) => {
    try {
        const abs = join(repo, p);
        return statSync(abs, { throwIfNoEntry: false })?.isFile() && realInside(repo, abs) ? readFileSync(abs, 'utf8') : undefined;
    }
    catch {
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
const isCite = (x) => typeof x.file === 'string' && Number.isInteger(x.line);
export async function maintainSteps(run, dir, cfg, h) {
    const repo = run.repo;
    const before = repoState(repo);
    const findings = (run.findings = []);
    // One finding per kind, file, line and text: a symlink found by two checks is reported once.
    const add = (f) => {
        if (!findings.some((x) => x.kind === f.kind && x.file === f.file && x.line === f.line && x.what === f.what))
            findings.push({ id: `F${findings.length + 1}`, ...f });
    };
    const rel = (p) => relative(repo, p);
    // A skill path that cannot be read is blocking coverage, not a crash.
    const tryRead = (p, fallback, read) => {
        try {
            return read();
        }
        catch (e) {
            add({ kind: 'coverage', file: rel(p), what: `cannot be read: ${e.code ?? 'an error'}` });
            return fallback;
        }
    };
    const linked = (p) => {
        if (!tryRead(p, false, () => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()))
            return false;
        add({ kind: 'coverage', file: rel(p), what: 'a symlink on the skill path, so maintain does not read through it' });
        return true;
    };
    // 1 locate
    let step = h.begin('locate');
    const skill = join(repo, cfg.skill);
    if (!existsSync(join(skill, 'SKILL.md'))) {
        h.set(step, 'failed');
        return h.finish('blocked', `locate: no verify skill at ${cfg.skill}/SKILL.md`);
    }
    if (realpathSync(skill) !== resolve(realpathSync(repo), cfg.skill)) {
        h.set(step, 'failed');
        return h.finish('blocked', `locate: ${cfg.skill} is reached through a symlink; maintain does not read through it`);
    }
    if (!realInside(repo, skill)) {
        h.set(step, 'failed');
        return h.finish('blocked', `locate: ${cfg.skill} is outside the repository; maintain does not read outside it`);
    }
    h.set(step, 'completed', { outputs: [cfg.skill] });
    // 2 hygiene: every local link in the skill resolves; the index lists each feature file once.
    // A symlinked .md file or directory anywhere in the skill is blocking coverage, and nothing is read through it.
    const docFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) {
            const target = statSync(p, { throwIfNoEntry: false });
            if (e.name.endsWith('.md') || !target || target.isDirectory())
                linked(p);
            return [];
        }
        if (e.isDirectory())
            return docFiles(p);
        return e.isFile() && e.name.endsWith('.md') ? [p] : [];
    });
    const docs = tryRead(skill, [], () => docFiles(skill).sort()).map((f) => ({ f, ls: tryRead(f, [], () => lines(f)) }));
    step = h.begin('hygiene');
    for (const { f, ls } of docs)
        ls.forEach((text, i) => {
            for (const m of text.matchAll(LINK)) {
                const t = localTarget(m[1]);
                if (t && !existsSync(resolve(dirname(f), t)))
                    add({ kind: 'dead-link', file: rel(f), line: i + 1, what: `links to ${m[1]}, which does not exist` });
            }
        });
    const featDir = join(skill, 'features');
    const index = join(featDir, 'README.md');
    // A features folder that is a symlink is never read through, so its index is not checked either.
    const featLinked = linked(featDir);
    const features = existsSync(featDir) && !featLinked ? tryRead(featDir, [], () => readdirSync(featDir)).filter((n) => n.endsWith('.md') && n !== 'README.md').sort() : [];
    if (!featLinked) {
        if (!tryRead(index, true, () => !!statSync(index, { throwIfNoEntry: false })?.isFile()))
            add({ kind: 'index', file: rel(index), what: 'the feature map has no index' });
        else if (!linked(index)) {
            const listed = new Map();
            tryRead(index, [], () => lines(index)).forEach((text, i) => {
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
    }
    if (!features.length)
        add({ kind: 'index', file: rel(featDir), what: 'the feature map has no feature files' });
    h.log('hygiene', { features, findings: [...findings] });
    h.set(step, 'completed');
    // 3 source wave: one fresh, read-only reader per feature file, at the configured agent.
    // ponytail: readers run one after another (askAgent is synchronous); run them in parallel when it is not.
    step = h.begin('source-wave');
    const tracked = git(repo, 'ls-files', '-z').split('\0').filter(Boolean);
    const exts = new Set(tracked.map((p) => extname(p)));
    // A citation in the text: a bare name counts only when its extension is one of the tracked files'.
    const cites = (text) => [...text.matchAll(CITE)].filter((m) => m[1].includes('/') || exts.has(extname(m[1])));
    // The text of each tracked file the feature file cites, for a reader with no tools. A file that cannot be read, or that
    // falls past the cap, is left out and named.
    const citedSource = (feature, text) => {
        const seen = new Map();
        const left = new Set();
        let total = 0;
        let capped = false;
        for (const m of cites(text)) {
            for (const p of citedFiles(repo, tracked, m[1])) {
                if (seen.has(p) || left.has(p))
                    continue;
                if (capped) {
                    left.add(p);
                    continue;
                }
                const body = citedText(repo, p);
                if (body === undefined) {
                    left.add(p);
                    continue;
                }
                const kept = body.length > FEATURE_CHARS ? `${body.slice(0, FEATURE_CHARS)}\n[truncated after ${FEATURE_CHARS} characters]` : body;
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
    const geminiBlock = agent.path && agent.agent === 'gemini' ? 'source-wave: gemini cannot read tool-less yet, since its none mode is read-only plan mode, not tool-free; use claude, opencode, pi or acp' : '';
    if (geminiBlock)
        add({ kind: 'coverage', file: rel(featDir), what: geminiBlock });
    const agentBlock = !agent.path || !supported(agent.agent) ? `source-wave: no agent done-done can start (${agent.agent}${agent.path ? ' is not supported yet' : ' is not on PATH'}); run done-done doctor` : geminiBlock;
    let calls = 0;
    const record = (name) => join(dir, 'agents', `${++calls}-${name}.json`);
    const read = agentBlock ? [] : features.slice(0, MAX_CALLS - 1);
    if (!agentBlock && read.length < features.length)
        add({ kind: 'coverage', file: rel(featDir), what: `${features.length - read.length} feature files not read: the run's call cap is ${MAX_CALLS}` });
    const regular = read.flatMap((name) => {
        const file = join(featDir, name);
        const text = tryRead(file, undefined, () => {
            if (lstatSync(file, { throwIfNoEntry: false })?.isFile())
                return readFileSync(file, 'utf8');
            if (!linked(file))
                add({ kind: 'coverage', file: rel(file), what: 'the feature entry is not a readable file, so no reader covers it' });
            return undefined;
        });
        return text === undefined ? [] : [{ name, text }];
    });
    const readers = regular.map(({ name, text }) => {
        const file = join(featDir, name);
        if (text.length > FEATURE_CHARS)
            add({ kind: 'truncated', file: rel(file), what: `the reader saw only the first ${FEATURE_CHARS} characters of this feature file` });
        const prompt = `You are a read-only source reader for done-done maintain. Do not edit, create or delete any file, and do not run the app or any command.
${toolless ? 'You have no tools: the source that the feature file cites is below, and it is all you can read.' : 'The repository is your working directory.'} Below is one feature file from the verification skill at ${cfg.skill} (app ${cfg.app}).
${toolless ? 'Use the cited source, not the skill, and explain' : "Read the product's source code, not the skill, and explain"} how this user-facing feature works today.
- drift: each statement in the feature file that the source contradicts or no longer supports, each {claim: the feature file's words, why: what the source does instead, file, line: the source location that shows it}. Empty when the file is right.
- recipe: one short recipe to verify the feature live, the way a user reaches it.

Feature file ${rel(file)}:
${text.slice(0, FEATURE_CHARS)}${toolless ? citedSource(rel(file), text.slice(0, FEATURE_CHARS)) : ''}`;
        const a = askAgent({ ...agent, prompt, schema: READER_SCHEMA, cwd: repo, tools: toolless ? 'none' : 'read', record: record(`reader-${name.replace(/\.md$/, '')}`) });
        if (!a.ok)
            add({ kind: 'coverage', file: rel(file), what: `the reader did not answer: ${a.error}` });
        return { feature: rel(file), ok: a.ok, drift: a.answer?.drift, recipe: a.answer?.recipe, ...(a.error && { error: a.error }), record: a.record, ...(a.recordError && { record_error: a.recordError }) };
    });
    h.log('source-wave', { agent: agent.agent, model: agent.model, readers });
    h.set(step, agentBlock ? 'failed' : 'completed', { outputs: readers.flatMap((r) => r.record ?? []) });
    // 4 reconcile: plain code checks each file:line the skill and the readers cite; churn comes from git log.
    step = h.begin('reconcile');
    for (const { f, ls } of docs)
        ls.forEach((text, i) => {
            for (const m of cites(text)) {
                const why = citeWhy(repo, tracked, m[1], Number(m[2]), Number(m[3] ?? m[2]));
                if (why)
                    add({ kind: 'citation', file: rel(f), line: i + 1, what: `cites ${m[0]}, but ${why}` });
            }
        });
    const unverified = (run.unverified = []);
    const shaped = (v, ok, where) => {
        if (!Array.isArray(v)) {
            unverified.push(`${where} is not a list, so none of it is checked`);
            return [];
        }
        return v.flatMap((x) => {
            if (x && typeof x === 'object' && ok(x))
                return [x];
            unverified.push(`${where} has an item in an unexpected shape, so it is not checked`);
            return [];
        });
    };
    for (const r of readers.filter((r) => r.ok)) {
        for (const d of shaped(r.drift, (x) => isCite(x) && typeof x.claim === 'string' && typeof x.why === 'string', `${r.feature} drift`)) {
            const why = citeWhy(repo, tracked, d.file, d.line);
            if (why)
                unverified.push(`${r.feature}: drift "${d.claim}" cites ${d.file}:${d.line}: ${why}`);
            else
                add({ kind: 'drift', file: r.feature, what: `"${d.claim}": ${d.why} (source ${d.file}:${d.line})` });
        }
    }
    const skillDir = rel(skill);
    // ponytail: the reconcile prompt names only the CHURN_MAX most recently changed paths; older ones get no coverage check.
    const trackedSet = new Set(tracked);
    const churnAll = [...new Set(git(repo, 'log', `--since=${CHURN_SINCE}`, '--name-only', '-z', '--format=').split('\0'))]
        .filter((p) => p && !p.startsWith(`${skillDir}/`) && trackedSet.has(p));
    const churn = churnAll.slice(0, CHURN_MAX);
    let recipes = [];
    const answered = readers.filter((r) => r.ok);
    if (answered.length) {
        const prompt = `You reconcile the source readers of done-done maintain for the verification skill of ${cfg.app}. Use no tools.
- recipes: merge the readers' recipes below into as few app states as practical, each {state: what to set up once, features: the feature files it covers, steps: the drive steps in order}.
- missing: from the recently changed files listed below, each one that is a user-facing surface no feature covers, as {file: the path exactly as listed, why}. Empty when none.

Features (JSON): ${JSON.stringify(answered.map((r) => ({ feature: r.feature, recipe: r.recipe })))}

Recently changed files (git log since ${CHURN_SINCE}, most recent first${churnAll.length > churn.length ? `; ${churnAll.length - churn.length} older paths left out` : ''}): ${churn.length ? churn.join(', ') : 'none'}`;
        const a = askAgent({ ...agent, prompt, schema: RECONCILE_SCHEMA, cwd: repo, tools: 'none', record: record('reconcile') });
        if (!a.ok)
            add({ kind: 'coverage', file: skillDir, what: `the reconcile call did not answer: ${a.error}` });
        if (a.answer) {
            recipes = shaped(a.answer.recipes, (x) => typeof x.state === 'string' && Array.isArray(x.features) && Array.isArray(x.steps), 'reconcile recipes');
            for (const m of shaped(a.answer.missing, (x) => typeof x.file === 'string' && typeof x.why === 'string', 'reconcile missing')) {
                if (churn.includes(m.file))
                    add({ kind: 'unmapped', file: m.file, what: `changed recently and no feature covers it: ${m.why}` });
                else
                    unverified.push(`missing ${m.file}: not in the churn list`);
            }
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
