// Conformance: every skill command and worked example the repo ships runs as
// written on a clean install, and every guard refuses bad input with a clear
// reason without false-failing real evidence. Integration style: drives the
// real built CLI against throwaway git repos with fictional fixtures.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { decode } from '@toon-format/toon';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const toon = (r) => decode(r.out);

const screen = () => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const w = 200, h = 120, raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([(x * 3) % 256, (y * 5) % 256, (x + y) % 256], y * (w * 3 + 1) + 1 + x * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

// done-done gives no result without its judge, so the user's judge here is a stub (never a model): a gemini stub through
// agent_path_override that says each capture shows the outcome.
function stubJudge(dir) {
  const bin = join(dir, 'judge-gemini');
  const answer = JSON.stringify({ relevance: { probabilities: { correct: 0.95, wrong: 0.03, unclear: 0.02 }, rationale: 'It shows the outcome.', personReason: 'It shows the outcome.' } });
  writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').readFileSync(0, 'utf8');\nprocess.stdout.write(JSON.stringify({ response: ${JSON.stringify(answer)} }));\n`, { mode: 0o755 });
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(join(dir, 'home', 'config.yaml'), `judge:\n  route: answerer:gemini\n  model: stub-judge\nagent_path_override: { gemini: ${JSON.stringify(bin)} }\n`);
}

// A clean install: a bare git repo, a throwaway HOME (never the user's logins), and the user's judge set.
function cleanRepo(yaml = 'app: notes\nevidence:\n  root: .proof\njourneys:\n  smoke:\n    command: node make-shots.mjs ${RUN_ID}\n') {
  const dir = mkdtempSync(join(tmpdir(), 'dd-conformance-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const env = { ...process.env, DONE_DONE_HOME: join(dir, 'home'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, '.done-done.yaml'), yaml);
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1;\n');
  writeFileSync(join(dir, 'screen.png'), screen());
  stubJudge(dir);
  writeFileSync(join(repo, 'make-shots.mjs'),
    `import { copyFileSync, mkdirSync } from 'node:fs';\nconst out = '.proof/' + process.argv[2];\nmkdirSync(out, { recursive: true });\ncopyFileSync(${JSON.stringify(join(dir, 'screen.png'))}, out + '/home.png');\n`);
  const sh = (...a) => execFileSync('git', a, { cwd: repo, env, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main');
  sh('add', '-A');
  sh('commit', '-qm', 'init');
  const at = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
  };
  const dd = (...args) => at(repo, ...args);
  const head = () => sh('rev-parse', 'HEAD').toString().trim();
  return { dir, repo, env, sh, dd, at, head };
}

test('the skill discovery path works: bare command, --help and every command --help', () => {
  const { dd } = cleanRepo();
  assert.equal(dd().code, 0, 'bare done-done shows this repo state');
  assert.equal(toon(dd()).config, 'present');
  assert.match(dd('--help').out, /done-done run/, '--help lists the commands');
  assert.equal(dd('--version').code, 0);
  for (const cmd of ['init', 'doctor', 'run', 'check', 'receipt', 'verify', 'respond', 'status', 'attach', 'logs', 'rerun', 'abort', 'history', 'signoff', 'design', 'maintain']) {
    const r = dd(cmd, '--help');
    assert.equal(r.code, 0, `${cmd} --help: ${r.out}`);
  }
});

test('the README manual-CLI worked example runs as written: init, journey, run, check, receipt, verify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-conformance-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'app');
  const env = { ...process.env, DONE_DONE_HOME: join(dir, 'home'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  mkdirSync(repo, { recursive: true });
  const sh = (...a) => execFileSync('git', a, { cwd: repo, env, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'app.js'), 'export const app = 1;\n');
  sh('add', '-A');
  sh('commit', '-qm', 'init');
  const dd = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
  };
  assert.equal(dd('init', '--journey', 'smoke', '--', 'npm test > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log').code, 2, 'init records the journey and stops at the agent ask');
  // The user's answer to the judge ask, saved in the global config.
  stubJudge(dir);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(\'ok\')"' } }));
  sh('add', '-A');
  sh('commit', '-qm', 'Add done-done');
  const run = dd('run', '--json', 'smoke');
  assert.equal(run.code, 0, run.out);
  const [log] = JSON.parse(run.stdout).evidence;
  assert.equal(dd('check', '--outcome', 'it starts', log).code, 0);
  assert.equal(dd('receipt', '--outcome', 'it starts', log).code, 0);
  assert.equal(dd('receipt', '--verify', sh('rev-parse', 'HEAD').toString().trim()).code, 0);
});

test('the reference init shapes run as written: --agent, --journey and every --hook', () => {
  const { repo, dd } = cleanRepo('app: notes\n');
  assert.match(dd('init', '--agent', 'opencode', '--model', 'opencode-go/muse-spark-1.3-contributor').out, /opencode/, 'init --agent saves the coding agent');
  assert.equal(toon(dd('init', '--journey', 'smoke', '--', 'echo added: milk > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log')).journey, 'smoke');
  for (const [flag, file] of [['claude', '.claude/settings.json'], ['codex', '.codex/hooks.json'], ['opencode', '.opencode/plugins/done-done.js'], ['gemini', '.gemini/settings.json'], ['pi', '.pi/extensions/done-done.js']]) {
    assert.match(dd('init', '--hook', flag).out, new RegExp(file.replace(/[./]/g, '\\$&').slice(0, 12)), `init --hook ${flag}`);
    assert.ok(existsSync(join(repo, file)), `init --hook ${flag} writes ${file}`);
  }
});

test('the brief-include contract runs as written: init, run, checks.md, check --from, receipt --from', () => {
  const { dir, repo, sh, dd, head } = cleanRepo();
  const { run_id: id } = toon(dd('run', 'smoke'));
  const h = head();
  const body = `## Checks\noutcome: home renders\nrepro: n/a: no bug\nproof: no verify skill - \`done-done run smoke\`\nevidence: .proof/${id}/home.png\n`;
  writeFileSync(join(dir, 'checks.md'), body);
  assert.equal(dd('check', '--from', join(dir, 'checks.md')).code, 0);
  assert.equal(dd('receipt', '--from', join(dir, 'checks.md')).code, 0);
  assert.equal(dd('receipt', '--verify', h).code, 0);
  void sh;
});

test('citations resolve from any cwd in the repo: repo-root first, caller cwd second, never a false ENOENT', () => {
  const { repo, dd, at } = cleanRepo();
  const { run_id: id } = toon(dd('run', 'smoke'));
  const cited = `.proof/${id}/home.png`;
  assert.equal(dd('check', '--outcome', 'home renders', cited).code, 0, 'from the repo root');
  assert.equal(at(join(repo, 'src'), 'check', '--outcome', 'home renders', cited).code, 0, 'repo-relative from a subdirectory (the 0.3.0 false-ENOENT defect)');
  assert.equal(at(join(repo, 'src'), 'check', '--outcome', 'home renders', join('..', cited)).code, 0, 'a shell-relative path typed for that shell');
  // Wrong-root counterfactual: the same name means the repo-root file, not whatever the cwd resolves to.
  const wrong = join(repo, 'src', '.proof', id, 'home.png');
  mkdirSync(join(repo, 'src', '.proof', id), { recursive: true });
  writeFileSync(wrong, 'tampered\n');
  assert.equal(at(join(repo, 'src'), 'check', '--outcome', 'home renders', cited).code, 0, 'repo-root evidence wins over a same-named cwd file');
  const missing = at(join(repo, 'src'), 'check', '--outcome', 'home renders', `.proof/${id}/nope.png`);
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, new RegExp(`looked for ${repo.replace(/[./]/g, (c) => `\\${c}`)}.*nope\\.png`), 'a true miss names the looked-for path');
});

test('guards refuse bad input with a clear reason: no agent, no runs, unknown keys', () => {
  const { repo, dd } = cleanRepo('app: notes\n');
  const verify = dd('verify', '--outcome', 'x', '--foreground');
  assert.equal(verify.code, 2, verify.out);
  assert.match(verify.out, /needs a journey or a verify skill/, 'verify without a journey or skill says what is missing');
  assert.match(dd('status').out, /no runs for notes/, 'status with no runs says so');
  assert.match(dd('signoff').out, /no runs for notes/, 'signoff with no runs says so');
  writeFileSync(join(repo, '.done-done.yaml'), 'evidnce:\n  root: x\n');
  assert.match(dd('doctor').out, /unknown key evidnce/, 'an unknown config key is refused by name');
  writeFileSync(join(repo, '.done-done.yaml'), 'evidence:\n  allow_dirty: "yes"\n');
  assert.match(dd('doctor').out, /must be a boolean/, 'a mistyped config value is refused with its type');
});
