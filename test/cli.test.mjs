// End-to-end: drives the built CLI against throwaway git repos with fictional fixtures.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { parse } from 'yaml';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

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
  const shots = () => {
    const r = dd('run', 'shots');
    assert.equal(r.code, 0, r.out);
    const id = r.out.match(/^run: (\S+)/m)[1];
    return { id, files: [`.proof/${id}/home.png`, `.proof/${id}/settings.png`] };
  };
  return { dir, repo, env, sh, dd, shots };
}

test('a fresh run of the real journey passes the check', () => {
  const { dd, shots } = setup();
  const { files } = shots();
  const r = dd('check', '--outcome', 'home and settings render', ...files);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /result: PASS \(2 evidence files\)/);
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
  const id = run.out.match(/^run: (\S+)/m)[1];
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
  const id = open.out.match(/^run: (\S+)/m)[1];
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
  const id = open.out.match(/^run: (\S+)/m)[1];
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
  const id = r.out.match(/^run: (\S+)/m)[1];
  assert.equal(dd('check', '--outcome', 'notes add works', `.proof/${id}/session.log`).code, 0);
  assert.equal(dd('check', '--outcome', 'gone', `.proof/${id}/missing.log`).code, 1, 'a missing file fails');
  writeFileSync(join(repo, 'app.js'), 'export const app = 2;\n');
  sh('commit', '-qam', 'code');
  const stale = dd('check', '--outcome', 'notes add works', `.proof/${id}/session.log`);
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /evidence is for commit/);
});
