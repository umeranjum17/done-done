// End-to-end: drives the built CLI against throwaway git repos with fictional fixtures.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { parse } from 'yaml';
import { decode } from '@toon-format/toon';
import { DEFAULT_JUDGE_MODEL, FLAGSHIP_MODEL_PATTERN, loadConfig } from '../dist/config.js';

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

test('a pass with no origin remote points at a receipt; with one, at the CI gate', () => {
  const { sh, dd, shots, repo, env } = setup();
  const { files } = shots();
  const claim = 'home and settings render, costs $5';
  const local = toon(dd('check', '--outcome', claim, ...files));
  assert.equal(local.help[0], `Record this pass for HEAD: done-done receipt --outcome '${claim}' ${files.join(' ')}`);
  const suggested = local.help[0].split(': ')[1].replace('done-done ', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} `);
  execFileSync('sh', ['-c', suggested], { cwd: repo, env, stdio: 'pipe' });
  const receipt = JSON.parse(readFileSync(join(repo, '.proof', '.done-done', 'receipts', `${sh('rev-parse', 'HEAD').toString().trim()}.json`), 'utf8'));
  assert.equal(receipt.claim, claim);
  sh('remote', 'add', 'origin', 'https://example.com/notes.git');
  assert.match(toon(dd('check', '--outcome', claim, ...files)).help[0], /^Gate CI on this proof: done-done check --from <PR URL> --trusted-ref origin\/main$/);
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
  const none = dd('run', '--', 'true');
  assert.equal(none.code, 1, none.out);
  assert.equal(toon(none).reason.split(';')[0], `the run wrote no files into its folder .proof/${toon(none).run_id}`, 'the reason names the run folder repo-relative');
  const run = dd('run', 'broken');
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /exited 4/);
  const id = toon(run).run_id;
  assert.match(dd('check', '--outcome', 'broken run', `.proof/${id}/home.png`).out, /its run command exited 4/);
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 3;\n');
  const dirty = dd('run', '--', 'node make-shots.mjs ${RUN_ID}');
  assert.equal(dirty.code, 0, dirty.out);
  const d = dd('check', '--outcome', 'dirty', `.proof/${toon(dirty).run_id}/settings.png`);
  assert.equal(d.code, 1, d.out);
  assert.match(d.out, /uncommitted changes/);
});

test('open and close a hand-driven run', () => {
  const { repo, dd } = setup();
  const open = dd('run', '--open');
  assert.equal(open.code, 0, open.out);
  const { run_id: id, evidence_root: folder } = toon(open);
  assert.equal(folder, `.proof/${id}`, 'a hand-driven run captures into its own folder');
  writeFileSync(join(repo, folder, 'cli.log'), '$ notes add milk\nadded: milk\nexit 0\n');
  const close = dd('run', '--close', id);
  assert.equal(close.code, 0, close.out);
  assert.equal(dd('check', '--outcome', 'notes add works', `${folder}/cli.log`).code, 0);
});

test('two runs in the same second at one commit get distinct ids and folders', () => {
  const { dd } = setup();
  // Retry until two runs share a timestamp second, so the test proves the suffix keeps them apart.
  let a, b;
  for (let i = 0; i < 10 && (!a || a.run_id.slice(0, 16) !== b.run_id.slice(0, 16)); i++) [a, b] = [toon(dd('run', '--open')), toon(dd('run', '--open'))];
  assert.equal(a.run_id.slice(0, 26), b.run_id.slice(0, 26), 'same second, same commit');
  assert.notEqual(a.run_id, b.run_id);
  assert.notEqual(a.evidence_root, b.evidence_root);
  assert.equal(dd('run', '--close', a.run_id).code, 1, 'each run closes on its own record (an empty one fails)');
  assert.match(dd('run', '--close', b.run_id).out, /wrote no files/);
});

test('a file claimed by more than one legacy run record is inconclusive', () => {
  const { repo, dd, head } = setup();
  mkdirSync(join(repo, '.proof', '.done-done', 'runs'), { recursive: true });
  writeFileSync(join(repo, '.proof', 'legacy.log'), 'added: milk\n');
  const file = { path: 'legacy.log', sha256: createHash('sha256').update('added: milk\n').digest('hex'), bytes: 12 };
  for (const id of ['old-a', 'old-b']) {
    const rec = { schema: 1, run_id: id, journey: null, command: 'x', commit: head(), tree: 't', dirty: false, started_at: `2026-01-01T00:00:0${id.at(-1) === 'a' ? 1 : 2}Z`, ended_at: '2026-01-01T00:00:03Z', exit: 0, files: [file] };
    writeFileSync(join(repo, '.proof', '.done-done', 'runs', `${id}.json`), JSON.stringify(rec));
  }
  const r = dd('check', '--outcome', 'notes add works', '.proof/legacy.log');
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /claimed by more than one run \(old-a, old-b\)/);
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

test('an absolute evidence.root is used as-is, not joined under the repo', () => {
  const { dir, repo, sh, dd } = setup();
  const root = join(dir, 'proof-outside');
  writeFileSync(join(repo, '.done-done.yaml'), `app: notes\nevidence:\n  root: ${JSON.stringify(root)}\n`);
  sh('commit', '-qam', 'absolute root');
  const r = dd('run', '--', 'echo added: milk > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log');
  assert.equal(r.code, 0, r.out);
  const d = toon(r);
  assert.deepEqual(d.evidence, [join(root, d.run_id, `${d.run_id}.log`)], 'evidence is written and shown at the absolute root');
  assert.ok(!existsSync(join(repo, root)), 'nothing is written under the repo');
});

test('videos are probed for real frames', { skip: spawnSync('ffmpeg', ['-version']).error && 'ffmpeg not installed' }, () => {
  const { repo, dd } = setup('app: notes\nevidence:\n  root: .proof\n');
  const open = dd('run', '--open');
  const id = toon(open).run_id;
  const out = join(repo, '.proof', id, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', out]);
  const full = readFileSync(out);
  writeFileSync(join(repo, '.proof', id, 'cut.mp4'), full.subarray(0, Math.floor(full.length / 2)));
  assert.equal(dd('run', '--close', id).code, 0);
  assert.equal(dd('check', '--outcome', 'clip plays', `.proof/${id}/clip.mp4`).code, 0);
  const cut = dd('check', '--outcome', 'cut clip', `.proof/${id}/cut.mp4`);
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

test('receipt --verify resolves HEAD, a branch name and a tag to the commit', () => {
  const { sh, dd, head, shots } = setup();
  const { files } = shots();
  const h = head();
  assert.equal(dd('receipt', '--outcome', 'home and settings render', ...files).code, 0);
  const sha = dd('receipt', '--verify', h);
  assert.equal(sha.code, 0, sha.out);
  for (const ref of ['HEAD', 'main']) {
    const v = dd('receipt', '--verify', ref);
    assert.equal(v.code, 0, `${ref}: ${v.out}`);
    assert.deepEqual(toon(v), toon(sha), `${ref} verifies exactly as the sha form`);
  }
  sh('tag', 'v1');
  const t = dd('receipt', '--verify', 'v1');
  assert.equal(t.code, 0, t.out);
  assert.equal(toon(t).head, h, 'a tag resolves to the commit before lookup');
  const bad = dd('receipt', '--verify', 'no-such-ref');
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /no receipt for no-such-ref/, 'an unresolvable argument keeps the missing-receipt shape');
});

test('evidence edited after its run fails as changed after that run', () => {
  const { repo, dd, head } = setup();
  const open = dd('run', '--open');
  assert.equal(open.code, 0, open.out);
  const { run_id: id, evidence_root: folder } = toon(open);
  const log = `${folder}/${id}.log`;
  writeFileSync(join(repo, log), 'added: milk\n');
  assert.equal(dd('run', '--close', id).code, 0);
  assert.equal(dd('check', '--outcome', 'notes add works', log).code, 0);
  const h = head();
  assert.equal(dd('receipt', '--outcome', 'notes add works', log).code, 0);
  assert.equal(dd('receipt', '--verify', h).code, 0, 'unmodified evidence still verifies');
  appendFileSync(join(repo, log), 'tampered');
  const check = dd('check', '--outcome', 'notes add works', log);
  assert.equal(check.code, 1, check.out);
  assert.match(check.out, new RegExp(`changed after run ${id}`));
  const verify = dd('receipt', '--verify', h);
  assert.equal(verify.code, 1, verify.out);
  assert.match(verify.out, new RegExp(`changed after run ${id}`));
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

test('the Firstmate merge gate passes fresh proof with a receipt, and refuses a missing receipt, stale proof or another PR head', () => {
  const { dir, repo, env, sh, dd, head, shots } = setup();
  // The default branch's rules are stricter than the branch's: a "feat" title needs a repro there.
  const yaml = readFileSync(join(repo, '.done-done.yaml'), 'utf8');
  writeFileSync(join(repo, '.done-done.yaml'), `${yaml}checks:\n  fix_title: "^feat"\n`);
  sh('commit', '-qam', 'strict rules');
  sh('update-ref', 'refs/remotes/origin/main', 'HEAD');
  sh('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  writeFileSync(join(repo, '.done-done.yaml'), yaml);
  sh('commit', '-qam', 'branch rules');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'done-done'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  // A stand-in `gh` that answers `gh pr view <url>` with the PR's head commit or its title and body.
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncase "$*" in *headRefOid*) cat ${JSON.stringify(join(dir, 'pr-head'))} ;; *) cat ${JSON.stringify(join(dir, 'pr.json'))} ;; esac\n`, { mode: 0o755 });
  const fm = join(dir, 'fm');
  const gate = (pr) => {
    const r = spawnSync(join(dirname(CLI), '..', 'integrations', 'firstmate', 'merge-gate'), ['t1', repo, head(), pr], {
      encoding: 'utf8', env: { ...env, FM_HOME: fm, PATH: `${bin}:${env.PATH}` },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const { files } = shots();
  const checks = `## Checks\noutcome: home and settings render\nrepro: n/a: no bug\nproof: no verify skill - \`done-done run shots\`\nevidence: ${files.join(', ')}\n`;
  mkdirSync(join(fm, 'data', 't1'), { recursive: true });
  writeFileSync(join(fm, 'data', 't1', 'checks.md'), checks);
  const missing = gate('-');
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /result: pass[\s\S]*no receipt for/, 'the check passes, then the missing receipt refuses');
  assert.equal(dd('receipt', '--from', join(fm, 'data', 't1', 'checks.md')).code, 0);
  const pass = gate('-');
  assert.equal(pass.code, 0, pass.out);
  assert.match(pass.out, /This receipt is valid for this head/);
  const pr = (title, prHead) => {
    writeFileSync(join(dir, 'pr.json'), JSON.stringify({ title, body: checks }));
    writeFileSync(join(dir, 'pr-head'), `${prHead}\n`);
    return gate('https://github.com/example/notes/pull/1');
  };
  const prPass = pr('docs: settings', head());
  assert.equal(prPass.code, 0, prPass.out);
  const strict = pr('feat: settings', head());
  assert.equal(strict.code, 1, strict.out);
  assert.match(strict.out, /a fix needs a repro/, 'the rules come from the default branch, not the PR');
  const moved = pr('docs: settings', 'f'.repeat(40));
  assert.equal(moved.code, 1, moved.out);
  assert.match(moved.out, /is at f{40}, not /);
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 2;\n');
  sh('commit', '-qam', 'change the app');
  const stale = gate('-');
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /evidence is for commit/);
  assert.doesNotMatch(stale.out, /command: receipt/, 'a failed check refuses before the receipt is read');
});

test('init writes a minimal config that keeps evidence outside the repo, and is idempotent', () => {
  const { dir, repo, dd } = bareRepo();
  const r = dd('init');
  assert.equal(r.code, 0, r.out);
  const d = toon(r);
  assert.equal(d.command, 'init');
  assert.equal(d.result, 'pass');
  assert.equal(d.config, 'written');
  assert.equal(d.gitignore, 'unchanged', 'nothing to ignore: the evidence root is outside the repo');
  assert.match(d.help.join('\n'), /journeys: .*done-done run smoke/s, 'the next step shows a journey, then the run');
  const yml = join(repo, '.done-done.yaml');
  assert.deepEqual(parse(readFileSync(yml, 'utf8')), { app: 'repo' }, 'the app is pinned and no in-repo evidence root is set');
  assert.ok(!existsSync(join(repo, '.gitignore')), 'no .gitignore is written');
  assert.match(d.evidence_root, /evidence[/\\]repo$/, 'init names the out-of-repo evidence root');
  const before = readFileSync(yml);
  const again = dd('init');
  assert.equal(again.code, 0, again.out);
  assert.equal(toon(again).config, 'unchanged');
  assert.equal(toon(again).gitignore, 'unchanged');
  assert.deepEqual(json(dd('init', '--json')), toon(again), '--json is the same result as JSON');
  assert.deepEqual(readFileSync(yml), before, 'repeat init preserves the config');
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
  writeFileSync(join(repo, '.done-done.yaml'), 'app: notes\nevidence:\n  root: ..proof\n');
  const dots = toon(dd('init'));
  assert.deepEqual([dots.evidence_root, dots.gitignore], ['..proof', 'added ..proof/'], 'a root named ..proof is inside the repo');
  assert.ok(isIgnored(repo, '..proof/'));
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
  assert.equal(toon(r).help[0], 'Fix the config file named above, then re-run: done-done init', 'init cannot fix a bad config, so the hint is to fix it');
  assert.deepEqual(readFileSync(join(repo, '.done-done.yaml')), before, 'the bad file is not rewritten');
  writeFileSync(join(repo, '.done-done.yaml'), 'unknown_key: 1\n');
  assert.equal(dd('init').code, 2, 'an invalid key is refused too');
});

test('init works in a repo path with a space', () => {
  const { repo, dd } = bareRepo('my project');
  const r = dd('init');
  assert.equal(r.code, 0, r.out);
  assert.equal(parse(readFileSync(join(repo, '.done-done.yaml'), 'utf8')).app, 'my project');
});

test('init outside a git repository reports a clear usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'done-done-nogit-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, env: { ...process.env, DONE_DONE_HOME: join(dir, 'home') }, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /not inside a git repository/);
});

test('a repo set up by init captures, checks and receipts real evidence that outlives the checkout', () => {
  const { dir, repo, env, sh, dd } = bareRepo();
  const init = dd('init');
  assert.equal(init.code, 0);
  // Follow init's hint as printed: its example journey, placeholder filled in, becomes the config.
  const example = toon(init).help[0].match(/journeys: \{.*\} \}/)[0].replace('<drive the real app>', 'echo added: milk');
  appendFileSync(join(repo, '.done-done.yaml'), `${example}\n`);
  sh('add', '-A');
  sh('commit', '-qm', 'config');
  const r = dd('run', 'smoke');
  assert.equal(r.code, 0, r.out);
  const [log] = toon(r).evidence;
  const { run_id: id } = toon(r);
  assert.equal(log, join(dir, 'home', 'evidence', 'repo', id, `${id}.log`), 'evidence lands outside the repo, in the run\'s own folder');
  assert.equal(dd('check', '--outcome', 'notes add works', log).code, 0);
  assert.equal(dd('check', '--outcome', 'gone', `${log}-missing.log`).code, 1, 'a missing file fails');
  const h = sh('rev-parse', 'HEAD').toString().trim();
  assert.equal(dd('receipt', '--outcome', 'notes add works', log).code, 0);
  // The worker's checkout goes away; a fresh clone elsewhere (a merge gate) re-verifies the same proof.
  const clone = join(dir, 'merge-gate');
  execFileSync('git', ['clone', '-q', repo, clone]);
  rmSync(repo, { recursive: true, force: true });
  const inClone = (e, ...args) => {
    const x = spawnSync(process.execPath, [CLI, ...args], { cwd: clone, env: e, encoding: 'utf8' });
    return { code: x.status, out: x.stdout + x.stderr };
  };
  const v = inClone(env, 'receipt', '--verify', h);
  assert.equal(v.code, 0, v.out);
  // CI on another machine: the evidence root restored under a different DONE_DONE_HOME verifies too.
  const ciHome = join(dir, 'ci-home');
  cpSync(join(dir, 'home', 'evidence'), join(ciHome, 'evidence'), { recursive: true });
  assert.equal(inClone({ ...env, DONE_DONE_HOME: ciHome }, 'receipt', '--verify', h).code, 0, 'a restored evidence root verifies');
  writeFileSync(join(ciHome, 'evidence', 'repo', id, basename(log)), 'added: eggs\n');
  const tampered = inClone({ ...env, DONE_DONE_HOME: ciHome }, 'receipt', '--verify', h);
  assert.equal(tampered.code, 1, tampered.out);
  assert.match(tampered.out, /hash changed/);
  writeFileSync(join(clone, 'app.js'), 'export const app = 2;\n');
  execFileSync('git', ['commit', '-qam', 'code'], { cwd: clone, env });
  const stale = inClone(env, 'check', '--outcome', 'notes add works', log);
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /evidence is for commit/);
  assert.equal(toon(stale).help[0], 'Commit your change, re-capture with done-done run smoke, then check the new files', 'evidence is ignored, so the hint never says to commit it');
});

test('overlapping runs from two checkouts sharing the evidence root never claim each other\'s files', () => {
  const { dir, repo, env, sh, dd } = bareRepo();
  assert.equal(dd('init').code, 0);
  sh('add', '-A');
  sh('commit', '-qm', 'config');
  const lane2 = join(dir, 'lane2');
  execFileSync('git', ['clone', '-q', repo, lane2]);
  writeFileSync(join(lane2, 'app.js'), 'export const app = 2;\n');
  execFileSync('git', ['commit', '-qam', 'lane 2 work'], { cwd: lane2, env });
  const in2 = (...args) => {
    const x = spawnSync(process.execPath, [CLI, ...args], { cwd: lane2, env, encoding: 'utf8' });
    return { code: x.status, out: x.stdout + x.stderr };
  };
  // Lane 1 holds a run open while lane 2 runs a failing capture and a passing one into the same root.
  const open = toon(dd('run', '--open'));
  const failed = in2('run', '--', 'echo broken > $DONE_DONE_EVIDENCE_ROOT/b.log; exit 1');
  assert.equal(failed.code, 1, failed.out);
  const passed = in2('run', '--', 'echo added: milk > $DONE_DONE_EVIDENCE_ROOT/c.log');
  assert.equal(passed.code, 0, passed.out);
  writeFileSync(join(open.evidence_root, 'a.log'), 'added: milk\n');
  const closed = dd('run', '--close', open.run_id);
  assert.deepEqual(toon(closed).evidence, [join(open.evidence_root, 'a.log')], 'lane 1 records only its own folder');
  // The failed run's file cannot pass through lane 1's successful record.
  const fromFailed = dd('check', '--outcome', 'notes add works', toon(failed).evidence[0]);
  assert.equal(fromFailed.code, 1, fromFailed.out);
  assert.match(fromFailed.out, /its run command exited 1/);
  // Byte-identical captures in both lanes: each lane's own file passes, tied to its own commit.
  assert.equal(in2('check', '--outcome', 'notes add works', toon(passed).evidence[0]).code, 0, 'lane 2 is not stale through lane 1');
  assert.equal(dd('check', '--outcome', 'notes add works', join(open.evidence_root, 'a.log')).code, 0, 'lane 1 is not stale through lane 2');
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

test('a noisy journey leaves run stdout as one document; its words go to stderr', () => {
  const { repo, env, sh } = setup('app: notes\nevidence:\n  root: .proof\njourneys:\n  noisy:\n    command: node noisy.mjs ${RUN_ID}\n');
  writeFileSync(join(repo, 'noisy.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';\nconsole.log('wrote .proof/SMOKE/smoke.log');\nmkdirSync(process.env.DONE_DONE_EVIDENCE_ROOT, { recursive: true });\nwriteFileSync(process.env.DONE_DONE_EVIDENCE_ROOT + '/' + process.env.DONE_DONE_RUN_ID + '.log', 'ok\\n');\n`);
  sh('add', '-A');
  sh('commit', '-qm', 'noisy journey');
  for (const args of [['run', 'noisy'], ['run', 'noisy', '--json']]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /wrote \.proof\/SMOKE\/smoke\.log/, `${args.join(' ')} still shows the journey line live on stderr`);
    // decode() and JSON.parse() throw unless stdout is exactly one result document.
    const d = args.includes('--json') ? JSON.parse(r.stdout) : decode(r.stdout);
    assert.equal(d.result, 'pass', `${args.join(' ')} stdout is only done-done's result`);
  }
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

test('every command has its own --help, and a usage error names the command and its flags', () => {
  const { dd } = setup();
  const top = dd('--help');
  assert.equal(top.code, 0, top.out);
  for (const cmd of ['init', 'run', 'check', 'receipt']) {
    const h = dd(cmd, '--help');
    assert.equal(h.code, 0, h.out);
    assert.match(h.out, /^usage:\n( {2}done-done .+\n)+flags:\n( {2}.+\n)+(\S.+\n( {2}.+\n)+)*global flags: .+\nexit codes: .+\n$/, `${cmd} --help has the shared shape`);
    for (const line of h.out.split('\n').filter((l) => l.startsWith('  done-done '))) {
      assert.ok(line.startsWith(`  done-done ${cmd}`), `${cmd} --help shows only ${cmd}: ${line}`);
      assert.ok(top.out.includes(line.split(/ {3,}/)[0]), `top-level --help lists ${line}`);
    }
    assert.equal(dd(cmd, '-h').out, h.out, `${cmd} -h is --help`);
    const bad = dd(cmd, '--bogus');
    assert.equal(bad.code, 2, bad.out);
    assert.equal(toon(bad).command, cmd, 'the error names the subcommand');
    assert.match(toon(bad).help[0], new RegExp(`done-done ${cmd} --help`));
  }
  assert.match(toon(dd('check', '--outcome', 'x', '--bogus.yaml')).help[0], /^Valid flags for check: /, 'a .yaml-looking flag is still a flag error');
  assert.match(toon(dd('check', '--from', 'missing.yaml')).help[0], /done-done check --help/, 'a missing claim file is not a config error');
  assert.match(dd('receipt', '--help').out, /done-done receipt --outcome .*\[--trusted-ref <ref>\]/);
  assert.match(dd('run', '--help').out, /--close <run-id> +seal an open run/);
  assert.match(dd('run', '--help').out, /^journeys \(\.done-done\.yaml\): /m, 'run --help shows the journey format');
  assert.match(dd('receipt', '--help').out, /^Checks block \(--from\): .*\n {2}outcome: /m, 'receipt --help shows the Checks block');
  assert.match(dd('check', '--help').out, /--trusted-ref <ref> +read \.done-done\.yaml/);
  assert.equal(dd('run', '--', 'node', '-e', 'process.exit(0)', '--help').code, 1, 'a --help after -- belongs to the run command');
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
if (p === 'error') process.exit(process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'usage limit reached' })) && 0);
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
  j.stub('error');
  const err = j.dd('check', '--judge', '--outcome', 'the home screen shows the sync banner', files[0]);
  assert.equal(err.code, 3, 'a model error while signed in is inconclusive, not a sign-in error');
  assert.match(toon(err).judge.judged[0].reason, /did not answer.*judge.model claude-test-1 and your plan's usage limit/);
  assert.doesNotMatch(err.out, /auth login/);
});

test('judge.enabled turns the judge on; text evidence is not judged; a failed check is not judged', () => {
  const j = judgeSetup(CORRECT, { projectYaml: 'app: notes\nevidence:\n  root: .proof\njudge:\n  enabled: true\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n' });
  const r = j.dd('run', '--', `node make-shots.mjs \${RUN_ID} && node -e "require('fs').writeFileSync(process.env.DONE_DONE_EVIDENCE_ROOT + '/session.log','saved 3 notes')"`);
  assert.equal(r.code, 0, r.out);
  const mixed = `.proof/${toon(r).run_id}`;
  const ok = j.dd('check', '--outcome', 'three notes are saved', `${mixed}/home.png`, `${mixed}/session.log`);
  assert.equal(ok.code, 0, ok.out);
  const d = toon(ok);
  assert.deepEqual(d.judge.judged.map((x) => x.path), [`${mixed}/home.png`]);
  assert.deepEqual(d.judge.not_judged, [`${mixed}/session.log`]);
  assert.match(d.judge.note, /text, log and video evidence are not/);
  const bad = j.dd('check', '--outcome', 'three notes are saved', `${mixed}/home.png`, '.proof/nope.png');
  assert.equal(bad.code, 1, bad.out);
  assert.match(toon(bad).judge.skipped, /already failed/);
  writeFileSync(join(j.repo, 'stray.png'), screen(11));
  const stray = j.dd('check', '--outcome', 'three notes are saved', 'stray.png');
  assert.equal(stray.code, 3, stray.out);
  assert.deepEqual(toon(stray).judge.judged, [], 'a capture with no run record is never sent');
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

test('without the optional kit, --judge is a config error naming the npx command; the default model is cheap Haiku', () => {
  const j = judgeSetup(CORRECT);
  const { files } = j.shots();
  // A plain install: done-done and its dependencies, without the optional @byokit/decide peer.
  const root = join(dirname(CLI), '..');
  const pkg = join(j.dir, 'plain');
  cpSync(join(root, 'dist'), join(pkg, 'dist'), { recursive: true });
  cpSync(join(root, 'package.json'), join(pkg, 'package.json'));
  mkdirSync(join(pkg, 'node_modules', '@toon-format'), { recursive: true });
  symlinkSync(join(root, 'node_modules', 'yaml'), join(pkg, 'node_modules', 'yaml'));
  symlinkSync(join(root, 'node_modules', '@toon-format', 'toon'), join(pkg, 'node_modules', '@toon-format', 'toon'));
  const args = ['check', '--judge', '--outcome', "Umer's notes list shows three notes", files[0]];
  const plain = spawnSync(process.execPath, [join(pkg, 'dist', 'cli.js'), ...args], { cwd: j.repo, env: j.env, encoding: 'utf8' });
  assert.equal(plain.status, 2, plain.stdout + plain.stderr);
  const e = toon({ out: plain.stdout });
  assert.match(e.error, /needs the optional @byokit\/decide@0\.6\.5 kit/);
  assert.equal(e.help[0], `Run this check with the kit: npx -y -p done-done-axi -p @byokit/decide@0.6.5 done-done-axi check --judge --outcome 'Umer'\\''s notes list shows three notes' ${files[0]}`);
  assert.equal(j.calls().length, 0);
  writeFileSync(join(j.env.DONE_DONE_HOME, 'config.yaml'), readFileSync(join(j.env.DONE_DONE_HOME, 'config.yaml'), 'utf8').replace('  model: claude-test-1\n', ''));
  assert.equal(j.dd(...args).code, 0);
  assert.equal(j.calls()[0].model, 'claude-haiku-5-5');
});

test('the default judge model is cheap, never a flagship', () => {
  const dir = mkdtempSync(join(tmpdir(), 'done-done-cheap-default-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const prev = process.env.DONE_DONE_HOME;
  process.env.DONE_DONE_HOME = home;
  let cfg;
  try {
    cfg = loadConfig(repo);
  } finally {
    if (prev === undefined) delete process.env.DONE_DONE_HOME;
    else process.env.DONE_DONE_HOME = prev;
  }
  assert.equal(cfg.judge.model, DEFAULT_JUDGE_MODEL, 'the default is the exported cheap default');
  assert.doesNotMatch(cfg.judge.model, FLAGSHIP_MODEL_PATTERN, 'the default must never be a flagship model again');
});
