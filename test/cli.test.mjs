// End-to-end: drives the built CLI against throwaway git repos with fictional fixtures.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { parse } from 'yaml';
import { decode } from '@toon-format/toon';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

// CLI results default to TOON; parse that (the AXI convention) or JSON with --json.
const toon = (r) => decode(r.out);
const json = (r) => JSON.parse(r.out);

const isIgnored = (repo, path) => spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: repo }).status === 0;

function png(w, h, pixel, colour = 2) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const channels = colour === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colour;
  const raw = Buffer.alloc(h * (w * channels + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * channels + 1) + 1 + x * channels);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const screen = (seed = 0) => png(200, 120, (x, y) => [(x * 3 + seed) % 256, (y * 5) % 256, (x + y) % 256]);
const blank = () => png(200, 120, () => [250, 250, 250]);

// verify judges by default; most tests are not about the judge, so they turn it off, and the judge tests use JUDGED.
const JUDGED = 'app: notes\nevidence:\n  root: .proof\n  ignore_paths: ["docs/**"]\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n';
function setup(projectYaml = JUDGED.replace('journeys:', 'judge:\n  enabled: false\njourneys:')) {
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
  const { dd, sh, shots, repo, env } = setup();
  const { files } = shots();
  assert.equal(dd('check', '--outcome', 'home renders', ...files).code, 0);
  assert.equal(dd('check', '--outcome', 'home renders', ...files).code, 0, 're-checking the same claim is fine');
  const reworded = dd('check', '--outcome', 'home and settings render', ...files);
  assert.equal(reworded.code, 0, `rewording the claim on the same branch is not reuse: ${reworded.out}`);
  assert.ok(existsSync(join(repo, '.proof', '.done-done', 'ledger')), 'the ledger lives in the evidence root');
  assert.ok(!existsSync(join(env.DONE_DONE_HOME, 'hashes')), 'no machine-wide ledger');
  sh('checkout', '-qb', 'checkout-flow');
  const r = dd('check', '--outcome', 'checkout works', ...files);
  assert.equal(r.code, 1, r.out);
  assert.match(toon(r).findings[0].why, /already used as proof of a different claim \(claim id main\), not this one \(claim id checkout-flow, from the current branch\)/);
  assert.equal(dd('check', '--claim-id', 'main', '--outcome', 'home renders', ...files).code, 0, '--claim-id names the claim');
  sh('checkout', '-q', '--detach');
  const detached = dd('check', '--outcome', 'home renders', ...files);
  assert.equal(detached.code, 2, detached.out);
  assert.match(toon(detached).error, /HEAD is detached.*pass --claim-id/);
  assert.equal(dd('check', '--claim-id', 'main', '--outcome', 'home and settings render', ...files).code, 0, 'a detached HEAD names its claim with --claim-id');
  assert.equal(dd('check', '--claim-id', ' ', '--outcome', 'x', ...files).code, 2, 'an empty claim id is a usage error');
});

test('two repos never see each other\'s reuse ledger', () => {
  const capture = (t) => {
    const r = t.dd('run', '--', 'cp ../screen.png "$DONE_DONE_EVIDENCE_ROOT/home.png"');
    assert.equal(r.code, 0, r.out);
    return toon(r).evidence[0];
  };
  const a = setup('app: notes\n');
  const b = setup('app: todo\n');
  b.env.DONE_DONE_HOME = a.env.DONE_DONE_HOME;
  assert.equal(a.dd('check', '--claim-id', 'notes-home', '--outcome', 'home renders', capture(a)).code, 0);
  const r = b.dd('check', '--claim-id', 'todo-home', '--outcome', 'home renders', capture(b));
  assert.equal(r.code, 0, `the same bytes in another repo are not reuse: ${r.out}`);
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
  // A local file has no PR title, so the HEAD commit subject is its title, and a fix still needs a repro.
  sh('commit', '-q', '--allow-empty', '-m', 'fix: home crash'); assert.match(dd('check', '--from', '../pr.md').out, /a fix needs a repro, not n\/a/);
  sh('commit', '-q', '--allow-empty', '-m', 'docs: home'); assert.doesNotMatch(dd('check', '--from', '../pr.md').out, /a fix needs a repro/);
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

function gateJudge(env, probabilities) {
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  const s = stubAgents(env, JSON.stringify({ relevance: { probabilities, rationale: 'The list shows the notes.', personReason: 'The list shows the notes.' } }));
  symlinkSync(process.execPath, join(s.bin, 'node'));
  return { ...s, env: { ...s.env, PATH: `${s.env.PATH}:/usr/bin:/bin` } };
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
  const judged = gateJudge(env, CORRECT);
  const gate = (pr) => {
    const r = spawnSync(join(dirname(CLI), '..', 'integrations', 'firstmate', 'merge-gate'), ['t1', repo, head(), pr], {
      encoding: 'utf8', env: { ...judged.env, FM_HOME: fm, PATH: `${bin}:${judged.env.PATH}` },
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
  assert.ok(judged.calls().length && judged.calls().every((c) => c.agent === 'opencode'), 'the gate judges each capture');
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

for (const remote of [true, false]) test(`the Firstmate merge gate reads a local-only task's rules from the default branch${remote ? '' : ' (local main in a repo with no remote)'}, not the task branch`, () => {
  const { dir, repo, env, sh, dd, head, shots } = setup();
  if (remote) {
    sh('update-ref', 'refs/remotes/origin/main', 'HEAD');
    sh('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  } else sh('checkout', '-qb', 'fm/t2');
  // The task branch ignores src/ so its own stale evidence would pass; the default branch does not.
  writeFileSync(join(repo, '.done-done.yaml'), 'app: notes\nevidence:\n  root: .proof\n  ignore_paths: ["docs/**", "src/**"]\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n');
  sh('commit', '-qam', 'branch loosens ignore_paths');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'done-done'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  const fm = join(dir, 'fm');
  const judged = gateJudge(env, CORRECT);
  const gate = () => {
    const r = spawnSync(join(dirname(CLI), '..', 'integrations', 'firstmate', 'merge-gate'), ['t2', repo, head(), '-'], {
      encoding: 'utf8', env: { ...judged.env, FM_HOME: fm, PATH: `${bin}:${judged.env.PATH}` },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const { files } = shots();
  const checks = `## Checks\noutcome: home and settings render\nrepro: n/a: no bug\nproof: no verify skill - \`done-done run shots\`\nevidence: ${files.join(', ')}\n`;
  mkdirSync(join(fm, 'data', 't2'), { recursive: true });
  writeFileSync(join(fm, 'data', 't2', 'checks.md'), checks);
  assert.equal(dd('receipt', '--from', join(fm, 'data', 't2', 'checks.md')).code, 0);
  assert.equal(gate().code, 0, 'fresh proof passes');
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 2;\n');
  sh('commit', '-qam', 'change the app');
  const stale = gate();
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /evidence is for commit/, 'the default branch\'s ignore_paths do not cover src/, so the change makes the proof stale');
});

test('the Firstmate merge gate refuses - (no worktree recorded) from any folder, a missing worktree and a capture the judge fails', () => {
  const { dir, repo, env, sh, dd, head, shots } = setup();
  sh('update-ref', 'refs/remotes/origin/main', 'HEAD');
  sh('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'done-done'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  const fm = join(dir, 'fm');
  const judged = gateJudge(env, { correct: 0.04, wrong: 0.93, unclear: 0.03 });
  const gate = (worktree, cwd) => {
    const r = spawnSync(join(dirname(CLI), '..', 'integrations', 'firstmate', 'merge-gate'), ['t3', worktree, head(), '-'], {
      encoding: 'utf8', env: { ...judged.env, FM_HOME: fm, PATH: `${bin}:${judged.env.PATH}` }, cwd,
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const { files } = shots();
  const checks = `## Checks\noutcome: home and settings render\nrepro: n/a: no bug\nproof: no verify skill - \`done-done run shots\`\nevidence: ${files.join(', ')}\n`;
  mkdirSync(join(fm, 'data', 't3'), { recursive: true });
  writeFileSync(join(fm, 'data', 't3', 'checks.md'), checks);
  assert.equal(dd('receipt', '--from', join(fm, 'data', 't3', 'checks.md')).code, 0);
  const none = gate('-', repo); assert.equal(none.code, 2, none.out);
  assert.match(none.out, /task t3 recorded no worktree, so there is no repo to check/, 'even run from the task\'s own repo, - is never checked');
  assert.equal(judged.calls().length, 0);
  const wrong = gate(repo, dir); assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /result: fail/); assert.doesNotMatch(wrong.out, /command: receipt/, 'a judge fail refuses before the receipt is read');
  assert.ok(judged.calls().length, 'the judge saw the captures');
  const missing = gate(join(dir, 'no-such-worktree'), repo);
  assert.equal(missing.code, 2, missing.out);
  assert.match(missing.out, /cannot enter worktree/);
});

test('init writes a minimal config that keeps evidence outside the repo, and is idempotent', () => {
  const { dir, repo, dd } = bareRepo();
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  const d = toon(r);
  assert.equal(d.command, 'init');
  assert.equal(d.result, 'fail');
  assert.equal(d.agent, 'not set', 'a non-terminal init with no agent writes the config and stops with the ask');
  assert.match(d.help.join('\n'), /no agent is set: ask the user which agent to use/);
  assert.equal(d.config, 'written');
  assert.equal(d.gitignore, 'unchanged', 'nothing to ignore: the evidence root is outside the repo');
  assert.match(d.help.join('\n'), /journeys: .*done-done run smoke/s, 'the next step shows a journey, then the run');
  const yml = join(repo, '.done-done.yaml');
  assert.deepEqual(parse(readFileSync(yml, 'utf8')), { app: 'repo' }, 'the app is pinned and no in-repo evidence root is set');
  assert.ok(!existsSync(join(repo, '.gitignore')), 'no .gitignore is written');
  assert.match(d.evidence_root, /evidence[/\\]repo$/, 'init names the out-of-repo evidence root');
  const globalYml = join(dir, 'home', 'config.yaml');
  assert.equal(d.global_config, `written ${globalYml}`);
  const globalText = readFileSync(globalYml, 'utf8');
  const g = parse(globalText);
  assert.deepEqual(Object.keys(g), ['agent_config', 'agent_args_override', 'agent_path_override', 'acpx_path', 'agent_timeout', 'auto_fix', 'evidence', 'judge'], 'every global key, named as in no-mistakes where the meaning is the same');
  assert.deepEqual([g.agent, g.agent_config.claude, g.agent_config.opencode, g.agent_timeout], [undefined, { model: 'claude-haiku-5-5', effort: 'low' }, { model: 'opencode-go/muse-spark-1.3-contributor', effort: 'low' }, '30m'], 'no agent key until the user picks one, and the cheap defaults');
  for (const key of Object.keys(g)) assert.match(globalText, new RegExp(`# .*\\n${key}:`), `${key} has a comment`);
  assert.equal(g.agent_config.codex, undefined, 'codex has no cheap default, so init writes no codex model');
  const before = readFileSync(yml);
  const again = dd('init');
  assert.equal(again.code, 2, again.out);
  assert.equal(toon(again).config, 'unchanged');
  assert.equal(toon(again).global_config, 'unchanged');
  assert.equal(readFileSync(globalYml, 'utf8'), globalText, 'init never overwrites the global config');
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
  assert.equal(dd('init').code, 2);
  assert.deepEqual(readFileSync(join(repo, '.done-done.yaml')), ymlBefore, 'customized config is byte-preserved');
  assert.ok(isIgnored(repo, 'node_modules/'), 'existing ignore entries kept');
  assert.ok(isIgnored(repo, '.verify/'), 'configured evidence root is now ignored by git');
  const snapshot = readFileSync(join(repo, '.gitignore'));
  assert.equal(dd('init').code, 2);
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
  assert.equal(dd('init').code, 2);
  const snapshot = readFileSync(join(repo, '.gitignore'));
  assert.equal(dd('init').code, 2);
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
  assert.equal(r.code, 2, r.out);
  assert.equal(parse(readFileSync(join(repo, '.done-done.yaml'), 'utf8')).app, 'my project');
});

test('init --hook claude adds a SessionStart hook that shows the bare state, merges, and never duplicates', () => {
  const { dir, repo, env, dd } = bareRepo();
  const settings = join(repo, '.claude', 'settings.json');
  const r = dd('init', '--hook', 'claude');
  assert.equal(r.code, 2, r.out);
  assert.equal(toon(r).claude_hook, 'added to .claude/settings.json');
  const hooks = JSON.parse(readFileSync(settings, 'utf8')).hooks.SessionStart;
  assert.equal(hooks.length, 1);
  const { command } = hooks[0].hooks[0];
  // Run the hook as Claude Code does: through a shell, from the repo, with done-done on PATH and without it.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'done-done'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  const hook = (path) => spawnSync('/bin/sh', ['-c', command], { cwd: repo, env: { ...env, PATH: path }, encoding: 'utf8' });
  const on = hook(`${bin}:${env.PATH}`);
  assert.equal(on.status, 0, on.stderr);
  assert.equal(on.stdout, dd().out, 'the hook prints the bare done-done state');
  assert.equal(toon({ out: on.stdout }).config, 'present');
  const off = hook(join(dir, 'empty'));
  assert.deepEqual([off.status, off.stdout, off.stderr], [0, '', ''], 'without done-done on PATH the hook is silent and exits 0');
  const before = readFileSync(settings);
  assert.equal(toon(dd('init', '--hook', 'claude')).claude_hook, 'unchanged');
  assert.deepEqual(readFileSync(settings), before, 'a second run adds no duplicate');
  // An existing settings file keeps its other keys and hooks.
  const other = { permissions: { allow: ['Bash(npm test)'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } };
  const two = bareRepo();
  mkdirSync(join(two.repo, '.claude'));
  writeFileSync(join(two.repo, '.claude', 'settings.json'), JSON.stringify(other));
  assert.equal(two.dd('init', '--hook', 'claude').code, 2);
  const merged = JSON.parse(readFileSync(join(two.repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(merged, { ...other, hooks: { ...other.hooks, SessionStart: [...other.hooks.SessionStart, hooks[0]] } }, 'both hooks and every other key are kept');
  // Another agent is a usage error naming the supported values; a malformed settings file is left untouched.
  const bad = two.dd('init', '--hook', 'cursor');
  assert.equal(bad.code, 2, bad.out);
  assert.match(toon(bad).error, /supported values are claude, codex, opencode/);
  writeFileSync(join(two.repo, '.claude', 'settings.json'), '{ nope');
  const broken = two.dd('init', '--hook', 'claude');
  assert.equal(broken.code, 2, broken.out);
  assert.match(toon(broken).help[0], /Fix \.claude\/settings\.json/);
  assert.equal(readFileSync(join(two.repo, '.claude', 'settings.json'), 'utf8'), '{ nope');
  // --hook with --journey records the journey and still adds the hook.
  const three = bareRepo();
  const both = three.dd('init', '--journey', 'smoke', '--hook', 'claude', '--', 'echo hi');
  assert.equal(both.code, 2, both.out);
  assert.deepEqual([toon(both).journey, toon(both).claude_hook], ['smoke', 'added to .claude/settings.json']);
  assert.match(toon(both).help.join('\n'), /Commit \.claude\/settings\.json/);
  assert.deepEqual(JSON.parse(readFileSync(join(three.repo, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart, hooks);
});

test('init --hook codex adds a SessionStart hook that shows the bare state, merges, and never duplicates', () => {
  const { dir, repo, env, dd } = bareRepo();
  const hooksFile = join(repo, '.codex', 'hooks.json');
  const r = dd('init', '--hook', 'codex');
  assert.equal(r.code, 2, r.out);
  assert.equal(toon(r).codex_hook, 'added to .codex/hooks.json');
  const hooks = JSON.parse(readFileSync(hooksFile, 'utf8')).hooks.SessionStart;
  assert.equal(hooks.length, 1);
  const { command } = hooks[0].hooks[0];
  // Run the hook as Codex does: through a shell, from the repo cwd, with done-done on PATH and without it.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'done-done'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  const hook = (path) => spawnSync('/bin/sh', ['-c', command], { cwd: repo, env: { ...env, PATH: path }, encoding: 'utf8' });
  const on = hook(`${bin}:${env.PATH}`);
  assert.equal(on.status, 0, on.stderr);
  assert.equal(on.stdout, dd().out, 'the hook prints the bare done-done state');
  assert.equal(toon({ out: on.stdout }).config, 'present');
  const off = hook(join(dir, 'empty'));
  assert.deepEqual([off.status, off.stdout, off.stderr], [0, '', ''], 'without done-done on PATH the hook is silent and exits 0');
  const before = readFileSync(hooksFile);
  assert.equal(toon(dd('init', '--hook', 'codex')).codex_hook, 'unchanged');
  assert.deepEqual(readFileSync(hooksFile), before, 'a second run adds no duplicate');
  // An existing hooks file keeps its other keys and hooks.
  const other = { description: 'team hooks', hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } };
  const two = bareRepo();
  mkdirSync(join(two.repo, '.codex'));
  writeFileSync(join(two.repo, '.codex', 'hooks.json'), JSON.stringify(other));
  assert.equal(two.dd('init', '--hook', 'codex').code, 2);
  const merged = JSON.parse(readFileSync(join(two.repo, '.codex', 'hooks.json'), 'utf8'));
  assert.deepEqual(merged, { ...other, hooks: { ...other.hooks, SessionStart: [...other.hooks.SessionStart, hooks[0]] } }, 'both hooks and every other key are kept');
  // A malformed hooks file is left untouched.
  writeFileSync(join(two.repo, '.codex', 'hooks.json'), '{ nope');
  const broken = two.dd('init', '--hook', 'codex');
  assert.equal(broken.code, 2, broken.out);
  assert.match(toon(broken).help[0], /Fix \.codex\/hooks\.json/);
  assert.equal(readFileSync(join(two.repo, '.codex', 'hooks.json'), 'utf8'), '{ nope');
});

test('init --journey records the capture recipe and the journey re-runs from any checkout', () => {
  const { dir, repo, env, sh, dd } = bareRepo();
  const r = dd('init', '--journey', 'smoke', '--', 'echo added: milk > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log');
  assert.equal(r.code, 2, r.out);
  assert.equal(toon(r).config, 'written');
  assert.equal(toon(r).journey, 'smoke');
  assert.equal(parse(readFileSync(join(repo, '.done-done.yaml'), 'utf8')).journeys.smoke.command, 'echo added: milk > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log', 'the ${RUN_ID} placeholder is stored verbatim');
  sh('add', '-A');
  sh('commit', '-qm', 'config');
  const run = dd('run', 'smoke');
  assert.equal(run.code, 0, run.out);
  assert.ok(!toon(run).help.join('\n').includes('not in the repo'), 'a recorded journey run carries no outside-repo hint');
  const { run_id: id } = toon(run);
  const [log] = toon(run).evidence;
  assert.equal(log, join(dir, 'home', 'evidence', 'repo', id, `${id}.log`));
  // A second checkout re-runs the proof from only the repo recipe.
  const lane2 = join(dir, 'lane2');
  execFileSync('git', ['clone', '-q', repo, lane2]);
  const in2 = spawnSync(process.execPath, [CLI, 'run', 'smoke'], { cwd: lane2, env, encoding: 'utf8' });
  assert.equal(in2.status, 0, in2.stdout + in2.stderr);
  assert.ok(!(in2.stdout + in2.stderr).includes('not in the repo'), 'the recipe travels with the repo');
  // Re-recording the journey updates the stored command.
  assert.equal(dd('init', '--journey', 'smoke', '--', 'echo added: eggs > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log').code, 2);
  assert.equal(parse(readFileSync(join(repo, '.done-done.yaml'), 'utf8')).journeys.smoke.command, 'echo added: eggs > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log');
  assert.equal(dd('init', '--journey', 'smoke').code, 2, 'a journey with no command after -- is a usage error');
});

test('init --journey keeps the comments and formatting of an existing config', () => {
  const { repo, dd } = bareRepo();
  const long = 'node make-shots.mjs ${RUN_ID} --viewport 1280x800 --theme dark --out-dir .proof/${RUN_ID} --wait-for-network-idle';
  const original = `# team proof config\napp: notes\n\njourneys:\n  shots:\n    command: ${long}\n`;
  writeFileSync(join(repo, '.done-done.yaml'), original);
  const r = dd('init', '--journey', 'smoke', '--', 'echo hi');
  assert.equal(r.code, 2, r.out);
  assert.equal(readFileSync(join(repo, '.done-done.yaml'), 'utf8'), `${original}  smoke:\n    command: echo hi\n`);
});

test('init --journey records the command a run executes, shell syntax included', () => {
  const { repo, sh, dd } = bareRepo();
  assert.equal(dd('init', '--journey', 'unit', '--', 'echo', 'added', '>', '$DONE_DONE_EVIDENCE_ROOT/out.txt').code, 2);
  assert.equal(parse(readFileSync(join(repo, '.done-done.yaml'), 'utf8')).journeys.unit.command, 'echo added > $DONE_DONE_EVIDENCE_ROOT/out.txt');
  sh('add', '-A');
  sh('commit', '-qm', 'recipe');
  const run = dd('run', 'unit');
  assert.equal(run.code, 0, run.out);
  const [file] = toon(run).evidence;
  assert.equal(readFileSync(file, 'utf8'), 'added\n');
  const adhoc = dd('run', '--', 'echo', 'added', '>', '$DONE_DONE_EVIDENCE_ROOT/out.txt');
  assert.equal(adhoc.code, 0, adhoc.out);
  assert.ok(!toon(adhoc).help.join('\n').includes('not in the repo'), 'the same command run ad hoc matches the recorded recipe');
});

test('re-recording a journey replaces only its command and keeps its other keys and comments', () => {
  const { repo, dd } = bareRepo();
  const original = 'app: notes\njourneys:\n  smoke:\n    command: old # keep\n    timeout: 60\n';
  writeFileSync(join(repo, '.done-done.yaml'), original);
  assert.equal(dd('init', '--journey', 'smoke', '--', 'echo new').code, 2);
  assert.equal(readFileSync(join(repo, '.done-done.yaml'), 'utf8'), 'app: notes\njourneys:\n  smoke:\n    command: echo new # keep\n    timeout: 60\n');
});

test('the outside-repo hint never prints the ad-hoc command, so a secret in it is not suggested for commit', () => {
  const { dd } = bareRepo();
  const r = dd('run', '--', 'true', '--token', 's3cret-value');
  const help = toon(r).help.join('\n');
  assert.match(help, /not in the repo/);
  assert.match(help, /init --journey <name> -- <command>/);
  assert.ok(!help.includes('s3cret-value'), help);
});

test('init with an empty --journey name is a usage error, not a plain init', () => {
  const { repo, dd } = bareRepo();
  const r = dd('init', '--journey', '', '--', 'echo hi');
  assert.equal(r.code, 2, r.out);
  assert.equal(existsSync(join(repo, '.done-done.yaml')), false, 'no config is written');
  assert.equal(dd('init', '--journey', '').code, 2, 'an empty name with no command is a usage error too');
});

test('init --journey rejects a blank command instead of recording an empty recipe', () => {
  const { repo, dd } = bareRepo();
  const r = dd('init', '--journey', 'smoke', '--', '');
  assert.equal(r.code, 2, r.out);
  assert.equal(existsSync(join(repo, '.done-done.yaml')), false, 'no config is written');
});

test('a run command outside the repo hints that its recipe is not recorded', () => {
  const { dd, shots } = setup();
  const adhoc = dd('run', '--', 'echo added: milk > $DONE_DONE_EVIDENCE_ROOT/adhoc.log');
  assert.equal(adhoc.code, 0, adhoc.out);
  assert.match(toon(adhoc).help.join('\n'), /not in the repo.*done-done init --journey <name> --/);
  const recorded = dd('run', 'shots');
  assert.equal(recorded.code, 0, recorded.out);
  assert.ok(!toon(recorded).help.join('\n').includes('not in the repo'), 'a journey run is the recipe, so no hint');
  const none = dd('run', '--', 'true');
  assert.equal(none.code, 1, none.out);
  assert.match(toon(none).reason, /DONE_DONE_EVIDENCE_ROOT/);
  assert.match(toon(none).reason, /DONE_DONE_RUN_ID/);
  assert.match(toon(none).help.join('\n'), /not in the repo/);
});

test('init --hook opencode adds a session plugin that shows the bare state, merges, and never duplicates', async () => {
  const { dir, repo, env, dd } = bareRepo();
  const plugin = join(repo, '.opencode', 'plugins', 'done-done.js');
  const r = dd('init', '--hook', 'opencode');
  assert.equal(r.code, 2, r.out);
  assert.equal(toon(r).opencode_plugin, 'added to .opencode/plugins/done-done.js');
  assert.match(toon(r).help.join('\n'), /Commit \.opencode\/plugins\/done-done\.js/);
  const body = readFileSync(plugin, 'utf8');
  const command = body.match(/^const COMMAND = "(.*)";$/m)[1];
  // Run the plugin's done-done command as opencode would: through a shell, from the repo, with done-done on PATH and without it.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'done-done'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  const shell = (path) => spawnSync('/bin/sh', ['-c', command], { cwd: repo, env: { ...env, PATH: path }, encoding: 'utf8' });
  const on = shell(`${bin}:${env.PATH}`);
  assert.equal(on.status, 0, on.stderr);
  assert.equal(on.stdout, dd().out, 'the plugin command prints the bare done-done state');
  assert.equal(toon({ out: on.stdout }).config, 'present');
  const off = shell(join(dir, 'empty'));
  assert.deepEqual([off.status, off.stdout, off.stderr], [0, '', ''], 'without done-done on PATH the command is silent and exits 0');
  // Drive the written plugin itself: the first message of a session gains the bare state, later ones do not.
  const prevPath = process.env.PATH;
  const prevHome = process.env.DONE_DONE_HOME;
  process.env.PATH = `${bin}:${prevPath}`;
  process.env.DONE_DONE_HOME = env.DONE_DONE_HOME;
  try {
    const { DoneDonePlugin } = await import(pathToFileURL(plugin).href);
    const id = () => `ses_${randomUUID()}`;
    const ses1 = id();
    const ses2 = id();
    const ses3 = id();
    const hooks = await DoneDonePlugin({ directory: repo });
    const parts = [];
    await hooks['chat.message']({ sessionID: ses1 }, { message: { id: 'msg_1' }, parts });
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, dd().out.trim(), 'the first message of a session gains the bare done-done state');
    assert.match(parts[0].id, /^prt_/, 'the appended part carries a part id opencode accepts');
    assert.equal(parts[0].messageID, 'msg_1', 'the appended part carries the message id from output.message, since opencode passes no messageID to the hook');
    assert.equal(parts[0].sessionID, ses1, 'the appended part carries the hook session id');
    await hooks['chat.message']({ sessionID: ses1 }, { message: { id: 'msg_2' }, parts });
    assert.equal(parts.length, 1, 'later messages in the same session gain nothing');
    const { DoneDonePlugin: ResumedPlugin } = await import(`${pathToFileURL(plugin).href}?resumed`);
    const resumed = await ResumedPlugin({ directory: repo });
    const afterResume = [];
    await resumed['chat.message']({ sessionID: ses1 }, { message: { id: 'msg_5' }, parts: afterResume });
    assert.equal(afterResume.length, 1, 'a resumed session in a new plugin instance shows the state again on its first message');
    const fresh = [];
    await hooks['chat.message']({ sessionID: ses2 }, { message: { id: 'msg_3' }, parts: fresh });
    assert.equal(fresh.length, 1, 'a new session gains the state again');
    assert.match(fresh[0].id, /^prt_/);
    assert.notEqual(fresh[0].id, parts[0].id, 'each appended part gets its own id');
    process.env.PATH = join(dir, 'empty');
    const silent = [];
    await hooks['chat.message']({ sessionID: ses3 }, { message: { id: 'msg_4' }, parts: silent });
    assert.deepEqual(silent, [], 'without done-done on PATH the hook appends nothing and never throws');
  } finally {
    process.env.PATH = prevPath;
    if (prevHome === undefined) delete process.env.DONE_DONE_HOME;
    else process.env.DONE_DONE_HOME = prevHome;
  }
  const before = readFileSync(plugin);
  assert.equal(toon(dd('init', '--hook', 'opencode')).opencode_plugin, 'unchanged');
  assert.deepEqual(readFileSync(plugin), before, 'a second run adds no duplicate');
  // An existing plugins directory keeps its other plugins and project config keys.
  const two = bareRepo();
  mkdirSync(join(two.repo, '.opencode', 'plugins'), { recursive: true });
  writeFileSync(join(two.repo, '.opencode', 'plugins', 'other.js'), 'export const Other = async () => ({});\n');
  writeFileSync(join(two.repo, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', theme: 'dark' }));
  assert.equal(two.dd('init', '--hook', 'opencode').code, 2);
  assert.equal(readFileSync(join(two.repo, '.opencode', 'plugins', 'other.js'), 'utf8'), 'export const Other = async () => ({});\n', 'other plugins are kept');
  assert.deepEqual(JSON.parse(readFileSync(join(two.repo, 'opencode.json'), 'utf8')), { $schema: 'https://opencode.ai/config.json', theme: 'dark' }, 'project config keys are kept');
});

test('init --hook opencode refuses to overwrite a plugin file with other content', () => {
  const { repo, dd } = bareRepo();
  const plugin = join(repo, '.opencode', 'plugins', 'done-done.js');
  mkdirSync(join(repo, '.opencode', 'plugins'), { recursive: true });
  writeFileSync(plugin, 'export const Mine = async () => ({});\n');
  const r = dd('init', '--hook', 'opencode');
  assert.equal(r.code, 2, r.out);
  assert.match(toon(r).error, /\.opencode\/plugins\/done-done\.js already exists/);
  assert.equal(readFileSync(plugin, 'utf8'), 'export const Mine = async () => ({});\n', 'the existing file is kept');
});

test('init --hook gemini and --hook pi give the model the bare state at the start of each session', async () => {
  const { dir, repo, env, dd } = bareRepo();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'done-done'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  const g = dd('init', '--hook', 'gemini');
  assert.equal(g.code, 2, g.out);
  assert.equal(toon(g).gemini_hook, 'added to .gemini/settings.json');
  assert.match(toon(g).help.join('\n'), /Commit \.gemini\/settings\.json/);
  const settings = join(repo, '.gemini', 'settings.json');
  const [{ hooks: [{ type, command }] }] = JSON.parse(readFileSync(settings, 'utf8')).hooks.SessionStart;
  assert.equal(type, 'command');
  // Run the hook as Gemini CLI does: through a shell from the project dir, the event JSON on stdin; it parses stdout as JSON.
  const hook = (path) => spawnSync('/bin/sh', ['-c', command], { cwd: repo, env: { ...env, PATH: path }, encoding: 'utf8', input: '{"hook_event_name":"SessionStart","source":"startup"}' });
  const on = hook(`${bin}:${env.PATH}`);
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(JSON.parse(on.stdout), { hookSpecificOutput: { additionalContext: dd().out.trim() } }, 'the bare state goes to the model as additionalContext');
  const off = hook(join(dir, 'empty'));
  assert.deepEqual([off.status, off.stdout, off.stderr], [0, '', ''], 'without done-done on PATH the hook is silent and exits 0');
  assert.equal(toon(dd('init', '--hook', 'gemini')).gemini_hook, 'unchanged');
  const p = dd('init', '--hook', 'pi');
  assert.equal(p.code, 2, p.out);
  assert.equal(toon(p).pi_extension, 'added to .pi/extensions/done-done.js');
  assert.match(toon(p).help.join('\n'), /Commit \.pi\/extensions\/done-done\.js/);
  assert.equal(toon(dd('init', '--hook', 'pi')).pi_extension, 'unchanged');
  // Drive the written extension as pi does: its default export registers handlers; the first prompt of a session gains the state.
  const prevPath = process.env.PATH;
  const prevHome = process.env.DONE_DONE_HOME;
  process.env.PATH = `${bin}:${prevPath}`;
  process.env.DONE_DONE_HOME = env.DONE_DONE_HOME;
  try {
    const { default: register } = await import(pathToFileURL(join(repo, '.pi', 'extensions', 'done-done.js')).href);
    const handlers = {};
    register({ on: (event, handler) => (handlers[event] = handler) });
    const ctx = { cwd: repo };
    await handlers.session_start({ type: 'session_start' }, ctx);
    const first = await handlers.before_agent_start({ type: 'before_agent_start', prompt: 'hi' }, ctx);
    assert.deepEqual(first, { message: { customType: 'done-done', content: dd().out.trim(), display: true } }, 'the first prompt gains the bare state as a message');
    assert.equal(await handlers.before_agent_start({ type: 'before_agent_start', prompt: 'again' }, ctx), undefined, 'later prompts in the session gain nothing');
    await handlers.session_start({ type: 'session_start' }, ctx);
    assert.equal((await handlers.before_agent_start({ type: 'before_agent_start', prompt: 'new' }, ctx)).message.content, dd().out.trim(), 'a new session gains it again');
    process.env.PATH = join(dir, 'empty');
    await handlers.session_start({ type: 'session_start' }, ctx);
    assert.equal(await handlers.before_agent_start({ type: 'before_agent_start', prompt: 'hi' }, ctx), undefined, 'without done-done on PATH it adds nothing and never throws');
  } finally {
    process.env.PATH = prevPath;
    if (prevHome === undefined) delete process.env.DONE_DONE_HOME;
    else process.env.DONE_DONE_HOME = prevHome;
  }
});

// Fixture repos of two shapes for init's verify-skill scaffold: a web app and a CLI tool.
function shapeRepo(kind, name) {
  const dir = mkdtempSync(join(tmpdir(), 'done-done-shape-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, name);
  const env = { ...process.env, DONE_DONE_HOME: join(dir, 'home'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  mkdirSync(repo, { recursive: true });
  if (kind === 'web') {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, scripts: { dev: 'vite --port 5173' }, dependencies: { react: '^19.0.0' }, devDependencies: { '@playwright/test': '^1.0.0' } }));
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'App.jsx'), 'export const App = () => <h1>shop</h1>;\n');
    writeFileSync(join(repo, 'server.js'), "app.get('/cart', show);\napp.post('/checkout', pay);\n");
    writeFileSync(join(repo, 'README.md'), '# shop\n');
  } else {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, bin: { [name]: 'bin/cli.js' }, dependencies: { commander: '^12.0.0' } }));
    mkdirSync(join(repo, 'bin'));
    writeFileSync(join(repo, 'bin', 'cli.js'), `#!/usr/bin/env node\nprogram.command('add').command('list');\n`);
    writeFileSync(join(repo, 'README.md'), '# notes\n');
  }
  const sh = (...a) => execFileSync('git', a, { cwd: repo, env, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main');
  sh('add', '-A');
  sh('commit', '-qm', 'init');
  const dd = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { dir, repo, env, dd };
}

const featureFiles = (skillDir) => readdirSync(join(skillDir, 'features')).sort();

test('init scaffolds a verify skill with real launch and features for a web app', () => {
  const { repo, dd } = shapeRepo('web', 'shop');
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  assert.equal(toon(r).verify_skill, 'written');
  const dir = join(repo, '.agents', 'skills', 'verify-shop');
  assert.deepEqual(featureFiles(dir), ['README.md', 'get-cart.md', 'post-checkout.md'], 'each route becomes a feature');
  const body = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.match(body, /^name: verify-shop$/m, 'frontmatter registers the skill');
  assert.match(body, /npm run dev \(vite --port 5173\)/, 'launch comes from the repo scripts');
  assert.match(body, /localhost:5173/, 'the detected port becomes the readiness check');
  assert.match(body, /browser\/CDP \(Playwright\)/, 'the harness comes from the repo deps');
  for (const f of ['get-cart', 'post-checkout']) {
    const feat = readFileSync(join(dir, 'features', `${f}.md`), 'utf8');
    assert.match(feat, /## Driving it with/, 'each feature keeps the four-H2 shape');
  }
  assert.match(readFileSync(join(dir, 'features', 'README.md'), 'utf8'), /get-cart\.md/, 'the map indexes its features');
  const before = body;
  assert.equal(toon(dd('init')).verify_skill, 'unchanged');
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), before, 're-run is idempotent');
});

test('init scaffolds a verify skill with real bin and commands for a CLI tool', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  assert.equal(dd('init').code, 2);
  const dir = join(repo, '.agents', 'skills', 'verify-notes');
  const body = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.match(body, /^name: verify-notes$/m);
  assert.match(body, /node bin\/cli\.js --help/, 'launch comes from package.json bin');
  assert.match(body, /tmux\/PTY/, 'a CLI is driven over a PTY');
  assert.ok(existsSync(join(dir, 'features', 'add.md')) && existsSync(join(dir, 'features', 'list.md')), 'subcommands become features');
});

test('init never overwrites an existing verify skill', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  const skill = join(repo, '.agents', 'skills', 'verify-notes', 'SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, '# hand-written\n');
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  assert.equal(toon(r).verify_skill, 'unchanged');
  assert.equal(readFileSync(skill, 'utf8'), '# hand-written\n', 'the existing file is kept');
});

test('init maps the app, not its dependencies, and lists each feature slug once', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  mkdirSync(join(repo, 'node_modules', 'lib'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'lib', 'index.js'), "router.get('/vendored/route');\nprogram.command('vendored');\n");
  writeFileSync(join(repo, 'routes.js'), "app.get('/a/b');\napp.get('/a-b');\n");
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  const dir = join(repo, '.agents', 'skills', 'verify-notes');
  assert.deepEqual(featureFiles(dir), ['README.md', 'add.md', 'get-a-b-2.md', 'get-a-b.md', 'list.md'], 'node_modules is skipped and each distinct route keeps its own file');
  assert.match(readFileSync(join(dir, 'features', 'get-a-b-2.md'), 'utf8'), /^# GET \/a-b$/m);
});

test('init keeps distinct routes whose slugs collide after truncation', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  writeFileSync(join(repo, 'routes.js'), "app.get('/api/organizations/:id/members/invitations/pending');\napp.get('/api/organizations/:id/members/invitations/expired');\n");
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  const dir = join(repo, '.agents', 'skills', 'verify-notes');
  const feats = featureFiles(dir).filter((f) => f.startsWith('get-api-organizations'));
  assert.equal(feats.length, 2, 'both routes get a feature file');
  const titles = feats.map((f) => readFileSync(join(dir, 'features', f), 'utf8').split('\n')[0]).sort();
  assert.deepEqual(titles, ['# GET /api/organizations/:id/members/invitations/expired', '# GET /api/organizations/:id/members/invitations/pending']);
});

test('init does not read a README that is a symlink out of the repo', () => {
  const { dir, repo, dd } = shapeRepo('cli', 'notes');
  writeFileSync(join(dir, 'secret.md'), "app.get('/secret');\n");
  rmSync(join(repo, 'README.md'));
  symlinkSync(join(dir, 'secret.md'), join(repo, 'README.md'));
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  assert.deepEqual(featureFiles(join(repo, '.agents', 'skills', 'verify-notes')), ['README.md', 'add.md', 'list.md'], 'the symlink target is not scanned');
});

test('init keeps a command in the feature map and says how many features it left out', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  writeFileSync(join(repo, 'routes.js'), ['1', '2', '3', '4', '5', '6'].map((n) => `app.get('/r${n}');`).join('\n') + '\n');
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  const dir = join(repo, '.agents', 'skills', 'verify-notes');
  assert.deepEqual(featureFiles(dir), ['README.md', 'add.md', 'get-r1.md', 'get-r2.md', 'get-r3.md', 'get-r4.md']);
  assert.match(readFileSync(join(dir, 'features', 'README.md'), 'utf8'), /3 more found and not listed/, 'six routes and two commands show five, and say three were left out');
});

test('init reads server routes only, not client calls or component files', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  mkdirSync(join(repo, 'src', 'components'), { recursive: true });
  writeFileSync(join(repo, 'src', 'components', 'Cart.js'), "app.get('/from-component');\n");
  writeFileSync(join(repo, 'src', 'Page.jsx'), "app.get('/from-jsx');\n");
  writeFileSync(join(repo, 'client.js'), "axios.get('/api/cart');\n");
  writeFileSync(join(repo, 'server.js'), "app.get('/server');\n");
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  assert.deepEqual(featureFiles(join(repo, '.agents', 'skills', 'verify-notes')), ['README.md', 'add.md', 'get-server.md', 'list.md']);
});

test('init takes the readiness port only from the dev script', () => {
  const { repo, dd } = shapeRepo('web', 'shop');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'shop', scripts: { dev: 'next dev' }, dependencies: { react: '^19.0.0' } }));
  writeFileSync(join(repo, 'README.md'), '# shop\nDATABASE_URL=postgres://localhost:5432/app\n');
  assert.equal(dd('init').code, 2);
  const body = readFileSync(join(repo, '.agents', 'skills', 'verify-shop', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(body, /localhost:5432/, 'a database URL in the README is not the app port');
});

test('init does not map README code samples as routes or commands', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  writeFileSync(join(repo, 'README.md'), "# notes\n\n```js\napp.get('/docs-example');\nprogram.command('demo');\n```\n");
  assert.equal(dd('init').code, 2);
  assert.deepEqual(featureFiles(join(repo, '.agents', 'skills', 'verify-notes')), ['README.md', 'add.md', 'list.md'], 'only source and bin commands become features');
});

test('init keeps the config when the verify skill cannot be written', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  writeFileSync(join(repo, '.agents'), 'not a directory\n');
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  assert.match(toon(r).verify_skill, /^skipped, .*could not be written/, 'the scaffold is skipped with a reason');
  assert.equal(existsSync(join(repo, '.done-done.yaml')), true, 'the config written before the scaffold is kept');
});

test('init reads a package.json larger than 20 KB', () => {
  const { repo, dd } = shapeRepo('web', 'shop');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'shop', scripts: { dev: 'vite --port 5173' }, dependencies: { react: '^19.0.0' }, description: 'x'.repeat(30000) }));
  assert.equal(dd('init').code, 2);
  const body = readFileSync(join(repo, '.agents', 'skills', 'verify-shop', 'SKILL.md'), 'utf8');
  assert.match(body, /npm run dev \(vite --port 5173\)/, 'scripts past the old 20000-character cut are still read');
});

test('init refuses a verify skill path that leaves the repo', () => {
  const { dir, repo, dd } = shapeRepo('cli', 'notes');
  writeFileSync(join(repo, '.done-done.yaml'), 'skill: ../escaped/verify\n');
  const r = dd('init');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /has a \.\. segment/);
  assert.match(r.out, /\.\.\/escaped\/verify/, 'the message names the bad value');
  assert.equal(existsSync(join(dir, 'escaped')), false, 'nothing is written outside the repo');
});

test('init skips the verify skill behind a symlinked ancestor and writes the rest', () => {
  const { dir, repo, dd } = shapeRepo('cli', 'notes');
  mkdirSync(join(dir, 'elsewhere'));
  symlinkSync(join(dir, 'elsewhere'), join(repo, '.agents'));
  writeFileSync(join(repo, '.done-done.yaml'), 'skill: .agents/skills/verify-notes\n');
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  assert.match(toon(r).verify_skill, /^skipped, \.agents is a symlink/);
  assert.equal(existsSync(join(dir, 'elsewhere', 'skills')), false, 'nothing is written through the symlink');
  assert.equal(existsSync(join(repo, '.done-done.yaml')), true, 'the rest of init still ran');
});

test('init skips the verify skill when a symlink sits beneath the skill dir', () => {
  const { dir, repo, dd } = shapeRepo('cli', 'notes');
  mkdirSync(join(repo, '.agents', 'skills', 'verify-notes'), { recursive: true });
  mkdirSync(join(dir, 'elsewhere'));
  symlinkSync(join(dir, 'elsewhere'), join(repo, '.agents', 'skills', 'verify-notes', 'features'));
  const r = dd('init');
  assert.equal(r.code, 2, r.out);
  assert.match(toon(r).verify_skill, /features is a symlink/);
  assert.deepEqual(readdirSync(join(dir, 'elsewhere')), [], 'no feature file is written through the symlink');
  assert.equal(existsSync(join(repo, '.agents', 'skills', 'verify-notes', 'SKILL.md')), false, 'no partial scaffold');
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
  assert.equal(init.code, 2);
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
  assert.equal(dd('init').code, 2);
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
  const version = dd('--version'); assert.deepEqual([version.code, version.out], [0, `${JSON.parse(readFileSync(join(dirname(CLI), '..', 'package.json'), 'utf8')).version}\n`]);
  for (const cmd of ['init', 'run', 'check', 'receipt', 'verify', 'status']) {
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
  const doctorBad = dd('doctor', 'extra');
  assert.equal(doctorBad.code, 2, doctorBad.out);
  assert.equal(toon(doctorBad).command, 'doctor', 'the error names the subcommand');
  assert.equal(toon(doctorBad).help[0], 'Run `done-done doctor` (or `done-done doctor --probe`) with no other arguments');
  assert.equal(dd('doctor', '--bogus').code, 2, 'an unknown doctor flag is a usage error too');
  assert.match(toon(dd('check', '--outcome', 'x', '--bogus.yaml')).help[0], /^Valid flags for check: /, 'a .yaml-looking flag is still a flag error');
  assert.match(toon(dd('check', '--from', 'missing.yaml')).help[0], /done-done check --help/, 'a missing claim file is not a config error');
  assert.match(dd('receipt', '--help').out, /done-done receipt --outcome .*\[--trusted-ref <ref>\]/);
  assert.match(dd('run', '--help').out, /--close <run-id> +seal an open run/);
  assert.match(dd('run', '--help').out, /^journeys \(\.done-done\.yaml\): /m, 'run --help shows the journey format');
  assert.match(dd('receipt', '--help').out, /^Checks block \(--from\): .*\n {2}outcome: /m, 'receipt --help shows the Checks block');
  assert.match(dd('check', '--help').out, /--trusted-ref <ref> +read \.done-done\.yaml/);
  assert.equal(dd('run', '--', 'node', '-e', 'process.exit(0)', '--help').code, 1, 'a --help after -- belongs to the run command');
});

// A repo with a journey that blocks until the test releases it, so a verify run can be caught mid-step.
function slowRepo() {
  const t = setup();
  const release = join(t.dir, 'release');
  writeFileSync(
    join(t.repo, 'slow.mjs'),
    `import { copyFileSync, existsSync, mkdirSync } from 'node:fs';\nconst out = '.proof/' + process.argv[2];\nmkdirSync(out, { recursive: true });\nwhile (!existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 50));\ncopyFileSync(${JSON.stringify(join(t.dir, 'screen.png'))}, out + '/home.png');\ncopyFileSync(${JSON.stringify(join(t.dir, 'screen2.png'))}, out + '/settings.png');\n`,
  );
  appendFileSync(join(t.repo, '.done-done.yaml'), '  slow:\n    command: node slow.mjs ${RUN_ID}\n  broken:\n    command: node -e "process.exit(3)"\n');
  t.sh('add', '-A');
  t.sh('commit', '-qm', 'journeys');
  const runs = join(t.env.DONE_DONE_HOME, 'runs', 'notes');
  // Wait for the newest run to reach `step` running, and return its record.
  const runningAt = async (step) => {
    for (let i = 0; i < 200; i++) {
      const id = existsSync(runs) && readdirSync(runs).sort().pop();
      const run = id && existsSync(join(runs, id, 'run.json')) && JSON.parse(readFileSync(join(runs, id, 'run.json'), 'utf8'));
      if (run?.runner?.journey_pgid && run.steps.find((s) => s.name === step).status === 'running') return run;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`no run reached step ${step}`);
  };
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      const r = t.dd('status');
      if (r.code !== 4) return r;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail('the run never ended');
  };
  return { ...t, release, runs, runningAt, settled };
}

test('verify goes on in a detached runner after the calling shell is killed, and status shows the pass', async () => {
  const { repo, env, release, runs, runningAt, settled } = slowRepo();
  const shell = spawn('sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} verify slow --outcome 'home and settings render'`], { cwd: repo, env, detached: true, stdio: 'ignore' });
  const run = await runningAt('drive');
  assert.equal(run.schema, 2);
  assert.equal(run.status, 'running');
  process.kill(-shell.pid, 'SIGKILL');
  await new Promise((r) => shell.on('exit', r));
  assert.ok(existsSync(join(runs, run.run_id, 'events.jsonl')));
  writeFileSync(release, '');
  const r = await settled();
  assert.equal(r.code, 0, r.out);
  const s = toon(r);
  assert.equal(s.run_id, run.run_id);
  assert.equal(s.result, 'pass');
  assert.deepEqual(s.steps.map((x) => [x.name, x.status]), [['resolve', 'completed'], ['drive', 'completed'], ['check', 'completed'], ['judge', 'skipped'], ['gate', 'skipped'], ['receipt', 'completed'], ['report', 'completed']], 'the judge is off');
  assert.deepEqual(s.evidence, [`.proof/${run.run_id}/home.png`, `.proof/${run.run_id}/settings.png`]);
  assert.match(s.help[0], /done-done receipt --verify [0-9a-f]{40}$/);
  assert.ok(existsSync(join(repo, s.receipt)), 'the runner recorded a receipt');
  assert.ok(existsSync(join(runs, run.run_id, 'logs', 'check.log')));
});

// Resolves true once the process group is gone, false if it outlives the poll.
async function groupGone(pgid) {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return true;
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

test('a runner killed mid-step shows as failed at that step, and status stops the journey it left', async () => {
  const { dd, runs, runningAt } = slowRepo();
  const started = dd('verify', 'slow', '--outcome', 'home and settings render', '--no-wait');
  assert.equal(started.code, 4, started.out);
  assert.match(toon(started).help[0], /done-done status --run /);
  const run = await runningAt('drive');
  process.kill(run.runner.pid, 'SIGKILL');
  let r;
  for (let i = 0; i < 100 && (r = dd('status')).code === 4; i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.code, 1, r.out);
  assert.ok(await groupGone(run.runner.journey_pgid), 'status killed the journey the killed runner left behind');
  assert.ok(existsSync(join(runs, run.run_id, 'journey.killed')), 'the kill is recorded once');
  const s = toon(r);
  assert.equal(s.status, 'failed');
  assert.equal(toon(dd('history')).history.find((x) => x.run_id === run.run_id).status, 'failed', 'history agrees with status');
  const a = dd('abort', '--run', run.run_id);
  assert.equal(a.code, 1, a.out);
  assert.equal(toon(a).status, 'failed', 'abort does not cancel a run whose runner is gone');
  assert.equal(s.steps[1].status, 'failed');
  assert.match(s.reason, new RegExp(`^the runner died at step drive \\(pid ${run.runner.pid},`));
  assert.equal(JSON.parse(readFileSync(join(runs, run.run_id, 'run.json'), 'utf8')).status, 'running', 'status only reads the store');
  assert.equal(s.help[1], `Fix the cause, commit, then run again from the failed step: done-done rerun --run ${run.run_id}`);
  assert.equal(s.help[2], "Or start a new run: done-done verify slow --outcome 'home and settings render'");
});

test('a live runner with an old heartbeat is not failed, and its journey is not killed', async () => {
  const { dd, runs, runningAt, release, settled } = slowRepo();
  assert.equal(dd('verify', 'slow', '--outcome', 'home and settings render', '--no-wait').code, 4);
  const run = await runningAt('drive');
  const file = join(runs, run.run_id, 'run.json');
  const stale = JSON.parse(readFileSync(file, 'utf8'));
  stale.runner.heartbeat = '2000-01-01T00:00:00.000Z';
  writeFileSync(file, JSON.stringify(stale));
  const r = dd('status', '--run', run.run_id);
  assert.equal(r.code, 4, r.out);
  assert.equal(toon(r).status, 'running');
  assert.equal(existsSync(join(runs, run.run_id, 'journey.killed')), false);
  writeFileSync(release, '');
  assert.equal((await settled()).code, 0);
});

test('a journey timeout of zero or past the timer limit is refused at resolve', () => {
  for (const timeout of ['0s', '40000m']) {
    const { repo, dd } = setup();
    appendFileSync(join(repo, '.done-done.yaml'), `  hang:\n    command: node -e "setInterval(() => {}, 1000)"\n    timeout: ${timeout}\n`);
    const r = dd('verify', 'hang', '--outcome', 'the app starts', '--foreground');
    assert.equal(r.code, 1, r.out);
    assert.equal(toon(r).reason, `resolve: journeys.hang.timeout must be a duration such as 30m or 90s, not ${timeout}`);
  }
});

test('status shows the newest run of this checkout and names its repo', () => {
  const { repo, env, dd } = setup();
  assert.equal(dd('verify', 'shots', '--outcome', 'home and settings render', '--foreground').code, 0);
  const other = mkdtempSync(join(tmpdir(), 'done-done-other-'));
  after(() => rmSync(other, { recursive: true, force: true }));
  const otherRepo = join(other, 'repo');
  mkdirSync(otherRepo);
  execFileSync('git', ['init', '-q'], { cwd: otherRepo, env });
  writeFileSync(join(otherRepo, '.done-done.yaml'), 'app: notes\n');
  const elsewhere = spawnSync(process.execPath, [CLI, 'status'], { cwd: otherRepo, env, encoding: 'utf8' });
  assert.equal(elsewhere.status, 2, elsewhere.stdout + elsewhere.stderr);
  const here = toon(dd('status'));
  assert.equal(here.repo, repo);
  assert.equal(here.result, 'pass');
});

test('status shows the run that started last, whatever its id sorts as', () => {
  const { dd, env } = setup();
  const a = toon(dd('verify', 'shots', '--outcome', 'home and settings render', '--foreground')).run_id;
  const b = toon(dd('verify', 'shots', '--outcome', 'home and settings render', '--foreground')).run_id;
  const early = [a, b].sort()[0];
  const file = join(env.DONE_DONE_HOME, 'runs', 'notes', early, 'run.json');
  const run = JSON.parse(readFileSync(file, 'utf8'));
  run.created = '2099-01-01T00:00:00.000Z';
  writeFileSync(file, JSON.stringify(run));
  assert.equal(toon(dd('status')).run_id, early);
});

test('a journey past its timeout is killed and the run ends inconclusive', async () => {
  const { repo, dd, env } = setup();
  appendFileSync(join(repo, '.done-done.yaml'), '  hang:\n    command: node -e "setInterval(() => {}, 1000)"\n    timeout: 2s\n');
  const r = dd('verify', 'hang', '--outcome', 'the app starts', '--foreground');
  assert.equal(r.code, 3, r.out);
  const s = toon(r);
  assert.equal(s.result, 'inconclusive');
  assert.equal(s.reason, 'drive: journey timed out after 2s');
  assert.deepEqual(s.steps.map((x) => x.status), ['completed', 'failed', 'skipped', 'skipped', 'skipped', 'skipped', 'completed']);
  const pgid = JSON.parse(readFileSync(join(env.DONE_DONE_HOME, 'runs', 'notes', s.run_id, 'run.json'), 'utf8')).runner.journey_pgid;
  assert.ok(await groupGone(pgid), 'the timed-out journey is gone');
});

test('the run store and check log keep every finding, not only the five shown', () => {
  const t = setup();
  writeFileSync(
    join(t.repo, 'dup.mjs'),
    `import { copyFileSync, mkdirSync } from 'node:fs';\nconst out = '.proof/' + process.argv[2];\nmkdirSync(out, { recursive: true });\nfor (let i = 0; i < 7; i++) copyFileSync(${JSON.stringify(join(t.dir, 'screen.png'))}, out + '/copy' + i + '.png');\n`,
  );
  appendFileSync(join(t.repo, '.done-done.yaml'), '  dup:\n    command: node dup.mjs ${RUN_ID}\n');
  t.sh('add', '-A');
  t.sh('commit', '-qm', 'dup journey');
  const r = t.dd('verify', 'dup', '--outcome', 'the copies render', '--foreground');
  assert.equal(r.code, 1, r.out);
  const s = toon(r);
  const runDir = join(t.env.DONE_DONE_HOME, 'runs', 'notes', s.run_id);
  const check = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).steps.find((x) => x.name === 'check');
  assert.equal(check.findings.length, 6, 'run.json keeps all six findings');
  const log = decode(readFileSync(join(runDir, 'logs', 'check.log'), 'utf8'));
  assert.equal(log.findings.length, 6, 'check.log keeps all six findings');
  assert.equal(log.findings_omitted, undefined);
});

test('verify waits until the run ends by default', () => {
  const { dd } = setup();
  const r = dd('verify', 'shots', '--outcome', 'home and settings render');
  assert.equal(r.code, 0, r.out);
  assert.equal(toon(r).result, 'pass');
});

test('a verify run fails when its log or text evidence holds a secret, naming where but never the value', () => {
  const t = setup(JUDGED.replace('journeys:', 'judge:\n  enabled: false\nsecrets:\n  patterns:\n    house-key: "HOUSE-\\\\d{4}"\n  allow: ["F4KE"]\njourneys:'));
  const leak = join(t.dir, 'leak.txt');
  appendFileSync(join(t.repo, '.done-done.yaml'), '  logged:\n    command: node make-shots.mjs ${RUN_ID} && cat ../leak.txt\n  saved:\n    command: node make-shots.mjs ${RUN_ID} && cp ../leak.txt "$DONE_DONE_EVIDENCE_ROOT/session.log"\n');
  t.sh('add', '-A'); t.sh('commit', '-qm', 'journeys');
  // Fake values, split so this file holds no secret shape itself.
  const fakes = [
    ['private-key', `-----BEGIN RSA ${'PRIVATE'} KEY-----`],
    ['github-token', `gh${'p_'}${'fake0'.repeat(8)}`],
    ['api-key', `s${'k-'}${'fake0'.repeat(5)}`],
    ['bearer', `Authorization: Bear${'er'} ${'fake0'.repeat(5)}`],
    ['key-value', `API_TOKEN=${'f4ke0'.repeat(6)}`],
    ['key-value', `DB_${'PASSWORD'}=Tr0ub4dor&3xtra`],
    ['house-key', 'door HOUSE-1234'],
  ];
  for (const [pattern, value] of fakes) {
    writeFileSync(leak, `starting\n${value}\n`);
    const r = t.dd('verify', 'logged', '--outcome', 'home and settings render');
    assert.match(toon(r).reason, new RegExp(`^secrets: .*/drive\\.log:2: holds a secret \\(${pattern}\\)`));
    const shownLog = t.dd('logs', '--step', 'check', '--run', toon(r).run_id).out;
    assert.ok(![r.out, shownLog].some((o) => o.includes(value.slice(-12))), `the ${pattern} value is never printed`);
  }
  writeFileSync(leak, `token=${'gh'}p_${'F4KE0'.repeat(8)}\n`);
  const evid = t.dd('verify', 'saved', '--outcome', 'home and settings render');
  assert.equal(evid.code, 0, `an allowed known-safe match passes: ${evid.out}`);
  writeFileSync(leak, `session ${'sk'}-${'fake0'.repeat(5)}\n`);
  assert.match(toon(t.dd('verify', 'saved', '--outcome', 'home and settings render')).reason, /^secrets: \.proof\/.*\/session\.log:1: holds a secret \(api-key\)/);
  writeFileSync(leak, 'saved 3 notes\n');
  assert.equal(t.dd('verify', 'logged', '--outcome', 'home and settings render').code, 0, 'clean evidence passes');
  writeFileSync(join(t.repo, '.done-done.yaml'), 'app: notes\nsecrets:\n  allow: ["("]\n');
  assert.match(t.dd('status').out, /secrets\.allow must be a list of valid regexes/);
});

test('a failed verify drive whose output holds a secret names where and never prints the value', () => {
  const t = setup(JUDGED.replace('journeys:', 'judge:\n  enabled: false\njourneys:'));
  const token = `API_${'TOKEN'}=${'f4ke0'.repeat(6)}`;
  writeFileSync(join(t.dir, 'leak.txt'), `starting\n${token}\n`);
  appendFileSync(join(t.repo, '.done-done.yaml'), '  failer:\n    command: cat ../leak.txt; exit 1\n');
  t.sh('add', '-A'); t.sh('commit', '-qm', 'failing journey');
  const r = t.dd('verify', 'failer', '--outcome', 'home and settings render');
  assert.match(toon(r).reason, /^drive: secrets: .*\/drive\.log:2: holds a secret \(key-value\)/);
  assert.equal(r.out.includes(token.slice(-12)), false, 'the secret value is never printed');
});

test('auto_fix.verify never re-runs a spends journey: one approval buys one spend, and the reason says so', () => {
  const t = setup(JUDGED.replace('journeys:', 'judge:\n  enabled: false\nauto_fix:\n  verify: 2\njourneys:'));
  appendFileSync(join(t.repo, '.done-done.yaml'), '  paid:\n    command: echo spent >> ../spent.txt && node shot.mjs\n    spends: one live generation\n');
  writeFileSync(join(t.repo, 'shot.mjs'), `import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';\nif (readFileSync('src/app.js', 'utf8').includes('BUG')) process.exit(1);\nmkdirSync(process.env.DONE_DONE_EVIDENCE_ROOT, { recursive: true });\ncopyFileSync(${JSON.stringify(join(t.dir, 'screen.png'))}, process.env.DONE_DONE_EVIDENCE_ROOT + '/home.png');\n`);
  writeFileSync(join(t.repo, 'src', 'app.js'), 'export const title = "BUG";\n');
  t.sh('add', '-A'); t.sh('commit', '-qm', 'a spending journey and a broken title');
  const e = pathEnv(t.env, []);
  writeFileSync(join(e.PATH, 'opencode'), `#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync('src/app.js', 'export const title = "Notes";\\n');
console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: JSON.stringify({ summary: 'fixed the title', blocker: '' }) } }));
`, { mode: 0o755 });
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\nagent_config:\n  opencode: { model: opencode-go/author }\n');
  const spent = join(t.dir, 'spent.txt');
  const spends = () => (existsSync(spent) ? readFileSync(spent, 'utf8').split('\n').filter(Boolean).length : 0);
  const parked = toon(t.dd('verify', 'paid', '--outcome', 'home and settings render'));
  assert.equal(parked.status, 'awaiting_approval', JSON.stringify(parked));
  const r = t.dd('respond', '--run', parked.run_id, '--action', 'approve', '--reason', 'Umer approved one generation');
  assert.equal(r.code, 1, r.out);
  assert.equal(spends(), 1, 'one approval buys one spend');
  assert.match(toon(r).reason, /auto_fix\.verify does not re-run a spends journey/);
});

test('a journey that spends parks before it runs until the user approves; respond approve runs it', () => {
  const t = setup();
  const spent = join(t.dir, 'spent.txt');
  appendFileSync(join(t.repo, '.done-done.yaml'), '  paid:\n    command: node make-shots.mjs ${RUN_ID} && echo spent >> ../spent.txt\n    spends: one live generation\n');
  t.sh('add', '-A'); t.sh('commit', '-qm', 'paid journey');
  const spends = () => (existsSync(spent) ? readFileSync(spent, 'utf8').split('\n').filter(Boolean).length : 0);
  const parked = toon(t.dd('verify', 'paid', '--outcome', 'home and settings render'));
  assert.deepEqual([parked.status, parked.step, spends()], ['awaiting_approval', 'drive', 0], 'nothing runs before approval');
  assert.match(parked.findings[0].what, /journey paid spends \(one live generation\)/);
  assert.ok(parked.help.includes(`done-done respond --run ${parked.run_id} --action approve --reason "<who approved the spend>"`), parked.help);
  assert.equal(t.dd('verify', 'paid', '--outcome', 'x').code, 2, 'a parked spend blocks a new run around it');
  const ok = t.dd('respond', '--run', parked.run_id, '--action', 'approve', '--reason', 'Umer approved one generation');
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual([toon(ok).result, toon(ok).spend.reason, spends()], ['pass', 'Umer approved one generation', 1]);
  const no = toon(t.dd('verify', 'paid', '--outcome', 'home and settings render'));
  assert.equal(no.status, 'awaiting_approval', 'every new run asks again');
  assert.equal(t.dd('respond', '--run', no.run_id, '--action', 'fix').code, 2, 'a spend gate takes approve or skip');
  const skip = t.dd('respond', '--run', no.run_id, '--action', 'skip', '--reason', 'Umer said no');
  assert.match(toon(skip).reason, /chose skip: the journey was not run, so nothing was spent/);
  assert.equal(spends(), 1);
  const plain = t.dd('run', 'paid');
  const withCommand = t.dd('run', 'paid', '--', 'sh', '-c', 'echo spent >> ../spent.txt');
  assert.deepEqual([plain.code, withCommand.code, spends()], [2, 2, 1], 'run refuses a spends journey, with or without a command');
  assert.match(plain.out, /done-done verify paid --outcome/, plain.out);
});

test('a spends journey with a matrix parks naming every cell its one approval covers', () => {
  const t = matrixed(MATRIXED.replace('    command: node make-cells.mjs\n', '    command: node make-cells.mjs\n    spends: one live generation\n'), 'true', () => '');
  const parked = toon(t.dd('verify', 'cells', '--outcome', 'every cell renders'));
  assert.equal(parked.status, 'awaiting_approval', 'a spending matrix journey parks');
  assert.match(parked.findings[0].what, /the approval covers every matrix cell, so it runs 4 times, once per cell/);
});

test('verify --foreground fails at a broken journey and skips the rest; usage errors name the next step', () => {
  const { dd } = slowRepo();
  assert.equal(toon(dd('status')).help[0], 'Start one: done-done verify <journey> --outcome "<what a user can now do>"');
  assert.equal(dd('verify', 'shots', '--outcome', 'x', '--claim-id', '').code, 2);
  const none = dd('verify', '--outcome', 'x');
  assert.equal(none.code, 2, none.out);
  assert.equal(toon(none).help[0], 'Run: done-done verify <shots|slow|broken> --outcome "<what a user can now do>"');
  assert.equal(dd('verify', 'shots', '--outcome', 'x', '--no-wait', '--foreground').code, 2);
  assert.equal(dd('verify', 'shots', '--outcome', 'x', '--wait', '90s').code, 2, 'a wait duration is no longer accepted');
  const r = dd('verify', 'broken', '--outcome', 'the app starts', '--foreground');
  assert.equal(r.code, 1, r.out);
  const s = toon(r);
  assert.equal(s.result, 'fail');
  assert.equal(s.reason, 'drive: the run command exited 3');
  assert.deepEqual(s.steps.map((x) => x.status), ['completed', 'failed', 'skipped', 'skipped', 'skipped', 'skipped', 'completed']);
  assert.equal(toon(dd('status')).run_id, s.run_id);
  assert.equal(dd('status', '--run', '../x').code, 2);
});

test('a failing check points at the exact command that produces the proof', () => {
  const { dd } = setup();
  const r = dd('check', '--outcome', 'nothing captured yet', '.proof/nope/session.log');
  assert.equal(r.code, 1, r.out);
  assert.match(toon(r).help[0], /done-done run shots/);
});

test('bare done-done orients with the config state and the next step, and names a valid receipt for HEAD', () => {
  const { dd, shots } = setup();
  const r = dd();
  assert.equal(r.code, 0, r.out);
  const b = toon(r);
  assert.equal(b.command, 'done-done');
  assert.equal(b.config, 'present');
  assert.deepEqual(b.journeys, ['shots']);
  assert.match(b.receipt, /^no receipt for /);
  assert.match(b.help[0], /done-done run shots/);
  const { files } = shots(); assert.equal(dd('verify', 'shots', '--outcome', 'home renders', '--foreground').code, 0); assert.equal(dd('receipt', '--outcome', 'home renders', ...files).code, 0); const after = toon(dd());
  assert.match(after.receipt, /^valid for HEAD [0-9a-f]{12}$/); assert.equal(after.help[0], 'HEAD has a valid receipt for "home renders"; prove the next commit with done-done verify --outcome "<what a user can now do>"');
  assert.equal(after.runs, toon(dd('history')).runs, 'bare counts the runs history lists');
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
function judgeSetup(answer, { loggedIn = true, projectYaml = JUDGED } = {}) {
  const t = setup(projectYaml);
  // The config's author agent (opencode) must be installed on any host, so the receipt names it.
  t.env.PATH = `${pathEnv(t.env, ['opencode']).PATH}:${t.env.PATH}`;
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
const img = images[0] && Buffer.from(images[0].source.data, 'base64');
appendFileSync(dir + '/calls.jsonl', JSON.stringify({ model: process.argv[process.argv.indexOf('--model') + 1], images: images.length, width: img?.readUInt32BE(16), prompt: content.at(-1).text }) + '\\n');
const state = JSON.parse(content.at(-1).text).state;
const p = 'before' in state && state.before === state.capture ? { correct: 0.04, wrong: 0.93, unclear: 0.03 } : stub.answer;
if (p === 'error') process.exit(process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'usage limit reached' })) && 0);
const pick = Object.keys(p).sort((a, b) => p[b] - p[a])[0];
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { relevance: { probabilities: p, pick, personReason: stub.reason } } }));
`,
    { mode: 0o755 },
  );
  const stub = (a, li = loggedIn) => writeFileSync(join(cfgDir, 'stub.json'), JSON.stringify({ loggedIn: li, answer: a, reason: 'The screen shows the notes list.' }));
  stub(answer);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), `agent: opencode\njudge:\n  route: claude-code\n  model: claude-test-1\n  claude_code: { config_dir: ${JSON.stringify(cfgDir)} }\nagent_path_override: { claude: ${JSON.stringify(bin)} }\n`);
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
  assert.deepEqual([d.judge.route, d.judge.model], ['claude-code', 'claude-test-1']);
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
  const cacheDir = join(j.env.DONE_DONE_HOME, 'runs', 'notes', 'judge');
  const cache = readFileSync(join(cacheDir, readdirSync(cacheDir)[0]), 'utf8');
  assert.doesNotMatch(cache, /token|key|secret/i, 'the cache in the run store holds verdicts only');
  const agents = join(j.env.DONE_DONE_HOME, 'agents');
  assert.deepEqual(existsSync(agents) ? readdirSync(agents).filter((n) => n.startsWith('judge-')) : [], [], 'the claude-code route starts no agent of ours, so it writes no call record');
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

test('judge.enabled turns the judge on; text evidence is judged too; a failed check is not judged', () => {
  const j = judgeSetup(CORRECT, { projectYaml: 'app: notes\nevidence:\n  root: .proof\njudge:\n  enabled: true\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n' });
  const r = j.dd('run', '--', `node make-shots.mjs \${RUN_ID} && node -e "require('fs').writeFileSync(process.env.DONE_DONE_EVIDENCE_ROOT + '/session.log','saved 3 notes')"`);
  assert.equal(r.code, 0, r.out);
  const mixed = `.proof/${toon(r).run_id}`;
  const ok = j.dd('check', '--outcome', 'three notes are saved', `${mixed}/home.png`, `${mixed}/session.log`);
  assert.equal(ok.code, 0, ok.out);
  const d = toon(ok);
  assert.deepEqual(d.judge.judged.map((x) => x.path), [`${mixed}/home.png`, `${mixed}/session.log`]);
  assert.equal(d.judge.not_judged, undefined);
  assert.match(d.judge.note, /text captures \(logs, JSON, CLI output\) are judged; video and other files are not/);
  const bad = j.dd('check', '--outcome', 'three notes are saved', `${mixed}/home.png`, '.proof/nope.png');
  assert.equal(bad.code, 1, bad.out);
  assert.match(toon(bad).judge.skipped, /already failed/);
  writeFileSync(join(j.repo, 'stray.png'), screen(11));
  const stray = j.dd('check', '--outcome', 'three notes are saved', 'stray.png');
  assert.equal(stray.code, 3, stray.out);
  assert.deepEqual(toon(stray).judge.judged, [], 'a capture with no run record is never sent');
  assert.equal(j.calls().length, 2);
});

test('the judge reads text and JSON captures as text: a wrong count fails with its reason, over-cap text is unsure, a re-run is a cache hit', () => {
  const j = judgeSetup(CORRECT);
  const r = j.dd('run', '--', `node -e "const fs = require('fs'), d = process.env.DONE_DONE_EVIDENCE_ROOT; fs.writeFileSync(d + '/count.json', JSON.stringify({ notes: 3 })); fs.writeFileSync(d + '/sync.log', 'synced 3 notes'); fs.writeFileSync(d + '/big.log', 'x'.repeat(70000))"`);
  assert.equal(r.code, 0, r.out);
  const ev = `.proof/${toon(r).run_id}`;
  const ok = j.dd('check', '--judge', '--outcome', 'three notes are saved', `${ev}/count.json`, `${ev}/sync.log`);
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(toon(ok).judge.judged.map((x) => [x.path, x.verdict, x.cached]), [[`${ev}/count.json`, 'pass', false], [`${ev}/sync.log`, 'pass', false]]);
  const calls = j.calls();
  assert.deepEqual(calls.map((c) => c.images), [0, 0], 'a text capture goes as text, not an image');
  assert.ok(calls[0].prompt.includes('notes\\":3') && calls[1].prompt.includes('synced 3 notes') && calls.every((c) => c.prompt.includes('three notes are saved')), calls[0].prompt);
  const again = j.dd('check', '--judge', '--outcome', 'three notes are saved', `${ev}/count.json`, `${ev}/sync.log`);
  assert.ok(toon(again).judge.judged.every((x) => x.cached && x.verdict === 'pass'), again.out);
  j.stub({ correct: 0.04, wrong: 0.93, unclear: 0.03 });
  const bad = j.dd('check', '--judge', '--outcome', 'five notes are saved', `${ev}/count.json`);
  assert.equal(bad.code, 1, bad.out);
  assert.match(toon(bad).findings[0].why, /count\.json: judge says wrong output: The screen shows the notes list\./);
  const big = j.dd('check', '--judge', '--outcome', 'three notes are saved', `${ev}/big.log`);
  assert.equal(big.code, 3, big.out);
  assert.match(toon(big).judge.judged[0].reason, /text is 70000 bytes, over the 65536 bytes the judge reads/);
  assert.equal(j.calls().length, 3, 'a cache hit and an over-cap capture ask no model');
});

test('judge.enabled: false: verify judges only with --judge, and a rerun repeats its source run; --no-judge turns it off', () => {
  const j = judgeSetup(CORRECT, { projectYaml: 'app: notes\nevidence:\n  root: .proof\njudge:\n  enabled: false\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n' });
  const judgeStep = (r) => toon(r).steps.find((x) => x.name === 'judge').status;
  const off = j.dd('verify', 'shots', '--outcome', 'home and settings render', '--foreground');
  assert.equal(off.code, 0, off.out);
  assert.equal(judgeStep(off), 'skipped');
  const on = j.dd('verify', 'shots', '--outcome', 'home and settings render', '--judge', '--foreground');
  assert.equal(on.code, 0, on.out);
  assert.equal(judgeStep(on), 'completed');
  const receipt = toon(j.dd('receipt', '--verify', j.head()));
  assert.deepEqual([receipt.schema, receipt.judge.route], [2, 'claude-code']);
  const again = j.dd('rerun', '--run', toon(on).run_id);
  assert.equal(again.code, 0, again.out);
  assert.equal(judgeStep(again), 'completed', 'the rerun judges as its source did, though judge.enabled is false');
  const plain = j.dd('rerun', '--run', toon(again).run_id, '--no-judge');
  assert.equal(plain.code, 0, plain.out);
  assert.equal(judgeStep(plain), 'skipped');
});

test('a failed verify suggests running again with the judge choice it was started with, under judge.enabled: false', () => {
  const t = setup('app: notes\nevidence:\n  root: .proof\njudge:\n  enabled: false\njourneys:\n  shots:\n    command: node -e "process.exit(3)"\n');
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  const verdict = JSON.stringify({ relevance: { probabilities: CORRECT, rationale: 'The list shows the notes.', personReason: 'The list shows the notes.' } });
  const s = stubAgents(t.env, verdict);
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const run = (...a) => {
    const r = spawnSync(process.execPath, [CLI, ...a], { cwd: t.repo, env: s.env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const withJudge = toon(run('verify', 'shots', '--outcome', 'home and settings render', '--judge', '--foreground'));
  assert.ok(withJudge.help.at(-1).startsWith('Or start a new run: done-done verify shots'), withJudge.help.at(-1));
  assert.ok(withJudge.help.at(-1).endsWith(' --judge'), withJudge.help.at(-1));
  const plain = toon(run('verify', 'shots', '--outcome', 'home and settings render', '--foreground'));
  assert.ok(!plain.help.at(-1).includes('--judge'), plain.help.at(-1));
});

test('a judge that judged no capture leaves a schema 1 receipt with no judge block', () => {
  const j = judgeSetup(CORRECT, { projectYaml: 'app: notes\nevidence:\n  root: .proof\njudge:\n  enabled: true\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n' });
  const r = j.dd('run', '--', `node -e "require('fs').writeFileSync(process.env.DONE_DONE_EVIDENCE_ROOT + '/session.bin','saved 3 notes')"`);
  assert.equal(r.code, 0, r.out);
  const log = `.proof/${toon(r).run_id}/session.bin`;
  const rec = j.dd('receipt', '--outcome', 'three notes are saved', log);
  assert.equal(rec.code, 0, rec.out);
  const verified = toon(j.dd('receipt', '--verify', j.head()));
  assert.deepEqual([verified.result, verified.schema, verified.judge], ['pass', 1, undefined]);
  assert.equal(j.calls().length, 0, 'a file the judge does not read is never sent to the model');
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
  // The receipt keeps the judge block (schema 2), and --verify shows it.
  const v = j.dd('receipt', '--verify', j.head());
  assert.equal(v.code, 0, v.out);
  const vd = toon(v);
  assert.deepEqual([vd.schema, vd.judge.route, vd.judge.model, vd.judge.independence, vd.judge.author], [2, 'claude-code', 'claude-test-1', 'agent', { agent: 'opencode', model: 'opencode-go/muse-spark-1.3-contributor' }]);
  assert.deepEqual(vd.judge.verdicts.map((x) => [x.path, x.verdict]), [[files[0], 'pass']]);
  const file = join(j.repo, toon(ok).receipt);
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...rec, judge: { ...rec.judge, verdicts: [{ ...rec.judge.verdicts[0], verdict: 'fail' }] } }));
  assert.match(toon(j.dd('receipt', '--verify', j.head())).reason, /malformed judge block/, 'a judge block that does not pass its captures is refused');
  writeFileSync(file, JSON.stringify({ ...rec, schema: 1, judge: undefined }));
  assert.equal(j.dd('receipt', '--verify', j.head()).code, 0, 'a schema 1 receipt still verifies');
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
  symlinkSync(join(root, 'node_modules', 'jpeg-js'), join(pkg, 'node_modules', 'jpeg-js'));
  symlinkSync(join(root, 'node_modules', '@toon-format', 'toon'), join(pkg, 'node_modules', '@toon-format', 'toon'));
  const args = ['check', '--judge', '--outcome', "Umer's notes list shows three notes", files[0]];
  const plain = spawnSync(process.execPath, [join(pkg, 'dist', 'cli.js'), ...args], { cwd: j.repo, env: j.env, encoding: 'utf8' });
  assert.equal(plain.status, 2, plain.stdout + plain.stderr);
  const e = toon({ out: plain.stdout });
  assert.match(e.error, /needs the optional @byokit\/decide@0\.8\.0 kit/);
  assert.equal(e.help[0], `Run this check with the kit: npx -y -p done-done-axi -p @byokit/decide@0.8.0 done-done-axi check --judge --outcome 'Umer'\\''s notes list shows three notes' ${files[0]}`);
  assert.equal(j.calls().length, 0);
  writeFileSync(join(j.env.DONE_DONE_HOME, 'config.yaml'), readFileSync(join(j.env.DONE_DONE_HOME, 'config.yaml'), 'utf8').replace('  model: claude-test-1\n', ''));
  assert.equal(j.dd(...args).code, 0);
  assert.equal(j.calls()[0].model, 'claude-haiku-5-5');
});

// The answerer route: the judge is another agent's CLI, asked tools-off through BYOKit's answerer backend.
test('verify judges by default with the judge the user set: opencode judges a claude author through the answerer; a right screen passes, a wrong one fails', () => {
  const t = setup(JUDGED);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  const verdict = (p) => JSON.stringify({ relevance: { probabilities: p, rationale: 'The list shows the notes.', personReason: 'The list shows the notes.' } });
  const agents = (p) => {
    const s = stubAgents(t.env, verdict(p));
    symlinkSync(process.execPath, join(s.bin, 'node'));
    return s;
  };
  const right = agents(CORRECT);
  const verify = (env, outcome, ...more) => {
    const r = spawnSync(process.execPath, [CLI, 'verify', 'shots', '--outcome', outcome, '--foreground', ...more], { cwd: t.repo, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const ok = verify(right.env, 'home and settings render');
  assert.equal(ok.code, 0, ok.out);
  const o = toon(ok);
  assert.deepEqual(o.steps.map((x) => [x.name, x.status]), [['resolve', 'completed'], ['drive', 'completed'], ['check', 'completed'], ['judge', 'completed'], ['gate', 'skipped'], ['receipt', 'completed'], ['report', 'completed']]);
  const calls = right.calls();
  assert.equal(calls.length, 2, 'one tools-off call per capture, none to the author');
  assert.ok(calls.every((c) => c.agent === 'opencode' && c.argv.includes('opencode-go/muse-spark-1.3-contributor') && JSON.parse(c.permission)['*'] === 'deny'));
  assert.ok(calls.every((c) => c.attached.length === 1 && c.attached[0] === 'PNG'), 'each call attaches its one capture');
  assert.ok(calls.every((c) => c.file.includes('home and settings render') && !c.file.includes('.proof') && !c.argv.some((a) => a.includes('home and settings render'))), 'the outcome goes in the prompt file, never argv or a path');
  const runDir = join(t.env.DONE_DONE_HOME, 'runs', 'notes', o.run_id);
  const judgeLog = decode(readFileSync(join(runDir, 'logs', 'judge.log'), 'utf8'));
  assert.deepEqual([judgeLog.route, judgeLog.independence, judgeLog.author], ['answerer:opencode', 'agent', 'claude (model claude-haiku-5-5)']);
  const records = readdirSync(join(runDir, 'agents')).sort();
  assert.equal(records.length, 2, 'one agent call record per capture, and no judge record');
  for (const n of records) {
    const text = readFileSync(join(runDir, 'agents', n), 'utf8');
    assert.doesNotMatch(text, /home and settings render|Answer the typed questions/, `${n} keeps no prompt text`);
  }
  const v = t.dd('receipt', '--verify', t.head());
  assert.equal(v.code, 0, v.out);
  assert.deepEqual([toon(v).schema, toon(v).judge.route, toon(v).judge.verdicts.map((x) => x.verdict)], [2, 'answerer:opencode', ['pass', 'pass']]);
  // A wrong screen parks the run at the gate (exit 4): the check passed, the judge failed it, no receipt yet.
  const wrong = agents({ correct: 0.04, wrong: 0.93, unclear: 0.03 });
  const bad = verify(wrong.env, 'the settings page shows dark mode on');
  assert.equal(bad.code, 4, bad.out);
  const b = toon(bad);
  assert.deepEqual([b.status, b.step, b.result], ['awaiting_approval', 'gate', undefined]);
  assert.deepEqual(b.steps.map((x) => x.status), ['completed', 'completed', 'completed', 'failed', 'awaiting_approval', 'pending', 'pending']);
  assert.deepEqual([b.findings.length, b.findings[0].id, b.findings[0].severity, b.findings[0].action], [2, 'gate-1', 'error', 'ask-user']);
  assert.match(b.findings[0].what, /judge says wrong screen/);
  assert.ok(b.help.some((h) => h.includes(`done-done respond --run ${b.run_id} --action approve --reason`)), bad.out);
  // An approve needs a reason; with one, the run ends overridden (exit 1, never pass) and the receipt says who and why.
  const noReason = t.dd('respond', '--run', b.run_id, '--action', 'approve');
  assert.equal(noReason.code, 2, noReason.out);
  assert.match(toon(noReason).error, /needs --reason/);
  const runJson = join(t.env.DONE_DONE_HOME, 'runs', 'notes', b.run_id, 'run.json'), saved = readFileSync(runJson, 'utf8');
  writeFileSync(runJson, '{');
  assert.equal(t.dd('respond', '--run', b.run_id, '--action', 'approve', '--reason', 'dark mode is on').code, 2);
  writeFileSync(runJson, saved);
  const ok2 = t.dd('respond', '--run', b.run_id, '--action', 'approve', '--reason', 'dark mode is on in the capture');
  assert.equal(ok2.code, 1, ok2.out);
  const a = toon(ok2);
  assert.deepEqual([a.status, a.result, a.response.action, a.response.reason], ['completed', 'overridden', 'approve', 'dark mode is on in the capture']);
  assert.ok(a.response.by, 'who answered is recorded');
  assert.deepEqual(a.steps.map((x) => x.status), ['completed', 'completed', 'completed', 'failed', 'completed', 'completed', 'completed']);
  const events = readFileSync(join(t.env.DONE_DONE_HOME, 'runs', 'notes', b.run_id, 'events.jsonl'), 'utf8');
  assert.match(events, /"step":"gate","response":"approve","by":"[^"]+","reason":"dark mode is on in the capture"/, 'the answer is logged');
  const ov = t.dd('receipt', '--verify', t.head());
  assert.equal(ov.code, 1, ov.out);
  assert.deepEqual([toon(ov).result, toon(ov).override.action, toon(ov).judge.verdicts.map((x) => x.verdict)], ['overridden', 'approve', ['fail', 'fail']]);
  assert.match(toon(ov).help[0], /not proven/);
  assert.equal(t.dd('respond', '--run', b.run_id, '--action', 'skip', '--reason', 'again').code, 2, 'a run is answered once');
  // A rerun of the judged run judges again (the cached wrong verdict), so it cannot pass with the judge left out.
  const re = spawnSync(process.execPath, [CLI, 'rerun', '--run', b.run_id], { cwd: t.repo, env: right.env, encoding: 'utf8' });
  assert.equal(re.status, 4, re.stdout + re.stderr);
  assert.deepEqual(toon({ out: re.stdout }).steps.map((x) => [x.name, x.status]).slice(3, 6), [['judge', 'failed'], ['gate', 'awaiting_approval'], ['receipt', 'pending']]);
  assert.equal(t.dd('respond', '--run', toon({ out: re.stdout }).run_id, '--action', 'fix').code, 1);
  // The author's own agent and model as the judge is a usage error before any run starts, unless allow_same accepts it.
  // Another claim, since run b still waits at its gate on this one.
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\njudge:\n  route: answerer:opencode\n');
  const same = verify(right.env, 'home and settings render', '--claim-id', 'settings');
  assert.equal(same.code, 2, same.out);
  assert.match(toon(same).error, /is the author's own agent and model/);
  assert.match(toon(same).help[0], /done-done init --judge <agent> --judge-model <model>/);
});

test('verify --judge on the answerer route: a malformed judge answer is one request per capture, never re-asked, and the verdict is unsure', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  const s = stubAgents(t.env, 'I think the screen is right, but I will not answer in JSON.');
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const r = spawnSync(process.execPath, [CLI, 'verify', 'shots', '--outcome', 'home and settings render', '--judge', '--foreground'], { cwd: t.repo, env: s.env, encoding: 'utf8' });
  const o = toon({ out: r.stdout });
  const calls = s.calls();
  assert.equal(calls.length, 2, 'one tools-off request per capture, no re-ask after a malformed answer');
  assert.ok(calls.every((c) => c.agent === 'opencode'));
  assert.equal(r.status, 4, r.stdout);
  assert.deepEqual([o.status, o.findings[0].severity], ['awaiting_approval', 'warning'], 'an unsure judge parks at the gate');
  assert.match(o.findings[0].what, /judge says unsure: the judge did not answer: the agent did not answer with valid JSON after 1 try/, r.stdout);
});

test('verify with no journey: the author agent drives the verify skill feature, the judge passes it; a wrong claim parks at the gate until respond', () => {
  const t = setup('app: notes\nevidence:\n  root: .proof\n');
  const skill = join(t.repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: verify-notes\n---\n# verify-notes\n\n## Launch\n\nnode src/app.js\n');
  writeFileSync(join(skill, 'features', 'README.md'), '- [Add a note](add-note.md)\n');
  writeFileSync(join(skill, 'features', 'add-note.md'), '# Add a note\n');
  t.sh('add', '-A');
  t.sh('commit', '-qm', 'verify skill');
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\n');
  const verdict = (p) => JSON.stringify({ relevance: { probabilities: p, rationale: 'The list shows the note.', personReason: 'The list shows the note.' } });
  // claude is the author: it saves a capture into the run's evidence folder and answers; DRIVE=edit also edits a tracked file.
  const agents = (p) => {
    const s = stubAgents(t.env, verdict(p));
    symlinkSync(process.execPath, join(s.bin, 'node'));
    writeFileSync(join(s.bin, 'claude'), `#!${process.execPath}
const { appendFileSync, copyFileSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
appendFileSync(${JSON.stringify(join(s.bin, 'calls.jsonl'))}, JSON.stringify({ agent: 'claude', argv: process.argv.slice(2), stdin: readFileSync(0, 'utf8'), cwd: process.cwd(), evidence: process.env.DONE_DONE_EVIDENCE_ROOT, tmp: process.env.TMPDIR }) + '\\n');
if (process.env.DRIVE === 'text') writeFileSync(process.env.DONE_DONE_EVIDENCE_ROOT + '/count.json', JSON.stringify({ notes: 1 }));
else copyFileSync(${JSON.stringify(join(t.dir, 'screen.png'))}, process.env.DONE_DONE_EVIDENCE_ROOT + '/note.png');
if (process.env.DRIVE === 'edit') appendFileSync('src/app.js', '// changed\\n');
if (process.env.DRIVE === 'log') writeFileSync(process.env.DONE_DONE_EVIDENCE_ROOT + '/session.bin', 'ok\\n');
if (process.env.DRIVE === 'switch') writeFileSync(process.env.DONE_DONE_HOME + '/config.yaml', 'agent: opencode\\njudge:\\n  route: answerer:opencode\\n');
if (process.env.DRIVE === 'probe') {
  const probes = [['respond', '--action', 'approve', '--reason', 'looks fine'], ['receipt', '--verify', 'HEAD'], ['verify', '--outcome', 'x']].map((argv) => {
    const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...argv], { encoding: 'utf8' });
    return { command: argv[0], status: r.status, out: r.stdout + r.stderr };
  });
  appendFileSync(${JSON.stringify(join(s.bin, 'calls.jsonl'))}, JSON.stringify({ probe: probes }) + '\\n');
}
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: { feature: 'features/add-note.md', captures: process.env.DRIVE === 'log' ? ['note.png', 'session.bin'] : process.env.DRIVE === 'text' ? ['count.json'] : ['note.png'], blocker: process.env.DRIVE === 'blocker' ? process.env.BLOCKER : '' } }));
`, { mode: 0o755 });
    return s;
  };
  const verify = (env, outcome, ...more) => {
    const r = spawnSync(process.execPath, [CLI, 'verify', '--outcome', outcome, '--foreground', ...more], { cwd: t.repo, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr, o: r.stdout.startsWith('command') ? toon({ out: r.stdout }) : undefined };
  };
  const right = agents(CORRECT);
  // With no agent set and no terminal to ask in, a drive stops and tells the caller to ask the user; it never picks one.
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), '');
  const unset = verify(right.env, 'the note Umer added shows in the list');
  assert.equal(unset.code, 2, unset.out);
  assert.match(unset.out, /no agent is set: ask the user which agent to use/);
  assert.equal(right.calls().length, 0, 'no agent was started');
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  const ok = verify(right.env, 'the note Umer added shows in the list');
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual([ok.o.result, ok.o.journey, ok.o.feature, ok.o.author], ['pass', null, 'add-note', 'claude (model claude-haiku-5-5)']);
  assert.deepEqual(ok.o.steps.map((x) => [x.name, x.status]), [['resolve', 'completed'], ['drive', 'completed'], ['check', 'completed'], ['judge', 'completed'], ['gate', 'skipped'], ['receipt', 'completed'], ['report', 'completed']]);
  const [drive, ...judged] = right.calls();
  assert.equal(drive.agent, 'claude');
  assert.equal(drive.cwd, t.repo, 'the drive runs in the repo');
  assert.equal(drive.evidence, join(t.repo, '.proof', ok.o.run_id), "the drive gets the run's own evidence folder");
  const runDir = join(t.env.DONE_DONE_HOME, 'runs', 'notes', ok.o.run_id);
  assert.equal(drive.tmp, join(runDir, 'tmp'), "the drive's scratch is the run's own tmp folder");
  assert.deepEqual(drive.argv.slice(drive.argv.indexOf('--permission-mode')), ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', '--add-dir', drive.evidence, '--add-dir', drive.tmp, '--effort', 'low'], 'edits only in the repo, the evidence folder and the run scratch, at the configured effort');
  assert.match(drive.stdin, /Never add steps or data to make the outcome look true/, 'the drive is told not to stage the claim');
  assert.match(drive.stdin, /a capture of an earlier step \(such as an empty or half-filled form, or text from before the outcome\) fails the drive: keep those in /, 'the drive saves only captures of the outcome, since the judge checks each against it');
  assert.match(drive.stdin, /for example \{"feature":"features\/<name>\.md","captures":\["<name>\.png"\],"blocker":""\}[\s\S]*"required":\["feature","captures","blocker"\]\}\nThat object holds your own values, never the schema itself/, 'the prompt shows an answer and ends on words, not the schema a weak model copies back');
  assert.match(drive.stdin, /Outcome to prove: the note Umer added shows in the list[\s\S]*verify-notes\/features\/add-note\.md/, 'the claim and the feature recipe go on stdin');
  assert.ok(!drive.argv.some((a) => a.includes('Umer added')), 'never in argv');
  assert.deepEqual([judged.length, judged[0].agent], [1, 'opencode'], 'one capture, judged by another agent');
  assert.ok(!judged[0].file.includes('verify-notes'), 'the judge sees the claim and the capture, not the recipe or the drive');
  assert.equal(JSON.parse(readFileSync(join(runDir, 'agents', 'drive.json'), 'utf8')).ok, true, 'the drive call leaves a record');
  assert.equal(t.dd('receipt', '--verify', t.head()).code, 0);
  // A wrong claim parks at the gate; skip needs a reason and ends the run overridden, never pass.
  const wrong = agents({ correct: 0.04, wrong: 0.93, unclear: 0.03 });
  const bad = verify(wrong.env, 'the note list is sorted by date');
  assert.equal(bad.code, 4, bad.out);
  assert.deepEqual([bad.o.status, bad.o.step, bad.o.findings.length], ['awaiting_approval', 'gate', 1]);
  assert.equal(t.dd('respond', '--action', 'skip').code, 2, 'skip needs a reason');
  const skip = t.dd('respond', '--action', 'skip', '--reason', 'the sort is checked by hand');
  assert.equal(skip.code, 1, skip.out);
  assert.deepEqual([toon(skip).run_id, toon(skip).result, toon(skip).response.action], [bad.o.run_id, 'overridden', 'skip'], 'respond answers the newest run by default');
  const ov = t.dd('receipt', '--verify', t.head());
  assert.deepEqual([ov.code, toon(ov).result, toon(ov).override.reason], [1, 'overridden', 'the sort is checked by hand']);
  // fix ends a parked run as fail; abort cancels one; neither can be answered again.
  const fixRun = verify(wrong.env, 'the note list is sorted by date');
  const fix = t.dd('respond', '--run', fixRun.o.run_id, '--action', 'fix');
  assert.equal(fix.code, 1, fix.out);
  assert.deepEqual([toon(fix).result, toon(fix).steps.find((x) => x.name === 'gate').status], ['fail', 'failed']);
  const abortRun = verify(wrong.env, 'the note list is sorted by date');
  assert.equal(t.dd('abort', '--run', abortRun.o.run_id).code, 0);
  assert.equal(toon(t.dd('status', '--run', abortRun.o.run_id)).status, 'cancelled');
  assert.equal(t.dd('respond', '--run', abortRun.o.run_id, '--action', 'fix').code, 2);
  // With DONE_DONE_DRIVE set, the commands that answer a gate, write a receipt or start a run exit 2 (an accidental call, not a sandbox).
  const probe = verify({ ...right.env, DRIVE: 'probe' }, 'the note Umer added shows in the list');
  assert.equal(probe.code, 0, probe.out);
  const probed = right.calls().find((c) => c.probe).probe;
  assert.deepEqual(probed.map((p) => [p.command, p.status]), [['respond', 2], ['receipt', 2], ['verify', 2]]);
  assert.match(probed[0].out, /respond refuses to run inside an agent drive \(DONE_DONE_DRIVE is set\), so the agent does not answer its own gate, write a receipt or start a run by accident; this guards against accidents and is not a sandbox/);
  // The judge is apart from the author the run recorded, even when the config names another agent during the drive.
  const seen = right.calls().length;
  const switched = verify({ ...right.env, DRIVE: 'switch' }, 'the note Umer added shows in the list after a switch');
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  assert.equal(switched.code, 0, switched.out);
  assert.deepEqual(right.calls().slice(seen + 1).map((c) => c.agent), ['opencode'], 'the judge is not the drive agent claude');
  // A drive whose only capture is text (a CLI's JSON output) passes on the judge's pass, the text sent with no attachment.
  const texted = verify({ ...right.env, DRIVE: 'text' }, 'the notes CLI reports the one note Umer added');
  assert.equal(texted.code, 0, texted.out);
  assert.deepEqual([right.calls().at(-1).agent, right.calls().at(-1).attached], ['opencode', []]);
  // A capture the judge cannot read is not covered by the judge's pass on the others: the run parks at the gate.
  const logged = verify({ ...right.env, DRIVE: 'log' }, 'the note Umer added shows in the list');
  assert.equal(logged.code, 4, logged.out);
  assert.deepEqual([logged.o.status, logged.o.step, logged.o.findings.length], ['awaiting_approval', 'gate', 1]);
  assert.match(logged.o.findings[0].what, /session\.bin: the judge did not read this capture/);
  // While that run waits at its gate, a new verify or a rerun of the same claim is refused: it would go around the gate.
  const calls = right.calls().length;
  for (const again of [verify(right.env, 'the note Umer added shows in the list'), spawnSync(process.execPath, [CLI, 'rerun', '--run', logged.o.run_id], { cwd: t.repo, env: right.env, encoding: 'utf8' })]) {
    const out = again.out ?? again.stdout;
    assert.equal(again.code ?? again.status, 2, out);
    assert.match(out, new RegExp(`run ${logged.o.run_id} waiting at its gate`));
    assert.match(out, new RegExp(`done-done respond --run ${logged.o.run_id} --action approve\\|skip\\|fix .*done-done abort --run ${logged.o.run_id}`));
  }
  // A rerun keeps the claim of its source run, so switching branches does not get around the gate.
  t.sh('checkout', '-qb', 'other');
  const switchedRerun = spawnSync(process.execPath, [CLI, 'rerun', '--run', logged.o.run_id], { cwd: t.repo, env: right.env, encoding: 'utf8' });
  assert.equal(switchedRerun.status, 2, switchedRerun.stdout);
  assert.match(switchedRerun.stdout, new RegExp(`run ${logged.o.run_id} waiting at its gate`));
  t.sh('checkout', '-q', 'main');
  assert.equal(right.calls().length, calls, 'no agent was started');
  // A run recorded before branches were stored (no branch, no claim id) still blocks a new run in its repo.
  const parkedFile = join(t.env.DONE_DONE_HOME, 'runs', 'notes', logged.o.run_id, 'run.json');
  writeFileSync(parkedFile, JSON.stringify({ ...JSON.parse(readFileSync(parkedFile, 'utf8')), branch: undefined }));
  const legacy = verify(right.env, 'the note Umer added shows in the list');
  assert.equal(legacy.code, 2, legacy.out);
  assert.match(legacy.out, new RegExp(`run ${logged.o.run_id} waiting at its gate`));
  assert.equal(right.calls().length, calls, 'no agent was started');
  assert.equal(t.dd('respond', '--run', logged.o.run_id, '--action', 'fix').code, 1);
  // With the judge off, an agent drive parks at the gate saying so, and its judge step shows skipped, not pending.
  const off = verify(right.env, 'the note Umer added shows in the list', '--no-judge');
  assert.equal(off.code, 4, off.out);
  assert.equal(off.o.findings[0].what, 'the judge is off (--no-judge), and an agent drive passes only with a judge pass');
  assert.equal(off.o.steps.find((x) => x.name === 'judge').status, 'skipped');
  assert.equal(t.dd('respond', '--run', off.o.run_id, '--action', 'fix').code, 1);
  // A run record that cannot be parsed stops the command with the file to fix, never a stack trace.
  const brokenRun = join(t.env.DONE_DONE_HOME, 'runs', 'notes', 'broken-run');
  mkdirSync(brokenRun);
  writeFileSync(join(brokenRun, 'run.json'), '{');
  const unreadable = t.dd('history');
  assert.equal(unreadable.code, 2, unreadable.out);
  assert.match(toon(unreadable).error, /cannot read the run record .*broken-run\/run\.json/);
  assert.match(toon(unreadable).help[0], /Fix or remove .*broken-run/);
  rmSync(brokenRun, { recursive: true });
  // A drive that changes a tracked file fails: its captures would not be of the committed code.
  const edit = verify({ ...right.env, DRIVE: 'edit' }, 'the note Umer added shows in the list');
  assert.equal(edit.code, 1, edit.out);
  assert.match(edit.o.reason, /^drive: claude changed tracked files in the repo during the drive/);
  t.sh('checkout', '--', 'src/app.js');
  // A tracked file already modified before the drive is checked by content: a further edit to it fails the drive too.
  writeFileSync(join(t.repo, '.done-done.yaml'), 'app: notes\nevidence:\n  root: .proof\n  allow_dirty: true\n');
  appendFileSync(join(t.repo, 'src/app.js'), '// wip\n');
  const wip = verify({ ...right.env, DRIVE: 'edit' }, 'the note Umer added shows in the list');
  assert.equal(wip.code, 1, wip.out);
  assert.match(wip.o.reason, /^drive: claude changed tracked files in the repo during the drive/);
  t.sh('checkout', '--', 'src/app.js', '.done-done.yaml');
  const secret = 'API_' + 'TOKEN=' + 'f4ke0'.repeat(6);
  const blocked = verify({ ...right.env, DRIVE: 'blocker', BLOCKER: `login rejected ${secret}` }, 'the note Umer added shows in the list');
  assert.match(blocked.o.reason, /^drive: secrets: .*holds a secret \(key-value\)/);
  const status = spawnSync(process.execPath, [CLI, 'status', '--run', blocked.o.run_id], { cwd: t.repo, env: right.env, encoding: 'utf8' });
  assert.equal([blocked.out, status.stdout + status.stderr].some((o) => o.includes(secret)), false, 'the blocker secret is never printed');
  // Usage errors before any run: an unknown feature, a journey with --feature, no verify skill.
  assert.match(toon(verify(right.env, 'x', '--feature', 'nope')).error, /no feature nope in \.agents\/skills\/verify-notes\/features; it has: add-note/);
  rmSync(skill, { recursive: true });
  const none = verify(right.env, 'x');
  assert.equal(none.code, 2, none.out);
  assert.match(toon(none).error, /needs a journey or a verify skill/);
});

test('a rerun refused by the judge preflight exits 2 and creates no run folder', () => {
  const t = setup(JUDGED);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  const s = stubAgents(t.env, JSON.stringify({ relevance: { probabilities: CORRECT, rationale: 'The list shows the notes.', personReason: 'The list shows the notes.' } }));
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const first = spawnSync(process.execPath, [CLI, 'verify', 'shots', '--outcome', 'home and settings render', '--judge', '--foreground'], { cwd: t.repo, env: s.env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const runs = join(t.env.DONE_DONE_HOME, 'runs', 'notes');
  const before = readdirSync(runs).sort();
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\njudge:\n  route: answerer:opencode\n');
  const re = spawnSync(process.execPath, [CLI, 'rerun', '--run', toon({ out: first.stdout }).run_id], { cwd: t.repo, env: s.env, encoding: 'utf8' });
  assert.equal(re.status, 2, re.stdout + re.stderr);
  assert.match(toon({ out: re.stdout }).error, /is the author's own agent and model/);
  assert.deepEqual(readdirSync(runs).sort(), before, 'the refused rerun leaves no new run folder');
});

test('verify --judge through pi and gemini: each judges tools-off with the capture attached; a right screen passes, a wrong one fails', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  const verdict = (p) => JSON.stringify({ relevance: { probabilities: p, rationale: 'The list shows the notes.', personReason: 'The list shows the notes.' } });
  const agents = (p) => {
    const s = stubPiGemini(t.env, verdict(p));
    symlinkSync(process.execPath, join(s.env.PATH, 'node'));
    return s;
  };
  const verify = (env, outcome) => {
    const r = spawnSync(process.execPath, [CLI, 'verify', 'shots', '--outcome', outcome, '--judge', '--foreground'], { cwd: t.repo, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  // The user names the judge: a pi author is judged by gemini at its cheap model; a gemini author by pi, each at its configured model.
  for (const [author, judge, model] of [['pi', 'gemini', 'flash-lite'], ['gemini', 'pi', 'vendor/vision-model']]) {
    writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), `agent: ${author}\nagent_config:\n  pi: { model: vendor/vision-model }\njudge:\n  route: answerer:${judge}\n`);
    const right = agents(CORRECT);
    const ok = verify(right.env, `home and settings render for ${judge}`);
    assert.equal(ok.code, 0, ok.out);
    const o = toon(ok);
    const calls = right.calls();
    assert.equal(calls.length, 2, 'one tools-off call per capture, none to the author');
    for (const c of calls) {
      assert.equal(c.agent, judge);
      assert.deepEqual(c.attached, ['PNG'], 'each call attaches its one capture');
      assert.match(c.stdin, new RegExp(`home and settings render for ${judge}`));
      assert.ok(!c.argv.some((a) => a.includes('home and settings render') || a.includes('.proof')), 'the outcome goes on stdin, never argv or a path');
      assert.notEqual(c.cwd, t.repo, 'the judge runs in a scratch folder, never the repo');
      if (judge === 'pi') assert.deepEqual(c.argv, ['-p', '--mode', 'json', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--model', model, `@${join(c.cwd, 'capture.png')}`]);
      else {
        assert.deepEqual(c.argv, ['-p', 'Follow the instructions on stdin. @capture.png', '-o', 'json', '-m', model, '--approval-mode', 'plan', '--policy', join(c.cwd, 'deny-all.toml'), '--skip-trust']);
        assert.match(c.policy, /toolName = "\*"\ndecision = "deny"/, 'every tool is denied');
      }
    }
    const runDir = join(t.env.DONE_DONE_HOME, 'runs', 'notes', o.run_id);
    const judgeLog = decode(readFileSync(join(runDir, 'logs', 'judge.log'), 'utf8'));
    assert.deepEqual([judgeLog.route, judgeLog.model, judgeLog.independence], [`answerer:${judge}`, model, 'agent']);
    for (const n of readdirSync(join(runDir, 'agents'))) {
      const rec = JSON.parse(readFileSync(join(runDir, 'agents', n), 'utf8'));
      assert.deepEqual([rec.agent, rec.tools, rec.images], [judge, 'none', ['capture.png']], 'the record names the capture and keeps no image bytes');
    }
    // A wrong screen parks the run at the gate (exit 4), not a fail.
    const bad = verify(agents({ correct: 0.04, wrong: 0.93, unclear: 0.03 }).env, `the settings page shows dark mode on for ${judge}`);
    assert.equal(bad.code, 4, bad.out);
    assert.equal(toon(bad).status, 'awaiting_approval');
    assert.match(toon(bad).findings[0].what, /judge says wrong screen/);
    assert.equal(t.dd('respond', '--run', toon(bad).run_id, '--action', 'fix').code, 1);
  }
});

test('a key-only user judges through openai:key: the key goes only to the kit, a right screen passes, a wrong one fails', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: openai:key\n  model: vision-test-1\n');
  // No agent CLI on PATH; the network is stubbed at fetch, the kit's only way out, and answers with STUB_VERDICT.
  const env = pathEnv(t.env, ['ffprobe']);
  symlinkSync(process.execPath, join(env.PATH, 'node'));
  const log = join(env.PATH, 'requests.jsonl');
  const stub = join(env.PATH, 'fetch-stub.mjs');
  writeFileSync(stub, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url), auth: init.headers.authorization, model: body.model, input: JSON.stringify(body.input) }) + '\\n');
  if (process.env.STUB_VERDICT === '401') return new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 });
  const probabilities = JSON.parse(process.env.STUB_VERDICT);
  const pick = Object.keys(probabilities).sort((a, b) => probabilities[b] - probabilities[a])[0];
  const text = JSON.stringify({ relevance: { probabilities, pick, rationale: 'The list shows the notes.', personReason: 'The list shows the notes.' } });
  return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
`);
  const key = 'sk-test-not-a-real-key';
  const withKey = (p) => ({ ...env, OPENAI_API_KEY: key, NODE_OPTIONS: `--import=${pathToFileURL(stub)}`, STUB_VERDICT: typeof p === 'string' ? p : JSON.stringify(p) });
  const verify = (e, outcome) => {
    const r = spawnSync(process.execPath, [CLI, 'verify', 'shots', '--outcome', outcome, '--judge', '--foreground'], { cwd: t.repo, env: e, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ok = verify(withKey(CORRECT), 'home and settings render');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(requests().length, 2, 'one request per capture');
  assert.ok(requests().every((r) => r.url === 'https://api.openai.com/v1/responses' && r.auth === `Bearer ${key}` && r.model === 'vision-test-1'));
  assert.ok(requests().every((r) => r.input.includes('data:image/png;base64,') && r.input.includes('home and settings render') && !r.input.includes('.proof')), 'the capture and the outcome, never a path');
  const runDir = join(t.env.DONE_DONE_HOME, 'runs', 'notes', toon(ok).run_id);
  const judgeLog = decode(readFileSync(join(runDir, 'logs', 'judge.log'), 'utf8'));
  assert.deepEqual([judgeLog.route, judgeLog.model, judgeLog.independence, judgeLog.author], ['openai:key', 'vision-test-1', 'agent', 'claude (model claude-haiku-5-5)']);
  const v = t.dd('receipt', '--verify', t.head());
  assert.deepEqual([toon(v).schema, toon(v).judge.route, toon(v).judge.verdicts.map((x) => x.verdict)], [2, 'openai:key', ['pass', 'pass']]);
  // A wrong screen parks the run at the gate (exit 4), not a fail.
  const bad = verify(withKey({ correct: 0.04, wrong: 0.93, unclear: 0.03 }), 'the settings page shows dark mode on');
  assert.equal(bad.code, 4, bad.out);
  assert.equal(toon(bad).status, 'awaiting_approval');
  assert.match(toon(bad).findings[0].what, /judge says wrong screen/);
  assert.equal(t.dd('respond', '--run', toon(bad).run_id, '--action', 'fix').code, 1);
  // A refused key is unsure, and the reason names the real cause and where the key comes from.
  const refused = verify(withKey('401'), 'the home screen shows the sync banner');
  assert.equal(refused.code, 4, refused.out);
  assert.match(toon(refused).findings[0].what, /the judge did not answer: http 401 \(check judge\.model vision-test-1 and the key in OPENAI_API_KEY\)/);
  assert.equal(spawnSync('grep', ['-rl', key, t.env.DONE_DONE_HOME, t.repo], { encoding: 'utf8' }).stdout, '', 'the key is written nowhere');
  // Doctor names a missing key and a missing model with their fixes, and never calls the model.
  const doctorEnv = { ...env, OPENAI_API_KEY: '' };
  const judgeRow = toon(doctorIn(t.repo, doctorEnv, 'doctor')).checks.find((c) => c.check === 'judge');
  assert.deepEqual([judgeRow.status, judgeRow.detail, judgeRow.fix], ['missing', 'judge: openai:key needs your own API key in OPENAI_API_KEY, which is not set', 'Export OPENAI_API_KEY with your key, then re-run this command']);
  assert.match(toon(doctorIn(t.repo, { ...env, OPENAI_API_KEY: key }, 'doctor')).checks.find((c) => c.check === 'judge').detail, /^openai:key \(model vision-test-1\): OPENAI_API_KEY is set and the judge kit is present; doctor does not call the model$/);
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: openai:key\n');
  const noModel = toon(doctorIn(t.repo, doctorEnv, 'doctor')).checks.find((c) => c.check === 'judge_choice');
  assert.deepEqual([noModel.status, noModel.detail], ['missing', 'judge: judge.route openai:key needs judge.model, a model your key can use that reads images']);
  writeFileSync(join(env.PATH, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: codex\nagent_config:\n  codex:\n    model: vision-test-1\njudge:\n  route: openai:key\n  model: vision-test-1\n');
  const sameModel = toon(doctorIn(t.repo, { ...env, OPENAI_API_KEY: key }, 'doctor')).checks.find((c) => c.check === 'judge_choice');
  assert.deepEqual([sameModel.status, sameModel.detail, sameModel.fix], ['missing', "judge: the judge openai:key (model vision-test-1) is the author's own agent and model (codex), and the judge is never the agent that did the work", 'Ask the user for another judge agent or model and save it: done-done init --judge <agent> --judge-model <model>; or set judge.allow_same: true in ~/.done-done/config.yaml to accept a fresh session of the same one']);
});

// done-done never picks the judge: no auto pick, no PATH detection, no fallback. With none set, verify asks the user.
test('with no judge set, verify stops with the ask (exit 2, the choices, the save command) and starts no run and no agent', () => {
  const t = setup(JUDGED);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\n');
  const verdict = JSON.stringify({ relevance: { probabilities: CORRECT, rationale: 'The list shows the notes.', personReason: 'The list shows the notes.' } });
  const s = stubAgents(t.env, verdict);
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const run = (...a) => {
    const r = spawnSync(process.execPath, [CLI, ...a], { cwd: t.repo, env: s.env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const v = run('verify', 'shots', '--outcome', 'home and settings render', '--foreground');
  assert.equal(v.code, 2, v.out);
  assert.equal(toon(v).error, 'no judge is set: ask the user which judge to use (claude, opencode, pi, gemini); never pick one for them, and never the agent that did the work');
  assert.equal(toon(v).help[0], "Save the user's answer: done-done init --judge <agent> --judge-model <model>, e.g. done-done init --judge opencode --judge-model opencode-go/muse-spark-1.3-contributor");
  assert.ok(!existsSync(join(t.env.DONE_DONE_HOME, 'runs', 'notes')), 'no run starts');
  assert.equal(s.calls().length, 0, 'no agent is started or picked, though claude and opencode are both on PATH');
  const d = toon(doctorIn(t.repo, s.env, 'doctor'));
  for (const row of ['judge', 'judge_choice']) {
    const c = d.checks.find((x) => x.check === row);
    assert.deepEqual([c.status, c.detail, c.fix], ['missing', toon(v).error, toon(v).help[0]], `doctor's ${row} row is the same ask`);
  }
  // check and receipt start no model, so they need no judge.
  const { files } = t.shots();
  assert.equal(run('check', '--outcome', 'home and settings render', ...files).code, 0);
  // The user turns the judge off by choice: --no-judge, or judge.enabled: false.
  const off = run('verify', 'shots', '--outcome', 'home and settings render', '--foreground', '--no-judge');
  assert.equal(off.code, 0, off.out);
  assert.equal(toon(off).steps.find((x) => x.name === 'judge').status, 'skipped');
  assert.equal(s.calls().length, 0);
  assert.match(run('verify', 'shots', '--outcome', 'x', '--judge', '--no-judge').out, /pass only one of --judge and --no-judge/);
  // The save command sets it; the next verify judges with exactly that judge.
  const saved = run('init', '--judge', 'claude', '--judge-model', 'claude-haiku-5-5');
  assert.equal(toon(saved).judge, `claude-code (model claude-haiku-5-5) saved to ${join(t.env.DONE_DONE_HOME, 'config.yaml')}`);
  const g = parse(readFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'utf8'));
  assert.deepEqual([g.agent, g.judge.route, g.judge.model], ['opencode', 'claude-code', 'claude-haiku-5-5']);
});

// An old config's judge.route auto stops every command that loads it, and names the file and the two steps that fix it.
test('a judge.route auto from an old config exits 2 naming the file; deleting that line then init --judge saves the judge', () => {
  const t = setup(JUDGED);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  const file = join(t.env.DONE_DONE_HOME, 'config.yaml');
  writeFileSync(file, 'agent: opencode\njudge:\n  route: auto\n');
  const auto = t.dd('verify', 'shots', '--outcome', 'home and settings render');
  assert.equal(auto.code, 2, auto.out);
  assert.match(toon(auto).error, /judge\.route auto is gone: done-done never picks the judge, the user sets it$/);
  assert.equal(toon(auto).help[0], `Delete the judge.route line in ${file}, then run: done-done init --judge <agent> --judge-model <model>`);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^ {2}route: auto\n/m, ''));
  const saved = t.dd('init', '--judge', 'claude', '--judge-model', 'claude-haiku-5-5');
  assert.equal(saved.code, 0, saved.out);
  assert.equal(toon(saved).judge, `claude-code (model claude-haiku-5-5) saved to ${file}`);
  assert.deepEqual(parse(readFileSync(file, 'utf8')).judge, { route: 'claude-code', model: 'claude-haiku-5-5' });
});

test('init --judge saves the user\'s judge, refuses one done-done cannot judge through and the author\'s own agent and model', () => {
  const t = setup(JUDGED);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\n');
  const bad = t.dd('init', '--judge', 'acp:gemini');
  assert.equal(bad.code, 2, bad.out);
  assert.match(toon(bad).error, /^done-done cannot judge through acp:gemini; it judges through claude, opencode, pi, gemini$/);
  const same = t.dd('init', '--judge', 'opencode', '--judge-model', 'opencode-go/muse-spark-1.3-contributor');
  assert.equal(same.code, 2, same.out);
  assert.match(toon(same).error, /^judge: the judge opencode \(model opencode-go\/muse-spark-1\.3-contributor\) is the author's own agent and model \(opencode\)/);
  assert.equal(parse(readFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'utf8')).judge, undefined, 'a refused judge writes nothing');
  assert.equal(toon(t.dd('init', '--judge-model', 'x')).error, '--judge-model needs --judge');
  // The author's agent at another model is allowed, and saved as answerer:opencode.
  const other = t.dd('init', '--judge', 'opencode', '--judge-model', 'opencode-go/other-model');
  assert.equal(toon(other).judge, `answerer:opencode (model opencode-go/other-model) saved to ${join(t.env.DONE_DONE_HOME, 'config.yaml')}`);
  assert.equal(toon(t.dd('init')).judge, 'unchanged (answerer:opencode)');
});

test('re-saving a judge without --judge-model keeps its model on the same route and drops it on another', () => {
  const t = setup(JUDGED);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  const file = join(t.env.DONE_DONE_HOME, 'config.yaml');
  writeFileSync(file, 'agent: claude\njudge:\n  route: answerer:opencode\n  model: opencode-go/other-model\n');
  assert.equal(t.dd('init', '--judge', 'opencode').code, 0);
  assert.equal(parse(readFileSync(file, 'utf8')).judge.model, 'opencode-go/other-model');
  assert.equal(t.dd('init', '--judge', 'gemini').code, 0);
  assert.equal(parse(readFileSync(file, 'utf8')).judge.model, undefined);
});

test('a judge is never the author, even an acp author that cannot start: a claude judge for acp:claude-code is refused and nothing is saved', () => {
  const t = setup(JUDGED);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  const file = join(t.env.DONE_DONE_HOME, 'config.yaml');
  writeFileSync(file, `agent: acp:claude-code\nacpx_path: ${JSON.stringify(join(t.dir, 'no-acpx'))}\n`);
  const before = readFileSync(file, 'utf8');
  const r = t.dd('init', '--judge', 'claude', '--judge-model', 'claude-haiku-5-5');
  assert.equal(r.code, 2, r.out);
  assert.match(toon(r).error, /^judge: the judge claude \(model claude-haiku-5-5\) is the author's own agent and model \(acp:claude-code\)/);
  assert.equal(readFileSync(file, 'utf8'), before, 'a refused judge writes nothing');
});

test('init --judge pi without a model exits 2 with the save command and writes nothing', () => {
  const t = setup(JUDGED);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  const file = join(t.env.DONE_DONE_HOME, 'config.yaml');
  writeFileSync(file, 'agent: opencode\n');
  const before = readFileSync(file, 'utf8');
  const r = t.dd('init', '--judge', 'pi');
  assert.equal(r.code, 2, r.out);
  assert.equal(toon(r).help[0], 'Save the judge with its model: done-done init --judge pi --judge-model <model>');
  assert.equal(readFileSync(file, 'utf8'), before, 'a judge with no model writes nothing');
});

// In a terminal (a pty from script(1)), verify asks for the judge from a list and saves the answer before it starts.
test('with no judge set, verify in a terminal asks from a list, saves the pick and judges with it', { skip: !existsSync('/usr/bin/script') && 'no script(1)' }, () => {
  const t = setup(JUDGED);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\n');
  const verdict = JSON.stringify({ relevance: { probabilities: CORRECT, rationale: 'The list shows the notes.', personReason: 'The list shows the notes.' } });
  const s = stubAgents(t.env, verdict);
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const cmd = [process.execPath, CLI, 'verify', 'shots', '--outcome', "'home and settings render'", '--foreground'].join(' ');
  // The answers come one at a time, as a person types them.
  const r = spawnSync('/bin/sh', ['-c', `(sleep 2; echo 2; sleep 1; echo 1; sleep 1) | /usr/bin/script -qec "${cmd}" /dev/null`], { cwd: t.repo, env: { ...s.env, PATH: `${s.env.PATH}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /none is set\. Judges:\r?\n {2}1\) claude\r?\n {2}2\) opencode\r?\n {2}3\) pi/);
  assert.match(r.stdout, /Models for the opencode judge:\r?\n {2}1\) opencode-go\/muse-spark-1\.3-contributor \(cheap\)/);
  assert.match(r.stdout, /answerer:opencode \(model opencode-go\/muse-spark-1\.3-contributor\) saved to /);
  const g = parse(readFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'utf8'));
  assert.deepEqual([g.judge.route, g.judge.model], ['answerer:opencode', 'opencode-go/muse-spark-1.3-contributor']);
  assert.ok(s.calls().length === 2 && s.calls().every((c) => c.agent === 'opencode'), 'the picked judge judged each capture');
});

test('init in a terminal says why it asks again and refuses a model the agent does not list', { skip: !existsSync('/usr/bin/script') && 'no script(1)' }, () => {
  const t = setup();
  const bin = join(t.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh\necho opencode-go/muse-spark-1.3-contributor\n`, { mode: 0o755 });
  const cmd = [process.execPath, CLI, 'init'].join(' ');
  const agentAnswers = ['x', '9', '3', '2', 'muse', 'opencode-go/nope', 'opencode-go/muse-spark-1.3-contributor'].join('\\n');
  const r = spawnSync('/bin/sh', ['-c', `(sleep 2; printf '${agentAnswers}\\n'; sleep 3; printf 'x\\n3\\nmuse\\n'; sleep 3) | /usr/bin/script -qec "${cmd}" /dev/null`], { cwd: t.repo, env: { ...t.env, PATH: `${bin}:${t.env.PATH}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /x is not on the list; type a number from 1 to 6/); assert.match(r.stdout, /9 is not on the list; type a number from 1 to 6/);
  assert.match(r.stdout, /muse is not provider\/model; type it again/); assert.match(r.stdout, /opencode-go\/nope is not a model opencode lists \(opencode models\); type it again/);
  assert.match(r.stdout, /x is not on the list; type a number from 1 to 4/, 'the judge list says why too');
  assert.match(r.stdout, /the model was not checked because pi has no model list; run 'done-done doctor --probe' to check it/, 'pi\'s list is not read');
  const g = parse(readFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'utf8'));
  assert.deepEqual([g.agent, g.agent_config.opencode.model, g.judge.route, g.judge.model], ['opencode', 'opencode-go/muse-spark-1.3-contributor', 'answerer:pi', 'muse']);
});

test('init in a terminal says a typed model is saved unchecked when its agent is not on PATH', { skip: !existsSync('/usr/bin/script') && 'no script(1)' }, () => {
  const t = setup();
  const bin = join(t.dir, 'bin');
  mkdirSync(bin);
  const cmd = [process.execPath, CLI, 'init'].join(' ');
  const agentAnswers = ['3', '2', 'opencode-go/x'].join('\\n');
  const r = spawnSync('/bin/sh', ['-c', `(sleep 2; printf '${agentAnswers}\\n'; sleep 3; printf 'x\\n1\\n1\\n'; sleep 3) | /usr/bin/script -qec "${cmd}" /dev/null`], { cwd: t.repo, env: { ...t.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 60_000 });
  assert.match(r.stdout, /opencode-go\/x is saved unchecked because opencode is not on PATH; run 'done-done doctor --probe' to check it/);
  const g = parse(readFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'utf8'));
  assert.equal(g.agent_config.opencode.model, 'opencode-go/x');
});

test('agent_path_override takes a name on PATH or an absolute path, and refuses a relative path', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\nagent_path_override: { claude: bin/claude }\n');
  const env = pathEnv(t.env, ['claude', 'opencode']);
  assert.match(toon(doctorIn(t.repo, env, 'doctor')).checks[1].detail, /agent_path_override must be a map of <agent>: <binary name or absolute path>/);
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\nagent_path_override: { opencode: claude }\n');
  const d = toon(doctorIn(t.repo, env, 'doctor'));
  assert.match(d.checks.find((c) => c.check === 'agent').detail, /^opencode .* at .*\/claude$/, 'a bare name is looked up on PATH');
  assert.match(d.checks.find((c) => c.check === 'agent_settings').detail, /path claude \(~?.*config\.yaml\)/);
});

// The design check: the same judge looks at each screen for visual defects, one tools-off request per screen.
test('design fails a screen on each defect the judge names, alone or next to its mock, and passes a clean one', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  writeFileSync(join(t.dir, 'mock.png'), screen(3));
  writeFileSync(join(t.dir, 'blank.png'), blank());
  const kinds = ['aspect', 'clipped-text', 'overlap', 'off-screen', 'blank-strip', 'layout'];
  const answer = (flagged = {}) => JSON.stringify(Object.fromEntries(kinds.map((k) => [k, { probabilities: flagged[k] ?? { defect: 0.03, none: 0.97 }, rationale: 'Looked.', personReason: flagged[k] ? `${k} at the header, top left` : 'Nothing of this kind.' }])));
  // Run from outside any repo, as a project's own capture step might.
  const design = (reply, ...args) => {
    const s = stubAgents(t.env, reply);
    symlinkSync(process.execPath, join(s.bin, 'node'));
    const r = spawnSync(process.execPath, [CLI, 'design', ...args], { cwd: t.dir, env: s.env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr, calls: s.calls() };
  };
  const bad = design(answer({ aspect: { defect: 0.9, none: 0.1 }, 'blank-strip': { defect: 0.85, none: 0.15 } }), 'screen.png', 'screen2.png', '--mock', 'screen.png=mock.png');
  assert.equal(bad.code, 1, bad.out);
  const b = toon(bad);
  assert.equal(b.result, 'fail');
  assert.deepEqual([b.judge.route, b.judge.model, b.judge.independence, b.judge.author], ['answerer:opencode', 'opencode-go/muse-spark-1.3-contributor', 'agent', 'claude (model claude-haiku-5-5)']);
  assert.deepEqual(b.screens.map((s) => [s.path, s.verdict, s.mock ?? null]), [['screen.png', 'fail', 'mock.png'], ['screen2.png', 'fail', null]]);
  assert.deepEqual(b.screens[0].defects, [{ kind: 'aspect', where: 'aspect at the header, top left' }, { kind: 'blank-strip', where: 'blank-strip at the header, top left' }]);
  assert.match(b.help[0], /^Fix each defect named above, .*done-done design screen\.png screen2\.png --mock screen\.png=mock\.png$/);
  assert.equal(bad.calls.length, 2, 'one tools-off request per screen');
  assert.deepEqual(bad.calls.map((c) => c.attached), [['PNG', 'PNG'], ['PNG']], 'a screen with a mock sends both images; one without, the screen alone');
  assert.ok(bad.calls.every((c) => JSON.parse(c.permission)['*'] === 'deny' && !/screen2?\.png|mock\.png/.test(c.file) && !c.file.includes(t.dir)), 'every tool is denied, and no path reaches the prompt');
  assert.match(bad.calls[0].file, /"mock"/);
  assert.doesNotMatch(bad.calls[1].file, /"mock"/);
  const ok = design(answer(), 'screen.png');
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual([toon(ok).result, toon(ok).screens[0].verdict, toon(ok).screens[0].defects], ['pass', 'pass', []]);
  // The same input gets the same verdict: a re-run asks no model, whatever it would answer now; a new mock is a new input.
  const again = design(answer({ layout: { defect: 0.9, none: 0.1 } }), 'screen.png', 'screen2.png', '--mock', 'screen.png=mock.png');
  assert.deepEqual(toon(again).screens.map((s) => [s.path, s.verdict, s.cached ?? false]), [['screen.png', 'fail', true], ['screen2.png', 'fail', true]]);
  assert.equal(again.calls.length, 0, 'both answers come from the cache');
  assert.deepEqual(toon(again).screens[0].defects, b.screens[0].defects);
  writeFileSync(join(t.dir, 'mock2.png'), screen(5));
  assert.equal(design(answer(), 'screen.png', '--mock', 'screen.png=mock2.png').calls.length, 1);
  writeFileSync(join(t.dir, 'screen3.png'), screen(11));
  const unsure = design(answer({ layout: { defect: 0.5, none: 0.5 } }), 'screen3.png');
  assert.equal(unsure.code, 3, unsure.out);
  assert.match(toon(unsure).screens[0].reason, /^not confident enough about layout$/);
  const empty = design(answer(), 'blank.png');
  assert.equal(empty.code, 1, empty.out);
  assert.match(toon(empty).screens[0].reason, /blank frame/);
  assert.equal(empty.calls.length, 0, 'a blank frame fails without a request');
  assert.equal(design(answer(), '--mock', 'screen.png').code, 2);
  assert.match(toon(design(answer(), 'gone.png')).error, /gone\.png: cannot read \(ENOENT\)/);
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  route: answerer:opencode\n'); const judgeOnly = design(answer(), 'screen.png');
  assert.equal(judgeOnly.code, 0, judgeOnly.out); assert.equal(toon(judgeOnly).judge.author, 'no agent set');
});

// A cheap model sometimes answers every kind with all-zero probabilities: that is a malformed answer to ask again, not
// a judge unsure of all six kinds, so the same screen gets the same verdict on every run.
test('design asks again when the judge answers with probabilities it cannot read, and never calls that unsure', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  const kinds = ['aspect', 'clipped-text', 'overlap', 'off-screen', 'blank-strip', 'layout'];
  const answer = (p) => JSON.stringify(Object.fromEntries(kinds.map((k) => [k, { probabilities: p, rationale: '' }])));
  // The stub opencode gives its answers in turn, the last one from then on.
  const design = (...replies) => {
    const s = stubAgents(t.env);
    symlinkSync(process.execPath, join(s.bin, 'node'));
    writeFileSync(join(s.bin, 'replies.json'), JSON.stringify(replies));
    rmSync(join(t.env.DONE_DONE_HOME, 'runs'), { recursive: true, force: true });
    const oc = join(s.bin, 'opencode');
    writeFileSync(oc, readFileSync(oc, 'utf8').replace(/^console\.log\('mise[\s\S]*$/m, `const replies = JSON.parse(readFileSync(${JSON.stringify(join(s.bin, 'replies.json'))}, 'utf8'));
console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: replies[Math.min(readFileSync(${JSON.stringify(join(s.bin, 'calls.jsonl'))}, 'utf8').trim().split('\\n').length, replies.length) - 1] } }));`));
    const r = spawnSync(process.execPath, [CLI, 'design', 'screen.png'], { cwd: t.dir, env: s.env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr, calls: s.calls() };
  };
  const zero = answer({ defect: 0, none: 0 });
  const again = design(zero, answer({ defect: 0.02, none: 0.98 }));
  assert.equal(again.code, 0, again.out);
  assert.equal(toon(again).screens[0].verdict, 'pass');
  assert.equal(again.calls.length, 2, 'the all-zero answer is asked once more');
  const never = design(zero);
  assert.equal(never.code, 3, never.out);
  assert.equal(never.calls.length, 2);
  assert.equal(toon(never).screens[0].reason, 'the judge did not answer: no probabilities for aspect, clipped-text, overlap, off-screen, blank-strip, layout that are each 0 to 1 and sum to 1');
  // One kind left without an option is malformed too, and only that kind is named.
  const partial = JSON.parse(answer({ defect: 0.02, none: 0.98 }));
  partial.layout.probabilities = { defect: 0.02 };
  assert.match(toon(design(JSON.stringify(partial))).screens[0].reason, /^the judge did not answer: no probabilities for layout that/);
});

test('design fails an overlay the approved mock does not draw in that place', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  writeFileSync(join(t.dir, 'mock.png'), screen(3));
  const kinds = ['aspect', 'clipped-text', 'overlap', 'off-screen', 'blank-strip', 'layout'];
  const reply = JSON.stringify(Object.fromEntries(kinds.map((k) => [k, k === 'overlap' ? { probabilities: { defect: 0.9, none: 0.1 }, rationale: 'Looked.', personReason: 'toast over the save button' } : { probabilities: { defect: 0.03, none: 0.97 }, rationale: 'Looked.', personReason: 'Nothing of this kind.' }])));
  const s = stubAgents(t.env, reply);
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const run = spawnSync(process.execPath, [CLI, 'design', 'screen.png', '--mock', 'screen.png=mock.png'], { cwd: t.dir, env: s.env, encoding: 'utf8' });
  const r = { code: run.status, out: run.stdout + run.stderr, calls: s.calls() };
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(toon(r).screens[0].defects, [{ kind: 'overlap', where: 'toast over the save button' }]);
  assert.equal(r.calls.length, 1, 'the overlay is judged, not passed without a request');
  assert.match(r.calls[0].file, /only where the mock draws that same overlay in the same place/, 'the mock is asked to approve an overlay only where it draws it');
  const alone = spawnSync(process.execPath, [CLI, 'design', 'screen2.png'], { cwd: t.dir, env: s.env, encoding: 'utf8' });
  assert.equal(alone.status, 1, alone.stdout + alone.stderr);
  assert.doesNotMatch(s.calls()[1].file, /dialog, sheet, menu, popover or toast/, 'alone, an overlay is judged as any element');
});

test('design measures a blank strip along an edge, but not a nav rail with icons or a uniform frame', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  // A light screen with a few dark text lines; the judge stub says every kind is clean, so only the pixels can fail it.
  const light = [245, 240, 230];
  const text = (x, y) => x >= 60 && x < 220 && y % 30 >= 10 && y % 30 < 16;
  writeFileSync(join(t.dir, 'strip.png'), png(240, 160, (x, y) => (x < 24 ? [20, 22, 20] : text(x, y) ? [40, 40, 40] : light)));
  writeFileSync(join(t.dir, 'rail.png'), png(240, 160, (x, y) => (x < 48 ? (x >= 14 && x < 34 && y % 40 >= 10 && y % 40 < 30 ? [220, 220, 220] : [30, 30, 36]) : text(x, y) ? [40, 40, 40] : light)));
  writeFileSync(join(t.dir, 'uniform.png'), png(240, 160, () => [20, 22, 20]));
  const clean = JSON.stringify(Object.fromEntries(['aspect', 'clipped-text', 'overlap', 'off-screen', 'blank-strip', 'layout'].map((k) => [k, { probabilities: { defect: 0.02, none: 0.98 }, rationale: 'Looked.', personReason: 'Nothing of this kind.' }])));
  const s = stubAgents(t.env, clean);
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const design = (...args) => {
    const r = spawnSync(process.execPath, [CLI, 'design', '--full', ...args], { cwd: t.dir, env: s.env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const strip = design('strip.png');
  assert.equal(strip.code, 1, strip.out);
  assert.deepEqual(toon(strip).screens[0].defects, [{ kind: 'blank-strip', where: 'left edge: a plain #141614 band 24 px deep (10% of the width), full height, with nothing in it' }]);
  const rail = design('rail.png');
  assert.equal(rail.code, 0, rail.out);
  assert.deepEqual(toon(rail).screens[0].defects, [], 'a dark rail that holds icons is content, not a strip');
  const uniform = design('uniform.png');
  assert.equal(uniform.code, 1, uniform.out);
  assert.match(toon(uniform).screens[0].reason, /blank frame/);
  assert.deepEqual(toon(uniform).screens[0].defects, [], 'a whole uniform screen is the blank-frame check, not a strip');
});

test('design does not report a strip its approved mock has too, but reports one the mock lacks', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  const light = [245, 240, 230];
  writeFileSync(join(t.dir, 'strip.png'), png(240, 160, (x) => (x < 24 ? [20, 22, 20] : light)));
  writeFileSync(join(t.dir, 'band-mock.png'), png(240, 160, (x) => (x < 24 ? [20, 22, 20] : light)));
  writeFileSync(join(t.dir, 'plain-mock.png'), png(240, 160, (x, y) => (x >= 60 && x < 220 && y % 30 >= 10 && y % 30 < 16 ? [40, 40, 40] : light)));
  const clean = JSON.stringify(Object.fromEntries(['aspect', 'clipped-text', 'overlap', 'off-screen', 'blank-strip', 'layout'].map((k) => [k, { probabilities: { defect: 0.02, none: 0.98 }, rationale: 'Looked.', personReason: 'Nothing of this kind.' }])));
  const s = stubAgents(t.env, clean);
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const design = (...args) => {
    const r = spawnSync(process.execPath, [CLI, 'design', '--full', ...args], { cwd: t.dir, env: s.env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const matched = design('strip.png', '--mock', 'strip.png=band-mock.png');
  assert.equal(matched.code, 0, matched.out);
  assert.deepEqual(toon(matched).screens[0].defects, [], 'a band the approved mock has too is approved design');
  const unmatched = design('strip.png', '--mock', 'strip.png=plain-mock.png');
  assert.equal(unmatched.code, 1, unmatched.out);
  assert.deepEqual(toon(unmatched).screens[0].defects, [{ kind: 'blank-strip', where: 'left edge: a plain #141614 band 24 px deep (10% of the width), full height, with nothing in it' }]);
  writeFileSync(join(t.dir, 'mock.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]));
  const unmeasurable = design('strip.png', '--mock', 'strip.png=mock.webp');
  assert.equal(unmeasurable.code, 3, unmeasurable.out);
  assert.deepEqual([toon(unmeasurable).screens[0].verdict, toon(unmeasurable).screens[0].reason], ['unsure', 'approved mock could not be measured; give a PNG or JPEG mock']);
});

test('design does not read a transparent margin as a strip, on a dark screen either', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  // An RGBA capture on a near-black screen whose left tenth is fully transparent, as a window capture's shadow margin is.
  writeFileSync(join(t.dir, 'margin.png'), png(240, 160, (x) => (x < 24 ? [0, 0, 0, 0] : [16, 18, 20, 255]), 6));
  const clean = JSON.stringify(Object.fromEntries(['aspect', 'clipped-text', 'overlap', 'off-screen', 'blank-strip', 'layout'].map((k) => [k, { probabilities: { defect: 0.02, none: 0.98 }, rationale: 'Looked.', personReason: 'Nothing of this kind.' }])));
  const s = stubAgents(t.env, clean);
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const r = spawnSync(process.execPath, [CLI, 'design', '--full', 'margin.png'], { cwd: t.dir, env: s.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(toon({ out: r.stdout + r.stderr }).screens[0].defects, [], 'the margin is transparent, not a band');
});

test('design reports an opaque black strip that has transparent pixels beside it on the same edge', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  writeFileSync(join(t.dir, 'partial.png'), png(240, 160, (x, y) => (x < 24 ? (y < 30 ? [0, 0, 0, 0] : [0, 0, 0, 255]) : [245, 240, 230, 255]), 6));
  writeFileSync(join(t.dir, 'clear-edge.png'), png(240, 160, (x) => (x === 0 ? [0, 0, 0, 0] : x < 24 ? [0, 0, 0, 255] : [245, 240, 230, 255]), 6));
  writeFileSync(join(t.dir, 'clear-inside.png'), png(240, 160, (x) => (x === 3 ? [0, 0, 0, 0] : x < 8 ? [0, 0, 0, 255] : [245, 240, 230, 255]), 6));
  const clean = JSON.stringify(Object.fromEntries(['aspect', 'clipped-text', 'overlap', 'off-screen', 'blank-strip', 'layout'].map((k) => [k, { probabilities: { defect: 0.02, none: 0.98 }, rationale: 'Looked.', personReason: 'Nothing of this kind.' }])));
  const s = stubAgents(t.env, clean);
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const design = (name) => spawnSync(process.execPath, [CLI, 'design', '--full', name], { cwd: t.dir, env: s.env, encoding: 'utf8' });
  const partial = design('partial.png');
  assert.equal(partial.status, 1, partial.stdout + partial.stderr);
  assert.deepEqual(toon({ out: partial.stdout + partial.stderr }).screens[0].defects, [{ kind: 'blank-strip', where: 'left edge: a plain #000000 band 24 px deep (10% of the width), full height, with nothing in it' }]);
  const edge = design('clear-edge.png');
  assert.equal(edge.status, 1, edge.stdout + edge.stderr);
  assert.deepEqual(toon({ out: edge.stdout + edge.stderr }).screens[0].defects, [{ kind: 'blank-strip', where: 'left edge: a plain #000000 band 24 px deep (10% of the width), full height, with nothing in it' }]);
  const inside = design('clear-inside.png');
  assert.equal(inside.status, 1, inside.stdout + inside.stderr);
  assert.deepEqual(toon({ out: inside.stdout + inside.stderr }).screens[0].defects, [{ kind: 'blank-strip', where: 'left edge: a plain #000000 band 8 px deep (3% of the width), full height, with nothing in it' }]);
});

test('design judges a JPEG longer than the judge size, downscaled to a PNG', () => {
  const t = setup();
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  const data = Buffer.alloc(1300 * 90 * 4);
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4, x = p % 1300, y = Math.floor(p / 1300);
    data.set([(x * 7) % 256, (y * 11) % 256, (x + y) % 256, 255], i);
  }
  writeFileSync(join(t.dir, 'long.jpg'), jpeg.encode({ width: 1300, height: 90, data }, 90).data);
  const clean = JSON.stringify(Object.fromEntries(['aspect', 'clipped-text', 'overlap', 'off-screen', 'blank-strip', 'layout'].map((k) => [k, { probabilities: { defect: 0.02, none: 0.98 }, rationale: 'Looked.', personReason: 'Nothing of this kind.' }])));
  const s = stubAgents(t.env, clean);
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const r = spawnSync(process.execPath, [CLI, 'design', '--full', 'long.jpg'], { cwd: t.dir, env: s.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(toon({ out: r.stdout + r.stderr }).screens[0].verdict, 'pass');
  const calls = s.calls();
  assert.equal(calls.length, 1, 'one request for the screen');
  assert.deepEqual(calls[0].attached, ['PNG'], 'the judge is sent the downscaled screen');
});

// doctor: read-only health check. Required items (git, config, evidence root) gate
// exit 0/2; the skill, agent, judge and ffprobe items are optional and never fail it.
// An isolated PATH holding only git plus the named stub binaries, so agent/judge/ffprobe
// detection never depends on what the host happens to have installed.
function pathEnv(env, bins) {
  const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), 'done-done-doctor-path-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(gitPath, join(dir, 'git'));
  // A claude stub is signed in: auto judges only a claude whose `auth status` says it is logged in.
  for (const b of bins) writeFileSync(join(dir, b), `#!/bin/sh\ncase "$*" in *auth*) echo '{"loggedIn":true}' ;; esac\nexit 0\n`, { mode: 0o755 });
  return { ...env, PATH: dir };
}

const doctorIn = (cwd, env, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('doctor passes in a set-up repo and lists every check', () => {
  const { dd, env } = setup();
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\n');
  const r = dd('doctor');
  assert.equal(r.code, 0, r.out);
  const d = toon(r);
  assert.equal(d.result, 'pass');
  assert.deepEqual(d.checks.map((c) => c.check), ['git', 'config', 'evidence_root', 'verify_skill', 'agent', 'judge', 'ffprobe', 'judge_choice', 'agent_settings']);
  assert.deepEqual(d.checks.slice(0, 3).map((c) => c.status), ['ok', 'ok', 'ok']);
  assert.match(d.checks[1].detail, /app notes/);
  assert.equal(d.checks[3].status, 'missing', 'no verify skill yet, and that is optional');
  assert.match(d.checks[3].fix, /SKILL\.md/);
  assert.ok(d.help.length >= 1);
  const j = json(dd('doctor', '--json'));
  assert.equal(j.result, 'pass');
  assert.equal(j.checks.length, 9);
});

test('doctor does not send a repo with a malformed global config to init', () => {
  const b = bareRepo();
  mkdirSync(b.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(b.env.DONE_DONE_HOME, 'config.yaml'), 'app: [unclosed\n');
  const d = toon(b.dd('doctor'));
  assert.equal(d.checks[1].status, 'missing');
  assert.match(d.checks[1].detail, /config\.yaml/);
  assert.ok(!d.help.some((h) => h.includes('done-done init')), 'init would read the same malformed global config and fail');
});

test('doctor checks the evidence root from a valid global config when the repo has no project file', () => {
  const b = bareRepo();
  mkdirSync(b.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(b.env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  route: claude-code\n  model: claude-test-1\n');
  const d = toon(b.dd('doctor'));
  assert.equal(d.checks[1].status, 'missing');
  assert.equal(d.checks[2].status, 'ok', 'the loaded config is used, not an unknown row');
  assert.match(d.checks[2].detail, /writable/);
  assert.ok(d.help.some((h) => h.includes('done-done init')));
});

test('doctor reports a present verify skill as ok', () => {
  const { repo, dd } = setup();
  mkdirSync(join(repo, '.agents', 'skills', 'verify-notes'), { recursive: true });
  writeFileSync(join(repo, '.agents', 'skills', 'verify-notes', 'SKILL.md'), '# verify-notes\n');
  const d = toon(dd('doctor'));
  assert.equal(d.checks[3].status, 'ok');
  assert.match(d.checks[3].detail, /SKILL\.md/);
});

test('doctor in a bare repo fails with the init fix; a malformed config names the file', () => {
  const b = bareRepo();
  const r = b.dd('doctor');
  assert.equal(r.code, 2, r.out);
  const d = toon(r);
  assert.equal(d.result, 'fail');
  assert.equal(d.checks[0].status, 'ok');
  assert.equal(d.checks[1].status, 'missing');
  assert.match(d.checks[1].fix, /done-done init/);
  assert.ok(d.help.some((h) => h.includes('done-done init')));
  writeFileSync(join(b.repo, '.done-done.yaml'), 'app: [unclosed\n');
  const r2 = b.dd('doctor');
  assert.equal(r2.code, 2, r2.out);
  assert.match(toon(r2).checks[1].detail, /\.done-done\.yaml/);
  assert.ok(!toon(r2).help.some((h) => h.includes('done-done init')), 'init cannot read a malformed config, so it is never the fix');
  mkdirSync(b.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(b.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  allow_same: true\n');
  const broke = toon(doctorIn(b.repo, pathEnv(b.env, ['claude']), 'doctor'));
  const ag = broke.checks.find((c) => c.check === 'agent');
  assert.equal(ag.status, 'missing', 'a broken repo config makes the agent unknown, not the global agent');
  assert.match(ag.detail, /unknown without a valid config/);
  const jc = broke.checks.find((c) => c.check === 'judge_choice');
  assert.equal(jc.status, 'missing', 'a broken repo config makes judge_choice unknown, not a global-fallback ok');
  assert.match(jc.detail, /unknown without a valid config/);
  const outside = doctorIn(b.dir, b.env, 'doctor');
  assert.equal(outside.code, 2, outside.out);
  assert.equal(toon(outside).checks[0].status, 'missing');
  assert.match(toon(outside).checks[0].fix, /inside a git repository/);
});

test('with no agent set, done-done never picks one: doctor, maintain and verify --judge tell the calling agent to ask the user', () => {
  const { repo, env } = setup();
  mkdirSync(join(env.DONE_DONE_HOME, 'claude'), { recursive: true });
  const path = pathEnv(env, ['claude', 'opencode']);
  const d = doctorIn(repo, path, 'doctor');
  assert.equal(d.code, 0, 'the agent is optional for doctor');
  const ag = toon(d).checks[4];
  assert.equal(ag.status, 'missing', 'an installed claude and opencode are not a choice');
  assert.equal(ag.detail, 'no agent is set: ask the user which agent to use (claude, codex, opencode, pi, gemini, acp:<target>); never pick one for them');
  assert.match(ag.fix, /^Save the user's answer: done-done init --agent <agent> --model <model>, e\.g\. done-done init --agent opencode --model opencode-go\/muse-spark-1\.3-contributor$/);
  assert.ok(!toon(d).checks.some((c) => c.check === 'agent_settings'));
  const by = (n) => toon(d).checks.find((c) => c.check === n); assert.deepEqual([by('judge').status, by('judge').fix], ['missing', "Save the user's answer: done-done init --judge <agent> --judge-model <model>, e.g. done-done init --judge opencode --judge-model opencode-go/muse-spark-1.3-contributor"]); assert.deepEqual([by('judge_choice').status, by('judge_choice').detail, by('judge_choice').fix], ['missing', 'unknown until the agent is set, since the judge is kept apart from it', '']);
  const runs = join(env.DONE_DONE_HOME, 'runs', 'notes');
  for (const args of [['maintain', '--foreground'], ['verify', 'shots', '--outcome', 'home renders', '--judge', '--foreground']]) {
    const r = doctorIn(repo, path, ...args);
    assert.equal(r.code, 2, r.out);
    assert.equal(toon(r).error, ag.detail);
    assert.deepEqual(toon(r).help, [ag.fix]);
    assert.equal(existsSync(runs), false, 'no run starts without the user\'s agent');
  }
  // init --agent saves the user's answer in place in the commented global config; doctor then names it.
  const init = toon(doctorIn(repo, path, 'init', '--agent', 'opencode', '--model', 'opencode-go/test-model'));
  assert.match(init.agent, /^opencode \(model opencode-go\/test-model\) saved to .*config\.yaml$/);
  const yml = readFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'utf8');
  assert.deepEqual([parse(yml).agent, parse(yml).agent_config.opencode.model, parse(yml).agent_config.claude.model], ['opencode', 'opencode-go/test-model', 'claude-haiku-5-5']);
  assert.match(yml, /^# The coding agent done-done starts/m, 'the comments stay');
  assert.match(init.global_config, /^written /, 'init writes the commented global first, then sets agent in it');
  assert.match(yml, /^agent: opencode$/m);
  const lines = yml.split('\n');
  const agentAt = lines.findIndex((l) => l.startsWith('agent: '));
  assert.ok(agentAt > lines.findIndex((l) => l.startsWith('# done-done global config')), 'the agent key comes after the file header');
  assert.ok(agentAt > lines.findIndex((l) => l.startsWith('# The coding agent done-done starts')), 'and after the agent comment block it describes');
  assert.ok(agentAt < lines.findIndex((l) => l.startsWith('agent_config:')), 'and before agent_config');
  assert.match(toon(doctorIn(repo, path, 'doctor')).checks[4].detail, /^opencode \(model opencode-go\/test-model; from config\) at /);
  assert.equal(toon(doctorIn(repo, path, 'init')).agent, 'unchanged (opencode)');
  // codex is one of the agents done-done starts, at the model the user names.
  assert.match(toon(doctorIn(repo, path, 'init', '--agent', 'codex', '--model', 'gpt-test')).agent, /^codex \(model gpt-test\) saved to .*config\.yaml$/);
  assert.deepEqual([parse(readFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'utf8')).agent, parse(readFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'utf8')).agent_config.codex], ['codex', { model: 'gpt-test' }]);
  assert.match(toon(doctorIn(repo, path, 'doctor')).checks[4].detail, /^codex \(model gpt-test; from config\): codex is not on PATH$/);
  for (const [args, error] of [[['--model', 'x'], /--model needs --agent/], [['--agent', 'cursor'], /done-done cannot start cursor; it starts claude, codex, opencode, pi, gemini, acp:<target>/], [['--agent', 'opencode', '--model', 'muse'], /provider\/model/]]) {
    const bad = doctorIn(repo, path, 'init', ...args);
    assert.equal(bad.code, 2, bad.out);
    assert.match(toon(bad).error, error);
  }
});

test('init --agent names the repo config agent that overrides the one it saves', () => {
  const { repo, env, dd } = setup('app: notes\nagent: claude\n');
  const r = dd('init', '--agent', 'opencode', '--model', 'opencode-go/test-model');
  assert.equal(r.code, 0, r.out);
  assert.match(toon(r).agent, /^opencode \(model opencode-go\/test-model\) saved to .*config\.yaml; \.done-done\.yaml overrides it with claude$/);
  assert.equal(parse(readFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'utf8')).agent, 'opencode');
  assert.equal(readFileSync(join(repo, '.done-done.yaml'), 'utf8'), 'app: notes\nagent: claude\n', 'the repo file is not written');
});

test('init --agent puts the key before the first top-level key when the example comment is gone', () => {
  const { dir, dd } = bareRepo();
  dd('init');
  const globalYml = join(dir, 'home', 'config.yaml');
  writeFileSync(globalYml, readFileSync(globalYml, 'utf8').replace(/^# agent: opencode\n/m, ''));
  const r = dd('init', '--agent', 'opencode', '--model', 'opencode-go/test-model');
  assert.equal(r.code, 0, r.out);
  const text = readFileSync(globalYml, 'utf8');
  const lines = text.split('\n');
  const agentAt = lines.findIndex((l) => l.startsWith('agent: '));
  assert.ok(agentAt >= 0 && agentAt < lines.findIndex((l) => l.startsWith('agent_config:')), 'the key lands before agent_config, not at the end');
  assert.equal(parse(text).agent, 'opencode');
  assert.equal(parse(text).agent_config.opencode.model, 'opencode-go/test-model');
});

test('init --agent replaces the example comment even when a key sits above it', () => {
  const { dir, dd } = bareRepo();
  const globalYml = join(dir, 'home', 'config.yaml');
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(globalYml, `evidence:\n  local_root: ${join(dir, 'ev')}\n# agent: opencode\nagent_config:\n  claude: { model: claude-haiku-5-5 }\n`);
  const r = dd('init', '--agent', 'opencode');
  assert.equal(r.code, 0, r.out);
  const text = readFileSync(globalYml, 'utf8');
  const lines = text.split('\n');
  const agentAt = lines.findIndex((l) => l.startsWith('agent: '));
  assert.ok(agentAt > lines.findIndex((l) => l.startsWith('evidence:')) && agentAt < lines.findIndex((l) => l.startsWith('agent_config:')), 'the key takes the example comment\'s place, after the key above it');
  assert.equal(parse(text).agent, 'opencode');
  assert.ok(!text.includes('# agent: opencode'), 'the example comment is replaced by the key');
});

test('agent "" is refused in the repo and the global config; removing the key leaves it unset', () => {
  const { repo, env, dd } = setup('app: notes\nagent: ""\n');
  const inRepo = dd('init');
  assert.equal(inRepo.code, 2, inRepo.out);
  assert.match(toon(inRepo).error, /\.done-done\.yaml: agent must not be empty; to leave it unset, remove the key$/);
  writeFileSync(join(repo, '.done-done.yaml'), 'app: notes\n');
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: ""\n');
  const inGlobal = dd('init');
  assert.equal(inGlobal.code, 2, inGlobal.out);
  assert.match(toon(inGlobal).error, /config\.yaml: agent must not be empty/);
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent_timeout: 30m\n');
  assert.equal(toon(dd('init')).agent, 'not set', 'with the key removed, the agent is unset and init asks for it');
});

test('the run error names agent_path_override only when the override is set and does not start', () => {
  const { repo, env, sh } = setup();
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nThe app starts at src/app.js:1.\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const path = pathEnv(env, ['ffprobe']);
  const config = join(env.DONE_DONE_HOME, 'config.yaml');
  writeFileSync(config, 'agent: pi\n');
  assert.match(toon(doctorIn(repo, path, 'maintain', '--foreground')).reason, /\(pi is not on PATH\)/);
  const gone = join(env.DONE_DONE_HOME, 'gone', 'pi');
  writeFileSync(config, `agent: pi\nagent_path_override: { pi: ${JSON.stringify(gone)} }\n`);
  assert.match(toon(doctorIn(repo, path, 'maintain', '--foreground')).reason, /\(agent_path_override\.pi .*gone\/pi is not an executable file\)/);
});

test('doctor reports the judge missing when claude has no sign-in, whichever binary agent_path_override names', () => {
  const { repo, env, dd } = setup();
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\njudge:\n  route: claude-code\n');
  const noSignIn = toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor'));
  assert.equal(noSignIn.checks[5].status, 'missing', 'a claude binary alone with no sign-in is not a judge');
  assert.match(noSignIn.checks[5].detail, /^judge: no Claude sign-in at /);
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\njudge:\n  route: claude-code\nagent_path_override: { claude: claude }\n');
  const relative = toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor'));
  assert.equal(relative.checks[5].status, 'missing');
  assert.match(relative.checks[5].detail, /^judge: no Claude sign-in at /);
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  bin: /usr/bin/claude\n');
  assert.match(toon(dd('doctor')).checks[1].detail, /unknown key judge\.bin/, 'a key that never shipped is unknown');
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  claude_code: { bin: /usr/bin/claude }\n');
  assert.match(toon(dd('doctor')).checks[1].detail, /the claude binary is agent_path_override\.claude/, 'the old key points at its replacement');
});

test('doctor reports the judge missing when agent_path_override.claude does not exist', () => {
  const { repo, env } = setup();
  mkdirSync(join(env.DONE_DONE_HOME, 'claude'), { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), `agent: opencode\njudge:\n  route: claude-code\nagent_path_override: { claude: ${JSON.stringify(join(env.DONE_DONE_HOME, 'gone', 'claude'))} }\n`);
  const j = toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor'));
  assert.equal(j.checks[5].status, 'missing');
  assert.equal(j.checks[5].detail, `judge: agent_path_override.claude ${join(env.DONE_DONE_HOME, 'gone', 'claude')} is not an executable file`, 'the same wording as the agent row and a run');
});

test('doctor reports the judge missing when agent_path_override.claude is a directory', () => {
  const { repo, env } = setup();
  mkdirSync(join(env.DONE_DONE_HOME, 'claude'), { recursive: true });
  const dirBin = join(env.DONE_DONE_HOME, 'bindir');
  mkdirSync(dirBin, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), `agent: opencode\njudge:\n  route: claude-code\nagent_path_override: { claude: ${JSON.stringify(dirBin)} }\n`);
  const j = toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor'));
  assert.equal(j.checks[5].status, 'missing');
  assert.equal(j.checks[5].detail, `judge: agent_path_override.claude ${dirBin} is not an executable file`);
});

test('doctor reports the judge missing when its sign-in folder is a ~/.claude', () => {
  const { repo, env } = setup();
  const userHome = join(env.DONE_DONE_HOME, 'userhome');
  const claudeDir = join(userHome, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), `agent: claude\njudge:\n  route: claude-code\n  allow_same: true\n  claude_code: { config_dir: ${JSON.stringify(claudeDir)} }\n`);
  const j = toon(doctorIn(repo, { ...pathEnv(env, ['claude']), HOME: userHome }, 'doctor'));
  assert.equal(j.checks[5].status, 'missing');
  assert.match(j.checks[5].fix, /not your ~\/\.claude/);
});

test('doctor finds agent, judge and ffprobe binaries from PATH; missing optionals never fail it', () => {
  const { repo, env } = setup();
  mkdirSync(join(env.DONE_DONE_HOME, 'claude'), { recursive: true });
  const agent = (a, judge = 'route: answerer:opencode\n') => writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), `agent: ${a}\njudge:\n  ${judge}`);
  agent('claude');
  const full = doctorIn(repo, pathEnv(env, ['claude', 'codex', 'opencode', 'ffprobe']), 'doctor');
  assert.equal(full.code, 0, full.out);
  const f = toon(full);
  assert.match(f.checks[4].detail, /^claude \(model claude-haiku-5-5; from config\) at .*claude/);
  assert.equal(f.checks[7].status, 'ok', 'the judge the user set is another agent');
  assert.match(f.checks[7].detail, /^answerer:opencode \(model opencode-go\/muse-spark-1\.3-contributor; from config\) judges the author claude \(model claude-haiku-5-5\): a different agent from the author$/);
  assert.match(f.checks[5].detail, /^answerer:opencode .*: opencode at .* and the judge kit are present; it judges with every tool off; doctor does not call the model/, 'the judge CLI is never run');
  assert.match(f.checks[6].detail, /found at .*ffprobe/);
  agent('codex');
  const codexOnly = toon(doctorIn(repo, pathEnv(env, ['codex']), 'doctor'));
  assert.deepEqual([codexOnly.checks[4].status, codexOnly.checks[4].fix], ['ok', '']);
  assert.match(codexOnly.checks[4].detail, /^codex \(its own default model; set agent_config\.codex\.model to choose one; from config\) at .*codex$/);
  const codexGate = codexOnly.checks.find((x) => x.check === 'tool_gate');
  assert.equal(codexGate.status, 'warning');
  assert.match(codexGate.detail, /^codex's drive sandbox lets its commands write only the repo, the run's evidence and scratch folders, \$TMPDIR and \/tmp; a tool that writes elsewhere needs its folder added with agent_args_override\.codex: \[--add-dir, <folder>\] \(see docs\/reference\.md, Drive by agent\)$/);
  const codexJudge = codexOnly.checks.find((x) => x.check === 'judge');
  assert.deepEqual([codexJudge.status, codexJudge.detail], ['missing', 'judge: opencode is not on PATH'], 'the judge the user set is never swapped for an installed one');
  agent('opencode');
  const two = toon(doctorIn(repo, pathEnv(env, ['codex', 'opencode']), 'doctor'));
  assert.match(two.checks[4].detail, /^opencode .* at /);
  assert.equal(two.checks[7].status, 'missing', 'a judge that is the author\'s own agent and model is refused');
  assert.match(two.checks[7].detail, /^judge: the judge opencode \(model opencode-go\/muse-spark-1\.3-contributor\) is the author's own agent and model \(opencode\)/);
  assert.match(two.checks[7].fix, /^Ask the user for another judge agent or model and save it: done-done init --judge <agent> --judge-model <model>/);
  agent('claude');
  const none = doctorIn(repo, pathEnv(env, []), 'doctor');
  assert.equal(none.code, 0, 'missing optionals still exit 0 when every required item is ok');
  const n = toon(none);
  assert.deepEqual(n.checks.slice(4).map((c) => c.status), ['missing', 'missing', 'missing', 'ok', 'ok']);
  assert.match(n.checks[4].fix, /^Install claude, or ask the user which agent to use/, 'a missing agent is never swapped for an installed one');
  assert.match(n.checks[5].fix, /^Install opencode, or ask the user for another judge and save it: done-done init --judge/);
  assert.match(n.checks[6].fix, /ffprobe/);
  const repoYaml = readFileSync(join(repo, '.done-done.yaml'), 'utf8');
  const claudeOnly = pathEnv(env, ['claude']);
  writeFileSync(join(repo, '.done-done.yaml'), `${repoYaml.replace('judge:\n  enabled: false\n', '')}judge:\n  allow_same: true\n`);
  const inRepo = toon(doctorIn(repo, claudeOnly, 'doctor'));
  assert.match(inRepo.checks[1].detail, /judge\.allow_same may only be set in the global config/, 'the project file cannot waive the judge');
  writeFileSync(join(repo, '.done-done.yaml'), repoYaml);
  agent('claude', 'route: claude-code\n  model: claude-sonnet-5-5\n');
  const apart = toon(doctorIn(repo, claudeOnly, 'doctor'));
  assert.deepEqual([apart.checks[7].status, apart.checks[7].detail], ['warning', 'claude-code (model claude-sonnet-5-5; from config) judges the author claude (model claude-haiku-5-5): the author\'s agent at a different model'], 'the author\'s agent at another model runs, with a warning');
  agent('claude', 'route: claude-code\n  allow_same: true\n');
  const same = toon(doctorIn(repo, claudeOnly, 'doctor'));
  assert.deepEqual([same.checks[7].status, /judge\.allow_same accepts it/.test(same.checks[7].detail)], ['warning', true]);
});

test('with no agent installed, the judge is still kept apart from the author the user set: doctor names it, the agent row still names the first agent', () => {
  const { repo, env } = setup();
  const claudeHome = join(env.DONE_DONE_HOME, 'claude');
  mkdirSync(claudeHome, { recursive: true });
  const bin = join(env.DONE_DONE_HOME, 'claude-bin');
  writeFileSync(bin, '#!/bin/sh\necho \'{"loggedIn":true}\'\n', { mode: 0o755 });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), `agent: opencode\njudge:\n  route: claude-code\n  claude_code: { config_dir: ${JSON.stringify(claudeHome)} }\nagent_path_override: { claude: ${JSON.stringify(bin)} }\n`);
  const d = toon(doctorIn(repo, pathEnv(env, []), 'doctor'));
  assert.match(d.checks[4].detail, /^opencode \(model opencode-go\/muse-spark-1\.3-contributor; from config\): opencode is not on PATH$/);
  assert.equal(d.checks[7].status, 'ok', 'a judge of another agent than the author is ok, installed or not');
  assert.match(d.checks[7].detail, /judges the author opencode \(model opencode-go\/muse-spark-1\.3-contributor\)/);
});

test('judge.route must name a judge, and judge.model is the judge\'s model', () => {
  const { repo, env } = setup();
  mkdirSync(join(env.DONE_DONE_HOME, 'claude'), { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), "agent: claude\njudge:\n  route: ''\n");
  assert.match(toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor')).checks[1].detail, /judge\.route must not be empty; to leave it unset, remove the key$/);
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:acp:gemini\n');
  assert.match(toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor')).checks[1].detail, /judge\.route must be claude-code \(for claude\), answerer:<agent> for one of opencode, pi, gemini, or a key route \(openai:key\)/);
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\njudge:\n  route: claude-code\n  model: x\n');
  const d = toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor'));
  assert.equal(d.checks[1].status, 'ok');
  assert.match(d.checks[7].detail, /^claude-code \(model x; from config\)/);
});

test('a judged receipt citing nothing the judge reads needs no judge, so no installed agent does not block it', () => {
  const t = setup('app: notes\nevidence:\n  root: .proof\njudge:\n  enabled: true\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n');
  const r = t.dd('run', '--', `node -e "require('fs').writeFileSync(process.env.DONE_DONE_EVIDENCE_ROOT + '/session.bin','saved 3 notes')"`);
  assert.equal(r.code, 0, r.out);
  const log = `.proof/${toon(r).run_id}/session.bin`;
  const rec = doctorIn(t.repo, pathEnv(t.env, []), 'receipt', '--outcome', 'three notes are saved', log);
  assert.equal(rec.code, 0, rec.out);
  const v = t.dd('receipt', '--verify', t.head());
  assert.deepEqual([toon(v).result, toon(v).schema, toon(v).judge], ['pass', 1, undefined]);
});

test('verify --judge on evidence the judge does not read leaves the judge step skipped and writes no judge log', () => {
  const t = setup(`app: notes
evidence:
  root: .proof
judge:
  enabled: true
journeys:
  shots:
    command: node -e "require('fs').writeFileSync(process.env.DONE_DONE_EVIDENCE_ROOT + '/session.bin', 'saved 3 notes')"
`);
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  const r = t.dd('verify', 'shots', '--outcome', 'three notes are saved', '--foreground');
  const runDir = join(t.env.DONE_DONE_HOME, 'runs', 'notes', toon(r).run_id);
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.equal(run.steps.find((s) => s.name === 'judge').status, 'skipped', 'no capture needed the judge');
  assert.equal(existsSync(join(runDir, 'logs', 'judge.log')), false, 'a judge that judged nothing writes no log');
});

// Stub agent CLIs that log how they were started (argv, stdin, cwd) and answer like the real ones:
// claude -p prints its JSON result with structured_output; opencode run reads the attached prompt file and
// prints JSON events (after a wrapper's banner line) whose text part holds the answer, fenced as models often do.
function stubAgents(env, answer = '{"ok":true}') {
  const e = pathEnv(env, ['ffprobe']);
  const log = join(e.PATH, 'calls.jsonl');
  const stub = (name, reply) => writeFileSync(join(e.PATH, name), `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const file = argv.includes('-f') ? readFileSync(argv[argv.indexOf('-f') + 1], 'utf8') : '';
const attached = argv.filter((a, i) => argv[i - 1] === '-f').slice(1).map((f) => readFileSync(f).subarray(1, 4).toString());
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: ${JSON.stringify(name)}, argv, stdin, file, attached, permission: process.env.OPENCODE_PERMISSION, cwd: process.cwd() }) + '\\n');
${reply}
`, { mode: 0o755 });
  stub('claude', `process.exitCode = ${JSON.stringify(answer)} === 'error' ? 1 : 0;
process.stdout.write(JSON.stringify({ type: 'result', is_error: ${JSON.stringify(answer)} === 'error', result: 'You have hit your session limit', structured_output: ${JSON.stringify(answer)} === 'error' ? undefined : JSON.parse(${JSON.stringify(answer)}) }));`);
  stub('opencode', `console.log('mise tools: opencode');
console.log(JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }));
console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: '\\\`\\\`\\\`json\\n' + ${JSON.stringify(answer)} + '\\n\\\`\\\`\\\`' } }));`);
  // The user sets the agent; done-done never picks one. A test that needs another agent writes its own config.
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  if (!existsSync(join(env.DONE_DONE_HOME, 'config.yaml'))) writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\n');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { env: e, calls, bin: e.PATH };
}

test('the agent comes from config, and doctor --probe asks it one schema question', () => {
  const { repo, env } = setup(JUDGED);
  const s = stubAgents(env);
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent_config:\n  opencode: { model: opencode-go/test-model }\njudge:\n  route: answerer:opencode\n  model: opencode-go/muse-spark-1.3-contributor\n');
  const yaml = readFileSync(join(repo, '.done-done.yaml'), 'utf8');
  const doctor = (extra, ...args) => {
    writeFileSync(join(repo, '.done-done.yaml'), yaml + extra);
    const r = doctorIn(repo, s.env, 'doctor', ...args);
    return { ...r, d: r.out.startsWith('command') ? toon(r) : undefined, by: (n) => toon(r).checks.find((c) => c.check === n) };
  };
  // opencode at its configured model.
  const oc = doctor('agent: opencode\n', '--probe');
  assert.equal(oc.code, 0, oc.out);
  assert.match(oc.by('agent').detail, /^opencode \(model opencode-go\/test-model; from config\) at /);
  assert.match(oc.by('judge_choice').detail, /^answerer:opencode \(model opencode-go\/muse-spark-1\.3-contributor; from config\) judges the author opencode \(model opencode-go\/test-model\): the author's agent at a different model/);
  assert.equal(oc.by('probe').status, 'ok');
  const [call] = s.calls();
  assert.match(call.file, /connectivity probe[\s\S]*JSON schema[\s\S]*"required":\["ok"\]/, 'the prompt and schema go in the attached file');
  assert.ok(!call.argv.some((a) => a.includes('connectivity probe')) && call.stdin === '', 'never in argv');
  assert.notEqual(call.cwd, repo, 'a tool-less probe runs in a scratch dir, never the repo');
  assert.deepEqual(call.argv.slice(0, 6), ['run', 'Follow the attached instructions.', '--format', 'json', '-m', 'opencode-go/test-model']);
  assert.deepEqual(JSON.parse(call.permission), { '*': 'deny' }, 'every tool is denied');
  const record = oc.by('probe').detail.match(/record (\S+)$/)[1];
  assert.equal(statSync(record).mode & 0o777, 0o600);
  const rec = JSON.parse(readFileSync(record, 'utf8'));
  assert.deepEqual([rec.agent, rec.model, rec.tools, rec.ok, rec.answer], ['opencode', 'opencode-go/test-model', 'none', true, { ok: true }]);
  assert.ok(rec.prompt_bytes > 0 && !JSON.stringify(rec).includes('connectivity probe'), 'the record keeps no prompt text');
  // claude at its cheap default, all tools off.
  const claude = doctor('agent: claude\n', '--probe');
  assert.equal(claude.code, 0, claude.out);
  const c = s.calls()[1];
  assert.equal(c.agent, 'claude');
  assert.notEqual(c.cwd, repo, 'a tool-less probe runs in a scratch dir, never the repo');
  assert.deepEqual(['--model', '--tools', '--setting-sources'].map((f) => c.argv[c.argv.indexOf(f) + 1]), ['claude-haiku-5-5', '', ''], 'no project or user settings load');
  assert.ok(c.argv.includes('-p') && c.argv.includes('--no-session-persistence') && JSON.parse(c.argv[c.argv.indexOf('--json-schema') + 1]).required[0] === 'ok');
  assert.match(c.stdin, /connectivity probe/);
  assert.deepEqual(c.argv.slice(-2), ['--effort', 'low'], 'the cheap default effort goes to claude --effort');
  // effort, extra flags and the call timeout come from the global config, and doctor names the file each came from.
  const globalYml = join(env.DONE_DONE_HOME, 'config.yaml');
  writeFileSync(globalYml, 'agent_config:\n  claude: { effort: high }\nagent_args_override:\n  claude: [--permission-mode, plan]\nagent_timeout: 2m\n');
  const tuned = doctor('agent: claude\n', '--probe');
  assert.equal(tuned.code, 0, tuned.out);
  assert.deepEqual(s.calls()[2].argv.slice(-4), ['--effort', 'high', '--permission-mode', 'plan'], 'effort maps to the CLI flag, extra flags come after done-done\'s own');
  const tunedRec = JSON.parse(readFileSync(tuned.by('probe').detail.match(/record (\S+)$/)[1], 'utf8'));
  assert.deepEqual([tunedRec.effort, tunedRec.args, tunedRec.timeoutMs], ['high', ['--permission-mode', 'plan'], 120_000], 'the call record names the effort, flags and timeout');
  assert.match(tuned.by('agent_settings').detail, /^agent claude \(\.done-done\.yaml\); model claude-haiku-5-5 \(default\); effort high \(.*config\.yaml\); args 2 set \(.*config\.yaml\); path claude on PATH \(default\); agent_timeout 2m \(.*config\.yaml\)$/);
  writeFileSync(globalYml, 'agent_config:\n  opencode: { model: opencode-go/test-model }\n');
  // A failed answer fails the probe, which --probe makes required; without --probe nothing is asked.
  const bad = stubAgents(env, 'error');
  const failed = doctorIn(repo, bad.env, 'doctor', '--probe');
  assert.equal(failed.code, 2, failed.out);
  assert.match(toon(failed).checks.find((x) => x.check === 'probe').detail, /claude did not answer: claude exited 1: You have hit your session limit; record /);
  assert.equal(toon(failed).checks.find((x) => x.check === 'probe').fix, `Check that claude is signed in and can use model claude-haiku-5-5, or set agent_config.claude.model`, 'a probe that ran and failed points at the sign-in');
  const blockedHome = join(repo, 'home');
  mkdirSync(blockedHome);
  writeFileSync(join(blockedHome, 'agents'), 'x');
  const unwritable = doctorIn(repo, { ...s.env, DONE_DONE_HOME: blockedHome }, 'doctor', '--probe');
  const unw = toon(unwritable).checks.find((x) => x.check === 'probe');
  assert.equal(unwritable.code, 0, unwritable.out);
  assert.equal(unw.status, 'ok', 'an agent that answered keeps its probe ok when only the record cannot be written');
  assert.match(unw.detail, /the call record could not be written/);
  assert.equal(doctorIn(repo, bad.env, 'doctor').code, 0);
  assert.equal(bad.calls().length, 1);
  // An explicit judge route, and bad values.
  // The user sets one agent: no auto, no fallback list.
  for (const agent of ['auto', '[codex, gemini]']) assert.match(doctor(`agent: ${agent}\n`).by('config').detail, /agent must be one of claude, codex, opencode, pi, gemini, or acp:<target>/);
  // The judge: another model of the author's agent is apart; its own model (judge.model, else agent_config) is refused unless allow_same.
  const routeCfg = (extra) => writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), `agent_config:\n  opencode: { model: opencode-go/test-model }\njudge:\n  route: answerer:opencode\n${extra}`);
  routeCfg('  model: opencode-go/muse-spark-1.3-contributor\n');
  assert.match(doctor('agent: opencode\n').by('judge_choice').detail, /^answerer:opencode \(model opencode-go\/muse-spark-1\.3-contributor; from config\) judges the author opencode \(model opencode-go\/test-model\): the author's agent at a different model$/);
  routeCfg('  model: opencode-go/test-model\n');
  const same = doctor('agent: opencode\n');
  assert.equal(same.by('judge_choice').status, 'missing');
  assert.match(same.by('judge_choice').detail, /^judge: the judge opencode \(model opencode-go\/test-model\) is the author's own agent and model \(opencode\)/);
  routeCfg('');
  assert.equal(doctor('agent: opencode\n').by('judge_choice').status, 'missing', 'no judge.model is the agent_config model, here the author\'s own: never swapped for a cheap one');
  assert.match(same.by('judge_choice').fix, /judge\.allow_same: true/);
  routeCfg('  model: opencode-go/test-model\n  allow_same: true\n');
  assert.equal(doctor('agent: opencode\n').by('judge_choice').status, 'warning', 'allow_same runs a session-only judge, and doctor says so');
  routeCfg('');
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  route: answerer:claude\n');
  assert.match(doctor('').out, /judge\.route must be claude-code \(for claude\), answerer:<agent> for one of opencode, pi, gemini, or a key route \(openai:key\)/, 'claude judges through claude-code');
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  route: answerer:acp:gemini\n');
  assert.match(doctor('').out, /judge\.route must be .*; an acp:<target> agent cannot judge, since done-done cannot send it an image/, 'an acp agent cannot judge, and the config error says why');
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  route: opencode-go\n');
  assert.match(doctor('').out, /judge\.route must be claude-code \(for claude\), answerer:<agent>/);
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  model: x\n');
  assert.equal(doctor('').by('config').status, 'ok', 'a judge.model with no route is not a config error');
  assert.match(doctor('agent: cursor\n').out, /agent must be one of claude, codex, opencode, pi, gemini/);
  assert.match(doctor('judge: auto\n').out, /judge must be a mapping/, 'judge: auto is not a spelling of the judge');
  assert.match(doctor('agent_config:\n  opencode: { model: x }\n').out, /agent_config may only be set in the global config/, 'the project file cannot pick a model');
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent_config:\n  cursor: { model: x }\n');
  assert.match(doctor('').out, /agent_config must be a map of <agent>: \{model: <string>, effort: <string>\}/);
  for (const [global, err] of [
    ['agent_config:\n  gemini: { effort: low }\n', /agent_config\.gemini\.effort: gemini has no reasoning-effort flag/],
    ['agent_config:\n  claude: { effort: turbo }\n', /agent_config\.claude\.effort must be one of minimal, low, medium, high, xhigh, max/],
    ['agent_config:\n  opencode: { model: muse }\n', /agent_config\.opencode\.model must be provider\/model/],
    ['agent_timeout: 0s\n', /agent_timeout must be a duration such as 90s, 30m or 1h/],
    ['agent_args_override:\n  claude: --verbose\n', /agent_args_override must be a map of <agent>: \[<flag>, \.\.\.\]/],
  ]) {
    writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), global);
    assert.match(doctor('').out, err);
  }
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), '');
  for (const key of ['agent_args_override: { claude: [] }', 'agent_path_override: { claude: claude }', 'acpx_path: acpx', 'agent_timeout: 5m'])
    assert.match(doctor(`${key}\n`).out, new RegExp(`${key.split(':')[0]} may only be set in the global config`), 'only agent may be set per repo, as in no-mistakes');
  assert.equal(s.calls().length, 4, 'only --probe asks the agent');
  // Without a repo config, the agent keys still come from the global config.
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\n');
  rmSync(join(repo, '.done-done.yaml'));
  const global = doctorIn(repo, s.env, 'doctor');
  assert.equal(global.code, 2, global.out);
  assert.match(toon(global).checks.find((x) => x.check === 'agent').detail, /^opencode \(model opencode-go\/muse-spark-1.3-contributor; from config\)/);
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\njudge:\n  modle: x\n');
  const broken = toon(doctorIn(repo, s.env, 'doctor'));
  assert.equal(broken.checks.find((x) => x.check === 'agent').status, 'missing');
  assert.match(broken.checks.find((x) => x.check === 'agent').detail, /unknown key judge\.modle/, 'a broken global config is named, never replaced by built-in defaults');
});

test('an acp:<target> agent runs through acpx, and doctor names acpx with its install step when it does not start', () => {
  const { repo, env } = setup();
  const s = stubAgents(env);
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  const yaml = readFileSync(join(repo, '.done-done.yaml'), 'utf8');
  const log = join(s.bin, 'acpx.jsonl');
  // A stub acpx: --version exits with `version`; exec logs how it was started and prints `events` as ACP JSON-RPC lines.
  const acpx = (version, events, exit = 0) => writeFileSync(join(s.bin, 'acpx'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') process.exit(${version});
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, stdin: readFileSync(0, 'utf8'), cwd: process.cwd() }) + '\\n');
for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));
process.exitCode = ${exit};
`, { mode: 0o755 });
  const chunk = (text) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const doctor = (extra, ...args) => {
    writeFileSync(join(repo, '.done-done.yaml'), yaml + extra);
    const r = doctorIn(repo, s.env, 'doctor', ...args);
    return { ...r, by: (n) => toon(r).checks.find((c) => c.check === n) };
  };
  // The answer arrives in message chunks after narration with braces, around a refused side request, fenced as models often do.
  acpx(0, [{ jsonrpc: '2.0', id: 0, result: {} }, chunk('I will check {config} and answer {}.\n'), chunk('Notes 🚀 {"note": "a longer narrated object than the answer", "a": 1, "b": 2, "c": 3}. '), chunk('I replaced the opening { with (. '), chunk('```json\n{"ok":'),{ jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'Method not found' } }, chunk('true}\n```'), chunk(' For example {"note": "a narrated object without the required key"}.')]);
  const ok = doctor('agent: acp:gemini\n', '--probe');
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.by('agent').detail, /^acp:gemini \(its own default model; set agent_config\.acp:gemini\.model to choose one; from config\) at .*acpx$/);
  assert.match(ok.by('probe').detail, /^acp:gemini \(its own default model; set agent_config\.acp:gemini\.model to choose one\) answered the schema question/);
  const [call] = calls();
  assert.notEqual(call.cwd, repo, 'a tool-less probe runs in a scratch dir, never the repo');
  assert.deepEqual(call.argv, ['--cwd', call.cwd, '--format', 'json', '--json-strict', '--deny-all', '--non-interactive-permissions', 'deny', 'gemini', 'exec', '--file', '-'], 'every tool is denied, and a permission prompt is denied too');
  assert.match(call.stdin, /connectivity probe[\s\S]*JSON schema[\s\S]*"required":\["ok"\]/, 'the prompt and the schema go on stdin');
  assert.ok(!call.argv.some((a) => a.includes('connectivity probe')), 'never in argv');
  const rec = JSON.parse(readFileSync(ok.by('probe').detail.match(/record (\S+)$/)[1], 'utf8'));
  assert.deepEqual([rec.agent, rec.model, rec.ok, rec.answer], ['acp:gemini', '', true, { ok: true }]);
  // claude through acpx is still claude: another agent is independent of it, and the claude-code route is not.
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  route: answerer:opencode\n');
  const auto = doctor('agent: acp:claude-code\n').by('judge_choice');
  assert.equal(auto.status, 'ok', auto.detail);
  assert.match(auto.detail, /^answerer:opencode \(.*\) judges the author acp:claude-code \(model none\): a different agent from the author/);
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  route: claude-code\n');
  assert.equal(doctor('agent: acp:claude\n').by('judge_choice').status, 'missing');
  assert.equal(doctor('agent: acp:claude-code\n').by('judge_choice').status, 'missing');
  // A model named in the global config goes to acpx ahead of the target.
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent_config:\n  acp:gemini: { model: flash-lite }\n');
  assert.equal(doctor('agent: acp:gemini\n', '--probe').code, 0);
  assert.deepEqual(calls()[1].argv.slice(8, 11), ['--model', 'flash-lite', 'gemini']);
  // An error with no answer fails the probe with the agent's own words.
  acpx(0, [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Authentication required' } }], 1);
  const failed = doctor('agent: acp:gemini\n', '--probe');
  assert.equal(failed.code, 2, failed.out);
  assert.match(failed.by('probe').detail, /acp:gemini did not answer: acp:gemini exited 1: Authentication required/);
  // acpx on PATH that does not start (a version-manager shim with no version set) is not installed: missing with the install step.
  acpx(1, []);
  const shim = doctor('agent: acp:gemini\n', '--probe');
  assert.equal(shim.code, 2, shim.out);
  assert.match(shim.by('agent').detail, /^acp:gemini \(model flash-lite; from config\): acp:gemini needs acpx, the ACP bridge, which is not startable \(.*acpx does not run\)$/);
  assert.match(shim.by('agent').fix, /npm install -g acpx/);
  assert.deepEqual([shim.by('probe').status, shim.by('probe').fix], ['missing', shim.by('agent').fix], 'a probe that never ran points at the install step');
  rmSync(join(s.bin, 'acpx'));
  assert.match(doctor('agent: acp:gemini\n').by('agent').detail, /which is not startable \(not on PATH\)$/);
  assert.equal(calls().length, 3, 'acpx is started only by --probe, beyond --version');
  // A target is one plain word, never a flag.
  assert.match(doctor('agent: acp:--help\n').out, /agent must be one of claude, codex, opencode, pi, gemini, or acp:<target>/);
});

test('history lists newest first and logs tails the step log', () => {
  const { dd } = setup();
  const a = toon(dd('verify', 'shots', '--outcome', 'home renders', '--foreground')).run_id;
  const b = toon(dd('verify', 'shots', '--outcome', 'home renders', '--foreground')).run_id;
  const h = toon(dd('history'));
  assert.deepEqual(h.history.map((x) => x.run_id), [b, a]);
  assert.equal(toon(dd('history', '--limit', '1')).history.length, 1);
  assert.equal(dd('history', '--limit', '0').code, 2);
  const l = toon(dd('logs', '--step', 'check'));
  assert.equal(l.step, 'check');
  assert.ok(l.log.join('\n').includes('pass'));
  assert.equal(dd('logs', '--step', 'nope').code, 2);
});

test('abort stops a live run and status says cancelled', async () => {
  const { dd, runningAt } = slowRepo();
  assert.equal(dd('verify', 'slow', '--outcome', 'home renders', '--no-wait').code, 4);
  const run = await runningAt('drive');
  assert.equal(dd('abort', '--run', run.run_id).code, 0);
  const s = toon(dd('status', '--run', run.run_id));
  assert.equal(s.status, 'cancelled');
  assert.equal(dd('status', '--run', run.run_id).code, 1);
  assert.ok(await groupGone(run.runner.journey_pgid), 'journey group gone');
  assert.equal(dd('abort', '--run', run.run_id).code, 1, 'second abort fails');
});

test('rerun after a killed runner reuses resolve and passes', async () => {
  const { dd, runningAt, release, runs } = slowRepo();
  assert.equal(dd('verify', 'slow', '--outcome', 'home renders', '--no-wait').code, 4);
  const run = await runningAt('drive');
  process.kill(run.runner.pid, 'SIGKILL');
  let f;
  for (let i = 0; i < 100 && (f = dd('status', '--run', run.run_id)).code === 4; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.code, 1, f.out);
  writeFileSync(release, '');
  const r = dd('rerun', '--run', run.run_id);
  assert.equal(r.code, 0, r.out);
  const s = toon(r);
  assert.equal(s.result, 'pass');
  const rerunEvent = readFileSync(join(runs, s.run_id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.rerun_of);
  assert.deepEqual(rerunEvent.reused, ['resolve']);
});

test('a rerun whose check fails does not carry the earlier receipt', () => {
  const { dd, repo } = setup();
  const a = toon(dd('verify', 'shots', '--outcome', 'home renders', '--foreground'));
  assert.equal(a.result, 'pass');
  assert.ok(a.receipt);
  rmSync(join(repo, '.proof', a.run_id, 'home.png'));
  const r = dd('rerun', '--run', a.run_id);
  const s = toon(r);
  assert.notEqual(s.result, 'pass', r.out);
  assert.equal(s.receipt, undefined);
  assert.notEqual(s.steps.find((x) => x.name === 'receipt').status, 'completed');
});

test('a rerun does not reuse a drive recorded from a dirty tree', () => {
  const t = setup('app: notes\nevidence:\n  root: .proof\n  ignore_paths: ["docs/**"]\n  allow_dirty: true\njudge:\n  enabled: false\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n');
  writeFileSync(join(t.repo, 'src', 'app.js'), 'export const app = 2;\n');
  const a = toon(t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground'));
  execFileSync('git', ['checkout', '--', 'src/app.js'], { cwd: t.repo, env: t.env, stdio: 'pipe' });
  const r = toon(t.dd('rerun', '--run', a.run_id));
  const rerunEvent = readFileSync(join(t.env.DONE_DONE_HOME, 'runs', 'notes', r.run_id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.rerun_of);
  assert.deepEqual(rerunEvent.reused, ['resolve']);
});

test('a rerun whose source record is gone starts a fresh run', () => {
  const t = setup();
  const a = toon(t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground'));
  rmSync(JSON.parse(readFileSync(join(t.env.DONE_DONE_HOME, 'runs', 'notes', a.run_id, 'run.json'), 'utf8')).record);
  const r = t.dd('rerun', '--run', a.run_id);
  assert.equal(r.code, 0, r.out);
  assert.equal(toon(r).result, 'pass');
});

test('logs reports zero lines for an empty step log', () => {
  const t = setup();
  const a = toon(t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground'));
  const r = toon(t.dd('logs', '--step', 'drive', '--run', a.run_id));
  assert.equal(r.lines, 0);
  assert.deepEqual(r.log, []);
});

test('abort on a run whose runner died still stops its orphaned journey', async () => {
  const t = setup();
  const journey = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  after(() => { try { process.kill(-journey.pid, 'SIGKILL'); } catch { /* already gone */ } });
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  const { id } = pendingRun(t, (run) => {
    run.status = 'running';
    run.runner = { pid: dead.pid, started: new Date().toISOString(), heartbeat: new Date().toISOString(), journey_pgid: journey.pid };
  });
  assert.equal(t.dd('abort', '--run', id).code, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(-journey.pid, 0), 'the orphaned journey group was signalled');
});

test('a cancelled run shows the step it was in as cancelled', () => {
  const t = setup();
  const { id } = pendingRun(t, (run) => {
    run.steps[0].status = 'running';
  });
  assert.equal(t.dd('abort', '--run', id).code, 0);
  const s = toon(t.dd('status', '--run', id));
  assert.equal(s.status, 'cancelled');
  assert.equal(s.steps[0].status, 'cancelled');
  assert.equal(s.steps[1].status, 'pending');
});

// A run as `verify` left it, rewritten to pending with no runner: the state a run is in before its runner boots.
function pendingRun(t, edit = () => {}) {
  const src = toon(t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground'));
  const id = `pending-${randomUUID()}`;
  const dir = join(t.env.DONE_DONE_HOME, 'runs', 'notes', id);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const run = JSON.parse(readFileSync(join(t.env.DONE_DONE_HOME, 'runs', 'notes', src.run_id, 'run.json'), 'utf8'));
  Object.assign(run, { run_id: id, status: 'pending', steps: run.steps.map((s) => ({ name: s.name, status: 'pending' })), created: new Date().toISOString() });
  for (const k of ['runner', 'result', 'reason', 'record', 'receipt']) delete run[k];
  edit(run);
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  return { id, dir };
}

test('a runner started for an aborted run exits without running the journey', () => {
  const t = setup();
  const { id, dir } = pendingRun(t);
  assert.equal(t.dd('abort', '--run', id).code, 0);
  const r = spawnSync(process.execPath, [CLI, '__runner', dir], { cwd: t.repo, env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).status, 'cancelled');
  assert.equal(existsSync(join(dir, 'runner.lock')), false, 'no runner took the run');
  assert.equal(existsSync(join(t.repo, '.proof', id)), false, 'the journey never ran');
});

test('a reused drive whose record cannot be read fails the drive step', () => {
  const t = setup();
  const { dir } = pendingRun(t, (run) => {
    run.steps[0].status = 'completed';
    run.steps[1].status = 'completed';
    run.record = join(t.dir, 'missing-record.json');
  });
  const r = spawnSync(process.execPath, [CLI, '__runner', dir], { cwd: t.repo, env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /^drive: /);
  assert.equal(run.steps[0].status, 'completed');
  assert.equal(run.steps[1].status, 'failed');
});

test('abort refuses when the runner pid is not confirmed as this run\'s runner', async () => {
  const t = setup();
  const unrelated = spawn('sleep', ['30'], { stdio: 'ignore' });
  after(() => unrelated.kill('SIGKILL'));
  const { id, dir } = pendingRun(t, (run) => {
    run.status = 'running';
    run.runner = { pid: unrelated.pid, started: new Date().toISOString(), heartbeat: new Date().toISOString() };
  });
  const r = t.dd('abort', '--run', id);
  const a = toon(r);
  assert.equal(r.code, 1);
  assert.match(a.reason, new RegExp(`could not confirm pid ${unrelated.pid}`));
  assert.equal(a.status, 'running');
  assert.equal(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).status, 'running');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(unrelated.signalCode, null, 'the unrelated process was not signalled');
  assert.equal(unrelated.exitCode, null, 'the unrelated process is still running');
});

test('rerun refuses a run whose runner is still open', () => {
  const t = setup();
  const { id } = pendingRun(t);
  const r = t.dd('rerun', '--run', id);
  assert.equal(r.code, 2, r.out);
  assert.match(toon(r).help[0], /abort --run/);
});

test('rerun refuses while a dead runner left its journey running, and starts no second run', async () => {
  const { dd, runs, runningAt, release } = slowRepo();
  assert.equal(dd('verify', 'slow', '--outcome', 'home and settings render', '--no-wait').code, 4);
  const run = await runningAt('drive');
  process.kill(run.runner.pid, 'SIGKILL');
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(run.runner.pid, 0);
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    const before = readdirSync(runs).length;
    const r = dd('rerun', '--run', run.run_id);
    assert.equal(r.code, 2, r.out);
    assert.match(toon(r).help[0], /status --run/);
    assert.equal(readdirSync(runs).length, before, 'no run was started');
    assert.doesNotThrow(() => process.kill(-run.runner.journey_pgid, 0), 'the orphan journey is still running');
  } finally {
    writeFileSync(release, '');
    try {
      process.kill(-run.runner.journey_pgid, 'SIGKILL');
    } catch {
      // The journey already exited.
    }
  }
});

test('attach streams a running run to its end', async () => {
  const { repo, env, release, dd } = slowRepo();
  assert.equal(dd('verify', 'slow', '--outcome', 'home renders', '--no-wait').code, 4);
  const child = spawn(process.execPath, [CLI, 'attach'], { cwd: repo, env, encoding: 'utf8' });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  await new Promise((r) => setTimeout(r, 500));
  writeFileSync(release, '');
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0, out + err);
  assert.match(err, /running/, 'events streamed to stderr');
  assert.equal(toon({ out }).result, 'pass');
});

// Stub pi, gemini and codex CLIs that log how they were started (argv, stdin, cwd) and answer like the real ones:
// pi -p --mode json streams JSONL with the answer in the assistant message_end text parts (fenced, as models
// often do); gemini -p -o json prints one object with the answer in `response` (its headless.md); codex exec --json
// streams JSONL events whose last agent_message holds the answer, after a narration message (seen live 13 Oct).
// Mode 'retry' answers garbage on the first call (counted from the log) so ask-again is exercised, 'bad'
// always does, and 'auth' fails like a signed-out CLI.
function stubPiGemini(env, answer = '{"ok":true}', mode = 'ok') {
  const e = pathEnv(env, ['ffprobe']);
  const log = join(e.PATH, 'calls.jsonl');
  const fenced = '```json\n' + answer + '\n```';
  writeFileSync(join(e.PATH, 'pi'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const attached = argv.filter((a) => a.startsWith('@')).map((a) => readFileSync(a.slice(1)).subarray(1, 4).toString());
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: 'pi', argv, stdin, attached, cwd: process.cwd() }) + '\\n');
const n = readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;
const text = ${JSON.stringify(mode)} === 'bad' || (${JSON.stringify(mode)} === 'retry' && n === 1) ? 'not json at all' : ${JSON.stringify(fenced)};
for (const t of ['session', 'agent_start', 'turn_start']) console.log(JSON.stringify({ type: t }));
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
console.log(JSON.stringify({ type: 'agent_end' }));
`, { mode: 0o755 });
  writeFileSync(join(e.PATH, 'gemini'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const policy = argv.includes('--policy') ? readFileSync(argv[argv.indexOf('--policy') + 1], 'utf8') : undefined;
const attached = (argv[1].match(/@\\S+/g) ?? []).map((a) => readFileSync(a.slice(1)).subarray(1, 4).toString());
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: 'gemini', argv, stdin, policy, attached, cwd: process.cwd() }) + '\\n');
// A signed-out gemini (seen 13 Oct): the stack of its auth error, a warning, then the one useful line in red.
if (${JSON.stringify(mode)} === 'auth') {
  process.stderr.write('Error authenticating: FatalCancellationError: Authentication cancelled by user.\\n    at initOauthClient (file:///gemini/bundle/chunk.js:1:1)\\n  exitCode: 130\\n}\\nSkill conflict detected: a skill overrides another\\n\\u001b[31mAuthentication cancelled by user.\\u001b[0m\\nUpdate available: 0.57.0\\n');
  process.exit(130);
}
process.stdout.write(JSON.stringify({ response: ${JSON.stringify(fenced)}, stats: {} }));
`, { mode: 0o755 });
  writeFileSync(join(e.PATH, 'codex'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: 'codex', argv, stdin, cwd: process.cwd() }) + '\\n');
const say = (e) => console.log(JSON.stringify(e));
say({ type: 'thread.started', thread_id: 't1' });
say({ type: 'turn.started' });
// A model a ChatGPT sign-in cannot use (seen 13 Oct): the API error comes as JSON text in an error event and turn.failed.
if (${JSON.stringify(mode)} === 'auth') {
  const message = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'x' model is not supported when using Codex with a ChatGPT account." } });
  say({ type: 'error', message });
  say({ type: 'turn.failed', error: { message } });
  process.exit(1);
}
say({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I will answer {with} the object.' } });
say({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: ${JSON.stringify(answer)} } });
say({ type: 'turn.completed', usage: {} });
`, { mode: 0o755 });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { env: e, calls };
}

test('doctor --probe asks pi on stdin (never in argv) with tools off and a scratch cwd', () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env);
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const r = doctorIn(repo, s.env, 'doctor', '--probe');
  assert.equal(r.code, 0, r.out);
  const d = toon(r);
  assert.match(d.checks.find((x) => x.check === 'agent').detail, /^pi \(its own default model; set agent_config\.pi\.model to choose one; from config\)/);
  assert.equal(d.checks.find((x) => x.check === 'probe').status, 'ok');
  const [call] = s.calls();
  assert.equal(call.agent, 'pi');
  assert.match(call.stdin, /connectivity probe/, 'the prompt goes on stdin (the schema is enforced by done-done, then asked again)');
  assert.match(call.stdin, /"required":\["ok"\]/, 'the first try already states the schema');
  assert.ok(!call.argv.some((a) => a.includes('connectivity probe')), 'never in argv');
  assert.deepEqual(call.argv, ['-p', '--mode', 'json', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files'], 'no model is passed, so pi runs its own default');
  assert.notEqual(call.cwd, repo, 'a tool-less probe runs in a scratch dir, never the repo');
  const record = d.checks.find((x) => x.check === 'probe').detail.match(/record (\S+)$/)[1];
  assert.equal(statSync(record).mode & 0o777, 0o600);
  const rec = JSON.parse(readFileSync(record, 'utf8'));
  assert.deepEqual([rec.agent, rec.model, rec.tools, rec.attempts, rec.ok, rec.answer], ['pi', '', 'none', 1, true, { ok: true }]);
  assert.ok(rec.prompt_bytes > 0 && !JSON.stringify(rec).includes('connectivity probe'), 'the record keeps no prompt text');
});

test('pi is asked again when its answer is not valid JSON, then fails after three tries', () => {
  const { repo, env } = setup();
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const once = stubPiGemini(env, '{"ok":true}', 'retry');
  const r = doctorIn(repo, once.env, 'doctor', '--probe');
  assert.equal(r.code, 0, r.out);
  assert.equal(toon(r).checks.find((x) => x.check === 'probe').status, 'ok');
  assert.equal(once.calls().length, 2, 'the bad first answer is asked again once');
  assert.match(once.calls()[1].stdin, /not valid[\s\S]*Answer with only one JSON object[\s\S]*"required":\["ok"\]/, 'the retry names what was wrong and repeats the schema');
  const record = toon(r).checks.find((x) => x.check === 'probe').detail.match(/record (\S+)$/)[1];
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).attempts, 2);
  const bad = stubPiGemini(env, '{"ok":true}', 'bad');
  const failed = doctorIn(repo, bad.env, 'doctor', '--probe');
  assert.equal(failed.code, 2, failed.out);
  assert.match(toon(failed).checks.find((x) => x.check === 'probe').detail, /did not answer with valid JSON after 3 tries/);
  assert.equal(bad.calls().length, 3, 'at most three tries');
});

test('doctor --probe asks gemini with the prompt on stdin, and reports a signed-out gemini with a sign-in fix', () => {
  const { repo, env } = setup();
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: gemini\n');
  const s = stubPiGemini(env);
  const r = doctorIn(repo, s.env, 'doctor', '--probe');
  assert.equal(r.code, 0, r.out);
  const d = toon(r);
  assert.match(d.checks.find((x) => x.check === 'agent').detail, /^gemini \(model flash-lite; from config\)/);
  assert.equal(d.checks.find((x) => x.check === 'probe').status, 'ok');
  const [call] = s.calls();
  assert.equal(call.agent, 'gemini');
  assert.match(call.stdin, /connectivity probe/);
  assert.deepEqual(call.argv, ['-p', 'Follow the instructions on stdin.', '-o', 'json', '-m', 'flash-lite', '--approval-mode', 'plan', '--policy', join(call.cwd, 'deny-all.toml'), '--skip-trust']);
  assert.equal(call.policy, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n', 'a tool-less call denies every tool, not only edits as plan mode does');
  assert.ok(!call.argv.some((a) => a.includes('connectivity probe')), 'never in argv');
  assert.notEqual(call.cwd, repo, 'a tool-less probe runs in a scratch dir, never the repo');
  const out = stubPiGemini(env, '{"ok":true}', 'auth');
  const failed = doctorIn(repo, out.env, 'doctor', '--probe');
  assert.equal(failed.code, 2, failed.out);
  const probe = toon(failed).checks.find((x) => x.check === 'probe');
  assert.equal(probe.status, 'missing');
  const record = probe.detail.match(/; record (\S+)$/)[1];
  assert.equal(probe.detail, `gemini did not answer: gemini exited 130: Authentication cancelled by user.; record ${record}`, 'one clean line: no stack, no colour codes');
  assert.match(JSON.parse(readFileSync(record, 'utf8')).stderr, /at initOauthClient[\s\S]*\u001b\[31mAuthentication cancelled/, 'the call record keeps the raw stderr');
  assert.match(JSON.parse(readFileSync(record, 'utf8')).error, /at initOauthClient[\s\S]*\u001b\[31mAuthentication cancelled/, 'the call record keeps the raw error text');
  assert.match(probe.fix, /Check that gemini is signed in and can use model flash-lite/);
});

test('doctor --probe shows codex as a warning, not a failure: codex cannot run tool-less, so it asks nothing', () => {
  const { repo, env } = setup();
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: codex\nagent_config:\n  codex: { model: gpt-test, effort: low }\n');
  const s = stubPiGemini(env);
  const r = doctorIn(repo, s.env, 'doctor', '--probe');
  assert.equal(r.code, 0, r.out);
  const d = toon(r);
  assert.match(d.checks.find((x) => x.check === 'agent').detail, /^codex \(model gpt-test; from config\) at /);
  const probe = d.checks.find((x) => x.check === 'probe');
  assert.equal(probe.status, 'warning');
  assert.match(probe.detail, /^codex cannot run tool-less: with your config\.toml it keeps its MCP tools/);
  assert.deepEqual(s.calls(), [], 'no tool-less call reaches codex');
});

test('doctor warns that pi has no permission gate', () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env);
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const d = toon(doctorIn(repo, s.env, 'doctor'));
  assert.match(d.checks.find((x) => x.check === 'agent').detail, /^pi \(its own default model; set agent_config\.pi\.model to choose one; from config\) at /);
  const gate = d.checks.find((x) => x.check === 'tool_gate');
  assert.equal(gate.status, 'warning');
  assert.equal(gate.detail, 'pi has no permission gate: every pi tool runs without approval');
});

test('agent_config.pi.model is passed to pi as --model', () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env);
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\nagent_config:\n  pi: { model: vendor/some-model }\n');
  const d = toon(doctorIn(repo, s.env, 'doctor', '--probe'));
  assert.match(d.checks.find((x) => x.check === 'agent').detail, /^pi \(model vendor\/some-model; from config\)/);
  assert.deepEqual(s.calls()[0].argv, ['-p', '--mode', 'json', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--model', 'vendor/some-model']);
});

test('gemini edit steps run with auto_edit, never yolo, and read steps stay in plan mode; codex edits only in its workspace sandbox', async () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env);
  const { askAgent } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'agents.js')).href);
  const call = { agent: 'gemini', model: 'flash-lite', path: join(s.env.PATH, 'gemini'), prompt: 'p', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, cwd: repo, timeoutMs: 60_000, record: join(s.env.PATH, 'rec.json') };
  const old = process.env.PATH;
  process.env.PATH = s.env.PATH;
  try {
    await askAgent({ ...call, tools: 'edit' });
    await askAgent({ ...call, tools: 'read' });
  } finally {
    process.env.PATH = old;
  }
  const [edit, read] = s.calls();
  assert.equal(edit.argv[edit.argv.indexOf('--approval-mode') + 1], 'auto_edit');
  assert.equal(read.argv[read.argv.indexOf('--approval-mode') + 1], 'plan');
  assert.ok(!edit.argv.includes('--skip-trust') && !read.argv.includes('--skip-trust'), 'a repo step keeps Gemini trust gate');
  // A codex edit step writes only the repo and the run's folders, and keeps the user's own codex config; a read step is refused.
  process.env.PATH = s.env.PATH;
  let refused;
  try {
    const codex = { ...call, agent: 'codex', model: 'gpt-test', path: join(s.env.PATH, 'codex') };
    await askAgent({ ...codex, tools: 'edit', dirs: ['/evidence/run-1', '/scratch'] });
    refused = await askAgent({ ...codex, tools: 'read' });
  } finally {
    process.env.PATH = old;
  }
  const [codexEdit] = s.calls().slice(2);
  assert.deepEqual(codexEdit.argv, ['exec', '--json', '--ephemeral', '-m', 'gpt-test', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '--add-dir', '/evidence/run-1', '--add-dir', '/scratch']);
  assert.equal(codexEdit.cwd, repo);
  // codex's sandbox ends a command's background processes with it, so its edit prompt says to drive within one command.
  assert.match(codexEdit.stdin, /^p\n\nYour shell sandbox ends every process a command started, background ones too, when that command ends\. So start what a task needs \(an app, a server, a browser bridge\), use it, save what it produces and stop it within one shell command/);
  assert.match(edit.stdin, /^p\n\nAnswer with only one JSON object/, 'other agents get no such note');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /^codex cannot run tool-less/);
  assert.equal(s.calls().length, 3, 'a refused read step starts no codex');
});

test('a codex edit step shows the API error codex wrote, as the other agents do', async () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env, '{"ok":true}', 'auth');
  const { askAgent } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'agents.js')).href);
  const old = process.env.PATH;
  process.env.PATH = s.env.PATH;
  let r;
  try {
    r = await askAgent({ agent: 'codex', model: 'x', path: join(s.env.PATH, 'codex'), prompt: 'p', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, cwd: repo, timeoutMs: 60_000, record: join(s.env.PATH, 'rec.json'), tools: 'edit' });
  } finally {
    process.env.PATH = old;
  }
  assert.equal(r.ok, false);
  assert.match(r.error, /is not supported when using Codex with a ChatGPT account/);
});

test('opencode read calls get a deny-all permission and no read allowance', async () => {
  const { repo, env } = setup();
  const s = stubAgents(env);
  const { askAgent } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'agents.js')).href);
  const old = process.env.PATH;
  process.env.PATH = s.env.PATH;
  try {
    await askAgent({ agent: 'opencode', model: 'm', path: join(s.env.PATH, 'opencode'), prompt: 'p', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, cwd: repo, timeoutMs: 60_000, tools: 'read', record: join(s.env.PATH, 'rec.json') });
  } finally {
    process.env.PATH = old;
  }
  assert.deepEqual(JSON.parse(s.calls()[0].permission), { '*': 'deny' });
});

test('braces in the prose before the JSON in the final answer do not break it', () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env);
  writeFileSync(join(s.env.PATH, 'pi'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(join(s.env.PATH, 'calls.jsonl'))}, JSON.stringify({ agent: 'pi', argv: process.argv.slice(2) }) + '\\n');
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Added the helper f() { return 1 }. Answer: {"ok":true}' }] } }));
`, { mode: 0o755 });
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const r = doctorIn(repo, s.env, 'doctor', '--probe');
  assert.equal(r.code, 0, r.out);
  assert.equal(toon(r).checks.find((x) => x.check === 'probe').status, 'ok');
  assert.equal(s.calls().length, 1, 'the final answer is read past the prose braces on the first try');
});

test('pi answers with its last message only, so braces in earlier narration do not break the answer', () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env);
  writeFileSync(join(s.env.PATH, 'pi'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(join(s.env.PATH, 'calls.jsonl'))}, JSON.stringify({ agent: 'pi', argv: process.argv.slice(2) }) + '\\n');
for (const text of ['Here is the code: function foo() { return 1; }', '{"ok":true}']) console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
`, { mode: 0o755 });
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const r = doctorIn(repo, s.env, 'doctor', '--probe');
  assert.equal(r.code, 0, r.out);
  assert.equal(toon(r).checks.find((x) => x.check === 'probe').status, 'ok');
  assert.equal(s.calls().length, 1, 'the final answer is accepted on the first try');
});

test('a repo step that gemini refuses as untrusted fails with the trust fix line', async () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env, '{"ok":true}', 'auth');
  const { askAgent } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'agents.js')).href);
  const old = process.env.PATH;
  process.env.PATH = s.env.PATH;
  try {
    const out = await askAgent({ agent: 'gemini', model: 'flash-lite', path: join(s.env.PATH, 'gemini'), prompt: 'p', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, cwd: repo, timeoutMs: 60_000, record: join(s.env.PATH, 'rec.json'), tools: 'edit' });
    assert.equal(out.ok, false);
    assert.match(out.error, /trust it in Gemini CLI first, then retry/);
  } finally {
    process.env.PATH = old;
  }
});

test('an edit step whose answer is not JSON is never asked again, while a tool-less probe is', async () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env, '{"ok":true}', 'bad');
  const { askAgent } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'agents.js')).href);
  const call = { agent: 'pi', model: '', path: join(s.env.PATH, 'pi'), prompt: 'p', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, cwd: repo, timeoutMs: 60_000, record: join(s.env.PATH, 'rec.json') };
  const old = process.env.PATH;
  process.env.PATH = s.env.PATH;
  try {
    const edit = await askAgent({ ...call, tools: 'edit' });
    assert.equal(edit.ok, false);
    assert.equal(s.calls().length, 1, 'the edit step ran once');
    const probe = await askAgent({ ...call, tools: 'none' });
    assert.equal(probe.ok, false);
    assert.equal(s.calls().length, 4, 'the tool-less probe is asked again up to three tries');
  } finally {
    process.env.PATH = old;
  }
});

test('maintain counts a truncated feature file as a notice, not drift', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), `# Home\n\n${'x'.repeat(20_000)}\n`);
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result, m.git_status], [0, 'clean', 'same'], r.out);
  assert.deepEqual(m.findings.map((f) => f.kind), ['truncated']);
});

test('maintain does not read host:port text as a file citation', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1;\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\nOpen api.example.com:8443 and app.js:1.\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nThe API is at api.example.com:8443.\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result, m.git_status], [0, 'clean', 'same'], r.out);
  assert.equal(m.findings?.length ?? 0, 0);
});

test('maintain blocks a dangling feature entry next to untracked symlinks', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n- [Broken](broken.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  symlinkSync(join(repo, '.agents'), join(repo, 'agents-link'));
  symlinkSync(join(repo, 'nowhere.md'), join(skill, 'features', 'broken.md'));
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result, m.git_status], [3, 'blocked', 'same'], r.out);
  assert.match(m.reason, /^coverage: .*broken\.md/);
});

test('maintain reports an untracked symlink retargeted during a run as a repo change', () => {
  const { repo, env, sh } = setup();
  const answer = JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] });
  const s = stubAgents(env, answer);
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  symlinkSync(join(repo, '.agents'), join(repo, 'agents-link'));
  // The reader points the link somewhere else: its target text is what the fingerprint must catch.
  writeFileSync(join(s.bin, 'claude'), `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv.includes('Read,Grep,Glob')) { fs.unlinkSync('agents-link'); fs.symlinkSync('src', 'agents-link'); }\nprocess.stdout.write(JSON.stringify({ structured_output: ${answer} }));\n`, { mode: 0o755 });
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result, m.git_status], [3, 'blocked', 'changed'], r.out);
  assert.match(m.reason, /^repo-changed: /);
});

test('maintain runs a reader with no user settings or MCP servers', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  assert.equal(r.code, 0, r.out);
  const reader = s.calls()[0].argv;
  assert.deepEqual([reader[reader.indexOf('--tools') + 1], reader[reader.indexOf('--setting-sources') + 1], reader.includes('--strict-mcp-config')], ['Read,Grep,Glob', '', true]);
});

test('maintain blocks on an unreadable feature file instead of crashing', { skip: process.getuid?.() === 0 && 'root reads files whatever their mode' }, () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  const home = join(skill, 'features', 'home.md');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(home, '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  chmodSync(home, 0);
  try {
    const r = doctorIn(repo, s.env, 'maintain', '--foreground');
    const m = toon(r);
    assert.deepEqual([r.code, m.result], [3, 'blocked'], r.out);
    assert.match(m.reason, /^coverage: .*home\.md: cannot be read/);
  } finally {
    chmodSync(home, 0o644);
  }
});

test('maintain blocks when a reader rewrites a file that was already modified', () => {
  const { repo, env, sh } = setup();
  const answer = JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] });
  const s = stubAgents(env, answer);
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1;\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 2;\n');
  writeFileSync(join(s.bin, 'claude'), `#!${process.execPath}\nif (process.argv.includes('Read,Grep,Glob')) require('node:fs').writeFileSync('src/app.js', 'export const app = 3;\\n');\nprocess.stdout.write(JSON.stringify({ structured_output: ${answer} }));\n`, { mode: 0o755 });
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result, m.git_status], [3, 'blocked', 'changed'], r.out);
  assert.match(m.reason, /^repo-changed: /);
});

test('maintain does not send a symlinked feature file to the agent', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const outside = mkdtempSync(join(tmpdir(), 'dd-outside-'));
  try {
    const secret = join(outside, 'creds.txt');
    writeFileSync(secret, 'SECRET-TOKEN\n');
    const skill = join(repo, '.agents', 'skills', 'verify-notes');
    mkdirSync(join(skill, 'features'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
    writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n- [Creds](creds.md)\n');
    writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
    symlinkSync(secret, join(skill, 'features', 'creds.md'));
    sh('add', '-A');
    sh('commit', '-qm', 'skill');
    const r = doctorIn(repo, s.env, 'maintain', '--foreground');
    const m = toon(r);
    assert.deepEqual([r.code, m.result, m.git_status], [3, 'blocked', 'same'], r.out);
    assert.match(m.reason, /^coverage: .*creds\.md/);
    assert.ok(s.calls().every((c) => !c.stdin.includes('SECRET-TOKEN')));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('maintain pins the read-only reader to read tools with no user settings, MCP servers or extra directories', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  assert.equal(doctorIn(repo, s.env, 'maintain', '--foreground').code, 0);
  const reader = s.calls()[0].argv;
  assert.deepEqual([reader[reader.indexOf('--tools') + 1], reader[reader.indexOf('--setting-sources') + 1], reader.includes('--strict-mcp-config')], ['Read,Grep,Glob', '', true]);
  assert.deepEqual(['--add-dir', '--permission-mode', '--dangerously-skip-permissions', '--allowedTools'].filter((f) => reader.includes(f)), []);
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\n');
  assert.equal(doctorIn(repo, s.env, 'maintain', '--foreground').code, 0);
  const permission = JSON.parse(s.calls().find((c) => c.agent === 'opencode').permission);
  assert.deepEqual(permission, { '*': 'deny' });
});

test('maintain refuses a skill reached through a symlinked ancestor', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const outside = mkdtempSync(join(tmpdir(), 'dd-ancestor-'));
  try {
    const skill = join(outside, 'skills', 'verify-notes');
    mkdirSync(join(skill, 'features'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
    writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
    writeFileSync(join(skill, 'features', 'home.md'), 'SECRET-NOTE\n');
    symlinkSync(outside, join(repo, '.agents'));
    sh('add', '-A');
    sh('commit', '-qm', 'skill');
    const r = doctorIn(repo, s.env, 'maintain', '--foreground');
    const m = toon(r);
    assert.deepEqual([r.code, m.result], [3, 'blocked'], r.out);
    assert.match(m.reason, /^locate: .*is reached through a symlink/);
    assert.doesNotMatch(m.help.join('\n'), /done-done init/);
    assert.deepEqual(s.calls(), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('maintain blocks a symlinked features folder and never checks the index behind it', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const outside = mkdtempSync(join(tmpdir(), 'dd-features-'));
  try {
    writeFileSync(join(outside, 'README.md'), '# features\n\n- [Home](home.md)\n- [Home](home.md)\n');
    writeFileSync(join(outside, 'home.md'), '# Home\n');
    const skill = join(repo, '.agents', 'skills', 'verify-notes');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
    symlinkSync(outside, join(skill, 'features'));
    sh('add', '-A');
    sh('commit', '-qm', 'skill');
    const r = doctorIn(repo, s.env, 'maintain', '--foreground');
    const m = toon(r);
    assert.deepEqual([r.code, m.result], [3, 'blocked'], r.out);
    assert.match(m.reason, /^coverage: .*features/);
    assert.equal(m.findings.some((f) => f.kind === 'duplicate'), false, 'the index behind the link is not read');
    assert.deepEqual(s.calls(), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('maintain blocks a symlinked CHECKLIST.md with a dead link and reads nothing through it', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const outside = mkdtempSync(join(tmpdir(), 'dd-checklist-'));
  try {
    writeFileSync(join(outside, 'CHECKLIST.md'), '# Checklist\n\n- [Gone](gone.md)\n');
    const skill = join(repo, '.agents', 'skills', 'verify-notes');
    mkdirSync(join(skill, 'features'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
    writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
    writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
    symlinkSync(join(outside, 'CHECKLIST.md'), join(skill, 'CHECKLIST.md'));
    sh('add', '-A');
    sh('commit', '-qm', 'skill');
    const r = doctorIn(repo, s.env, 'maintain', '--foreground');
    const m = toon(r);
    assert.deepEqual([r.code, m.result], [3, 'blocked'], r.out);
    assert.match(m.reason, /^coverage: .*CHECKLIST\.md/);
    assert.equal(m.findings.some((f) => f.kind === 'dead-link'), false, 'nothing is read through the link');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('maintain gives a pi reader no tools and puts the cited source in its prompt', () => {
  const { repo, env, sh } = setup();
  const s = stubPiGemini(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1; // CITED-SOURCE-LINE\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nThe app starts at src/app.js:1.\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  assert.equal(r.code, 0, r.out);
  const reader = s.calls().find((c) => c.stdin.includes('Feature file'));
  assert.ok(reader.argv.includes('--no-tools'), reader.argv.join(' '));
  assert.ok(!reader.argv.includes('-t'), 'no read tools for pi');
  assert.match(reader.stdin, /Cited source src\/app\.js:\n1: export const app = 1; \/\/ CITED-SOURCE-LINE/);
});

test('maintain sends a pi reader only the source its prompt shows, not a citation past the reader window', () => {
  const { repo, env, sh } = setup();
  const s = stubPiGemini(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1; // LATE-CITED-LINE\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), `# Home\n\n${'x'.repeat(20_000)}\nThe app starts at src/app.js:1.\n`);
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  assert.equal(r.code, 0, r.out);
  const reader = s.calls().find((c) => c.stdin.includes('Feature file'));
  assert.doesNotMatch(reader.stdin, /Cited source src\/app\.js/);
});

test('maintain names at most 500 recently changed paths to reconcile and says how many it left out', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  mkdirSync(join(repo, 'churn'));
  for (let i = 0; i < 600; i++) writeFileSync(join(repo, 'churn', `f${i}.txt`), `${i}\n`);
  sh('add', '-A');
  sh('commit', '-qm', 'skill and churn');
  assert.equal(doctorIn(repo, s.env, 'maintain', '--foreground').code, 0);
  const reconcile = s.calls().find((c) => c.stdin.includes('Recently changed files')).stdin;
  const line = reconcile.split('\n').find((l) => l.startsWith('Recently changed files'));
  const header = line.slice(0, line.indexOf(': '));
  const listed = line.slice(line.indexOf(': ') + 2).split(', ');
  assert.equal(listed.length, 500);
  assert.match(header, /most recent first; \d+ older paths left out/);
});

test('maintain lists a reader drift item with a string line as unverified, not as a finding', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ recipe: 'open it', drift: [{ claim: 'app is 2', why: 'it is 1', file: 'src/app.js', line: '1' }], recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1;\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [0, 'clean'], r.out);
  assert.match(m.unverified.join('\n'), /drift has an item in an unexpected shape/, r.out);
});

test('maintain gives a pi reader the cited source for a ./ path citation', () => {
  const { repo, env, sh } = setup();
  const s = stubPiGemini(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1; // CITED-SOURCE-LINE\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nThe app starts at ./src/app.js:1.\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  assert.equal(r.code, 0, r.out);
  const reader = s.calls().find((c) => c.stdin.includes('Feature file'));
  assert.match(reader.stdin, /Cited source src\/app\.js:\n1: export const app = 1; \/\/ CITED-SOURCE-LINE/);
});

test('maintain says a cited symlink that points outside the repo is outside the repository', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const outside = mkdtempSync(join(tmpdir(), 'dd-leaf-'));
  try {
    writeFileSync(join(outside, 'secrets.txt'), 'token\n');
    symlinkSync(join(outside, 'secrets.txt'), join(repo, 'link.txt'));
    const skill = join(repo, '.agents', 'skills', 'verify-notes');
    mkdirSync(join(skill, 'features'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\nSee link.txt:1.\n');
    writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
    writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
    sh('add', '-A');
    sh('commit', '-qm', 'skill');
    const r = doctorIn(repo, s.env, 'maintain', '--foreground');
    const m = toon(r);
    assert.deepEqual([r.code, m.result], [1, 'drift'], r.out);
    assert.match(m.findings.find((f) => f.kind === 'citation').what, /link\.txt is outside the repository/, r.out);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('maintain does not wait on a cited path that is a named pipe; it is a citation finding', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'pipes'));
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\nSee pipes/x.sh:3.\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  assert.equal(spawnSync('mkfifo', [join(repo, 'pipes', 'x.sh')]).status, 0);
  const r = spawnSync(process.execPath, [CLI, 'maintain', '--foreground'], { cwd: repo, env: s.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, null, 'the run never opened the pipe');
  const m = toon({ code: r.status, out: r.stdout + r.stderr });
  assert.deepEqual([r.status, m.result], [1, 'drift'], r.stdout + r.stderr);
  assert.ok(m.findings.some((f) => f.kind === 'citation' && /pipes\/x\.sh is not a file/.test(f.what)));
});

test('maintain caps the source a tool-less reader gets at 60,000 characters and says what it left out', () => {
  const { repo, env, sh } = setup();
  const s = stubPiGemini(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  for (const d of ['a', 'b', 'c', 'd', ...Array.from({ length: 24 }, (_, i) => `e${i}`)]) {
    mkdirSync(join(repo, d), { recursive: true });
    writeFileSync(join(repo, d, 'index.ts'), `export const ${d} = 1;\n${'x'.repeat(19_000)}\n`);
  }
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nSee index.ts:1.\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [0, 'clean'], r.out);
  assert.ok(m.findings.some((f) => f.kind === 'truncated' && /25 cited files were left out/.test(f.what) && /, \+5 more\)/.test(f.what)), r.out);
  const reader = s.calls().find((c) => c.stdin.includes('Feature file'));
  assert.equal(reader.stdin.split('Cited source ').length - 1, 3, 'three of the 28 cited files fit under the cap');
  assert.ok(reader.stdin.length < 70_000);
  assert.match(reader.stdin, /so 25 cited files are left out: /);
  const named = reader.stdin.match(/left out: ([^\]]*)\]/)[1].split(', ');
  assert.equal(named.length, 21, 'the notice names 20 files and counts the rest');
  assert.equal(named[20], '+5 more');
});

test('maintain blocks an unreadable features folder instead of failing the run', { skip: process.getuid?.() === 0 && 'root reads files whatever their mode' }, () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  chmodSync(join(skill, 'features'), 0o000);
  try {
    const r = doctorIn(repo, s.env, 'maintain', '--foreground');
    const m = toon(r);
    assert.deepEqual([r.code, m.result], [3, 'blocked'], r.out);
    assert.match(m.reason, /^coverage: /);
  } finally {
    chmodSync(join(skill, 'features'), 0o755);
  }
});

test('maintain reports a citation under an unreadable folder as a citation finding, not a failed run', { skip: process.getuid?.() === 0 && 'root reads files whatever their mode' }, () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(join(repo, 'locked'));
  writeFileSync(join(repo, 'locked', 'x.js'), 'export const x = 1;\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\nSee locked/x.js:1.\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  chmodSync(join(repo, 'locked'), 0o000);
  try {
    const r = doctorIn(repo, s.env, 'maintain', '--foreground');
    const m = toon(r);
    assert.deepEqual([r.code, m.result], [1, 'drift'], r.out);
    assert.ok(m.findings.some((f) => f.kind === 'citation' && /locked\/x\.js is not a file/.test(f.what)), r.out);
  } finally {
    chmodSync(join(repo, 'locked'), 0o755);
  }
});

test('maintain does not follow a committed symlink folder out of the repo to count a cited file', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const outside = mkdtempSync(join(tmpdir(), 'dd-notes-'));
  try {
    writeFileSync(join(outside, 'secrets.txt'), 'token\n');
    symlinkSync(outside, join(repo, 'notes'));
    const skill = join(repo, '.agents', 'skills', 'verify-notes');
    mkdirSync(join(skill, 'features'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\nSee notes/secrets.txt:99.\n');
    writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
    writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
    sh('add', '-A');
    sh('commit', '-qm', 'skill');
    const r = doctorIn(repo, s.env, 'maintain', '--foreground');
    const m = toon(r);
    assert.deepEqual([r.code, m.result], [1, 'drift'], r.out);
    const cite = m.findings.find((f) => f.kind === 'citation');
    assert.match(cite.what, /notes\/secrets\.txt is outside the repository/, r.out);
    assert.doesNotMatch(cite.what, /has \d+ lines/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('maintain blocks a verify skill that resolves outside the repo and reads nothing from it', () => {
  const { repo, env, sh } = setup('app: notes\nevidence:\n  root: .proof\nskill: ../outside\n');
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const outside = join(repo, '..', 'outside');
  mkdirSync(join(outside, 'features'), { recursive: true });
  writeFileSync(join(outside, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(outside, 'features', 'README.md'), '# features\n');
  writeFileSync(join(outside, 'features', 'home.md'), '# Home\n');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.equal(m.result, 'blocked', r.out);
  assert.match(r.out, /outside the repository/, r.out);
});

test('maintain reports a cited line in an empty file as a citation finding with 0 lines', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  writeFileSync(join(repo, 'docs', 'empty.md'), '');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\nSee docs/empty.md:1.\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [1, 'drift'], r.out);
  assert.match(m.findings.find((f) => f.kind === 'citation').what, /docs\/empty\.md has 0 lines/, r.out);
});

test('maintain blocks a dangling symlink folder in the skill', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  symlinkSync('../missing', join(skill, 'refs'));
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.equal(m.result, 'blocked', r.out);
  assert.deepEqual(m.findings.map((f) => [f.kind, f.file]), [['coverage', '.agents/skills/verify-notes/refs']], r.out);
});

test('maintain reads a cited path whose first segment starts with two dots as inside the repo', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(join(repo, '..cache'));
  writeFileSync(join(repo, '..cache', 'app.js'), 'export const app = 1;\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\nSee ..cache/app.js:1.\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [0, 'clean'], r.out);
});

test('maintain fingerprints an untracked file whose name has a newline', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  writeFileSync(join(repo, 'notes\nv2.txt'), 'untracked\n');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result, m.git_status], [0, 'clean', 'same'], r.out);
});

test('maintain reports a dead link, a wrong file:line and drift from read-only readers, and changes nothing', () => {
  const { repo, env, sh } = setup();
  const answer = JSON.stringify({
    recipe: 'import src/app.js',
    drift: [{ claim: 'app is 2', why: 'it is 1', file: 'src/app.js', line: 1 }, { claim: 'made up', why: 'no such line', file: 'src/app.js', line: 50 }],
    recipes: [{ state: 'fresh', features: ['home.md'], steps: ['open it'] }], missing: [{ file: 'src/app.js', why: 'new surface' }, { file: 'src/gone.js', why: 'not in the churn list' }],
  });
  const s = stubAgents(env, answer);
  const dd = (...args) => doctorIn(repo, s.env, ...args);
  const none = dd('maintain', '--foreground');
  assert.equal(none.code, 3, none.out);
  assert.deepEqual([toon(none).result, toon(none).help[0]], ['blocked', 'Create the verify skill: done-done init']);
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\nThe map: [features](features/README.md). See https://example.com:443/x and localhost:3000.\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n- [Search](search.md)\n- [Home again](home.md#top)\n');
  mkdirSync(join(repo, 'src', 'café'));
  writeFileSync(join(repo, 'src', 'café', 'gate.js'), 'export const gate = 1;\n');
  writeFileSync(join(skill, 'features', 'home.md'), `# Home\n\nSource: src/app.js:1, and the old src/app.js:40.\nAlso app.js:1, app.js:40, ghost.js:2 and gate.js:1.\nLong note: ${'x'.repeat(20_000)}\n`);
  writeFileSync(join(skill, 'features', 'extra.md'), '# Extra\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const status = () => sh('status', '--porcelain', '--untracked-files=all').toString() + sh('rev-parse', 'HEAD');
  const before = status();
  const r = dd('maintain', '--foreground', '--full');
  assert.equal(r.code, 1, r.out);
  const m = toon(r);
  assert.deepEqual([m.kind, m.result, m.git_status], ['maintain', 'drift', 'same']);
  const at = (f) => `${f.kind} ${f.file.replace('.agents/skills/verify-notes/', '')}${f.line ? `:${f.line}` : ''}`;
  assert.deepEqual(m.findings.map(at), [
    'dead-link features/README.md:4', 'duplicate features/README.md:5', 'unlisted features/README.md', 'truncated features/home.md',
    'citation features/home.md:3', 'citation features/home.md:4', 'citation features/home.md:4', 'drift features/extra.md', 'drift features/home.md', 'unmapped src/app.js',
  ], 'a reader citation that does not exist and a missing file outside the churn list are not findings');
  assert.match(m.findings[4].what, /cites src\/app\.js:40, but src\/app\.js has 1 lines/);
  assert.match(m.findings[5].what, /cites app\.js:40, but src\/app\.js has 1 lines/);
  assert.match(m.findings[6].what, /cites ghost\.js:2, but no tracked file is named ghost\.js/);
  assert.equal(status(), before, 'maintain changed nothing');
  // One fresh read-only reader per feature file runs in the repo; the reconcile call has no tools and runs elsewhere.
  const calls = s.calls();
  assert.deepEqual(calls.map((c) => c.argv[c.argv.indexOf('--tools') + 1]), ['Read,Grep,Glob', 'Read,Grep,Glob', '']);
  assert.deepEqual(calls.map((c) => c.cwd === repo), [true, true, false]);
  assert.match(calls[0].stdin, /extra\.md/);
  const run = join(env.DONE_DONE_HOME, 'runs', 'notes', m.run_id);
  assert.deepEqual(readdirSync(join(run, 'agents')).sort(), ['1-reader-extra.json', '2-reader-home.json', '3-reconcile.json']);
  assert.equal(toon(dd('history')).history[0].kind, 'maintain');
  assert.match(toon(dd('logs', '--step', 'reconcile')).log.join('\n'), /src\/app\.js:50: src\/app\.js has 1 lines/);
  // With no agent the readers do not run, but the plain citation checks still report the planted bad file:line.
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: gemini\n');
  const noAgent = toon(dd('maintain', '--foreground', '--full'));
  assert.deepEqual([noAgent.result, noAgent.git_status], ['blocked', 'same']);
  assert.match(noAgent.reason, /^source-wave: no agent/);
  assert.deepEqual(noAgent.findings.map(at).slice(3), ['citation features/home.md:3', 'citation features/home.md:4', 'citation features/home.md:4']);
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\n');
  // A reader that writes into the repo makes the run blocked.
  writeFileSync(join(s.bin, 'claude'), `#!${process.execPath}\nrequire('node:fs').writeFileSync('stray.txt', '');\nprocess.stdout.write(JSON.stringify({ structured_output: ${answer} }));\n`, { mode: 0o755 });
  const changed = toon(dd('maintain', '--foreground'));
  assert.deepEqual([changed.result, changed.git_status], ['blocked', 'changed']);
  assert.match(changed.reason, /^repo-changed: /);
});

test('maintain gives an acp reader no tools and the cited source in its prompt', () => {
  const { repo, env, sh } = setup();
  const answer = JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] });
  const s = stubAgents(env);
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: acp:claude-code\n');
  const log = join(s.bin, 'acpx.jsonl');
  writeFileSync(join(s.bin, 'acpx'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') process.exit(0);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, stdin: readFileSync(0, 'utf8') }) + '\\n');
console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(answer)} } } } }));
`, { mode: 0o755 });
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1; // ACP-CITED-LINE\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nThe app starts at src/app.js:1.\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  assert.equal(r.code, 0, r.out);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const reader = calls.find((c) => c.stdin.includes('Feature file'));
  assert.ok(reader.argv.includes('--deny-all'), reader.argv.join(' '));
  assert.match(reader.stdin, /Cited source src\/app\.js:\n1: export const app = 1; \/\/ ACP-CITED-LINE/);
});

test('maintain checks and sends a tracked symlink to an in-repo file as that file', () => {
  const { repo, env, sh } = setup();
  const s = stubPiGemini(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(repo, 'CLAUDE.md'), '# Rules\n// LINK-CITED-LINE\n');
  symlinkSync('CLAUDE.md', join(repo, 'AGENTS.md'));
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\nSee AGENTS.md:2.\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nThe rules are in AGENTS.md:2.\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground', '--full');
  const m = toon(r);
  assert.deepEqual([r.code, m.result, m.findings?.length ?? 0], [0, 'clean', 0], r.out);
  const reader = s.calls().find((c) => c.stdin.includes('Feature file'));
  assert.match(reader.stdin, /Cited source AGENTS\.md:\n1: # Rules\n2: \/\/ LINK-CITED-LINE/);
});

test('maintain treats an untracked repo path as a citation problem in the skill and as unverified drift', () => {
  const { repo, env, sh } = setup();
  const answer = JSON.stringify({ drift: [{ claim: 'scratch is right', why: 'the source has it', file: 'scratch/notes.js', line: 1 }], recipe: 'open it', recipes: [], missing: [] });
  const s = stubAgents(env, answer);
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\nScratch is at scratch/notes.js:1.\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  mkdirSync(join(repo, 'scratch'), { recursive: true });
  writeFileSync(join(repo, 'scratch', 'notes.js'), 'export const notes = 1;\n');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground', '--full');
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [1, 'drift'], r.out);
  assert.deepEqual(m.findings.map((f) => f.kind), ['citation'], 'the untracked file is not a drift finding');
  assert.match(m.findings[0].what, /cites scratch\/notes\.js:1, but scratch\/notes\.js is not a tracked file/);
  assert.match(m.unverified.join('\n'), /home\.md: drift "scratch is right" cites scratch\/notes\.js:1: scratch\/notes\.js is not a tracked file/);
});

test('maintain checks a link whose target has balanced parentheses and reports only the dead one', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(skill, 'notes', '(auth)'), { recursive: true });
  writeFileSync(join(skill, 'notes', '(auth)', 'login.md'), '# Login\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\n[Login](notes/(auth)/login.md) and [Gone](gone/(auth)/login.md).\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [1, 'drift'], r.out);
  assert.deepEqual(m.findings.map((f) => f.what), ['links to gone/(auth)/login.md, which does not exist'], r.out);
});

test('maintain checks a bracketed or parenthesized file:line citation and sends that file to a tool-less reader', () => {
  const { repo, env, sh } = setup();
  const s = stubPiGemini(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'app', '[slug]'), { recursive: true });
  mkdirSync(join(repo, 'app', '(auth)'), { recursive: true });
  writeFileSync(join(repo, 'app', '[slug]', 'page.tsx'), 'export default 1;\n');
  writeFileSync(join(repo, 'app', '(auth)', 'login.tsx'), 'export const Login = 1; // BRACKET-CITED-LINE\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nThe page is app/[slug]/page.tsx:10, and login is app/(auth)/login.tsx:1. Run handler(login.tsx:1) or foo[page.tsx:1].\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [1, 'drift'], r.out);
  assert.deepEqual(m.findings.map((f) => f.what), ['cites app/[slug]/page.tsx:10, but app/[slug]/page.tsx has 1 lines'], r.out);
  const reader = s.calls().find((c) => c.stdin.includes('Feature file'));
  assert.ok(reader.stdin.includes('Cited source app/(auth)/login.tsx:\n1: export const Login = 1; // BRACKET-CITED-LINE'), reader.stdin);
});

test('maintain checks a citation of a bracketed file name like pages/[id].tsx and reports a wrong line', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(join(repo, 'pages'), { recursive: true });
  writeFileSync(join(repo, 'pages', '[id].tsx'), 'export default 1;\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nThe detail page is pages/[id].tsx:10.\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [1, 'drift'], r.out);
  assert.deepEqual(m.findings.map((f) => f.what), ['cites pages/[id].tsx:10, but pages/[id].tsx has 1 lines'], r.out);
});

test('maintain leaves an unreadable cited file out of the reader source and names it, without blocking', { skip: process.getuid?.() === 0 && 'root reads files whatever their mode' }, () => {
  const { repo, env, sh } = setup();
  const s = stubPiGemini(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: pi\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'secret.js'), 'export const secret = 1;\n');
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1; // READABLE-CITED-LINE\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nThe secret is in src/secret.js:1 and the app is in src/app.js:1.\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  chmodSync(join(repo, 'src', 'secret.js'), 0o000);
  let r;
  try {
    r = doctorIn(repo, s.env, 'maintain', '--foreground');
  } finally {
    chmodSync(join(repo, 'src', 'secret.js'), 0o644);
  }
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [1, 'drift'], r.out);
  assert.ok(!m.findings.some((f) => f.kind === 'coverage'), r.out);
  const reader = s.calls().find((c) => c.stdin.includes('Feature file'));
  assert.ok(reader.stdin.includes('Cited source src/app.js:\n1: export const app = 1; // READABLE-CITED-LINE'), reader.stdin);
  assert.match(reader.stdin, /\[truncated: .*left out: src\/secret\.js\]/, reader.stdin);
});

test('maintain does not name a file that was untracked since the window as recently changed', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [{ file: 'secrets/.env', why: 'a feature should cover it' }] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  mkdirSync(join(repo, 'secrets'), { recursive: true });
  writeFileSync(join(repo, 'secrets', '.env'), 'TOKEN=1\n');
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill and env');
  sh('rm', '-q', '--cached', 'secrets/.env');
  writeFileSync(join(repo, '.gitignore'), 'secrets/\n');
  sh('add', '-A');
  sh('commit', '-qm', 'untrack env');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground');
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [0, 'clean'], r.out);
  assert.match(m.unverified.join('\n'), /missing secrets\/\.env: not in the churn list/, r.out);
});

test('maintain blocks the source wave for gemini, which cannot read tool-less, and still runs the plain checks', () => {
  const { repo, env, sh } = setup();
  const s = stubPiGemini(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: gemini\n');
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n\n[Gone](gone.md)\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const r = doctorIn(repo, s.env, 'maintain', '--foreground', '--full');
  const m = toon(r);
  assert.deepEqual([r.code, m.result], [3, 'blocked'], r.out);
  assert.match(m.reason, /^coverage: .*gemini cannot read tool-less yet/, r.out);
  assert.deepEqual(m.findings.map((f) => f.kind), ['dead-link', 'coverage'], r.out);
  assert.equal(s.calls().length, 0, 'no reader or reconcile call reaches gemini');
});

test('rerun refuses a maintain run with a usage error that points to done-done maintain', () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env, JSON.stringify({ drift: [], recipe: 'open it', recipes: [], missing: [] }));
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const id = toon(doctorIn(repo, s.env, 'maintain', '--foreground')).run_id;
  const re = spawnSync(process.execPath, [CLI, 'rerun', '--run', id], { cwd: repo, env: s.env, encoding: 'utf8' });
  assert.equal(re.status, 2, re.stdout + re.stderr);
  assert.match(toon({ out: re.stdout }).error, /is a maintain run, which cannot be rerun/);
  assert.match(toon({ out: re.stdout }).help[0], /done-done maintain$/);
});

test('abort of a running maintain run also ends its agent child', async () => {
  const { repo, env, sh } = setup();
  const s = stubAgents(env);
  const pidFile = join(s.bin, 'agent.pid');
  writeFileSync(join(s.bin, 'claude'), `#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => {}, 30_000);
`, { mode: 0o755 });
  const skill = join(repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n');
  sh('add', '-A');
  sh('commit', '-qm', 'skill');
  const id = toon(doctorIn(repo, s.env, 'maintain', '--no-wait')).run_id;
  for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const agent = Number(readFileSync(pidFile, 'utf8'));
  const ab = spawnSync(process.execPath, [CLI, 'abort', '--run', id], { cwd: repo, env: { ...s.env, PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(ab.status, 0, ab.stdout + ab.stderr);
  assert.ok(await groupGone(agent), 'the agent child outlived the aborted run');
});

// auto_fix: the opencode author reads and fixes the skill, the pi judge triages; the stub reads its mode from a file.
function fixSetup(autoFix) {
  const t = setup(`app: notes\njudge:\n  enabled: false\n${autoFix === undefined ? '' : `auto_fix:\n  maintain: ${autoFix}\n`}`);
  const e = pathEnv(t.env, []);
  const log = join(e.PATH, 'calls.jsonl');
  const stub = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const argv = process.argv.slice(2);
const pi = argv[0] === '-p';
const prompt = pi ? readFileSync(0, 'utf8') : readFileSync(argv[argv.indexOf('-f') + 1], 'utf8');
const mode = readFileSync(${JSON.stringify(join(e.PATH, 'mode'))}, 'utf8').trim();
const role = pi ? 'judge' : /You fix the verification skill/.test(prompt) ? 'fixer' : /read-only source reader/.test(prompt) ? 'reader' : 'reconcile';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role, cwd: process.cwd(), argv, prompt }) + '\\n');
let answer;
if (role === 'judge') {
  const ids = JSON.parse(prompt.trim().split('\\n').filter((l) => l.startsWith('{')).pop()).required;
  const p = mode === 'product' ? { skill: 0.02, product: 0.97, unclear: 0.01 } : { skill: 0.97, product: 0.02, unclear: 0.01 };
  answer = Object.fromEntries(ids.map((id) => [id, { probabilities: p, rationale: 'r', personReason: mode === 'product' ? 'the source looks broken' : 'the rename is deliberate' }]));
} else if (role === 'fixer') {
  const f = '.agents/skills/verify-notes/features/home.md';
  writeFileSync(f, readFileSync(f, 'utf8').replace('OLD', 'NEW'));
  if (mode === 'outside') writeFileSync('src/app.js', 'export const app = 2;\\n');
  if (mode === 'move') require('node:child_process').execFileSync('git', ['mv', 'src/app.js', '.agents/skills/verify-notes/app.js']);
  answer = { summary: 'renamed the title', blocker: '' };
} else if (role === 'reader') {
  const [file, line] = readFileSync(${JSON.stringify(join(e.PATH, 'cite'))}, 'utf8').trim().split(':');
  answer = { drift: /Feature file[\\s\\S]*OLD/.test(prompt.split('Cited source')[0]) ? [{ claim: 'the title is OLD', why: 'the source names it NEW', file, line: Number(line) }] : [], recipe: 'open home' };
} else answer = { recipes: [], missing: [] };
const text = JSON.stringify(answer);
if (pi) console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
else console.log(JSON.stringify({ type: 'text', part: { type: 'text', text } }));
`;
  for (const b of ['opencode', 'pi']) writeFileSync(join(e.PATH, b), stub, { mode: 0o755 });
  writeFileSync(join(e.PATH, 'mode'), 'good');
  writeFileSync(join(e.PATH, 'cite'), 'src/app.js:1');
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\nagent_config:\n  opencode: { model: opencode-go/author }\njudge:\n  route: answerer:pi\n  model: pi/judge\n');
  const skill = join(t.repo, '.agents', 'skills', 'verify-notes');
  mkdirSync(join(skill, 'features'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# verify-notes\n');
  writeFileSync(join(skill, 'features', 'README.md'), '# features\n\n- [Home](home.md)\n');
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nThe title is OLD. See src/app.js:1.\n');
  t.sh('add', '-A');
  t.sh('commit', '-qm', 'skill');
  const git = (...a) => t.sh(...a).toString().trim();
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const maintain = () => {
    const r = doctorIn(t.repo, { ...e, PATH: `${e.PATH}:${dirname(process.execPath)}` }, 'maintain', '--foreground');
    return { r, m: toon(r) };
  };
  return { ...t, e, calls, git, maintain, mode: (m) => writeFileSync(join(e.PATH, 'mode'), m), branches: () => git('branch', '--list', 'done-done/*') };
}

test('maintain with auto_fix 0 reports drift only: no judge, no fixer, no branch', () => {
  const t = fixSetup(0);
  const { r, m } = t.maintain();
  assert.deepEqual([r.code, m.result], [1, 'drift'], r.out);
  assert.deepEqual(t.calls().map((c) => c.role), ['reader', 'reconcile']);
  assert.equal(t.branches(), '');
  assert.match(m.help.join('\n'), /auto_fix: \{ maintain: 2 \}/);
});

test('maintain with auto_fix fixes the skill in one skill-only commit on a done-done branch and leaves the user branch alone', () => {
  const t = fixSetup(2);
  const head = t.git('rev-parse', 'HEAD');
  const { r, m } = t.maintain();
  assert.deepEqual([r.code, m.result], [0, 'changed'], r.out);
  assert.deepEqual(t.calls().map((c) => c.role), ['reader', 'reconcile', 'judge', 'fixer', 'reader', 'reconcile']);
  const fixer = t.calls().find((c) => c.role === 'fixer');
  assert.notEqual(fixer.cwd, t.repo, 'the fixer edits a done-done worktree, never the checkout');
  assert.equal(m.fix.branch, `done-done/maintain-${m.run_id}`);
  assert.equal(t.git('rev-parse', 'HEAD'), head, 'the user branch did not move');
  assert.equal(t.git('status', '--porcelain'), '', 'the checkout is untouched');
  assert.equal(t.git('rev-list', '--count', `${head}..${m.fix.branch}`), '1');
  assert.equal(t.git('diff', '--name-only', head, m.fix.branch), '.agents/skills/verify-notes/features/home.md');
  assert.match(t.git('show', `${m.fix.branch}:.agents/skills/verify-notes/features/home.md`), /The title is NEW/);
  assert.equal(t.git('worktree', 'list').split('\n').length, 1, 'the done-done worktree is removed');
});

test('maintain with auto_fix drops a fix that edits outside the skill folder and makes no branch', () => {
  const t = fixSetup(2);
  t.mode('outside');
  const { r, m } = t.maintain();
  assert.deepEqual([r.code, m.result], [3, 'blocked'], r.out);
  assert.match(m.reason, /^fix: opencode changed files outside \.agents\/skills\/verify-notes\/ \(src\/app\.js\)/);
  assert.equal(t.branches(), '');
  assert.equal(readFileSync(join(t.repo, 'src', 'app.js'), 'utf8'), 'export const app = 1;\n');
  assert.equal(t.git('worktree', 'list').split('\n').length, 1);
});

test('maintain with auto_fix drops a fix that moves a product file into the skill folder, even staged', () => {
  const t = fixSetup(2);
  t.mode('move');
  const head = t.git('rev-parse', 'HEAD');
  const { r, m } = t.maintain();
  assert.deepEqual([r.code, m.result], [3, 'blocked'], r.out);
  assert.match(m.reason, /^fix: opencode changed files outside \.agents\/skills\/verify-notes\/ \(.*src\/app\.js/);
  assert.equal(t.branches(), '');
  assert.equal(t.git('rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(t.repo, 'src', 'app.js'), 'utf8'), 'export const app = 1;\n');
});

test('maintain with auto_fix does not fix a checkout with uncommitted changes to a tracked file', () => {
  const t = fixSetup(2);
  writeFileSync(join(t.repo, 'src', 'app.js'), 'export const app = 2;\n');
  const { r, m } = t.maintain();
  assert.deepEqual([r.code, m.result], [3, 'blocked'], r.out);
  assert.match(m.reason, /^dirty: uncommitted changes to tracked files \(src\/app\.js\)/);
  assert.deepEqual(m.findings.map((f) => f.kind), ['drift', 'dirty']);
  assert.deepEqual(t.calls().map((c) => c.role), ['reader', 'reconcile'], 'no judge and no fixer run');
  assert.equal(t.branches(), '');
});

test('maintain with auto_fix stops and asks when the judge says the product may be wrong', () => {
  const t = fixSetup(2);
  t.mode('product');
  const { r, m } = t.maintain();
  assert.deepEqual([r.code, m.result], [3, 'blocked'], r.out);
  assert.match(m.reason, /^ask-user: .*\(F1\)/);
  assert.deepEqual(m.findings.map((f) => [f.kind, f.action]), [['drift', 'ask-user']]);
  assert.ok(!t.calls().some((c) => c.role === 'fixer'), 'no fixer runs on an ask-user finding');
  assert.equal(t.branches(), '');
  assert.match(m.help[0], /Ask the user/);
});

test('maintain with auto_fix on a clean skill ends clean with no branch and no judge', () => {
  const t = fixSetup(2);
  writeFileSync(join(t.repo, '.agents', 'skills', 'verify-notes', 'features', 'home.md'), '# Home\n\nThe title is NEW. See src/app.js:1.\n');
  t.sh('commit', '-qam', 'fresh');
  const { r, m } = t.maintain();
  assert.deepEqual([r.code, m.result], [0, 'clean'], r.out);
  assert.deepEqual(t.calls().map((c) => c.role), ['reader', 'reconcile']);
  assert.equal(t.branches(), '');
});

test('maintain with auto_fix refuses a judge that is the fixer\'s own agent at any model, even with judge.allow_same', () => {
  const t = fixSetup(2);
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\nagent_config:\n  opencode: { model: opencode-go/author }\njudge:\n  route: answerer:opencode\n  model: opencode-go/author\n  allow_same: true\n');
  const { r, m } = t.maintain();
  assert.equal(r.code, 2, r.out);
  assert.match(m.error, /the judge is never the agent that did the work; judge\.allow_same does not apply to auto_fix/);
  assert.match(m.help[0], /done-done init --judge <agent> --judge-model <model>/);
  // The fixer's agent at another model is the same agent, so it is refused too.
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\nagent_config:\n  opencode: { model: opencode-go/author }\njudge:\n  route: answerer:opencode\n  model: opencode-go/other\n');
  const other = t.maintain();
  assert.equal(other.r.code, 2, other.r.out);
  assert.match(other.m.error, /the judge opencode \(model opencode-go\/other\) is the fixer's own agent \(opencode\) at any model/);
  assert.deepEqual(t.calls(), [], 'no run starts, so no reader, judge or fixer is called');
  assert.equal(t.branches(), '');
});

test('maintain with auto_fix triages a bare file name with the first file that has the cited line', () => {
  const t = fixSetup(2);
  mkdirSync(join(t.repo, 'api'), { recursive: true });
  mkdirSync(join(t.repo, 'web'), { recursive: true });
  writeFileSync(join(t.repo, 'api', 'app.js'), 'export const api = 1;\n');
  writeFileSync(join(t.repo, 'web', 'app.js'), 'one\ntwo\nthree\nfour\nweb-marker-five\nsix\n');
  writeFileSync(join(t.repo, '.agents', 'skills', 'verify-notes', 'features', 'home.md'), '# Home\n\nThe title is OLD. See app.js:5.\n');
  writeFileSync(join(t.e.PATH, 'cite'), 'app.js:5');
  t.sh('add', '-A');
  t.sh('commit', '-qm', 'two app.js files');
  const { r, m } = t.maintain();
  assert.equal(m.result, 'changed', r.out);
  const judge = t.calls().find((c) => c.role === 'judge');
  assert.match(judge.prompt, /web-marker-five/, 'the judge sees the file with the cited line');
  assert.doesNotMatch(judge.prompt, /export const api/, 'the judge does not see the other same-name file');
});

test('maintain with auto_fix leaves out a cited file the numbered source would push past the 60,000 cap', () => {
  const t = fixSetup(0);
  const body = 'ab\n'.repeat(6666);
  for (const n of ['one', 'two', 'three']) writeFileSync(join(t.repo, `${n}.txt`), body);
  writeFileSync(join(t.repo, '.agents', 'skills', 'verify-notes', 'features', 'home.md'), '# Home\n\nThe notes are in one.txt:1, two.txt:1 and three.txt:1.\n');
  t.sh('add', '-A');
  t.sh('commit', '-qm', 'three notes');
  const { r, m } = t.maintain();
  assert.deepEqual([r.code, m.result], [0, 'clean'], r.out);
  const left = m.findings.find((f) => f.kind === 'truncated');
  assert.match(left?.what ?? '', /1 cited files were left out \(three\.txt\)/);
});

for (const ready of ['url: http://127.0.0.1:$DONE_DONE_PORT/health', 'command: curl -sf $DONE_DONE_BASE_URL/'])
test(`an instance (ready ${ready.split(':')[0]}) serves the journey on its own port; the journey keeps the caller HOME, only the app runs isolated`, () => {
  const t = setup(`app: notes\njudge:\n  enabled: false\nevidence:\n  root: .proof\ninstance:\n  command: node server.mjs\n  ready:\n    ${ready}\n  ready_timeout: 15s\njourneys:\n  probe:\n    command: curl -sf $DONE_DONE_BASE_URL/ > $DONE_DONE_EVIDENCE_ROOT/reply.txt && echo "port=$DONE_DONE_PORT home=$HOME base=$DONE_DONE_BASE_URL" >> $DONE_DONE_EVIDENCE_ROOT/reply.txt\n`);
  writeFileSync(join(t.repo, 'server.mjs'), `import {createServer} from 'node:http';\nimport {writeSync} from 'node:fs';\nwriteSync(1, 'instance-marker\\ninstance-home=' + process.env.HOME + '\\n');\ncreateServer((q,s)=>s.writeHead(200).end('ok')).listen(Number(process.env.DONE_DONE_PORT),'127.0.0.1');\n`);
  t.sh('add', '-A');
  t.sh('commit', '-qm', 'instance fixture');
  const r = t.dd('run', 'probe');
  assert.equal(r.code, 0, r.out);
  const id = toon(r).run_id;
  const reply = readFileSync(join(t.repo, '.proof', id, 'reply.txt'), 'utf8');
  const port = reply.match(/port=(\d+)/)[1];
  assert.ok(reply.includes(`home=${process.env.HOME} `), 'the journey keeps the caller HOME');
  assert.match(reply, new RegExp(`base=http://127.0.0.1:${port}`));
  assert.notEqual(spawnSync('curl', ['-sf', `http://127.0.0.1:${port}/`], { timeout: 8000 }).status, 0, 'the instance stops at run end');
  const runFolder = join(t.env.DONE_DONE_HOME, 'runs', 'notes', id);
  const appLog = readFileSync(join(runFolder, 'logs', 'instance.log'), 'utf8');
  assert.match(appLog, /instance-marker/, 'the app output goes to instance.log in the run folder');
  assert.match(appLog, /instance-home=.*done-done-instance-[^/\n]*\/instance-home\/home/, 'the app runs with its own HOME');
  assert.ok(!readdirSync(join(t.repo, '.proof'), { recursive: true }).some((n) => String(n).endsWith('instance.log')), 'never with the evidence');
});

test('a verify whose instance never becomes ready marks its drive step failed', () => {
  const t = setup('app: notes\njudge:\n  enabled: false\nevidence:\n  root: .proof\ninstance:\n  command: node hang.mjs\n  ready:\n    command: exit 1\n  ready_timeout: 2s\njourneys:\n  probe:\n    command: echo hi > $DONE_DONE_EVIDENCE_ROOT/out.txt\n');
  writeFileSync(join(t.repo, 'hang.mjs'), 'console.log("hang-marker");\nsetInterval(()=>{}, 1000);\n');
  t.sh('add', '-A');
  t.sh('commit', '-qm', 'hang fixture');
  const r = t.dd('verify', 'probe', '--outcome', 'home renders', '--foreground');
  assert.equal(r.code, 1, r.out);
  const run = JSON.parse(readFileSync(join(t.env.DONE_DONE_HOME, 'runs', 'notes', toon(r).run_id, 'run.json'), 'utf8'));
  assert.equal(run.steps.find((s) => s.name === 'drive').status, 'failed');
  assert.match(readFileSync(join(t.env.DONE_DONE_HOME, 'runs', 'notes', toon(r).run_id, 'logs', 'instance.log'), 'utf8'), /hang-marker/, 'a failed readiness wait shows the app output in the run folder');
});

test('an instance ready url that is an empty string is refused', () => {
  const t = setup('app: notes\njudge:\n  enabled: false\nevidence:\n  root: .proof\ninstance:\n  command: node hang.mjs\n  ready:\n    url: ""\njourneys:\n  probe:\n    command: echo hi\n');
  const r = t.dd('run', 'probe');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /needs exactly one of ready\.url and ready\.command/);
});

for (const [ready, why] of [['url: http://127.0.0.1:$DONE_DONE_PORT/health', /GET .* never returned 2xx/], ['command: sleep 60', /readiness command never exited 0/]])
test(`an unreadied instance (ready ${ready.split(':')[0]}) fails the run with its reason and is killed`, () => {
  const t = setup();
  writeFileSync(join(t.repo, '.done-done.yaml'), `app: notes\njudge:\n  enabled: false\nevidence:\n  root: .proof\ninstance:\n  command: node hang.mjs\n  ready:\n    ${ready}\n  ready_timeout: 2s\njourneys:\n  probe:\n    command: echo hi > $DONE_DONE_EVIDENCE_ROOT/out.txt\n`);
  writeFileSync(join(t.repo, 'hang.mjs'), `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(join(t.dir, 'inst.pid'))}, String(process.pid));\nsetInterval(()=>{}, 1000);\n`);
  t.sh('add', '-A');
  t.sh('commit', '-qm', 'hang fixture');
  const began = performance.now();
  const r = t.dd('run', 'probe');
  assert.ok(performance.now() - began < 20000, 'a hung readiness probe is killed at the timeout');
  assert.equal(r.code, 1, r.out);
  assert.match(toon(r).reason, /instance not ready within 2s/);
  assert.match(toon(r).reason, why);
  assert.throws(() => process.kill(Number(readFileSync(join(t.dir, 'inst.pid'), 'utf8')), 0), 'the instance group is killed');
});

// auto_fix.verify: the journey fails while src/app.js says BUG; the opencode stub fixes it, and also writes the file named in `extra`.
test('verify with auto_fix fixes the product on a done-done branch, and never fixes a dirty checkout or keeps a fix that touches the skill, config or tests', () => {
  const t = setup('app: notes\nevidence:\n  root: .proof\n  ignore_paths: ["docs/**"]\njudge:\n  enabled: false\nauto_fix:\n  verify: 2\njourneys:\n  shots:\n    command: node shot.mjs\n');
  const e = pathEnv(t.env, []);
  writeFileSync(join(t.repo, 'shot.mjs'), `import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';\nif (readFileSync('src/app.js', 'utf8').includes('BUG')) process.exit(1);\nmkdirSync(process.env.DONE_DONE_EVIDENCE_ROOT, { recursive: true });\ncopyFileSync(${JSON.stringify(join(t.dir, 'screen.png'))}, process.env.DONE_DONE_EVIDENCE_ROOT + '/home.png');\n`);
  writeFileSync(join(t.repo, 'src', 'app.js'), 'export const title = "BUG";\n');
  t.sh('add', '-A');
  t.sh('commit', '-qm', 'a broken title');
  writeFileSync(join(e.PATH, 'opencode'), `#!${process.execPath}
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const extra = readFileSync(${JSON.stringify(join(e.PATH, 'extra'))}, 'utf8');
appendFileSync(${JSON.stringify(join(e.PATH, 'calls'))}, process.cwd() + '\\n');
writeFileSync('src/app.js', 'export const title = "Notes";\\n');
if (extra) mkdirSync(require('node:path').dirname(extra), { recursive: true }), writeFileSync(extra, 'changed\\n');
console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: JSON.stringify({ summary: 'fixed the title', blocker: '' }) } }));
`, { mode: 0o755 });
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\nagent_config:\n  opencode: { model: opencode-go/author }\n');
  const [head, git] = [t.head(), (...a) => t.sh(...a).toString().trim()];
  const off = /^fix: opencode changed the verify skill, \.done-done\.yaml, a test file or a test-runner config, which a fix never changes/;
  for (const [extra, dirty, code, reason] of [
    ['test/home.test.js', false, 1, off], ['src/app_test.go', false, 1, off], ['test_app.py', false, 1, off], ['spec/home_spec.rb', false, 1, off],
    ['tests/home.js', false, 1, off], ['__tests__/home.js', false, 1, off], ['e2e/home.js', false, 1, off], ['src/app.test.js', false, 1, off], ['src/app.spec.ts', false, 1, off],
    ['app_test.py', false, 1, off], ['vitest.config.ts', false, 1, off], ['playwright.config.ts', false, 1, off], ['jest.config.js', false, 1, off],
    ['cypress.config.ts', false, 1, off], ['cypress.json', false, 1, off], ['.done-done.yaml', false, 1, off], ['.agents/skills/verify-notes/SKILL.md', false, 1, off],
    ['', true, 1, /^dirty: uncommitted changes to tracked files \(docs\/guide\.md\)/],
    ['', false, 1, /^your HEAD failed; the fix passes, on done-done\/verify-/],
  ]) {
    writeFileSync(join(e.PATH, 'extra'), extra);
    if (dirty) writeFileSync(join(t.repo, 'docs', 'guide.md'), '# guide, edited\n');
    const r = doctorIn(t.repo, { ...e, PATH: `${e.PATH}:${dirname(process.execPath)}` }, 'verify', 'shots', '--outcome', 'the home screen shows the title Notes', '--foreground');
    assert.deepEqual([r.code, toon(r).reason?.match(reason)?.[0] !== undefined], [code, true], `${extra || (dirty ? 'dirty' : 'fix')}: ${r.out}`);
    if (dirty) t.sh('checkout', '--', 'docs/guide.md');
    assert.equal(git('worktree', 'list').split('\n').length, 1, 'the done-done worktree is removed');
  }
  const calls = readFileSync(join(e.PATH, 'calls'), 'utf8').trim().split('\n');
  assert.deepEqual([calls.length, calls.includes(t.repo)], [18, false], 'no fixer on the dirty checkout; the fixer edits a done-done worktree, never the checkout');
  const branch = git('branch', '--list', 'done-done/*').trim();
  assert.deepEqual([git('rev-parse', 'HEAD'), git('status', '--porcelain'), git('diff', '--name-only', head, branch)], [head, '', 'src/app.js'], 'one fix on its own branch; the user branch and checkout are untouched');
});

const MATRIXED = `app: notes
judge:
  enabled: false
evidence:
  root: .proof
  ignore_paths: ["docs/**"]
matrix:
  theme: [light, dark]
  width: [390, 1280]
journeys:
  cells:
    command: node make-cells.mjs
`;
// A stub journey proving the cell reached it: it refuses without its env, then runs `then`.
const matrixed = (yaml, needs, then) => {
  const t = setup(yaml);
  writeFileSync(join(t.repo, 'make-cells.mjs'), `import { copyFileSync, mkdirSync } from 'node:fs';
const root = process.env.DONE_DONE_EVIDENCE_ROOT;
const { DONE_DONE_THEME: theme, DONE_DONE_WIDTH: width, DONE_DONE_FORM: form, DONE_DONE_CELL: cell } = process.env;
if (${needs}) { console.error('missing cell env'); process.exit(1); }
mkdirSync(root, { recursive: true });
${then(t)}
`);
  t.sh('add', '-A'); t.sh('commit', '-qm', 'matrix journey');
  return t;
};
// Captures its cell's own shot (distinct bytes per cell), refusing without the full cell env.
const shot = (cells) => (t) => {
  cells.forEach((s, i) => writeFileSync(join(t.dir, `${s}.png`), screen(i)));
  return `copyFileSync(${JSON.stringify(t.dir)} + '/' + cell + '.png', root + '/home.' + cell + '.png');`;
};

test('a matrix run captures every cell with its env and suffix in the manifest', () => {
  const t = matrixed(MATRIXED, "!theme || !width || form !== '' || !cell", shot(['light.390w', 'light.1280w', 'dark.390w', 'dark.1280w']));
  const d = toon(t.dd('run', 'cells'));
  assert.equal(d.result, 'pass');
  assert.deepEqual(d.matrix.cells.map((c) => c.suffix).sort(), ['dark.1280w', 'dark.390w', 'light.1280w', 'light.390w']);
  for (const c of d.matrix.cells) assert.equal(c.files.length, 1, `${c.cell} names its capture`);
  assert.deepEqual(d.matrix.skipped, []);
});

test('a matrix skip drops the partial cell and records its reason', () => {
  const yaml = MATRIXED.replace('  width: [390, 1280]\n', '').replace('journeys:', '  skip:\n    - theme: dark\n      reason: dark ships later\njourneys:');
  const t = matrixed(yaml, "!theme || width !== '' || form !== '' || !cell", shot(['light']));
  const d = toon(t.dd('run', 'cells'));
  assert.deepEqual(d.matrix.cells.map((c) => c.cell), ['theme=light']);
  assert.equal(d.matrix.cells[0].files.length, 1);
  assert.deepEqual(d.matrix.skipped, [{ cell: 'theme=dark', reason: 'dark ships later' }]);
});

test('a matrix skip that drops every cell or matches no cell is refused when the config is read', () => {
  const all = MATRIXED.replace('  width: [390, 1280]\n', '').replace('  theme: [light, dark]', '  theme: [dark]').replace('journeys:', '  skip:\n    - theme: dark\n      reason: ships later\njourneys:');
  const unmatched = MATRIXED.replace('journeys:', '  skip:\n    - form: phone\n      reason: no form axis\njourneys:');
  for (const [yaml, why] of [[all, 'every cell is skipped, so there is nothing to capture'], [unmatched, 'skip form=phone matches no cell'], [MATRIXED.replace('[light, dark]', '[light, dark.hc]'), 'dark.hc']]) {
    const r = setup(yaml).dd('run', 'cells'); assert.equal(r.code, 2, r.out); assert.ok(r.out.includes(why), r.out);
  }
});

test('the check fails naming a matrix cell with no capture', () => {
  const t = matrixed(MATRIXED.replace('  width: [390, 1280]\n', '').replace('[light, dark]', '[light, dark, dark-hc]'), "!theme || width !== '' || !cell", (t) => `if (theme !== 'dark') copyFileSync(${JSON.stringify(t.dir)} + (theme === 'light' ? '/screen.png' : '/screen2.png'), root + '/home.' + theme + '.png');`);
  const run = toon(t.dd('run', 'cells'));
  const r = t.dd('check', '--outcome', 'home renders light', `.proof/${run.run_id}/home.light.png`, `.proof/${run.run_id}/home.dark-hc.png`);
  assert.equal(r.code, 1, r.out);
  assert.equal(toon(r).findings.length, 1, r.out);
  assert.match(toon(r).findings[0].why, /cell theme=dark has no capture: name one file \*dark\*/);
});

test('without a matrix block a run carries no manifest and sets no cell env', () => {
  const t = setup();
  writeFileSync(join(t.repo, 'plain.mjs'), `import { copyFileSync, mkdirSync } from 'node:fs';\nif (['DONE_DONE_THEME', 'DONE_DONE_WIDTH', 'DONE_DONE_FORM', 'DONE_DONE_CELL'].some((k) => process.env[k] !== undefined)) process.exit(1);\nconst root = process.env.DONE_DONE_EVIDENCE_ROOT;\nmkdirSync(root, { recursive: true });\ncopyFileSync(${JSON.stringify(join(t.dir, 'screen.png'))}, root + '/plain.png');\n`);
  appendFileSync(join(t.repo, '.done-done.yaml'), '  plain:\n    command: node plain.mjs\n');
  t.sh('add', '-A'); t.sh('commit', '-qm', 'plain journey');
  const r = t.dd('run', 'plain');
  assert.equal(r.code, 0, r.out);
  assert.equal(toon(r).matrix, undefined);
});

test('one verify run captures every matrix cell, and status shows the manifest', () => {
  const t = matrixed(MATRIXED, "!theme || !width || form !== '' || !cell", shot(['light.390w', 'light.1280w', 'dark.390w', 'dark.1280w']));
  const s = toon(t.dd('verify', 'cells', '--outcome', 'home renders in every cell', '--foreground'));
  assert.equal(s.result, 'pass');
  assert.equal(s.matrix.cells.length, 4);
  assert.deepEqual(s.matrix.skipped, []);
  assert.equal(toon(t.dd('status')).matrix.cells.length, 4);
  const rec = JSON.parse(readFileSync(join(t.repo, '.proof', '.done-done', 'runs', `${s.run_id}.json`), 'utf8'));
  assert.equal(rec.matrix.cells.length, 4, 'the run record keeps the manifest');
});

const GUARDED = `app: notes
judge:
  enabled: false
evidence:
  root: .proof
  ignore_paths: ["docs/**"]
inputs: ["data/**"]
journeys:
  shots:
    command: node make-shots.mjs \${RUN_ID}
  edit:
    command: node make-shots.mjs \${RUN_ID} && echo tampered >> data/seed.json
  add:
    command: node make-shots.mjs \${RUN_ID} && echo new > data/extra.json
  remove:
    command: node make-shots.mjs \${RUN_ID} && rm data/seed.json
`;
// A repo with a committed data file watched by the input guard.
const guarded = (yaml = GUARDED) => {
  const t = setup(yaml);
  mkdirSync(join(t.repo, 'data'), { recursive: true });
  writeFileSync(join(t.repo, 'data', 'seed.json'), '{"token":"secret-value-xyz"}\n');
  t.sh('add', '-A'); t.sh('commit', '-qm', 'data file');
  return t;
};
const guardRun = (t, journey) => join(t.env.DONE_DONE_HOME, 'runs', 'notes', journey, 'run.json');

test('an honest drive leaves the watched inputs alone and passes, keeping the hash lists', () => {
  const t = guarded();
  const s = toon(t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground'));
  assert.equal(s.result, 'pass');
  const run = JSON.parse(readFileSync(guardRun(t, s.run_id), 'utf8'));
  const want = createHash('sha256').update(readFileSync(join(t.repo, 'data', 'seed.json'))).digest('hex');
  assert.deepEqual(run.guarded.before, [{ path: 'data/seed.json', sha256: want }]);
  assert.deepEqual(run.guarded.after, run.guarded.before, 'the run record keeps the before/after hash lists');
});

test('a drive that edits a watched input fails naming the path, never its contents', () => {
  const t = guarded();
  const r = t.dd('verify', 'edit', '--outcome', 'home renders', '--foreground');
  assert.equal(r.code, 1, r.out);
  assert.match(toon(r).reason, /input guard: data\/seed\.json: changed during the drive/);
  assert.ok(!r.out.includes('secret-value-xyz'), 'file contents are never printed');
  const run = JSON.parse(readFileSync(guardRun(t, toon(r).run_id), 'utf8'));
  assert.notEqual(run.guarded.before[0].sha256, run.guarded.after[0].sha256);
});

test('a drive that adds or removes a watched file fails naming it', () => {
  const added = guarded();
  const a = added.dd('verify', 'add', '--outcome', 'home renders', '--foreground');
  assert.equal(a.code, 1, a.out);
  assert.match(toon(a).reason, /input guard: data\/extra\.json: appeared during the drive/);
  const removed = guarded();
  const d = removed.dd('verify', 'remove', '--outcome', 'home renders', '--foreground');
  assert.equal(d.code, 1, d.out);
  assert.match(toon(d).reason, /input guard: data\/seed\.json: disappeared during the drive/);
});

test('without an inputs key the guard stays off and the run behaves as before', () => {
  const t = guarded(GUARDED.replace('inputs: ["data/**"]\n', ''));
  const a = t.dd('verify', 'add', '--outcome', 'home renders', '--foreground');
  assert.equal(a.code, 0, a.out, 'an added file with no inputs key still passes');
  assert.equal(JSON.parse(readFileSync(guardRun(t, toon(a).run_id), 'utf8')).guarded, undefined);
  const e = t.dd('verify', 'edit', '--outcome', 'home renders', '--foreground');
  assert.equal(e.code, 1, e.out);
  assert.match(toon(e).reason, /tracked files have uncommitted changes/, 'an edited file still fails only at the receipt, as before');
  assert.ok(!e.out.includes('input guard'), 'the guard says nothing with no inputs key');
});

test('a directory pattern with a trailing slash or a leading ./ still guards its files', () => {
  for (const pattern of ['./data/', 'data/']) {
    const t = guarded(GUARDED.replace('inputs: ["data/**"]', `inputs: ["${pattern}"]`));
    const e = t.dd('verify', 'edit', '--outcome', 'home renders', '--foreground');
    assert.equal(e.code, 1, e.out);
    assert.match(toon(e).reason, /input guard: data\/seed\.json: changed during the drive/, pattern);
  }
});

test('a watched input the repo git-ignores is still guarded by its name', () => {
  const t = setup(GUARDED);
  mkdirSync(join(t.repo, 'data'), { recursive: true });
  writeFileSync(join(t.repo, 'data', 'seed.json'), '{"token":"secret-value-xyz"}\n');
  writeFileSync(join(t.repo, '.gitignore'), 'data/\n');
  t.sh('add', '-A'); t.sh('commit', '-qm', 'ignored data');
  const e = t.dd('verify', 'edit', '--outcome', 'home renders', '--foreground');
  assert.equal(e.code, 1, e.out);
  assert.match(toon(e).reason, /input guard: data\/seed\.json: changed during the drive/);
});

test('an inputs path that leaves the worktree or names the repo root is refused at config time', () => {
  for (const pattern of ['../outside.txt', './']) {
    const t = guarded(GUARDED.replace('inputs: ["data/**"]', `inputs: ["${pattern}"]`));
    const r = t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground');
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /inputs must be a list of repo-relative paths or globs/, pattern);
  }
});

test('a watched input under a symlinked parent that points outside the repo fails naming it', () => {
  const t = guarded(GUARDED.replace('inputs: ["data/**"]', 'inputs: ["linkdir/seed.json"]'));
  mkdirSync(join(dirname(t.repo), 'outdir'));
  writeFileSync(join(dirname(t.repo), 'outdir', 'seed.json'), '{}\n');
  symlinkSync(join(dirname(t.repo), 'outdir'), join(t.repo, 'linkdir'));
  const r = t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /input guard: linkdir\/seed\.json links outside the repo/);
});

test('an input-guard failure is never handed to the fixer', () => {
  const t = guarded(GUARDED.replace('inputs: ["data/**"]', 'inputs: ["data/**"]\nauto_fix:\n  verify: 1'));
  mkdirSync(t.env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\n');
  const e = pathEnv(t.env, []);
  const calls = join(e.PATH, 'calls');
  symlinkSync(process.execPath, join(e.PATH, 'node'));
  writeFileSync(join(e.PATH, 'opencode'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'fixer\\n');\nprocess.exit(1);\n`, { mode: 0o755 });
  const s = spawnSync(process.execPath, [CLI, 'verify', 'edit', '--outcome', 'home renders', '--foreground'], { cwd: t.repo, env: e, encoding: 'utf8' });
  const r = { code: s.status, out: s.stdout + s.stderr };
  assert.equal(toon(r).result, 'fail', r.out);
  assert.match(toon(r).reason, /check: input guard: data\/seed\.json: changed during the drive/);
  assert.equal(existsSync(calls), false, 'the fixer is never started for a guard failure');
});

test('a watched symlink that points outside the repo fails the run naming it', () => {
  const t = guarded();
  writeFileSync(join(dirname(t.repo), 'outside.json'), '{}\n');
  symlinkSync(join(dirname(t.repo), 'outside.json'), join(t.repo, 'data', 'escape.json'));
  const r = t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /input guard: data\/escape\.json links outside the repo/);
});

test('a watched input that cannot be read fails the run naming it, never passes',{ skip: process.getuid?.() === 0 }, () => {
  const t = guarded();
  chmodSync(join(t.repo, 'data', 'seed.json'), 0o000);
  const r = t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /input guard: cannot read data\/seed\.json/);
});

test('a rerun whose watched inputs changed drives again instead of reusing the source guard', () => {
  const t = guarded(`${GUARDED}  tamper:\n    command: node make-shots.mjs \${RUN_ID} && echo tampered >> fixtures/seed.json\n`);
  mkdirSync(join(t.repo, 'fixtures'));
  writeFileSync(join(t.repo, 'fixtures', 'seed.json'), 'seed\n');
  t.sh('update-index', '--skip-worktree', '.done-done.yaml');
  const a = t.dd('verify', 'tamper', '--outcome', 'home renders', '--foreground');
  assert.equal(toon(a).result, 'pass', a.out);
  writeFileSync(join(t.repo, '.done-done.yaml'), `${GUARDED.replace('inputs: ["data/**"]', 'inputs: ["data/**", "fixtures/seed.json"]')}  tamper:\n    command: node make-shots.mjs \${RUN_ID} && echo tampered >> fixtures/seed.json\n`);
  const r = t.dd('rerun', '--run', toon(a).run_id);
  assert.equal(r.code, 1, r.out);
  assert.match(toon(r).reason, /input guard: fixtures\/seed\.json: changed during the drive/);
});

test('a glob input still guards in a repo whose file listing exceeds 1 MiB', () => {
  const t = guarded();
  mkdirSync(join(t.repo, 'scratch'));
  for (let i = 0; i < 12000; i++) writeFileSync(join(t.repo, 'scratch', `${String(i).padStart(5, '0')}-${'x'.repeat(90)}.txt`), '');
  const s = toon(t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground'));
  assert.equal(s.result, 'pass', s.reason);
  const run = JSON.parse(readFileSync(guardRun(t, s.run_id), 'utf8'));
  assert.deepEqual(run.guarded.before.map((f) => f.path), ['data/seed.json']);
});

test('a glob input watches a dotfile under it like any other file', () => {
  const t = guarded(`${GUARDED}  dot:\n    command: node make-shots.mjs \${RUN_ID} && echo tampered >> data/.cache.json\n`);
  writeFileSync(join(t.repo, 'data', '.cache.json'), '{}\n');
  t.sh('add', '-A'); t.sh('commit', '-qm', 'dotfile');
  const d = t.dd('verify', 'dot', '--outcome', 'home renders', '--foreground');
  assert.equal(d.code, 1, d.out);
  assert.match(toon(d).reason, /input guard: data\/\.cache\.json: changed during the drive/);
});

test('a watched input that is a symlink to a folder fails the run naming it, never passes empty', () => {
  const t = guarded(GUARDED.replace('inputs: ["data/**"]', 'inputs: ["linkdir"]'));
  symlinkSync(join(t.repo, 'data'), join(t.repo, 'linkdir'));
  t.sh('add', '-A'); t.sh('commit', '-qm', 'folder link');
  const r = t.dd('verify', 'shots', '--outcome', 'home renders', '--foreground');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /input guard: linkdir reaches linkdir, a symlink to a folder/);
});

test('a non-ASCII untracked input is guarded by its real name', () => {
  const t = guarded(`${GUARDED}  accent:\n    command: node make-shots.mjs \${RUN_ID} && echo new > "data/café.json"\n`);
  const a = t.dd('verify', 'accent', '--outcome', 'home renders', '--foreground');
  assert.equal(a.code, 1, a.out);
  assert.match(toon(a).reason, /input guard: data\/café\.json: appeared during the drive/);
});

test('a rerun that reuses the drive keeps guarding it, so a guarded change still fails', () => {
  const t = guarded();
  const a = t.dd('verify', 'add', '--outcome', 'home renders', '--foreground');
  assert.equal(a.code, 1, a.out);
  const r = t.dd('rerun', '--run', toon(a).run_id);
  assert.equal(r.code, 1, r.out);
  assert.match(toon(r).reason, /input guard: data\/extra\.json: appeared during the drive/);
});

// DOM assertions: a two-cell matrix whose journey writes each cell's capture and, when given, its page-check record.
const CLEAN = { url: 'http://127.0.0.1/home', overflow: false, overflowing: [], console_errors: [], failed_requests: [] };
const BROKEN = { ...CLEAN, overflow: true, overflowing: ['div#wide'], console_errors: ['boom'], failed_requests: [{ url: 'http://127.0.0.1/x.js', status: 404 }] };
const domVerify = (dom, records, capture = shot(['light', 'dark'])) => {
  const t = matrixed(MATRIXED.replace('  width: [390, 1280]\n', '').replace('journeys:', `${dom}journeys:`), '!cell', (t) =>
    `import { writeFileSync } from 'node:fs';\n${capture(t)}\nconst rec = ${JSON.stringify(records)}[cell];\nif (rec) writeFileSync(root + '/home.' + cell + '.dom.json', JSON.stringify(rec));`);
  const r = t.dd('verify', 'cells', '--outcome', 'home renders in every theme', '--foreground');
  // verify names only the first finding; the check of the same files lists them all.
  const c = t.dd('check', '--outcome', 'home renders in every theme', ...toon(r).evidence);
  return { r, d: toon(r), why: toon(c).findings?.map((f) => f.why) ?? [] };
};

test('a dom block passes when every capture has a clean page-check record', () => {
  const { r, d } = domVerify('dom:\n', { light: CLEAN, dark: { ...CLEAN, failed_requests: [{ url: 'http://127.0.0.1/moved.js', status: 304 }] } });
  assert.equal(d.result, 'pass', r.out);
});

test('a dom block fails naming the capture and each overflow, console error and failed request', () => {
  const { r, d, why } = domVerify('dom: {}\n', { light: CLEAN, dark: BROKEN });
  assert.equal(r.code, 1, r.out);
  assert.equal(d.result, 'fail');
  assert.deepEqual(why.filter((w) => w.includes('home.dark.png')).map((w) => w.replace(/^.*home\.dark\.png: /, '')), [
    'http://127.0.0.1/home overflows the viewport horizontally (div#wide)',
    'http://127.0.0.1/home console error: boom',
    'http://127.0.0.1/home request failed (404): http://127.0.0.1/x.js',
  ]);
  assert.equal(why.length, 3, r.out);
});

test('dom allow lists and fail_on_overflow: false suppress those issues', () => {
  const { r, d } = domVerify('dom:\n  allow_console: ["^bo+m$"]\n  allow_requests: ["x\\\\.js$"]\n  fail_on_overflow: false\n', { light: CLEAN, dark: BROKEN });
  assert.equal(d.result, 'pass', r.out);
});

test('a dom block fails each matrix cell whose capture has no page-check record, and refuses a bad block', () => {
  const { r, why } = domVerify('dom:\n', { light: CLEAN });
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(why.filter((w) => /page-check/.test(w)).map((w) => w.replace(/^.*\/(home\.)/, '$1')), ['home.dark.png: no page-check record home.dark.dom.json next to it (the dom block needs one per captured screen)']);
  const bad = setup(MATRIXED.replace('journeys:', 'dom:\n  allow_console: ["("]\njourneys:')).dd('run', 'cells');
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /dom allow_console: \\"\(\\" is not a valid regular expression/);
});

test('a dom block asks for a page-check record of a gif capture too', () => {
  const gif = () => `writeFileSync(root + '/home.' + cell + '.gif', Buffer.from('GIF89a;', 'latin1'));`;
  const { r, why } = domVerify('dom:\n', {}, gif);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(why.filter((w) => /page-check/.test(w)).map((w) => w.replace(/^.*\/(home\.)/, '$1')).sort(), [
    'home.dark.gif: no page-check record home.dark.dom.json next to it (the dom block needs one per captured screen)',
    'home.light.gif: no page-check record home.light.dom.json next to it (the dom block needs one per captured screen)',
  ]);
});

// base_ref: verify drives the base ref too, in a done-done worktree, and the judge sees each head capture with its base capture.
test('base_ref pairs each cell with its base capture in one judge request, and reports a head capture with none', () => {
  const t = matrixed(MATRIXED.replace('  width: [390, 1280]\n', '').replace('  enabled: false\n', ''), '!cell', (t) =>
    `const page = readFileSync('page.txt', 'utf8').trim();\nif (existsSync(${JSON.stringify(t.dir)} + '/' + page + '.' + cell + '.png')) copyFileSync(${JSON.stringify(t.dir)} + '/' + page + '.' + cell + '.png', root + '/home.' + cell + '.png');`);
  writeFileSync(join(t.repo, 'make-cells.mjs'), readFileSync(join(t.repo, 'make-cells.mjs'), 'utf8').replace('mkdirSync }', 'mkdirSync, existsSync, readFileSync }'));
  ['old.light', 'old.dark', 'new.light', 'new.dark'].forEach((n, i) => writeFileSync(join(t.dir, `${n}.png`), screen(i * 11)));
  writeFileSync(join(t.repo, 'page.txt'), 'old\n');
  t.sh('add', '-A'); t.sh('commit', '-qm', 'old page');
  const base = t.head();
  writeFileSync(join(t.repo, 'page.txt'), 'new\n');
  t.sh('commit', '-qam', 'new page');
  const s = stubAgents(t.env, JSON.stringify({ relevance: { probabilities: CORRECT, rationale: 'The page is new.', personReason: 'The page is new.' } }));
  writeFileSync(join(t.env.DONE_DONE_HOME, 'config.yaml'), 'agent: claude\njudge:\n  route: answerer:opencode\n');
  symlinkSync(process.execPath, join(s.bin, 'node'));
  const verify = () => {
    const r = spawnSync(process.execPath, [CLI, 'verify', 'cells', '--outcome', 'home shows the new page', '--foreground'], { cwd: t.repo, env: s.env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr, run: toon({ out: r.stdout }) };
  };
  // Key off: each capture is judged alone and nothing is driven at a base ref.
  const off = verify();
  assert.equal(off.code, 0, off.out);
  assert.deepEqual([s.calls().map((c) => c.attached.length), existsSync(join(t.repo, '.proof', off.run.run_id, 'before'))], [[1, 1], false]);
  writeFileSync(join(t.repo, '.done-done.yaml'), `${readFileSync(join(t.repo, '.done-done.yaml'), 'utf8')}base_ref: ${base}\n`);
  t.sh('commit', '-qam', 'compare with the old page');
  const on = verify();
  assert.equal(on.code, 0, on.out);
  const calls = s.calls().slice(2);
  assert.ok(calls.length === 2 && calls.every((c) => c.attached.join() === 'PNG,PNG' && c.file.includes('base ref')), 'one request per cell holds its before and after images');
  const proof = join(t.repo, '.proof', on.run.run_id);
  for (const cell of ['light', 'dark']) assert.deepEqual(readFileSync(join(proof, 'before', `home.${cell}.png`)), readFileSync(join(t.dir, `old.${cell}.png`)), `the ${cell} base capture is the base ref's page`);
  const judged = decode(readFileSync(join(t.env.DONE_DONE_HOME, 'runs', 'notes', on.run.run_id, 'logs', 'judge.log'), 'utf8')).judged;
  assert.deepEqual(judged.map((j) => [basename(j.path), j.before.replace(`${proof}/`, '')]).sort(), [['home.dark.png', 'before/home.dark.png'], ['home.light.png', 'before/home.light.png']], 'pairs by screen name and cell');
  assert.equal(JSON.parse(readFileSync(join(t.repo, '.proof', '.done-done', 'runs', `${on.run.run_id}.json`), 'utf8')).base.commit, base);
  assert.equal(t.sh('worktree', 'list').toString().trim().split('\n').length, 1, 'the base worktree is removed after the run');
  // A head capture whose base capture is missing is reported, never passed silently.
  rmSync(join(t.dir, 'old.dark.png'));
  const gap = verify();
  assert.equal(gap.code, 3, gap.out);
  assert.match(gap.run.reason, /home\.dark\.png: no base capture to compare with: the drive at base_ref \w+ saved no before\/home\.dark\.png/);
});

test('base_ref judges a text capture against its base text: identical text fails, changed text passes', () => {
  const j = judgeSetup(CORRECT, { projectYaml: 'app: notes\nevidence:\n  root: .proof\njudge:\n  enabled: true\njourneys:\n  count:\n    command: node count.mjs\n' });
  writeFileSync(join(j.repo, 'count.mjs'), "import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync(process.env.DONE_DONE_EVIDENCE_ROOT + '/count.json', readFileSync('page.txt'));\n");
  writeFileSync(join(j.repo, 'page.txt'), '{"notes":3}\n');
  j.sh('add', '-A');
  j.sh('commit', '-qm', 'three notes');
  const base = j.head();
  writeFileSync(join(j.repo, '.done-done.yaml'), `${readFileSync(join(j.repo, '.done-done.yaml'), 'utf8')}base_ref: ${base}\n`);
  j.sh('commit', '-qam', 'compare with three notes');
  const verify = (outcome) => j.dd('verify', 'count', '--outcome', outcome, '--foreground');
  const judgedOf = (r) => decode(readFileSync(join(j.env.DONE_DONE_HOME, 'runs', 'notes', toon(r).run_id, 'logs', 'judge.log'), 'utf8')).judged;
  const same = verify('three notes are saved');
  assert.equal(same.code, 4, same.out);
  assert.match(same.out, /count\.json: judge says wrong output/, 'the judge reads identical text as no change');
  assert.deepEqual(judgedOf(same).map((x) => x.verdict), ['fail']);
  assert.equal(j.dd('abort', '--run', toon(same).run_id).code, 0);
  assert.equal(JSON.parse(j.calls().at(-1).prompt).state.before, '{"notes":3}\n', 'the request holds the base text as well as the capture');
  writeFileSync(join(j.repo, 'page.txt'), '{"notes":4}\n');
  j.sh('commit', '-qam', 'a fourth note');
  const changed = verify('a fourth note is saved');
  assert.equal(changed.code, 0, changed.out);
  assert.deepEqual(judgedOf(changed).map((x) => x.verdict), ['pass']);
});
