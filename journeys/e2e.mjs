// e2e journey: drives the built CLI end to end against a throwaway fixture repo.
// Runs from the done-done repo root with DONE_DONE_EVIDENCE_ROOT and
// DONE_DONE_RUN_ID set by `done-done run e2e`. Follows the repo's own
// integrations/firstmate/brief-include.md contract: init, run, check, receipt.
// Writes e2e.log plus the fixture's captures into DONE_DONE_EVIDENCE_ROOT.
// Node stdlib only, plus Chrome or Chromium on PATH for the look journeys; exits nonzero on the first failure.
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { crc32 } from 'node:zlib';

const REPO = process.cwd();
const CLI = process.env.DONE_DONE_TEST_CLI || join(REPO, 'dist', 'cli.js');
const OUT = process.env.DONE_DONE_EVIDENCE_ROOT;
const RUN_ID = process.env.DONE_DONE_RUN_ID || process.argv[2];
if (!OUT || !RUN_ID) {
  console.error('e2e: DONE_DONE_EVIDENCE_ROOT and DONE_DONE_RUN_ID must be set (run via `done-done run e2e`)');
  process.exit(2);
}

const log = [];
const say = (s) => { log.push(s); console.error(s); };
const tmp = mkdtempSync(join(tmpdir(), 'dd-e2e-'));
const home = join(tmp, 'home');
const repo = join(tmp, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
const env = {
  ...process.env,
  DONE_DONE_HOME: home,
  DONE_DONE_TEST_CLI: CLI,
  DONE_DONE_LOOK_FIXTURES: join(REPO, 'test', 'fixtures', 'look'),
  GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com',
};

try {
  // A real PNG with no binary deps (same shape test/cli.test.mjs uses).
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const png = (seed) => {
    const w = 200, h = 120, raw = Buffer.alloc(h * (w * 3 + 1));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      raw.set([(x * 3 + seed) % 256, (y * 5) % 256, (x + y) % 256], y * (w * 3 + 1) + 1 + x * 3);
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };

  const drive = (code, ...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
    say(`$ done-done ${args.join(' ')}\n${r.stdout}${r.stderr}\nexit: ${r.status}`);
    assert.equal(r.status, code, r.error?.message || r.stdout + r.stderr);
    return r.stdout;
  };
  const dd = (...args) => drive(0, ...args);
  const sh = (...a) => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' });

  // Fixture repo: minimal app with its own journeys. done-done gives no result without its judge, so the fixture's judge is a
  // stub (deterministic, never a model) that says each capture shows the outcome, and its agent a stub doctor finds but no
  // step here starts. The look journeys call the look step on a phone screen with a clipped card title and on the same
  // screen fixed.
  // The committed recipe names the CLI and the fixture pages through env, so it holds no path of this checkout.
  const look = (page) => `node "\${DONE_DONE_TEST_CLI:?}" look "\${DONE_DONE_LOOK_FIXTURES:?}/${page}.html" --out "$DONE_DONE_EVIDENCE_ROOT/${page}.png"`;
  const stub = (name, body) => (writeFileSync(join(tmp, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 }), join(tmp, name));
  const answer = JSON.stringify({ relevance: { probabilities: { correct: 0.95, wrong: 0.03, unclear: 0.02 }, rationale: 'It shows the outcome.', personReason: 'It shows the outcome.' } });
  const judge = stub('judge-gemini', `require('node:fs').readFileSync(0, 'utf8');\nprocess.stdout.write(JSON.stringify({ response: ${JSON.stringify(answer)} }));`);
  const agent = stub('agent-opencode', 'process.exit(1);');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), `agent: opencode\nagent_config:\n  opencode: { model: stub/agent }\njudge:\n  route: answerer:gemini\n  model: stub-judge\nagent_path_override: { opencode: ${JSON.stringify(agent)}, gemini: ${JSON.stringify(judge)} }\n`);
  writeFileSync(join(repo, '.done-done.yaml'), `app: fixture\njourneys:\n  shots:\n    command: node make-shots.mjs \${RUN_ID}\n${['clipped', 'fixed'].map((p) => `  look-${p}:\n    command: ${JSON.stringify(look(p))}\n`).join('')}`);
  // The screen is committed beside the recipe and named relative to it, so the fixture holds no absolute path.
  writeFileSync(join(repo, 'screen.png'), png(3));
  writeFileSync(join(repo, 'make-shots.mjs'),
    `import { copyFileSync } from 'node:fs';\ncopyFileSync('screen.png', process.env.DONE_DONE_EVIDENCE_ROOT + '/home.png');\n`);
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1;\n');
  sh('init', '-q', '-b', 'main'); sh('add', '-A'); sh('commit', '-qm', 'init');
  const head = sh('rev-parse', 'HEAD').trim();
  say(`fixture HEAD: ${head}`);

  dd('doctor');
  const runOut = dd('run', 'shots');
  const runId = /run_id:\s*"?([^\s"]+)"?/.exec(runOut)?.[1];
  if (!runId) throw new Error('could not parse run_id from run output');
  assert.equal(JSON.parse(dd('--json', 'status', '--run', runId)).run_id, runId, 'status shows the run record that run printed');
  const shot = join(home, 'evidence', 'fixture', runId, 'home.png');
  dd('check', '--outcome', 'fixture home renders', shot);
  // Relative citations select the explicit base, never a same-named cwd file.
  const base = join(tmp, "citation base's captures");
  mkdirSync(base);
  copyFileSync(shot, join(base, 'home.png'));
  writeFileSync(join(repo, 'home.png'), 'wrong same-named file\n');
  drive(1, 'check', '--outcome', 'fixture home renders', 'home.png');
  const selected = JSON.parse(dd('--json', 'check', '--citation-base', base, '--outcome', 'fixture home renders', 'home.png'));
  assert.deepEqual(selected.evidence, [join(base, 'home.png')]);
  const follow = (result, source) => {
    const command = result.help[0].split(': ')[1]
      .replace('done-done ', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} `)
      .replace('<PR URL>', JSON.stringify(source));
    const output = execFileSync('sh', ['-c', command], { cwd: repo, env, encoding: 'utf8' });
    say(`$ ${command}\n${output}`);
    return output;
  };
  follow(selected);
  dd('check', '--citation-base', repo, '--outcome', 'fixture home renders', shot);
  drive(1, 'check', '--citation-base', base, '--outcome', 'fixture home renders', 'missing.png');
  writeFileSync(join(base, 'stray.log'), 'unrecorded output\n');
  drive(3, 'check', '--citation-base', base, '--outcome', 'fixture home renders', 'stray.log');
  const body = join(tmp, 'checks.md');
  writeFileSync(body, '## Checks\noutcome: fixture home renders\nrepro: n/a: no bug\nproof: no verify skill - done-done run shots\nevidence: home.png\n');
  // Untracked counterfactual output must not change the caller's tracked identity.
  const from = JSON.parse(dd('--json', 'check', '--citation-base', base, '--from', body));
  follow(from);
  dd('receipt', '--verify', head);
  sh('remote', 'add', 'origin', 'https://example.com/fixture.git');
  sh('update-ref', 'refs/remotes/origin/main', head);
  for (const args of [['--from', body], ['--outcome', 'fixture home renders', 'home.png']]) {
    const remote = JSON.parse(dd('--json', 'check', '--citation-base', base, ...args));
    follow(remote, body);
  }

  // A look hit fails the journey that calls it, naming the element, kind and text; the fixed page passes.
  const lookRun = (page, code) => {
    const out = drive(code, 'run', `look-${page}`);
    const id = /run_id:\s*"?([^\s"]+)"?/.exec(out)?.[1];
    const capture = join(home, 'evidence', 'fixture', id, `${page}.png`);
    const record = JSON.parse(readFileSync(capture.replace(/\.png$/, '.dom.json'), 'utf8'));
    assert.deepEqual(readFileSync(capture).subarray(16, 24), Buffer.from([0, 0, 1, 134, 0, 0, 3, 76]), 'the capture is 390x844');
    return { out: log.at(-1), record, capture };
  };
  const clipped = lookRun('clipped', 1);
  assert.match(clipped.out, /clipped text: h3\.card-title \\?"Answered: the release notes are approved\\?" is cut by its own box/);
  assert.deepEqual(clipped.record.clipped_text.map((q) => q.element), ['h3.card-title']);
  const fixed = lookRun('fixed', 0);
  assert.deepEqual([fixed.record.clipped_text, fixed.record.cut_off, fixed.record.squashed_text, fixed.record.overflow], [[], [], [], false]);

  // Proof for the outer run: transcript plus the fixture's own captures.
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${RUN_ID}.log`), log.join('\n') + '\n');
  copyFileSync(shot, join(OUT, `${RUN_ID}.home.png`));
  for (const [page, r] of [['clipped', clipped], ['fixed', fixed]]) copyFileSync(r.capture, join(OUT, `${RUN_ID}.look-${page}.png`));
  const names = readdirSync(OUT).sort();
  say(`evidence: ${names.join(', ')}`);
} catch (err) {
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${RUN_ID}.log`), [...log, `FAIL: ${err.message}`].join('\n') + '\n');
  } catch { /* keep the original error */ }
  console.error(`e2e FAIL: ${err.message}`);
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
