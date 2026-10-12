// End-to-end: drives the built CLI against throwaway git repos with fictional fixtures.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { parse } from 'yaml';
import { decode } from '@toon-format/toon';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

// CLI results default to TOON; parse that (the AXI convention) or JSON with --json.
const toon = (r) => decode(r.out);
const json = (r) => JSON.parse(r.out);

const isIgnored = (repo, path) => spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: repo }).status === 0;

function png(w, h, pixel) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const screen = (seed = 0) => png(200, 120, (x, y) => [(x * 3 + seed) % 256, (y * 5) % 256, (x + y) % 256]);
const blank = () => png(200, 120, () => [250, 250, 250]);

function setup(projectYaml = 'app: notes\nevidence:\n  root: .proof\n  ignore_paths: ["docs/**"]\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n') {
  const dir = mkdtempSync(join(tmpdir(), 'done-done-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const env = { ...process.env, DONE_DONE_HOME: join(dir, 'home'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, '.gitignore'), '.proof/\n');
  writeFileSync(join(repo, '.done-done.yaml'), projectYaml);
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1;\n');
  writeFileSync(join(repo, 'docs', 'guide.md'), '# guide\n');
  writeFileSync(join(dir, 'screen.png'), screen());
  writeFileSync(join(dir, 'screen2.png'), screen(7));
  writeFileSync(
    join(repo, 'make-shots.mjs'),
    `import { copyFileSync, mkdirSync } from 'node:fs';\nconst out = '.proof/' + process.argv[2];\nmkdirSync(out, { recursive: true });\ncopyFileSync(${JSON.stringify(join(dir, 'screen.png'))}, out + '/home.png');\ncopyFileSync(${JSON.stringify(join(dir, 'screen2.png'))}, out + '/settings.png');\n`,
  );
  const sh = (...a) => execFileSync('git', a, { cwd: repo, env, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main');
  sh('add', '-A');
  sh('commit', '-qm', 'init');
  const dd = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const ddin = (input, ...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8', input });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const head = () => sh('rev-parse', 'HEAD').toString().trim();
  const shots = () => {
    const r = dd('run', 'shots');
    assert.equal(r.code, 0, r.out);
    const id = toon(r).run_id;
    return { id, files: [`.proof/${id}/home.png`, `.proof/${id}/settings.png`] };
  };
  return { dir, repo, env, sh, dd, ddin, head, shots };
}

test('a fresh run of the real journey passes the check', () => {
  const { dd, shots } = setup();
  const { files } = shots();
  const r = dd('check', '--outcome', 'home and settings render', ...files);
  assert.equal(r.code, 0, r.out);
  const d = toon(r);
  assert.equal(d.result, 'pass');
  assert.equal(d.files, 2);
  assert.deepEqual(d.evidence, files);
});

test('empty, truncated, blank, tiny and mislabelled images fail with the reason', () => {
  const { repo, dd, shots } = setup();
  const { id, files } = shots();
  const p = (n) => join(repo, '.proof', id, n);
  const good = readFileSync(p('home.png'));
  const cases = {
    'empty.png': [Buffer.alloc(0), /empty \(0 bytes\)/],
    'cut.png': [good.subarray(0, good.length - 20), /png truncated/],
    'blank.png': [blank(), /blank frame/],
    'tiny.png': [png(16, 16, (x) => [x * 16, 0, 0]), /smaller than 64x64/],
    'shot.jpg': [good, /named \.jpg but the bytes are png/],
    'notes.json': [Buffer.from('{oops'), /json does not parse/],
  };
  for (const [name, [bytes, why]] of Object.entries(cases)) {
    writeFileSync(p(name), bytes);
    const r = dd('check', '--outcome', `case ${name}`, `.proof/${id}/${name}`);
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, why, name);
  }
  assert.equal(dd('check', '--outcome', 'x', files[0], files[0]).code, 1, 'byte-identical files in one claim');
});

test('evidence goes stale when HEAD moves past code, but not past ignored paths', () => {
  const { repo, sh, dd, shots } = setup();
  const { files } = shots();
  sh('commit', '-q', '--allow-empty', '-m', 'empty');
  assert.equal(dd('check', '--outcome', 'still fresh', ...files).code, 1, 'an empty diff is not "only ignored paths"');
  writeFileSync(join(repo, 'docs', 'guide.md'), '# guide v2\n');
  sh('commit', '-qam', 'docs only');
  assert.equal(dd('check', '--outcome', 'still fresh', ...files).code, 0, 'a diff of only ignored paths keeps evidence fresh');
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 2;\n');
  sh('commit', '-qam', 'code');
  const r = dd('check', '--outcome', 'stale now', ...files);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /evidence is for commit \w+, HEAD is \w+ \(changed: src\/app\.js\)/);
});

test('files outside any run record are inconclusive; a failed or dirty run fails', () => {
  const { dir, repo, dd } = setup('app: notes\nevidence:\n  root: .proof\njourneys:\n  broken:\n    command: node make-shots.mjs ${RUN_ID} && exit 4\n');
  const r = dd('check', '--outcome', 'hand made', join(dir, 'screen.png'));
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /not in any done-done run record/);
  const run = dd('run', 'broken');
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /exited 4/);
  const id = toon(run).run_id;
  assert.match(dd('check', '--outcome', 'broken run', `.proof/${id}/home.png`).out, /its run command exited 4/);
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 3;\n');
  const dirty = dd('run', '--', `node make-shots.mjs dirty`);
  assert.equal(dirty.code, 0, dirty.out);
  const d = dd('check', '--outcome', 'dirty', '.proof/dirty/settings.png');
  assert.equal(d.code, 1, d.out);
  assert.match(d.out, /uncommitted changes/);
});

test('open and close a hand-driven run', () => {
  const { repo, dd } = setup();
  const open = dd('run', '--open');
  assert.equal(open.code, 0, open.out);
  const id = toon(open).run_id;
  mkdirSync(join(repo, '.proof', 'manual'), { recursive: true });
  writeFileSync(join(repo, '.proof', 'manual', 'cli.log'), '$ notes add milk\nadded: milk\nexit 0\n');
  const close = dd('run', '--close', id);
  assert.equal(close.code, 0, close.out);
  assert.equal(dd('check', '--outcome', 'notes add works', '.proof/manual/cli.log').code, 0);
});

test('the same evidence cannot prove a second, different claim', () => {
  const { dd, shots } = setup();
  const { files } = shots();
  assert.equal(dd('check', '--outcome', 'home renders', ...files).code, 0);
  assert.equal(dd('check', '--outcome', 'home renders', ...files).code, 0, 're-checking the same claim is fine');
  const r = dd('check', '--outcome', 'checkout works', ...files);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /already used as proof of a different claim/);
});

test('Checks block: form rules, not-proven and trusted config', () => {
  const { repo, sh, dd, shots } = setup();
  const { files } = shots();
  const write = (body) => writeFileSync(join(repo, '..', 'pr.md'), body);
  write(`# PR\n\n## Checks\noutcome: home renders\nrepro: n/a: no bug\nproof: no verify skill - \`done-done run shots\`\nevidence: ${files.join(', ')}\n`);
  assert.equal(dd('check', '--from', '../pr.md').code, 0);
  write('## Checks\noutcome: x\nproof: y\n');
  assert.match(dd('check', '--from', '../pr.md').out, /missing repro, evidence/);
  write('## Checks\noutcome: x\nrepro: n/a\nproof: no verify skill - `done-done run shots`\nevidence: not proven: no device here\n');
  const np = dd('check', '--from', '../pr.md');
  assert.equal(np.code, 3, np.out);
  writeFileSync(join(repo, '.done-done.yaml'), 'app: notes\nevidence:\n  root: .proof\nchecks:\n  not_proven: allow\n');
  assert.equal(dd('check', '--from', '../pr.md').code, 3, 'allow from the working copy is not trusted');
  sh('commit', '-qam', 'allow not proven');
  assert.equal(dd('check', '--from', '../pr.md', '--trusted-ref', 'HEAD').code, 0, 'allow from the trusted ref is honoured');
  mkdirSync(join(repo, '.agents', 'skills', 'verify-notes'), { recursive: true });
  write(`## Checks\noutcome: x\nrepro: n/a\nproof: \`done-done run shots\`\nevidence: ${files[0]}\n`);
  assert.match(dd('check', '--from', '../pr.md').out, /does not name the project's verify skill verify-notes/);
});

test('config is strict and scoped', () => {
  const { dir, repo, dd } = setup();
  const bad = (yaml) => {
    writeFileSync(join(repo, '.done-done.yaml'), yaml);
    return dd('check', '--outcome', 'x', 'a.png');
  };
  assert.match(bad('evidnce:\n  root: x\n').out, /unknown key evidnce/);
  assert.equal(bad('evidence:\n  local_root: /x\n').code, 2);
  assert.match(bad('evidence:\n  local_root: /x\n').out, /may only be set in the global config/);
  assert.match(bad('evidence:\n  allow_dirty: "yes"\n').out, /must be a boolean/);
  writeFileSync(join(repo, '.done-done.yaml'), 'app: notes\n');
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(join(dir, 'home', 'config.yaml'), 'app: other\n');
  const r = dd('check', '--outcome', 'x', 'a.png');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /app may only be set in the project/);
});

test('videos are probed for real frames', { skip: spawnSync('ffmpeg', ['-version']).error && 'ffmpeg not installed' }, () => {
  const { repo, dd } = setup('app: notes\nevidence:\n  root: .proof\n');
  const open = dd('run', '--open');
  const id = toon(open).run_id;
  const out = join(repo, '.proof', 'clip.mp4');
  mkdirSync(dirname(out), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', out]);
  const full = readFileSync(out);
  writeFileSync(join(repo, '.proof', 'cut.mp4'), full.subarray(0, Math.floor(full.length / 2)));
  assert.equal(dd('run', '--close', id).code, 0);
  assert.equal(dd('check', '--outcome', 'clip plays', '.proof/clip.mp4').code, 0);
  const cut = dd('check', '--outcome', 'cut clip', '.proof/cut.mp4');
  assert.equal(cut.code, 1, cut.out);
  assert.match(cut.out, /does not decode/);
});

test('check reads the same Checks block from a file or from stdin', () => {
  const { repo, dd, ddin, shots } = setup();
  const { files } = shots();
  const body = `# PR\n\n## Checks\noutcome: home and settings render\nrepro: n/a: no bug\nproof: no verify skill - \`done-done run shots\`\nevidence: ${files.join(', ')}\n`;
  const p = join(repo, '..', 'pr.md');
  writeFileSync(p, body);
  const fromFile = dd('check', '--from', p);
  assert.equal(fromFile.code, 0, fromFile.out);
  const fromStdin = ddin(body, 'check', '--from', '-');
  assert.equal(fromStdin.code, 0, fromStdin.out);
  const a = toon(fromFile);
  const b = toon(fromStdin);
  assert.equal(b.source, '-');
  assert.equal(a.result, 'pass');
  assert.equal(b.result, 'pass');
  assert.equal(a.claim, b.claim);
  assert.equal(a.files, b.files);
  assert.deepEqual(a.evidence, b.evidence, 'stdin and file parse the same block');
});

test('receipt records a passing check for the head, then verifies', () => {
  const { repo, dd, head, shots } = setup();
  const { files } = shots();
  const h = head();
  const r = dd('receipt', '--outcome', 'home and settings render', ...files);
  assert.equal(r.code, 0, r.out);
  const d = toon(r);
  assert.equal(d.result, 'pass');
  assert.equal(d.head, h);
  assert.equal(d.files, 2);
  const rec = JSON.parse(readFileSync(join(repo, d.receipt), 'utf8'));
  assert.equal(rec.schema, 1);
  assert.equal(rec.head, h);
  assert.match(rec.tree, /^[0-9a-f]{40,64}$/);
  assert.equal(rec.claim, 'home and settings render');
  assert.equal(rec.result, 'pass');
  assert.ok(rec.at && rec.repo, 'the record carries a timestamp and the repo');
  assert.equal(rec.files.length, 2);
  assert.ok(rec.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), 'every cited file carries its sha256');
  const v = dd('receipt', '--verify', h);
  assert.equal(v.code, 0, v.out);
  assert.equal(toon(v).result, 'pass');
});

test('receipt is not written when the check fails', () => {
  const { dd, head } = setup();
  const r = dd('receipt', '--outcome', 'nothing here', '.proof/nope/session.log');
  assert.equal(r.code, 1, r.out);
  assert.equal(toon(r).result, 'fail');
  assert.match(r.out, /did not pass/);
  assert.equal(dd('receipt', '--verify', head()).code, 1, 'a refused write leaves no receipt');
});

test('receipt is refused when the head moved, and verify rejects a wrong head', () => {
  const { repo, sh, dd, head, shots } = setup();
  const { files } = shots();
  const h = head();
  assert.equal(dd('receipt', '--outcome', 'home and settings render', ...files).code, 0);
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 2;\n');
  sh('commit', '-qam', 'move');
  const again = dd('receipt', '--outcome', 'home and settings render', ...files);
  assert.equal(again.code, 1, again.out);
  assert.match(again.out, /did not pass/);
  const v = dd('receipt', '--verify', h);
  assert.equal(v.code, 1, v.out);
  assert.match(v.out, /HEAD is/);
});

test('receipt refuses a dirty tracked tree', () => {
  const { repo, dd, head, shots } = setup();
  const { files } = shots();
  const h = head();
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 7;\n');
  const r = dd('receipt', '--outcome', 'home and settings render', ...files);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /uncommitted changes/);
  assert.equal(dd('receipt', '--verify', h).code, 1, 'refused write leaves no receipt');
});

test('receipt --verify fails on a changed file and on a missing receipt', () => {
  const { repo, dd, head, shots } = setup();
  const { files } = shots();
  const h = head();
  assert.equal(dd('receipt', '--outcome', 'home and settings render', ...files).code, 0);
  assert.equal(dd('receipt', '--verify', h).code, 0, 'a clean receipt verifies');
  appendFileSync(join(repo, files[0]), 'tampered');
  const changed = dd('receipt', '--verify', h);
  assert.equal(changed.code, 1, changed.out);
  assert.match(changed.out, /hash changed/);
  const missing = dd('receipt', '--verify', '0'.repeat(40));
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /no receipt/);
});

test('receipt refuses a not-proven pass that cites no evidence, and writes nothing', () => {
  const { repo, sh, dd, head } = setup();
  writeFileSync(join(repo, '.done-done.yaml'), 'app: notes\nevidence:\n  root: .proof\nchecks:\n  not_proven: allow\n');
  writeFileSync(join(repo, '..', 'pr.md'), '## Checks\noutcome: x\nrepro: n/a\nproof: no verify skill - `done-done run shots`\nevidence: not proven: no device here\n');
  sh('commit', '-qam', 'allow not proven');
  const h = head();
  assert.equal(dd('check', '--from', '../pr.md', '--trusted-ref', 'HEAD').code, 0, 'check still honours the not-proven allowance');
  const r = dd('receipt', '--from', '../pr.md', '--trusted-ref', 'HEAD');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cited no evidence files/);
  assert.ok(!existsSync(join(repo, '.proof', '.done-done', 'receipts', `${h}.json`)), 'no receipt file is produced');
  const v = dd('receipt', '--verify', h);
  assert.equal(v.code, 1, v.out);
  assert.match(v.out, /no receipt/);
});

test('receipt written from a subdirectory stores canonical paths and verifies from the root', () => {
  const { repo, env, dd, head, shots } = setup();
  const { files } = shots();
  const h = head();
  const fromSub = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: join(repo, 'src'), env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const relativeFiles = files.map((f) => join('..', f));
  const r = fromSub('receipt', '--outcome', 'home and settings render', ...relativeFiles);
  assert.equal(r.code, 0, r.out);
  const rec = JSON.parse(readFileSync(join(repo, toon(r).receipt), 'utf8'));
  assert.deepEqual(rec.files.map((f) => f.path).sort(), [...files].sort(), 'stored paths are relative to the repo root');
  assert.equal(dd('receipt', '--verify', h).code, 0, 'the receipt verifies from the repo root');
});

// A bare git repo with no done-done config yet, for exercising `init`.
function bareRepo(dirName = 'repo') {
  const dir = mkdtempSync(join(tmpdir(), 'done-done-init-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, dirName);
  const env = { ...process.env, DONE_DONE_HOME: join(dir, 'home'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  mkdirSync(repo, { recursive: true });
  const sh = (...a) => execFileSync('git', a, { cwd: repo, env, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'app.js'), 'export const app = 1;\n');
  sh('add', '-A');
  sh('commit', '-qm', 'init');
  const dd = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { dir, repo, env, sh, dd };
}

test('init writes a minimal config, ignores the evidence root, and is idempotent', () => {
  const { repo, dd } = bareRepo();
  const r = dd('init');
  assert.equal(r.code, 0, r.out);
  const yml = join(repo, '.done-done.yaml');
  assert.equal(parse(readFileSync(yml, 'utf8')).evidence.root, '.proof');
  assert.ok(isIgnored(repo, '.proof/'), 'git ignores the evidence root');
  const before = [readFileSync(yml), readFileSync(join(repo, '.gitignore'))];
  const again = dd('init');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already exists/);
  assert.deepEqual([readFileSync(yml), readFileSync(join(repo, '.gitignore'))], before, 'repeat init preserves both files');
});

test('init leaves a customized config untouched and only appends a missing ignore line', () => {
  const { repo, dd } = bareRepo();
  const custom = 'app: notes\nevidence:\n  root: .verify\n  ignore_paths: ["docs/**"]\njourneys:\n  smoke:\n    command: node x.mjs\n';
  writeFileSync(join(repo, '.done-done.yaml'), custom);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  const ymlBefore = readFileSync(join(repo, '.done-done.yaml'));
  assert.equal(dd('init').code, 0);
  assert.deepEqual(readFileSync(join(repo, '.done-done.yaml')), ymlBefore, 'customized config is byte-preserved');
  assert.ok(isIgnored(repo, 'node_modules/'), 'existing ignore entries kept');
  assert.ok(isIgnored(repo, '.verify/'), 'configured evidence root is now ignored by git');
  const snapshot = readFileSync(join(repo, '.gitignore'));
  assert.equal(dd('init').code, 0);
  assert.deepEqual(readFileSync(join(repo, '.gitignore')), snapshot, 'the second init appends nothing');
});

test('init is a no-op when the evidence root is already tracked and ignored', () => {
  const { repo, sh, dd } = bareRepo();
  writeFileSync(join(repo, '.gitignore'), '.proof/\n');
  mkdirSync(join(repo, '.proof'), { recursive: true });
  writeFileSync(join(repo, '.proof', 'old.log'), '$ notes add milk\n');
  sh('add', '-f', '.gitignore', '.proof/old.log');
  sh('commit', '-qm', 'tracked evidence');
  assert.equal(dd('init').code, 0);
  const snapshot = readFileSync(join(repo, '.gitignore'));
  assert.equal(dd('init').code, 0);
  assert.deepEqual(readFileSync(join(repo, '.gitignore')), snapshot, 'a tracked evidence root does not grow .gitignore');
});

test('init refuses a malformed config with a clear error and no rewrite', () => {
  const { repo, dd } = bareRepo();
  writeFileSync(join(repo, '.done-done.yaml'), 'evidence:\n  root: [unterminated\n');
  const before = readFileSync(join(repo, '.done-done.yaml'));
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /\.done-done\.yaml/);
  assert.match(toon(r).help[0], /done-done init/, 'a config error names the recovery command');
  assert.deepEqual(readFileSync(join(repo, '.done-done.yaml')), before, 'the bad file is not rewritten');
  writeFileSync(join(repo, '.done-done.yaml'), 'unknown_key: 1\n');
  assert.equal(dd('init').code, 2, 'an invalid key is refused too');
});

test('init works in a repo path with a space', () => {
  const { repo, dd } = bareRepo('my project');
  const r = dd('init');
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(repo, '.done-done.yaml')));
  assert.ok(isIgnored(repo, '.proof/'), 'git ignores the evidence root');
});

test('init outside a git repository reports a clear usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'done-done-nogit-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, env: { ...process.env, DONE_DONE_HOME: join(dir, 'home') }, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /not inside a git repository/);
});

test('a repo set up by init captures and checks real evidence, then catches stale and missing', () => {
  const { repo, sh, dd } = bareRepo();
  assert.equal(dd('init').code, 0);
  writeFileSync(join(repo, 'make-log.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nconst out = '.proof/' + process.argv[2];\nmkdirSync(out, { recursive: true });\nwriteFileSync(out + '/session.log', '$ notes add milk\\nadded: milk\\nexit 0\\n');\n");
  sh('add', '-A');
  sh('commit', '-qm', 'config and capture script');
  const r = dd('run', '--', 'node make-log.mjs ${RUN_ID}');
  assert.equal(r.code, 0, r.out);
  const id = toon(r).run_id;
  assert.equal(dd('check', '--outcome', 'notes add works', `.proof/${id}/session.log`).code, 0);
  assert.equal(dd('check', '--outcome', 'gone', `.proof/${id}/missing.log`).code, 1, 'a missing file fails');
  writeFileSync(join(repo, 'app.js'), 'export const app = 2;\n');
  sh('commit', '-qam', 'code');
  const stale = dd('check', '--outcome', 'notes add works', `.proof/${id}/session.log`);
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /evidence is for commit/);
});

test('a result is one TOON document by default, and --json is the same data as JSON', () => {
  const { dd, shots } = setup();
  const { files } = shots();
  const r = dd('check', '--outcome', 'home renders', ...files);
  assert.equal(r.code, 0, r.out);
  const d = toon(r); // decode() throws unless stdout is exactly one TOON document
  assert.equal(d.command, 'check');
  assert.equal(d.result, 'pass');
  assert.equal(d.files, 2);
  const j = dd('check', '--json', '--outcome', 'home renders', ...files);
  assert.equal(j.code, 0, j.out);
  assert.deepEqual(json(j), d);
});

test('--full lists every finding; the compact default truncates and says how many it dropped', () => {
  const { dd } = setup();
  const missing = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png', 'g.png'];
  const compact = dd('check', '--outcome', 'many missing', ...missing);
  assert.equal(compact.code, 1, compact.out);
  const c = toon(compact);
  assert.equal(c.evidence.length, 5, 'compact shows the first five evidence files');
  assert.equal(c.evidence_omitted, 2);
  assert.equal(c.findings.length, 5, 'compact shows the first five findings');
  assert.equal(c.findings_omitted, 2);
  const f = toon(dd('check', '--full', '--outcome', 'many missing', ...missing));
  assert.equal(f.evidence.length, 7, '--full shows every evidence file');
  assert.equal(f.findings.length, 7, '--full shows every finding');
  assert.equal(f.findings_omitted, undefined);
  assert.equal(f.evidence_omitted, undefined);
});

test('a failing check points at the exact command that produces the proof', () => {
  const { dd } = setup();
  const r = dd('check', '--outcome', 'nothing captured yet', '.proof/nope/session.log');
  assert.equal(r.code, 1, r.out);
  assert.match(toon(r).help[0], /done-done run shots/);
});

test('bare done-done orients with the config state and the next step', () => {
  const { dd } = setup();
  const r = dd();
  assert.equal(r.code, 0, r.out);
  const b = toon(r);
  assert.equal(b.command, 'done-done');
  assert.equal(b.config, 'present');
  assert.deepEqual(b.journeys, ['shots']);
  assert.match(b.help[0], /done-done run shots/);
});

test('bare done-done in a repo with no config points at init', () => {
  const { dd } = bareRepo();
  const r = dd();
  assert.equal(r.code, 0, r.out);
  const b = toon(r);
  assert.equal(b.config, 'missing');
  assert.match(b.help[0], /done-done init/);
});

// The relevance judge, driven through BYOKit decide's claude-code backend against a local stub binary:
// the stub answers `auth status` and the one headless request the kit sends, and logs what it was sent.
function judgeSetup(answer, { loggedIn = true, projectYaml } = {}) {
  const t = setup(projectYaml);
  const cfgDir = join(t.dir, 'judge-signin');
  const bin = join(t.dir, 'claude');
  mkdirSync(cfgDir);
  writeFileSync(
    bin,
    `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const dir = process.env.CLAUDE_CONFIG_DIR;
const stub = JSON.parse(readFileSync(dir + '/stub.json', 'utf8'));
if (process.argv.includes('auth')) {
  process.stdout.write(JSON.stringify({ loggedIn: stub.loggedIn, authMethod: stub.loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty' }));
  process.exit(stub.loggedIn ? 0 : 1);
}
const content = JSON.parse(readFileSync(0, 'utf8')).message.content;
const images = content.filter((c) => c.type === 'image');
const img = Buffer.from(images[0].source.data, 'base64');
appendFileSync(dir + '/calls.jsonl', JSON.stringify({ model: process.argv[process.argv.indexOf('--model') + 1], images: images.length, width: img.readUInt32BE(16), prompt: content.at(-1).text }) + '\\n');
const p = stub.answer;
const pick = Object.keys(p).sort((a, b) => p[b] - p[a])[0];
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { relevance: { probabilities: p, pick, personReason: stub.reason } } }));
`,
    { mode: 0o755 },
  );
  const stub = (a, li = loggedIn) => writeFileSync(join(cfgDir, 'stub.json'), JSON.stringify({ loggedIn: li, answer: a, reason: 'The screen shows the notes list.' }));
  stub(answer);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), `judge:\n  bin: ${JSON.stringify(bin)}\n  config_dir: ${JSON.stringify(cfgDir)}\n  model: claude-test-1\n`);
  const calls = () => (existsSync(join(cfgDir, 'calls.jsonl')) ? readFileSync(join(cfgDir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { ...t, cfgDir, stub, calls };
}
const CORRECT = { correct: 0.95, wrong: 0.03, unclear: 0.02 };

test('with the judge off, check output is unchanged and no model is asked', () => {
  const t = setup();
  const { files } = t.shots();
  const before = t.dd('check', '--outcome', 'home and settings render', ...files);
  const j = judgeSetup(CORRECT);
  const { files: files2 } = j.shots();
  const after = j.dd('check', '--outcome', 'home and settings render', ...files2);
  assert.equal(after.code, 0, after.out);
  assert.equal(after.out.replaceAll(files2[0].split('/')[1], 'RUN'), before.out.replaceAll(files[0].split('/')[1], 'RUN'), 'same bytes with judge config present but off');
  assert.equal(toon(after).judge, undefined);
  assert.equal(j.calls().length, 0);
});

test('judge pass exits 0, sends one downscaled image and the outcome only, and a re-run is a cache hit', () => {
  const j = judgeSetup(CORRECT);
  writeFileSync(join(j.dir, 'screen2.png'), png(2000, 1000, (x, y) => [x % 256, y % 256, 90]));
  const { files: cited } = j.shots();
  const r = j.dd('check', '--judge', '--outcome', 'the notes list shows three notes', ...cited);
  assert.equal(r.code, 0, r.out);
  const d = toon(r);
  assert.equal(d.result, 'pass');
  assert.equal(d.judge.model, 'claude-test-1');
  assert.deepEqual(d.judge.judged.map((x) => [x.path, x.verdict, x.cached]), cited.map((p) => [p, 'pass', false]));
  assert.equal(d.judge.judged[0].reason, 'The screen shows the notes list.');
  const calls = j.calls();
  assert.equal(calls.length, 2, 'one request per image');
  assert.ok(calls.every((c) => c.images === 1 && c.model === 'claude-test-1'));
  assert.deepEqual(calls.map((c) => c.width), [200, 1000], 'a 2000px capture is downscaled to fit 1280px');
  assert.ok(calls.every((c) => c.prompt.includes('the notes list shows three notes') && !c.prompt.includes('.proof') && !c.prompt.includes(j.repo)), 'only the outcome line goes with the image');
  const again = j.dd('check', '--judge', '--outcome', 'the notes list shows three notes', ...cited);
  assert.equal(again.code, 0, again.out);
  assert.ok(toon(again).judge.judged.every((x) => x.cached === true && x.verdict === 'pass'));
  assert.equal(j.calls().length, 2, 'a cache hit asks no model');
  const cache = readFileSync(join(j.env.DONE_DONE_HOME, 'judge', readdirSync(join(j.env.DONE_DONE_HOME, 'judge'))[0]), 'utf8');
  assert.doesNotMatch(cache, /token|key|secret/i, 'the cache holds verdicts only');
});

test('judge wrong screen fails with exit 1, unsure and low confidence are inconclusive with exit 3', () => {
  const j = judgeSetup({ correct: 0.05, wrong: 0.9, unclear: 0.05 });
  const { files } = j.shots();
  const fail = j.dd('check', '--judge', '--outcome', 'the settings page shows dark mode on', files[0]);
  assert.equal(fail.code, 1, fail.out);
  const f = toon(fail);
  assert.equal(f.result, 'fail');
  assert.equal(f.judge.judged[0].verdict, 'fail');
  assert.match(f.findings[0].why, /judge says wrong screen/);
  assert.match(f.help[0], /Capture the screen the outcome describes.*done-done run shots/);
  const cachedFail = j.dd('check', '--judge', '--outcome', 'the settings page shows dark mode on', files[0]);
  assert.equal(cachedFail.code, 1, 'a cached wrong-screen verdict still fails');
  assert.equal(toon(cachedFail).judge.judged[0].cached, true);
  j.stub({ correct: 0.05, wrong: 0.05, unclear: 0.9 });
  const unsure = j.dd('check', '--judge', '--outcome', 'the sync finished in the background', files[0]);
  assert.equal(unsure.code, 3, unsure.out);
  assert.equal(toon(unsure).judge.judged[0].verdict, 'unsure');
  assert.match(toon(unsure).help[0], /Look at the capture yourself/);
  j.stub({ correct: 0.6, wrong: 0.3, unclear: 0.1 });
  const low = j.dd('check', '--judge', '--outcome', 'the home screen shows the welcome card', files[0]);
  assert.equal(low.code, 3, low.out);
  assert.match(toon(low).judge.judged[0].reason, /not confident enough \(confidence 0.6 below floor 0.8\)/);
  assert.equal(j.calls().length, 3);
});

test('judge.enabled turns the judge on; text evidence is not judged; a failed check is not judged', () => {
  const j = judgeSetup(CORRECT, { projectYaml: 'app: notes\nevidence:\n  root: .proof\njudge:\n  enabled: true\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n' });
  const r = j.dd('run', '--', `node make-shots.mjs mixed && node -e "require('fs').writeFileSync('.proof/mixed/session.log','saved 3 notes')"`);
  assert.equal(r.code, 0, r.out);
  const ok = j.dd('check', '--outcome', 'three notes are saved', '.proof/mixed/home.png', '.proof/mixed/session.log');
  assert.equal(ok.code, 0, ok.out);
  const d = toon(ok);
  assert.deepEqual(d.judge.judged.map((x) => x.path), ['.proof/mixed/home.png']);
  assert.deepEqual(d.judge.not_judged, ['.proof/mixed/session.log']);
  assert.match(d.judge.note, /text, log and video evidence are not/);
  const bad = j.dd('check', '--outcome', 'three notes are saved', '.proof/mixed/home.png', '.proof/nope.png');
  assert.equal(bad.code, 1, bad.out);
  assert.match(toon(bad).judge.skipped, /already failed/);
  assert.equal(j.calls().length, 1);
});

test('judge with no sign-in is a config error naming the sign-in command, and writes no receipt', () => {
  const j = judgeSetup(CORRECT, { loggedIn: false });
  const { files } = j.shots();
  const r = j.dd('receipt', '--judge', '--outcome', 'the notes list shows three notes', files[0]);
  assert.equal(r.code, 2, r.out);
  const e = toon(r);
  assert.match(e.error, /^judge: /);
  assert.ok(e.help[0].includes(`CLAUDE_CONFIG_DIR=${j.cfgDir}`) && e.help[0].includes('auth login'), e.help[0]);
  assert.equal(j.dd('receipt', '--verify', j.head()).code, 1, 'no receipt was written');
  rmSync(j.cfgDir, { recursive: true });
  const missing = j.dd('check', '--judge', '--outcome', 'the notes list shows three notes', files[0]);
  assert.equal(missing.code, 2, missing.out);
  assert.match(toon(missing).help[0], /mkdir -p .*auth login/);
  assert.doesNotMatch(r.out + missing.out, /token|secret/i);
  mkdirSync(j.cfgDir);
  j.stub(CORRECT, true);
  const ok = j.dd('receipt', '--judge', '--outcome', 'the notes list shows three notes', files[0]);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(toon(ok).judge.judged[0].verdict, 'pass');
});
