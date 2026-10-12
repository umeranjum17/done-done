#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { encode } from '@toon-format/toon';
import { loadConfig, UsageError } from './config.js';
import { judge } from './judge.js';
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
// One table drives `--help` and every `<command> --help`: each command's usage lines and the flags it takes.
const FLAGS = {
    '-- <command...>': 'run this command instead of a journey; ${RUN_ID} in it becomes the run id',
    '--open': 'open a run for a hand- or agent-driven proof; prints its id and folder',
    '--close <run-id>': 'seal an open run and record the files in its folder',
    '--outcome "<claim>"': 'the outcome the evidence files prove; the files follow as arguments',
    '--from <file | - | PR URL>': 'read the claim from the newest "## Checks" block of a file, stdin or a PR body',
    '--trusted-ref <ref>': 'read .done-done.yaml from this git ref instead of the working tree (use in CI)',
    '--claim-id <id>': 'the claim the evidence proves; evidence already used for another claim id is reuse (default: the current branch, or the PR branch with --from <PR URL>; required on a detached HEAD)',
    '--judge': 'a model says whether each PNG/JPEG capture shows the outcome (off by default; or judge.enabled: true)',
    '--verify <head>': 'read-only: verify the receipt recorded for <head>',
};
// `more` is the reference text a command needs beyond its flags, shared with the top-level help.
const COMMANDS = {
    init: { usage: [['done-done init', 'write a minimal .done-done.yaml (evidence lives outside the repo)']], flags: [], more: [JOURNEYS_TEXT] },
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
const rows = (pairs, width = Math.max(...pairs.map(([a]) => a.length)) + 3) => pairs.map(([a, b]) => `  ${a}${' '.repeat(Math.max(3, width - a.length))}${b}`).join('\n');
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
function commandHelp(cmd) {
    const c = COMMANDS[cmd];
    const flags = c.flags.length ? rows(c.flags.map((f) => [f, FLAGS[f]])) : '  none';
    return [`usage:\n${rows(c.usage)}`, `flags:\n${flags}`, ...c.more, GLOBAL_TEXT].join('\n');
}
// How many list rows a compact result shows before it reports the rest as omitted.
const COMPACT_LIST = 5;
let OUT = 'toon';
let FULL = false;
// One machine-readable result on stdout: TOON by default (the AXI convention), JSON with --json.
function emit(value) {
    process.stdout.write(`${OUT === 'json' ? JSON.stringify(value, null, 2) : encode(value)}\n`);
}
// Compact results cap long lists; --full returns every row.
function cap(items) {
    return FULL || items.length <= COMPACT_LIST ? { items, omitted: 0 } : { items: items.slice(0, COMPACT_LIST), omitted: items.length - COMPACT_LIST };
}
// A hint that names the exact command that moves the work forward, naming the journey when there is one.
function captureHint(cfg) {
    const names = Object.keys(cfg.journeys);
    if (names.length === 1)
        return `done-done run ${names[0]}`;
    if (names.length > 1)
        return `done-done run <journey> (${names.join(', ')})`;
    return 'done-done run -- <capture command>';
}
// A path as the user should see it: repo-relative inside the repo, else with the home directory as ~.
const outside = (r) => r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r);
const shown = (repo, p) => {
    const r = relative(repo, p);
    if (r && !outside(r))
        return r;
    if (!r)
        return '.';
    const rh = relative(homedir(), p);
    return rh && !outside(rh) ? `~${sep}${rh}` : p;
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
// `p` relative to `base` when it lies under it, else null.
function under(base, p) {
    const r = relative(base, p);
    return r && !outside(r) ? r : null;
}
// A path to pass back to done-done (an evidence file to cite, a folder to capture into): exact, so no shell
// needs to expand `~`. Repo-relative inside the repo, absolute outside it (the default evidence root).
const citable = (repo, p) => under(repo, p) ?? p;
function repoRoot() {
    try {
        return git(process.cwd(), 'rev-parse', '--show-toplevel');
    }
    catch {
        throw new UsageError('not inside a git repository');
    }
}
function head(repo) {
    return {
        commit: git(repo, 'rev-parse', 'HEAD'),
        tree: git(repo, 'rev-parse', 'HEAD^{tree}'),
        dirty: git(repo, 'status', '--porcelain', '--untracked-files=no') !== '',
    };
}
const recordsDir = (cfg) => join(cfg.evidence.root, '.done-done', 'runs');
// Each run captures into its own new folder in the evidence root. Every checkout of a repo shares that root,
// so a run records only its own folder and never claims a file another, overlapping run wrote.
const runDir = (cfg, runId) => join(cfg.evidence.root, runId);
// Every file in a run's folder, relative to the evidence root.
function captured(cfg, runId) {
    const dir = runDir(cfg, runId);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(cfg.evidence.root, join(e.parentPath, e.name)));
}
function writeRecord(cfg, rec) {
    const path = join(recordsDir(cfg), `${rec.run_id}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
    return path;
}
function openRun(repo, cfg, journey, command) {
    const h = head(repo);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    // The random suffix keeps two runs in the same second at one commit apart; mkdir without recursive refuses a reused id.
    const runId = `${stamp}-${h.commit.slice(0, 8)}-${randomBytes(3).toString('hex')}`;
    mkdirSync(cfg.evidence.root, { recursive: true });
    mkdirSync(runDir(cfg, runId));
    return { schema: 1, run_id: runId, journey, command, ...h, started_at: new Date().toISOString(), ended_at: null, exit: null, files: [] };
}
function closeRun(repo, cfg, rec) {
    const now = head(repo);
    rec.files = captured(cfg, rec.run_id)
        .sort()
        .map((p) => {
        const b = readFileSync(join(cfg.evidence.root, p));
        return { path: p, sha256: sha256(b), bytes: b.length };
    });
    rec.ended_at = new Date().toISOString();
    const record = writeRecord(cfg, rec);
    const rel = (p) => citable(repo, join(cfg.evidence.root, p));
    let reason = '';
    if (now.commit !== rec.commit)
        reason = `HEAD moved from ${rec.commit} to ${now.commit} during the run; evidence is not tied to one commit`;
    else if (rec.exit !== null && rec.exit !== 0)
        reason = `the run command exited ${rec.exit}`;
    else if (!rec.files.length)
        reason = `the run wrote no files into its folder ${shown(repo, runDir(cfg, rec.run_id))}; the command gets it as $DONE_DONE_EVIDENCE_ROOT and its run id as $DONE_DONE_RUN_ID (or \${RUN_ID} in the command)`;
    const evidence = FULL ? rec.files.map((f) => ({ path: rel(f.path), sha256: f.sha256, bytes: f.bytes })) : rec.files.map((f) => rel(f.path));
    const rows = cap(evidence);
    const result = {
        command: 'run',
        result: reason ? 'fail' : 'pass',
        run_id: rec.run_id,
        commit: rec.commit,
        dirty: rec.dirty,
        files: rec.files.length,
        record: shown(repo, record),
    };
    if (reason)
        result.reason = reason;
    result.evidence = rows.items;
    if (rows.omitted)
        result.evidence_omitted = rows.omitted;
    result.help = [reason
            ? `Fix the capture, commit, then re-run: ${captureHint(cfg)}`
            : `Check this proof: done-done check --outcome "<what you proved>" ${rel(rec.files[0].path)}`];
    emit(result);
    return reason ? FAIL : PASS;
}
function cmdRun(argv) {
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
        if (!existsSync(path))
            throw new UsageError(`no open run ${values.close} (looked for ${shown(repo, path)})`);
        const rec = JSON.parse(readFileSync(path, 'utf8'));
        if (rec.ended_at)
            throw new UsageError(`run ${values.close} is already closed`);
        return closeRun(repo, cfg, rec);
    }
    const journey = positionals[0] ?? null;
    if (positionals.length > 1)
        throw new UsageError('run takes at most one journey name');
    let command = dash < 0 ? null : argv.slice(dash + 1).join(' ');
    if (journey && !command) {
        const j = cfg.journeys[journey];
        if (!j)
            throw new UsageError(`unknown journey ${journey}; .done-done.yaml defines: ${Object.keys(cfg.journeys).join(', ') || 'none'}`);
        command = j.command;
    }
    const rec = openRun(repo, cfg, journey, command);
    if (values.open) {
        if (command)
            throw new UsageError('--open takes no command; drive the proof, then run --close');
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
    if (!command)
        throw new UsageError('run needs a journey, a command after --, or --open');
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
// The newest "## Checks" block: outcome, repro, proof and evidence lines.
function claimFromChecks(body, title, repo, cfg, out) {
    const blocks = [...body.matchAll(/^##\s*Checks\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/gm)];
    if (!blocks.length)
        return void out.push({ level: 'fail', why: 'no "## Checks" block' });
    const text = blocks[blocks.length - 1][1].replace(/^\s*```.*$/gm, '');
    const f = {};
    for (const m of text.matchAll(/^\s*(outcome|repro|proof|evidence)\s*:\s*(.*)$/gm))
        f[m[1]] = m[2].trim();
    const missing = ['outcome', 'repro', 'proof', 'evidence'].filter((k) => !f[k]);
    if (missing.length)
        return void out.push({ level: 'fail', why: `Checks block is missing ${missing.join(', ')}` });
    if (!/[/`]|\.\w+\b|\b(npm|pnpm|yarn|npx|node|bash|sh|python3?|cargo|go|gradle|make|adb|xcrun|done-done)\b/.test(f.proof))
        out.push({ level: 'fail', why: 'proof names no command or path' });
    const skill = cfg.skill.split('/').pop();
    if (existsSync(join(repo, cfg.skill))) {
        if (!f.proof.includes(skill))
            out.push({ level: 'fail', why: `proof does not name the project's verify skill ${skill}` });
    }
    else if (!/verify-|no verify skill/i.test(f.proof))
        out.push({ level: 'fail', why: 'proof names no verify skill and does not say "no verify skill"' });
    if (/^n\/?a\b/i.test(f.repro) && new RegExp(cfg.checks.fix_title, 'i').test(title))
        out.push({ level: 'fail', why: 'a fix needs a repro, not n/a' });
    const np = f.evidence.match(/^not proven\s*:?\s*(.*)$/i);
    if (np)
        return { outcome: f.outcome, files: [], title, notProven: np[1] || 'no cause given' };
    const files = f.evidence.split(/[\s,]+/).map((t) => t.replace(/^[`'"(]+|[`'"),.;]+$/g, '')).filter((t) => /\.\w{1,10}$/.test(t));
    if (!files.length)
        out.push({ level: 'fail', why: 'evidence names no files' });
    return { outcome: f.outcome, files, title };
}
// A PR body also names its head branch, which is the claim a CI checkout (a detached HEAD) is checking.
function readSource(from) {
    if (from === '-')
        return { body: readFileSync(0, 'utf8'), title: '' };
    if (/^https?:\/\//.test(from)) {
        const r = spawnSync('gh', ['pr', 'view', from, '--json', 'body,title,headRefName'], { encoding: 'utf8' });
        if (r.error || r.status !== 0)
            throw new UsageError(`gh pr view ${from} failed: ${(r.error?.message || r.stderr).trim()}`);
        const pr = JSON.parse(r.stdout);
        return { body: pr.body, title: pr.title, branch: pr.headRefName };
    }
    try {
        return { body: readFileSync(from, 'utf8'), title: '' };
    }
    catch (e) {
        throw new UsageError(`cannot read ${from}: ${e.message}`);
    }
}
function loadRecords(cfg) {
    const dir = recordsDir(cfg);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8'))).filter((r) => r.ended_at);
}
// Run a check and return its result without printing it, so `check` and `receipt` share one path.
async function runCheck(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        options: { outcome: { type: 'string' }, from: { type: 'string' }, 'claim-id': { type: 'string' }, 'trusted-ref': { type: 'string' }, judge: { type: 'boolean' } },
        allowPositionals: true,
    });
    if (!!values.outcome === !!values.from)
        throw new UsageError('check needs exactly one of --outcome or --from');
    if (values.from && positionals.length)
        throw new UsageError('--from takes no file arguments; the Checks block names them');
    if (values['claim-id']?.trim() === '')
        throw new UsageError('--claim-id needs a non-empty id');
    const repo = repoRoot();
    let projectText = null;
    if (values['trusted-ref']) {
        try {
            projectText = git(repo, 'show', `${values['trusted-ref']}:.done-done.yaml`);
        }
        catch (e) {
            const msg = e.stderr ?? '';
            if (!/does not exist|exists on disk, but not in/.test(msg))
                throw new UsageError(`cannot read .done-done.yaml at ${values['trusted-ref']}: ${msg.trim()}`);
            projectText = '';
        }
    }
    const cfg = loadConfig(repo, projectText);
    const now = head(repo);
    const findings = [];
    let claim;
    let prBranch;
    if (values.outcome) {
        if (!positionals.length)
            throw new UsageError('--outcome needs at least one evidence file');
        claim = { outcome: values.outcome, files: positionals, title: '' };
    }
    else {
        const src = readSource(values.from);
        prBranch = src.branch;
        claim = claimFromChecks(src.body, src.title, repo, cfg, findings);
    }
    if (claim?.notProven) {
        const allowed = cfg.checks.not_proven === 'allow' && cfg.trusted;
        const rep = report(findings.concat(allowed ? [] : [{ level: 'inconclusive', why: `not proven: ${claim.notProven}` }]), [], { cfg, repo, claim: claim.outcome, source: values.from, notProven: true }, allowed ? 'not proven (allowed by trusted config)' : '');
        return { code: rep.code, result: rep.result, claim: claim?.outcome, files: [], cited: [], head: now };
    }
    const files = claim?.files ?? [];
    const records = loadRecords(cfg);
    const seen = new Map();
    const hashes = [];
    const cited = [];
    const captures = [];
    for (const name of files) {
        const path = resolve(name);
        let bytes;
        try {
            if (!statSync(path).isFile())
                throw new Error('not a regular file');
            bytes = readFileSync(path);
        }
        catch (e) {
            findings.push({ level: 'fail', why: `${name}: missing (${e.code ?? e.message})` });
            continue;
        }
        const v = checkMedia(path, bytes);
        if (v.status !== 'ok')
            findings.push({ level: v.status === 'fail' ? 'fail' : 'inconclusive', why: `${name}: ${v.why}` });
        const hash = sha256(bytes);
        hashes.push(hash);
        cited.push({ path: receiptPath(repo, cfg, path), sha256: hash });
        if (seen.has(hash))
            findings.push({ level: 'fail', why: `${name}: byte-identical to ${seen.get(hash)}` });
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
        if (v.status === 'fail')
            continue;
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
        if (v.status === 'ok')
            captures.push({ name, bytes, sha256: hash, media: v });
        const stale = staleness(repo, cfg, rec.commit, now.commit);
        if (stale)
            findings.push({ level: 'fail', why: `${name}: ${stale} (run ${rec.run_id})` });
        if (rec.dirty && !cfg.evidence.allow_dirty)
            findings.push({ level: 'fail', why: `${name}: captured from a tree with uncommitted changes (run ${rec.run_id})` });
        if (rec.exit !== null && rec.exit !== 0)
            findings.push({ level: 'fail', why: `${name}: its run command exited ${rec.exit} (run ${rec.run_id})` });
    }
    // Reuse: fail only when every cited file was already used for a different claim id. The ledger lives in the
    // evidence root next to the run records it guards: one per app (repo), shared by every checkout of it, never in git.
    const ledger = join(cfg.evidence.root, '.done-done', 'ledger');
    const given = values['claim-id']?.replace(/\s+/g, ' ').trim();
    const claimId = given || prBranch || git(repo, 'branch', '--show-current');
    const idFrom = given ? '--claim-id' : prBranch ? 'the PR branch' : 'the current branch';
    if (!claimId && claim)
        throw new UsageError('HEAD is detached, so no branch names this claim; pass --claim-id <id>', 'Re-run with --claim-id <the branch or task this claim is for>');
    const used = new Map();
    if (existsSync(ledger))
        for (const line of readFileSync(ledger, 'utf8').split('\n')) {
            const [h, k] = [line.slice(0, 64), line.slice(65)];
            if (k)
                used.set(h, (used.get(h) ?? new Set()).add(k));
        }
    const others = (h) => [...(used.get(h) ?? [])].filter((k) => k !== claimId);
    if (hashes.length && hashes.every((h) => others(h).length))
        findings.push({ level: 'fail', why: `every evidence file was already used as proof of a different claim (claim id ${[...new Set(hashes.flatMap(others))].join(', ')}), not this one (claim id ${claimId}, from ${idFrom}); if it is the same claim, pass --claim-id with its id` });
    let judged;
    let judgeLevel;
    if ((values.judge || cfg.judge.enabled) && claim) {
        if (findings.some((f) => f.level === 'fail'))
            judged = { skipped: 'the check already failed, so no capture was judged' };
        else {
            const j = await judge(cfg, claim.outcome, captures);
            // The judge's next step leads the help when its verdict decides the result.
            if (j.judged.some((r) => r.verdict === 'fail'))
                judgeLevel = 'fail';
            else if (!findings.length && j.judged.some((r) => r.verdict === 'unsure'))
                judgeLevel = 'inconclusive';
            for (const r of j.judged.filter((r) => r.verdict !== 'pass'))
                findings.push({ level: r.verdict === 'fail' ? 'fail' : 'inconclusive', why: `${r.path}: judge says ${r.verdict === 'fail' ? 'wrong screen' : 'unsure'}: ${r.reason}` });
            const rows = cap(j.judged);
            judged = { model: j.model, judged: rows.items };
            if (rows.omitted)
                judged.judged_omitted = rows.omitted;
            if (j.notJudged.length)
                judged.not_judged = j.notJudged;
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
async function cmdCheck(argv) {
    const r = await runCheck(argv);
    emit(r.result);
    return r.code;
}
const receiptsDir = (cfg) => join(cfg.evidence.root, '.done-done', 'receipts');
// A receipt names a cited file relative to the repo, or to an evidence root outside it under this prefix,
// so any checkout of the repo (or a CI job that restored the evidence root) finds the same file.
const IN_EVIDENCE = '<evidence root>/';
function receiptPath(repo, cfg, p) {
    const inRepo = under(repo, p);
    if (inRepo !== null)
        return inRepo;
    const inRoot = under(cfg.evidence.root, p);
    return inRoot === null ? p : IN_EVIDENCE + inRoot;
}
function writeReceipt(cfg, rec) {
    const path = join(receiptsDir(cfg), `${rec.head}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return path;
}
// Verify a recorded receipt for `headArg`, which may be a full sha or a ref (HEAD, a branch or a tag).
// Read-only, so a missing or changed record is a failure, not a usage error.
function verifyReceipt(repo, cfg, headArg) {
    let commit = headArg;
    try {
        commit = git(repo, 'rev-parse', '--verify', `${headArg}^{commit}`);
    }
    catch {
        // Unresolvable: keep the argument so the lookup below fails with the current "no receipt" shape.
    }
    const short = commit.slice(0, 12);
    const path = join(receiptsDir(cfg), `${commit}.json`);
    const fail = (reason) => {
        emit({ command: 'receipt', result: 'fail', head: commit, reason, help: ['Record a passing check for this head: done-done receipt --from <file|->'] });
        return FAIL;
    };
    if (!existsSync(path))
        return fail(`no receipt for ${short} in ${receiptsDir(cfg)}`);
    let rec;
    try {
        rec = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (e) {
        return fail(`receipt for ${short} is malformed (${e.message})`);
    }
    if (!rec || typeof rec !== 'object' || rec.schema !== 1 || rec.result !== 'pass' || !Array.isArray(rec.files) || !rec.files.length)
        return fail(`receipt for ${short} is malformed`);
    if (!rec.files.every((f) => f && typeof f === 'object' && typeof f.path === 'string' && typeof f.sha256 === 'string'))
        return fail(`receipt for ${short} is malformed`);
    if (rec.head !== commit)
        return fail(`receipt records head ${String(rec.head).slice(0, 12)}, not ${short}`);
    const now = head(repo);
    if (now.commit !== commit)
        return fail(`HEAD is ${now.commit.slice(0, 12)}, not ${short}`);
    const records = loadRecords(cfg);
    const bad = [];
    for (const f of rec.files) {
        let bytes;
        try {
            bytes = readFileSync(f.path.startsWith(IN_EVIDENCE) ? join(cfg.evidence.root, f.path.slice(IN_EVIDENCE.length)) : resolve(repo, f.path));
        }
        catch {
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
    if (bad.length)
        return fail(`cited evidence no longer matches the receipt: ${bad.join('; ')}`);
    emit({ command: 'receipt', result: 'pass', head: commit, tree: rec.tree, claim: rec.claim, files: rec.files.length, at: rec.at, help: ['This receipt is valid for this head.'] });
    return PASS;
}
async function cmdReceipt(argv) {
    const vi = argv.indexOf('--verify');
    let verifyHead = null;
    let rest = argv;
    if (vi >= 0) {
        verifyHead = argv[vi + 1] ?? null;
        if (!verifyHead || verifyHead.startsWith('--'))
            throw new UsageError('receipt --verify needs a head sha or ref');
        rest = [...argv.slice(0, vi), ...argv.slice(vi + 2)];
    }
    const repo = repoRoot();
    const cfg = loadConfig(repo);
    if (verifyHead) {
        if (rest.length)
            throw new UsageError('receipt --verify takes no other arguments');
        return verifyReceipt(repo, cfg, verifyHead);
    }
    if (!rest.length)
        throw new UsageError('receipt needs a claim (--outcome "<claim>" <files...> or --from <file|->) or --verify <head>');
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
    const rec = { schema: 1, repo: cfg.app, head: r.head.commit, tree: r.head.tree, claim: r.claim ?? '', result: 'pass', at: new Date().toISOString(), files: r.cited };
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
function staleness(repo, cfg, from, to) {
    if (from === to)
        return '';
    let changed;
    try {
        changed = git(repo, 'diff', '--name-only', from, to).split('\n').filter(Boolean);
    }
    catch {
        return `evidence is for commit ${from.slice(0, 12)}, which is not in this repository`;
    }
    const outside = changed.filter((p) => !cfg.evidence.ignore_paths.some((g) => matchesGlob(p, g)));
    if (changed.length && !outside.length)
        return '';
    return `evidence is for commit ${from.slice(0, 12)}, HEAD is ${to.slice(0, 12)}${outside.length ? ` (changed: ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', ...' : ''})` : ''}`;
}
// Quote an argument only when a shell would split it.
const arg = (a) => (/^[\w./@:+-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`);
function checkHelp(code, files, { cfg, repo, claim, source, notProven, judgeLevel }) {
    if (notProven)
        return ['Capture real proof and replace "not proven:", or set checks.not_proven: allow and re-check from a trusted ref'];
    if (judgeLevel === 'fail' && code === FAIL)
        return [`Capture the screen the outcome describes, then re-run this check: ${captureHint(cfg)}`];
    if (judgeLevel && code === INCONCLUSIVE)
        return ['Look at the capture yourself, or capture a clearer screen of the outcome and re-run this check'];
    if (code === PASS) {
        // The CI gate needs a PR on a remote; without one, a receipt records the pass locally.
        if (spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repo }).status === 0)
            return ['Gate CI on this proof: done-done check --from <PR URL> --trusted-ref origin/main'];
        const claimArgs = source ? ['--from', source] : ['--outcome', claim ?? '', ...files];
        return [`Record this pass for HEAD: done-done receipt ${claimArgs.map(arg).join(' ')}`];
    }
    const capture = captureHint(cfg);
    if (code === INCONCLUSIVE)
        return [`Capture this proof through a run so it is tied to a commit, then re-run this check: ${capture}`];
    return [`Commit your change, re-capture with ${capture}, then check the new files`];
}
function report(findings, files, ctx, note = '') {
    const code = findings.some((f) => f.level === 'fail') ? FAIL : findings.length ? INCONCLUSIVE : PASS;
    const result = {
        command: 'check',
        result: code === PASS ? 'pass' : code === FAIL ? 'fail' : 'inconclusive',
    };
    if (ctx.claim)
        result.claim = ctx.claim;
    if (ctx.source)
        result.source = ctx.source;
    if (note)
        result.note = note;
    if (files.length) {
        const ev = cap(files);
        result.files = files.length;
        result.evidence = ev.items;
        if (ev.omitted)
            result.evidence_omitted = ev.omitted;
    }
    if (ctx.judge)
        result.judge = ctx.judge;
    const rows = cap(findings.map((f) => ({ level: f.level, why: f.why })));
    if (rows.items.length)
        result.findings = rows.items;
    if (rows.omitted)
        result.findings_omitted = rows.omitted;
    result.help = checkHelp(code, files, ctx);
    return { code, result };
}
// Append `<rel>/` to .gitignore unless git already ignores it. Never rewrites existing bytes.
function ensureIgnored(repo, rel) {
    const entry = `${rel.replace(/\/+$/, '')}/`;
    if (spawnSync('git', ['check-ignore', '--no-index', '-q', '--', entry], { cwd: repo }).status === 0)
        return false;
    const file = join(repo, '.gitignore');
    if (!existsSync(file)) {
        writeFileSync(file, `${entry}\n`);
        return true;
    }
    const text = readFileSync(file, 'utf8');
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`);
    return true;
}
function cmdInit(argv) {
    parseArgs({ args: argv, options: {}, allowPositionals: false });
    const repo = repoRoot();
    const file = join(repo, '.done-done.yaml');
    const existed = existsSync(file);
    const cfg = loadConfig(repo); // validates the existing project config; malformed -> exit 2, no writes
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
    const root = shown(repo, cfg.evidence.root);
    const check = 'done-done check --outcome "<what you proved>" <files it recorded>';
    emit({
        command: 'init',
        result: 'pass',
        config: existed ? 'unchanged' : 'written',
        app: cfg.app,
        evidence_root: root,
        gitignore: added ? `added ${rel.replace(/\/+$/, '')}/` : 'unchanged',
        help: Object.keys(cfg.journeys).length
            ? [`Capture proof: ${captureHint(cfg)}, then: ${check}`]
            : [`Add a journey that drives the real app and saves proof under $DONE_DONE_EVIDENCE_ROOT (each run's own folder in ${root}), e.g. ${journeyExample}`, `Then commit, run \`done-done run smoke\`, and: ${check}`],
    });
    return PASS;
}
// The exact next command for a usage or config error, so an agent can recover without reading --help.
function errorHelp(msg, cmd) {
    if (/not inside a git repository/.test(msg))
        return ['Run done-done from inside a git repository'];
    if (/unknown journey|run needs a journey/.test(msg))
        return ['Run `done-done` to list journeys, or capture a one-off proof: done-done run -- <command>'];
    if (cmd && /Unknown option|Unexpected argument|argument missing/.test(msg))
        return [`Valid flags for ${cmd}: ${COMMANDS[cmd].flags.join(', ') || 'none'}. Run \`done-done ${cmd} --help\` for its usage`];
    // Config errors name their file (.done-done.yaml or the global config.yaml); init never rewrites one, so fixing it is the way out.
    if (/\.done-done\.yaml|config\.yaml:/.test(msg))
        return [`Fix the config file named above, then re-run: done-done${cmd ? ` ${cmd}` : ''}`];
    if (!cmd)
        return ['Run `done-done --help` for every command and flag'];
    return [`Run \`done-done ${cmd} --help\` for its usage and flags`];
}
// Bare `done-done`: orient a new user or agent with the config state and the next step.
function cmdBare() {
    let repo;
    try {
        repo = repoRoot();
    }
    catch {
        emit({ command: 'done-done', config: 'none', help: ['Run done-done inside a git repository, then `done-done init` to set up proof'] });
        return PASS;
    }
    if (!existsSync(join(repo, '.done-done.yaml'))) {
        emit({ command: 'done-done', config: 'missing', help: ['Run `done-done init` to write a minimal .done-done.yaml'] });
        return PASS;
    }
    const cfg = loadConfig(repo);
    const journeys = Object.keys(cfg.journeys);
    const result = {
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
async function main(argv) {
    const dash = argv.indexOf('--');
    const head = dash < 0 ? argv : argv.slice(0, dash);
    const kept = [];
    for (const a of head) {
        if (a === '--json')
            OUT = 'json';
        else if (a === '--full')
            FULL = true;
        else
            kept.push(a);
    }
    const [cmd, ...rest] = [...kept, ...(dash < 0 ? [] : argv.slice(dash))];
    const sub = Object.hasOwn(COMMANDS, cmd) ? cmd : undefined;
    if (sub && (kept.includes('--help') || kept.includes('-h'))) {
        console.log(commandHelp(sub));
        return PASS;
    }
    try {
        if (cmd === 'init')
            return cmdInit(rest);
        if (cmd === 'run')
            return cmdRun(rest);
        if (cmd === 'check')
            return await cmdCheck(rest);
        if (cmd === 'receipt')
            return await cmdReceipt(rest);
        if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
            console.log(USAGE_TEXT);
            return PASS;
        }
        if (cmd === undefined)
            return cmdBare();
        throw new UsageError(`unknown command ${cmd}`);
    }
    catch (e) {
        const msg = (e.stderr || e.message || String(e)).trim();
        emit({ command: sub ?? 'done-done', error: msg, help: e instanceof UsageError && e.help ? [e.help] : errorHelp(msg, sub) });
        return USAGE;
    }
}
process.exitCode = await main(process.argv.slice(2));
