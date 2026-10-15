// e2e journey: drives the built CLI end to end against a throwaway fixture repo.
// Runs from the done-done repo root with DONE_DONE_EVIDENCE_ROOT and
// DONE_DONE_RUN_ID set by `done-done run e2e`. Follows the repo's own
// integrations/firstmate/brief-include.md contract: init, run, check, receipt.
// Writes e2e.log plus the fixture's captures into DONE_DONE_EVIDENCE_ROOT.
// Pure node stdlib; exits nonzero on the first failure.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { crc32 } from 'node:zlib';

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'cli.js');
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

  const dd = (...args) => {
    const r = execFileSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
    say(`$ done-done ${args.join(' ')}\n${r.trim()}`);
    return r;
  };
  const sh = (...a) => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' });

  // Fixture repo: minimal app with its own journey, judge off (deterministic).
  writeFileSync(join(repo, '.done-done.yaml'), 'app: fixture\njudge:\n  enabled: false\njourneys:\n  shots:\n    command: node make-shots.mjs ${RUN_ID}\n');
  writeFileSync(join(repo, 'make-shots.mjs'),
    `import { copyFileSync } from 'node:fs';\ncopyFileSync(${JSON.stringify(join(tmp, 'screen.png'))}, process.env.DONE_DONE_EVIDENCE_ROOT + '/home.png');\n`);
  writeFileSync(join(tmp, 'screen.png'), png(3));
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1;\n');
  sh('init', '-q', '-b', 'main'); sh('add', '-A'); sh('commit', '-qm', 'init');
  const head = sh('rev-parse', 'HEAD').trim();
  say(`fixture HEAD: ${head}`);

  dd('doctor');
  const runOut = dd('run', 'shots');
  const runId = /run_id:\s*"?([^\s"]+)"?/.exec(runOut)?.[1];
  if (!runId) throw new Error('could not parse run_id from run output');
  const shot = join(home, 'evidence', 'fixture', runId, 'home.png');
  dd('check', '--outcome', 'fixture home renders', shot);
  dd('receipt', '--outcome', 'fixture home renders', shot);
  dd('receipt', '--verify', head);

  // Proof for the outer run: transcript plus the fixture's own capture.
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${RUN_ID}.log`), log.join('\n') + '\n');
  copyFileSync(shot, join(OUT, `${RUN_ID}.home.png`));
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
