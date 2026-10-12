// End-to-end: drives the built CLI against throwaway git repos with fictional fixtures.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  const gate = () => {
    const r = spawnSync(join(dirname(CLI), '..', 'integrations', 'firstmate', 'merge-gate'), ['t2', repo, head(), '-'], {
      encoding: 'utf8', env: { ...env, FM_HOME: fm, PATH: `${bin}:${env.PATH}` },
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

test('the Firstmate merge gate treats - as no worktree and refuses a missing worktree', () => {
  const { dir, repo, env, sh, dd, head, shots } = setup();
  sh('update-ref', 'refs/remotes/origin/main', 'HEAD');
  sh('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'done-done'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  const fm = join(dir, 'fm');
  const gate = (worktree, cwd) => {
    const r = spawnSync(join(dirname(CLI), '..', 'integrations', 'firstmate', 'merge-gate'), ['t3', worktree, head(), '-'], {
      encoding: 'utf8', env: { ...env, FM_HOME: fm, PATH: `${bin}:${env.PATH}` }, cwd,
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const { files } = shots();
  const checks = `## Checks\noutcome: home and settings render\nrepro: n/a: no bug\nproof: no verify skill - \`done-done run shots\`\nevidence: ${files.join(', ')}\n`;
  mkdirSync(join(fm, 'data', 't3'), { recursive: true });
  writeFileSync(join(fm, 'data', 't3', 'checks.md'), checks);
  assert.equal(dd('receipt', '--from', join(fm, 'data', 't3', 'checks.md')).code, 0);
  const pass = gate('-', repo);
  assert.equal(pass.code, 0, pass.out);
  assert.match(pass.out, /This receipt is valid for this head/);
  const missing = gate(join(dir, 'no-such-worktree'), repo);
  assert.equal(missing.code, 2, missing.out);
  assert.match(missing.out, /cannot enter worktree/);
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

test('init --agent claude adds a SessionStart hook that shows the bare state, merges, and never duplicates', () => {
  const { dir, repo, env, dd } = bareRepo();
  const settings = join(repo, '.claude', 'settings.json');
  const r = dd('init', '--agent', 'claude');
  assert.equal(r.code, 0, r.out);
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
  assert.equal(toon(dd('init', '--agent', 'claude')).claude_hook, 'unchanged');
  assert.deepEqual(readFileSync(settings), before, 'a second run adds no duplicate');
  // An existing settings file keeps its other keys and hooks.
  const other = { permissions: { allow: ['Bash(npm test)'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } };
  const two = bareRepo();
  mkdirSync(join(two.repo, '.claude'));
  writeFileSync(join(two.repo, '.claude', 'settings.json'), JSON.stringify(other));
  assert.equal(two.dd('init', '--agent', 'claude').code, 0);
  const merged = JSON.parse(readFileSync(join(two.repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(merged, { ...other, hooks: { ...other.hooks, SessionStart: [...other.hooks.SessionStart, hooks[0]] } }, 'both hooks and every other key are kept');
  // Another agent is a usage error naming the supported values; a malformed settings file is left untouched.
  const bad = two.dd('init', '--agent', 'cursor');
  assert.equal(bad.code, 2, bad.out);
  assert.match(toon(bad).error, /supported values are claude, codex, opencode/);
  writeFileSync(join(two.repo, '.claude', 'settings.json'), '{ nope');
  const broken = two.dd('init', '--agent', 'claude');
  assert.equal(broken.code, 2, broken.out);
  assert.match(toon(broken).help[0], /Fix \.claude\/settings\.json/);
  assert.equal(readFileSync(join(two.repo, '.claude', 'settings.json'), 'utf8'), '{ nope');
});

test('init --agent codex adds a SessionStart hook that shows the bare state, merges, and never duplicates', () => {
  const { dir, repo, env, dd } = bareRepo();
  const hooksFile = join(repo, '.codex', 'hooks.json');
  const r = dd('init', '--agent', 'codex');
  assert.equal(r.code, 0, r.out);
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
  assert.equal(toon(dd('init', '--agent', 'codex')).codex_hook, 'unchanged');
  assert.deepEqual(readFileSync(hooksFile), before, 'a second run adds no duplicate');
  // An existing hooks file keeps its other keys and hooks.
  const other = { description: 'team hooks', hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } };
  const two = bareRepo();
  mkdirSync(join(two.repo, '.codex'));
  writeFileSync(join(two.repo, '.codex', 'hooks.json'), JSON.stringify(other));
  assert.equal(two.dd('init', '--agent', 'codex').code, 0);
  const merged = JSON.parse(readFileSync(join(two.repo, '.codex', 'hooks.json'), 'utf8'));
  assert.deepEqual(merged, { ...other, hooks: { ...other.hooks, SessionStart: [...other.hooks.SessionStart, hooks[0]] } }, 'both hooks and every other key are kept');
  // A malformed hooks file is left untouched.
  writeFileSync(join(two.repo, '.codex', 'hooks.json'), '{ nope');
  const broken = two.dd('init', '--agent', 'codex');
  assert.equal(broken.code, 2, broken.out);
  assert.match(toon(broken).help[0], /Fix \.codex\/hooks\.json/);
  assert.equal(readFileSync(join(two.repo, '.codex', 'hooks.json'), 'utf8'), '{ nope');
});

test('init --journey records the capture recipe and the journey re-runs from any checkout', () => {
  const { dir, repo, env, sh, dd } = bareRepo();
  const r = dd('init', '--journey', 'smoke', '--', 'echo added: milk > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log');
  assert.equal(r.code, 0, r.out);
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
  assert.equal(dd('init', '--journey', 'smoke', '--', 'echo added: eggs > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log').code, 0);
  assert.equal(parse(readFileSync(join(repo, '.done-done.yaml'), 'utf8')).journeys.smoke.command, 'echo added: eggs > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log');
  assert.equal(dd('init', '--journey', 'smoke').code, 2, 'a journey with no command after -- is a usage error');
});

test('init --journey keeps the comments and formatting of an existing config', () => {
  const { repo, dd } = bareRepo();
  const long = 'node make-shots.mjs ${RUN_ID} --viewport 1280x800 --theme dark --out-dir .proof/${RUN_ID} --wait-for-network-idle';
  const original = `# team proof config\napp: notes\n\njourneys:\n  shots:\n    command: ${long}\n`;
  writeFileSync(join(repo, '.done-done.yaml'), original);
  const r = dd('init', '--journey', 'smoke', '--', 'echo hi');
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(repo, '.done-done.yaml'), 'utf8'), `${original}  smoke:\n    command: echo hi\n`);
});

test('init --journey records the command a run executes, shell syntax included', () => {
  const { repo, sh, dd } = bareRepo();
  assert.equal(dd('init', '--journey', 'unit', '--', 'echo', 'added', '>', '$DONE_DONE_EVIDENCE_ROOT/out.txt').code, 0);
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
  assert.equal(dd('init', '--journey', 'smoke', '--', 'echo new').code, 0);
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

test('init --agent opencode adds a session plugin that shows the bare state, merges, and never duplicates', async () => {
  const { dir, repo, env, dd } = bareRepo();
  const plugin = join(repo, '.opencode', 'plugins', 'done-done.js');
  const r = dd('init', '--agent', 'opencode');
  assert.equal(r.code, 0, r.out);
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
  assert.equal(toon(dd('init', '--agent', 'opencode')).opencode_plugin, 'unchanged');
  assert.deepEqual(readFileSync(plugin), before, 'a second run adds no duplicate');
  // An existing plugins directory keeps its other plugins and project config keys.
  const two = bareRepo();
  mkdirSync(join(two.repo, '.opencode', 'plugins'), { recursive: true });
  writeFileSync(join(two.repo, '.opencode', 'plugins', 'other.js'), 'export const Other = async () => ({});\n');
  writeFileSync(join(two.repo, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', theme: 'dark' }));
  assert.equal(two.dd('init', '--agent', 'opencode').code, 0);
  assert.equal(readFileSync(join(two.repo, '.opencode', 'plugins', 'other.js'), 'utf8'), 'export const Other = async () => ({});\n', 'other plugins are kept');
  assert.deepEqual(JSON.parse(readFileSync(join(two.repo, 'opencode.json'), 'utf8')), { $schema: 'https://opencode.ai/config.json', theme: 'dark' }, 'project config keys are kept');
});

test('init --agent opencode refuses to overwrite a plugin file with other content', () => {
  const { repo, dd } = bareRepo();
  const plugin = join(repo, '.opencode', 'plugins', 'done-done.js');
  mkdirSync(join(repo, '.opencode', 'plugins'), { recursive: true });
  writeFileSync(plugin, 'export const Mine = async () => ({});\n');
  const r = dd('init', '--agent', 'opencode');
  assert.equal(r.code, 2, r.out);
  assert.match(toon(r).error, /\.opencode\/plugins\/done-done\.js already exists/);
  assert.equal(readFileSync(plugin, 'utf8'), 'export const Mine = async () => ({});\n', 'the existing file is kept');
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
  assert.equal(r.code, 0, r.out);
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
  assert.equal(dd('init').code, 0);
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
  assert.equal(r.code, 0, r.out);
  assert.equal(toon(r).verify_skill, 'unchanged');
  assert.equal(readFileSync(skill, 'utf8'), '# hand-written\n', 'the existing file is kept');
});

test('init maps the app, not its dependencies, and lists each feature slug once', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  mkdirSync(join(repo, 'node_modules', 'lib'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'lib', 'index.js'), "router.get('/vendored/route');\nprogram.command('vendored');\n");
  writeFileSync(join(repo, 'routes.js'), "app.get('/a/b');\napp.get('/a-b');\n");
  const r = dd('init');
  assert.equal(r.code, 0, r.out);
  const dir = join(repo, '.agents', 'skills', 'verify-notes');
  assert.deepEqual(featureFiles(dir), ['README.md', 'add.md', 'get-a-b-2.md', 'get-a-b.md', 'list.md'], 'node_modules is skipped and each distinct route keeps its own file');
  assert.match(readFileSync(join(dir, 'features', 'get-a-b-2.md'), 'utf8'), /^# GET \/a-b$/m);
});

test('init keeps distinct routes whose slugs collide after truncation', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  writeFileSync(join(repo, 'routes.js'), "app.get('/api/organizations/:id/members/invitations/pending');\napp.get('/api/organizations/:id/members/invitations/expired');\n");
  const r = dd('init');
  assert.equal(r.code, 0, r.out);
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
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(featureFiles(join(repo, '.agents', 'skills', 'verify-notes')), ['README.md', 'add.md', 'list.md'], 'the symlink target is not scanned');
});

test('init keeps a command in the feature map and says how many features it left out', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  writeFileSync(join(repo, 'routes.js'), ['1', '2', '3', '4', '5', '6'].map((n) => `app.get('/r${n}');`).join('\n') + '\n');
  const r = dd('init');
  assert.equal(r.code, 0, r.out);
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
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(featureFiles(join(repo, '.agents', 'skills', 'verify-notes')), ['README.md', 'add.md', 'get-server.md', 'list.md']);
});

test('init takes the readiness port only from the dev script', () => {
  const { repo, dd } = shapeRepo('web', 'shop');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'shop', scripts: { dev: 'next dev' }, dependencies: { react: '^19.0.0' } }));
  writeFileSync(join(repo, 'README.md'), '# shop\nDATABASE_URL=postgres://localhost:5432/app\n');
  assert.equal(dd('init').code, 0);
  const body = readFileSync(join(repo, '.agents', 'skills', 'verify-shop', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(body, /localhost:5432/, 'a database URL in the README is not the app port');
});

test('init does not map README code samples as routes or commands', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  writeFileSync(join(repo, 'README.md'), "# notes\n\n```js\napp.get('/docs-example');\nprogram.command('demo');\n```\n");
  assert.equal(dd('init').code, 0);
  assert.deepEqual(featureFiles(join(repo, '.agents', 'skills', 'verify-notes')), ['README.md', 'add.md', 'list.md'], 'only source and bin commands become features');
});

test('init keeps the config when the verify skill cannot be written', () => {
  const { repo, dd } = shapeRepo('cli', 'notes');
  writeFileSync(join(repo, '.agents'), 'not a directory\n');
  const r = dd('init');
  assert.equal(r.code, 0, r.out);
  assert.match(toon(r).verify_skill, /^skipped, .*could not be written/, 'the scaffold is skipped with a reason');
  assert.equal(existsSync(join(repo, '.done-done.yaml')), true, 'the config written before the scaffold is kept');
});

test('init reads a package.json larger than 20 KB', () => {
  const { repo, dd } = shapeRepo('web', 'shop');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'shop', scripts: { dev: 'vite --port 5173' }, dependencies: { react: '^19.0.0' }, description: 'x'.repeat(30000) }));
  assert.equal(dd('init').code, 0);
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
  assert.equal(r.code, 0, r.out);
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
  assert.equal(r.code, 0, r.out);
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
  assert.deepEqual(s.steps.map((x) => x.status), ['completed', 'completed', 'completed', 'completed', 'completed']);
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
  assert.deepEqual(s.steps.map((x) => x.status), ['completed', 'failed', 'skipped', 'skipped', 'completed']);
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
  assert.deepEqual(s.steps.map((x) => x.status), ['completed', 'failed', 'skipped', 'skipped', 'completed']);
  assert.equal(toon(dd('status')).run_id, s.run_id);
  assert.equal(dd('status', '--run', '../x').code, 2);
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
  assert.equal(e.help[0], `Run this check with the kit: npx -y --allow-git=all -p github:umeranjum17/done-done-axi -p @byokit/decide@0.6.5 done-done-axi check --judge --outcome 'Umer'\\''s notes list shows three notes' ${files[0]}`);
  assert.equal(j.calls().length, 0);
  writeFileSync(join(j.env.DONE_DONE_HOME, 'config.yaml'), readFileSync(join(j.env.DONE_DONE_HOME, 'config.yaml'), 'utf8').replace('  model: claude-test-1\n', ''));
  assert.equal(j.dd(...args).code, 0);
  assert.equal(j.calls()[0].model, 'claude-haiku-5-5');
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
  for (const b of bins) writeFileSync(join(dir, b), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { ...env, PATH: dir };
}

const doctorIn = (cwd, env, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('doctor passes in a set-up repo and lists every check', () => {
  const { dd } = setup();
  const r = dd('doctor');
  assert.equal(r.code, 0, r.out);
  const d = toon(r);
  assert.equal(d.result, 'pass');
  assert.deepEqual(d.checks.map((c) => c.check), ['git', 'config', 'evidence_root', 'verify_skill', 'agent', 'judge', 'ffprobe', 'judge_choice']);
  assert.deepEqual(d.checks.slice(0, 3).map((c) => c.status), ['ok', 'ok', 'ok']);
  assert.match(d.checks[1].detail, /app notes/);
  assert.equal(d.checks[3].status, 'missing', 'no verify skill yet, and that is optional');
  assert.match(d.checks[3].fix, /SKILL\.md/);
  assert.ok(d.help.length >= 1);
  const j = json(dd('doctor', '--json'));
  assert.equal(j.result, 'pass');
  assert.equal(j.checks.length, 8);
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
  writeFileSync(join(b.env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  model: claude-test-1\n');
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

test('with no agent key, doctor names agent: auto and the cheap default judge model', () => {
  const { repo, env } = setup();
  const d = toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor'));
  assert.match(d.checks[4].detail, /^claude \(model claude-haiku-5-5; agent: auto\)/);
  assert.match(d.checks[7].detail, /^claude judge \(model claude-haiku-5-5\)/);
});

test('doctor reports the judge missing when claude has no sign-in or judge.bin is relative', () => {
  const { repo, env, dd } = setup();
  const noSignIn = toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor'));
  assert.equal(noSignIn.checks[5].status, 'missing', 'a claude binary alone is not a working judge');
  assert.match(noSignIn.checks[5].detail, /no Claude sign-in/);
  assert.match(noSignIn.checks[5].fix, /auth login/);
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  bin: claude\n');
  const relative = toon(dd('doctor'));
  assert.equal(relative.checks[5].status, 'missing');
  assert.match(relative.checks[5].detail, /must be absolute paths \(got claude/);
});

test('doctor reports the judge missing when judge.bin does not exist', () => {
  const { repo, env } = setup();
  mkdirSync(join(env.DONE_DONE_HOME, 'claude'), { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), `judge:\n  bin: ${JSON.stringify(join(env.DONE_DONE_HOME, 'gone', 'claude'))}\n`);
  const j = toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor'));
  assert.equal(j.checks[5].status, 'missing');
  assert.match(j.checks[5].detail, /is not an executable file/);
  assert.match(j.checks[5].fix, /judge\.bin/);
});

test('doctor reports the judge missing when judge.bin is a directory', () => {
  const { repo, env } = setup();
  mkdirSync(join(env.DONE_DONE_HOME, 'claude'), { recursive: true });
  const dirBin = join(env.DONE_DONE_HOME, 'bindir');
  mkdirSync(dirBin, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), `judge:\n  bin: ${JSON.stringify(dirBin)}\n`);
  const j = toon(doctorIn(repo, pathEnv(env, ['claude']), 'doctor'));
  assert.equal(j.checks[5].status, 'missing');
  assert.match(j.checks[5].detail, /is not an executable file/);
});

test('doctor reports the judge missing when its sign-in folder is a ~/.claude', () => {
  const { repo, env } = setup();
  const userHome = join(env.DONE_DONE_HOME, 'userhome');
  const claudeDir = join(userHome, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), `judge:\n  config_dir: ${JSON.stringify(claudeDir)}\n`);
  const j = toon(doctorIn(repo, { ...pathEnv(env, ['claude']), HOME: userHome }, 'doctor'));
  assert.equal(j.checks[5].status, 'missing');
  assert.match(j.checks[5].fix, /not your ~\/\.claude/);
});

test('doctor finds agent, judge and ffprobe binaries from PATH; missing optionals never fail it', () => {
  const { repo, env } = setup();
  mkdirSync(join(env.DONE_DONE_HOME, 'claude'), { recursive: true });
  const full = doctorIn(repo, pathEnv(env, ['claude', 'codex', 'opencode', 'ffprobe']), 'doctor');
  assert.equal(full.code, 0, full.out);
  const f = toon(full);
  assert.match(f.checks[4].detail, /^claude \(model claude-haiku-5-5; agent: auto\) at .*claude/, 'claude wins over codex and opencode');
  assert.equal(f.checks[7].status, 'missing', 'claude is the author, so the claude judge is the same agent');
  assert.match(f.checks[7].detail, /^claude judge \(model claude-haiku-5-5\) in a fresh session, the same agent as the author/);
  assert.match(f.checks[5].detail, /never called/, 'the judge binary is never run');
  assert.match(f.checks[6].detail, /found at .*ffprobe/);
  const codexOnly = toon(doctorIn(repo, pathEnv(env, ['codex']), 'doctor'));
  assert.equal(codexOnly.checks[4].status, 'missing');
  assert.match(codexOnly.checks[4].detail, /^codex \(its own default model; set agent_config\.codex\.model to choose one; agent: auto\) at .*, but done-done cannot start codex yet \(claude, opencode, pi and gemini for now\)/);
  assert.equal(codexOnly.checks[7].status, 'missing', 'an author done-done cannot start is no author');
  assert.match(codexOnly.checks[7].detail, /^claude judge \(model claude-haiku-5-5\), and no startable author agent is installed/);
  const two = toon(doctorIn(repo, pathEnv(env, ['codex', 'opencode']), 'doctor'));
  assert.match(two.checks[4].detail, /^opencode .* at /, 'auto skips an installed agent done-done cannot start');
  assert.equal(two.checks[7].status, 'ok', 'the author is opencode, so the claude judge is apart from it');
  assert.match(two.checks[7].detail, /^claude judge \(model claude-haiku-5-5\), a different agent from the author \(opencode\)/);
  const none = doctorIn(repo, pathEnv(env, []), 'doctor');
  assert.equal(none.code, 0, 'missing optionals still exit 0 when every required item is ok');
  const n = toon(none);
  assert.deepEqual(n.checks.slice(4).map((c) => c.status), ['missing', 'missing', 'missing', 'missing']);
  assert.match(n.checks[4].fix, /Install claude, opencode, pi and gemini, or set agent: to an installed one of claude, codex, opencode, pi, gemini/);
  assert.match(n.checks[5].fix, /judge\.bin/);
  assert.match(n.checks[6].fix, /ffprobe/);
  assert.match(n.checks[7].detail, /^claude judge \(model claude-haiku-5-5\), and no author agent is installed/, 'with no author there is no same-agent claim');
  const repoYaml = readFileSync(join(repo, '.done-done.yaml'), 'utf8');
  const claudeOnly = pathEnv(env, ['claude']);
  writeFileSync(join(repo, '.done-done.yaml'), `${repoYaml}judge:\n  allow_same: true\n`);
  const inRepo = toon(doctorIn(repo, claudeOnly, 'doctor'));
  assert.match(inRepo.checks[1].detail, /judge\.allow_same may only be set in the global config/, 'the project file cannot waive the judge');
  writeFileSync(join(repo, '.done-done.yaml'), repoYaml);
  const unwaived = toon(doctorIn(repo, claudeOnly, 'doctor'));
  assert.equal(unwaived.checks[7].status, 'missing');
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  allow_same: true\n');
  const same = toon(doctorIn(repo, claudeOnly, 'doctor'));
  assert.deepEqual([same.checks[7].status, /judge\.allow_same accepts it/.test(same.checks[7].detail)], ['ok', true]);
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
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: ${JSON.stringify(name)}, argv, stdin, file, permission: process.env.OPENCODE_PERMISSION, cwd: process.cwd() }) + '\\n');
${reply}
`, { mode: 0o755 });
  stub('claude', `process.exitCode = ${JSON.stringify(answer)} === 'error' ? 1 : 0;
process.stdout.write(JSON.stringify({ type: 'result', is_error: ${JSON.stringify(answer)} === 'error', result: 'You have hit your session limit', structured_output: ${JSON.stringify(answer)} === 'error' ? undefined : JSON.parse(${JSON.stringify(answer)}) }));`);
  stub('opencode', `console.log('mise tools: opencode');
console.log(JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }));
console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: '\\\`\\\`\\\`json\\n' + ${JSON.stringify(answer)} + '\\n\\\`\\\`\\\`' } }));`);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { env: e, calls, bin: e.PATH };
}

test('the agent comes from config (a fallback list moves past missing agents), and doctor --probe asks it one schema question', () => {
  const { repo, env } = setup();
  const s = stubAgents(env);
  mkdirSync(env.DONE_DONE_HOME, { recursive: true });
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent_config:\n  opencode: { model: opencode-go/test-model }\n');
  const yaml = readFileSync(join(repo, '.done-done.yaml'), 'utf8');
  const doctor = (extra, ...args) => {
    writeFileSync(join(repo, '.done-done.yaml'), yaml + extra);
    const r = doctorIn(repo, s.env, 'doctor', ...args);
    return { ...r, d: r.out.startsWith('command') ? toon(r) : undefined, by: (n) => toon(r).checks.find((c) => c.check === n) };
  };
  // codex is listed first and installed, but done-done cannot start it yet, so the list moves on to opencode at its configured model and doctor names codex.
  writeFileSync(join(s.bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const oc = doctor('agent: [codex, opencode]\n', '--probe');
  assert.equal(oc.code, 0, oc.out);
  assert.match(oc.by('agent').detail, /^opencode \(model opencode-go\/test-model; from config; skipped codex: done-done cannot start it yet\)/);
  assert.match(oc.by('judge_choice').detail, /^claude judge \(model claude-haiku-5-5\), a different agent from the author \(opencode\)/);
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
  // An agent without an adapter yet, an explicit judge route, and bad values.
  const cx = doctor('agent: codex\n', '--probe');
  assert.equal(cx.code, 2, cx.out);
  assert.match(cx.by('probe').detail, /cannot start codex yet/);
  assert.equal(cx.by('probe').fix, 'Set agent: to claude, opencode, pi and gemini', 'a probe that never ran points at the agent fix, not a sign-in');
  writeFileSync(join(s.bin, 'gemini'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pg = doctor('agent: [codex, gemini]\n');
  assert.match(pg.by('agent').detail, /^gemini \(model flash-lite; from config; skipped codex: done-done cannot start it yet\)/, 'the list moves past codex to the startable gemini at its cheap default');
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'judge:\n  route: opencode:plan_key:opencode-go\n  model: muse-spark-1.3-contributor\n');
  assert.match(doctor('').by('judge_choice').detail, /^claude judge \(model muse-spark-1.3-contributor\) in a fresh session.*judge\.route opencode:plan_key:opencode-go is recorded, not used yet/);
  assert.match(doctor('agent: cursor\n').out, /agent must be auto, or one or a list of claude, codex, opencode, pi, gemini/);
  assert.match(doctor('judge: auto\n').out, /judge must be a mapping/, 'judge: auto is not a spelling of the judge');
  assert.match(doctor('agent_config:\n  opencode: { model: x }\n').out, /agent_config may only be set in the global config/, 'the project file cannot pick a model');
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent_config:\n  cursor: { model: x }\n');
  assert.match(doctor('').out, /agent_config must be a map of <agent>: \{model: <string>\}/);
  assert.equal(s.calls().length, 3, 'only --probe asks the agent');
  // Without a repo config, the agent keys still come from the global config.
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: opencode\n');
  rmSync(join(repo, '.done-done.yaml'));
  const global = doctorIn(repo, s.env, 'doctor');
  assert.equal(global.code, 2, global.out);
  assert.match(toon(global).checks.find((x) => x.check === 'agent').detail, /^opencode \(model opencode-go\/muse-spark-1.3-contributor; from config\)/);
  writeFileSync(join(env.DONE_DONE_HOME, 'config.yaml'), 'agent: [pi]\njudge:\n  modle: x\n');
  const broken = toon(doctorIn(repo, s.env, 'doctor'));
  assert.equal(broken.checks.find((x) => x.check === 'agent').status, 'missing');
  assert.match(broken.checks.find((x) => x.check === 'agent').detail, /unknown key judge\.modle/, 'a broken global config is named, never replaced by built-in defaults');
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
  const t = setup('app: notes\nevidence:\n  root: .proof\n  ignore_paths: ["docs/**"]\n  allow_dirty: true\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n');
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

// Stub pi and gemini CLIs that log how they were started (argv, stdin, cwd) and answer like the real ones:
// pi -p --mode json streams JSONL with the answer in the assistant message_end text parts (fenced, as models
// often do); gemini -p -o json prints one object with the answer in `response` (its headless.md).
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
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: 'pi', argv, stdin, cwd: process.cwd() }) + '\\n');
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
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: 'gemini', argv, stdin, cwd: process.cwd() }) + '\\n');
// A signed-out gemini (seen 13 Oct): the stack of its auth error, a warning, then the one useful line in red.
if (${JSON.stringify(mode)} === 'auth') {
  process.stderr.write('Error authenticating: FatalCancellationError: Authentication cancelled by user.\\n    at initOauthClient (file:///gemini/bundle/chunk.js:1:1)\\n  exitCode: 130\\n}\\nSkill conflict detected: a skill overrides another\\n\\u001b[31mAuthentication cancelled by user.\\u001b[0m\\nUpdate available: 0.57.0\\n');
  process.exit(130);
}
process.stdout.write(JSON.stringify({ response: ${JSON.stringify(fenced)}, stats: {} }));
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
  assert.deepEqual(call.argv, ['-p', '--mode', 'json', '--no-session', '--no-tools'], 'no model is passed, so pi runs its own default');
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
  assert.deepEqual(call.argv, ['-p', 'Follow the instructions on stdin.', '-o', 'json', '-m', 'flash-lite', '--approval-mode', 'plan', '--skip-trust']);
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

test('agent auto picks pi over gemini, and doctor warns that pi has no permission gate', () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env);
  const d = toon(doctorIn(repo, s.env, 'doctor'));
  assert.match(d.checks.find((x) => x.check === 'agent').detail, /^pi \(its own default model; set agent_config\.pi\.model to choose one; agent: auto\) at /);
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
  assert.deepEqual(s.calls()[0].argv, ['-p', '--mode', 'json', '--no-session', '--no-tools', '--model', 'vendor/some-model']);
});

test('gemini edit steps run with auto_edit, never yolo, and read steps stay in plan mode', async () => {
  const { repo, env } = setup();
  const s = stubPiGemini(env);
  const { askAgent } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'agents.js')).href);
  const call = { agent: 'gemini', model: 'flash-lite', prompt: 'p', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, cwd: repo, timeoutMs: 60_000, record: join(s.env.PATH, 'rec.json') };
  const old = process.env.PATH;
  process.env.PATH = s.env.PATH;
  try {
    askAgent({ ...call, tools: 'edit' });
    askAgent({ ...call, tools: 'read' });
  } finally {
    process.env.PATH = old;
  }
  const [edit, read] = s.calls();
  assert.equal(edit.argv[edit.argv.indexOf('--approval-mode') + 1], 'auto_edit');
  assert.equal(read.argv[read.argv.indexOf('--approval-mode') + 1], 'plan');
  assert.ok(!edit.argv.includes('--skip-trust') && !read.argv.includes('--skip-trust'), 'a repo step keeps Gemini trust gate');
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
    const out = askAgent({ agent: 'gemini', model: 'flash-lite', prompt: 'p', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, cwd: repo, timeoutMs: 60_000, record: join(s.env.PATH, 'rec.json'), tools: 'edit' });
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
  const call = { agent: 'pi', model: '', prompt: 'p', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, cwd: repo, timeoutMs: 60_000, record: join(s.env.PATH, 'rec.json') };
  const old = process.env.PATH;
  process.env.PATH = s.env.PATH;
  try {
    const edit = askAgent({ ...call, tools: 'edit' });
    assert.equal(edit.ok, false);
    assert.equal(s.calls().length, 1, 'the edit step ran once');
    const probe = askAgent({ ...call, tools: 'none' });
    assert.equal(probe.ok, false);
    assert.equal(s.calls().length, 4, 'the tool-less probe is asked again up to three tries');
  } finally {
    process.env.PATH = old;
  }
});

test('maintain reports a dead link, a wrong file:line and drift from read-only readers, and changes nothing', () => {
  const { repo, env, sh } = setup();
  const answer = JSON.stringify({
    summary: 'app.js exports the app', entry_points: [{ file: 'src/app.js', line: 1 }], recipe: 'import src/app.js',
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
  writeFileSync(join(skill, 'features', 'home.md'), '# Home\n\nSource: src/app.js:1, and the old src/app.js:40.\n');
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
    'dead-link features/README.md:4', 'duplicate features/README.md:5', 'unlisted features/README.md',
    'citation features/home.md:3', 'drift features/extra.md', 'drift features/home.md', 'unmapped src/app.js',
  ], 'a reader citation that does not exist and a missing file outside the churn list are not findings');
  assert.match(m.findings[3].what, /cites src\/app\.js:40, but src\/app\.js has 1 lines/);
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
  // A reader that writes into the repo makes the run blocked.
  writeFileSync(join(s.bin, 'claude'), `#!${process.execPath}\nrequire('node:fs').writeFileSync('stray.txt', '');\nprocess.stdout.write(JSON.stringify({ structured_output: ${answer} }));\n`, { mode: 0o755 });
  const changed = toon(dd('maintain', '--foreground'));
  assert.deepEqual([changed.result, changed.git_status], ['blocked', 'changed']);
  assert.match(changed.reason, /^repo-changed: /);
});
