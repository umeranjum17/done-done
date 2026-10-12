import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Backend, Question } from '@byokit/decide';
import { type Config, home, UsageError } from './config.js';
import { downscalePng, type Verdict } from './media.js';

// The relevance judge: one question about one downscaled capture and the claim's outcome line.
// It runs only when asked for, through a BYOKit decide backend on the person's own Claude plan.

export type Capture = { name: string; bytes: Buffer; sha256: string; media: Verdict };
export type Judged = { path: string; verdict: 'pass' | 'fail' | 'unsure'; reason: string; cached: boolean };

const MAX_SIDE = 1280; // long edge sent to the model, in pixels
const TIMEOUT_MS = 120_000; // one model request per capture, no retry
const MAX_CALLS = 10; // model requests per check; later captures are unsure
const VERSION = 1; // bump when QUESTION changes, so older cached verdicts are not reused
const OPTIONS: Record<string, string> = {
  correct: 'The screenshot shows the screen and state the outcome describes.',
  wrong: 'The screenshot shows a different screen, an error, a crash, a dialog or overlay (such as a keyboard) hiding the content, or a state that contradicts the outcome.',
  unclear: 'The screenshot cannot settle it: it is unreadable, or the outcome names nothing that could be visible on a screen.',
};
const QUESTION: Question = {
  kind: 'choice',
  instructions: 'The image is a screenshot cited as proof that the outcome in the state was achieved. Judge only what is visible in it.',
  options: OPTIONS,
  floor: 0.8,
  personReason: true,
  images: ['capture'],
};

function onPath(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      if (isAbsolute(path)) return path;
    } catch {}
  }
  return '';
}

async function backend(cfg: Config): Promise<{ ask: Backend['ask']; signIn: string; signedIn: () => boolean }> {
  const bin = cfg.judge.bin || onPath('claude');
  const dir = cfg.judge.config_dir;
  const signIn = `CLAUDE_CONFIG_DIR=${dir} ${bin || 'claude'} auth login`;
  if (!bin) throw new UsageError('judge: no claude binary on PATH; install Claude Code or set judge.bin in ~/.done-done/config.yaml', 'Install Claude Code, or set judge.bin to its absolute path');
  if (!isAbsolute(bin) || !isAbsolute(dir)) throw new UsageError(`judge: judge.bin and judge.config_dir must be absolute paths (got ${bin}, ${dir})`, 'Fix judge.bin or judge.config_dir in ~/.done-done/config.yaml');
  if (!existsSync(dir)) throw new UsageError(`judge: no Claude sign-in at ${dir}`, `Sign in once with your Claude plan: mkdir -p ${dir} && ${signIn}`);
  const { claudeCode } = await import('@byokit/decide/claude-code');
  // The real folder, so a link to ~/.claude is refused here as a config error, not later per capture.
  const real = realpathSync(dir);
  // After a failed request: is the binary still signed in? Reads only the binary's non-secret auth status, as the kit does.
  const signedIn = () => {
    const scratch = mkdtempSync(join(tmpdir(), 'done-done-judge-'));
    try {
      const r = spawnSync(bin, ['--safe-mode', '--setting-sources', '', 'auth', 'status'], { cwd: scratch, encoding: 'utf8', timeout: 30_000, env: { HOME: scratch, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: real } });
      return r.status === 0 && JSON.parse(r.stdout).loggedIn === true;
    } catch {
      return false;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  try {
    return { ask: claudeCode({ bin, configDir: real, model: cfg.judge.model, timeoutMs: TIMEOUT_MS }).ask, signIn, signedIn };
  } catch (e) {
    throw new UsageError(`judge: ${(e as Error).message} (judge.bin ${bin}, judge.config_dir ${dir})`, 'Set judge.config_dir to a folder of its own, not your ~/.claude');
  }
}

// The image to send: the original when it already fits, else a downscaled PNG; a reason when neither works.
function prepare(c: Capture): { mime: string; bytes: Buffer } | string {
  const mime = `image/${c.media.type}`;
  if (Math.max(c.media.w ?? 0, c.media.h ?? 0) <= MAX_SIDE) return { mime, bytes: c.bytes };
  const small = c.media.type === 'png' ? downscalePng(c.bytes, MAX_SIDE) : undefined;
  return small ? { mime: 'image/png', bytes: small } : `${c.media.type} is ${c.media.w}x${c.media.h} and cannot be downscaled (only 8-bit PNGs that are not extremely long are), so capture a PNG or an image at most ${MAX_SIDE}px on its long side`;
}

export async function judge(cfg: Config, outcome: string, captures: Capture[]): Promise<{ model: string; judged: Judged[]; notJudged: string[] }> {
  const model = cfg.judge.model;
  const dir = join(home(), 'judge');
  const judged: Judged[] = [];
  const notJudged: string[] = [];
  let be: Awaited<ReturnType<typeof backend>> | undefined;
  let calls = 0;
  for (const c of captures) {
    if (c.media.type !== 'png' && c.media.type !== 'jpeg') {
      notJudged.push(c.name);
      continue;
    }
    const key = createHash('sha256').update(JSON.stringify([VERSION, c.sha256, outcome, model])).digest('hex');
    const file = join(dir, `${key}.json`);
    try {
      const hit = JSON.parse(readFileSync(file, 'utf8'));
      if (['pass', 'fail', 'unsure'].includes(hit.verdict) && typeof hit.reason === 'string') {
        judged.push({ path: c.name, verdict: hit.verdict, reason: hit.reason, cached: true });
        continue;
      }
    } catch {}
    const image = prepare(c);
    if (typeof image === 'string') {
      judged.push({ path: c.name, verdict: 'unsure', reason: image, cached: false });
      continue;
    }
    if (calls++ >= MAX_CALLS) {
      judged.push({ path: c.name, verdict: 'unsure', reason: `not judged: one check sends at most ${MAX_CALLS} captures to the model, so cite fewer`, cached: false });
      continue;
    }
    be ??= await backend(cfg);
    let row: Judged;
    try {
      const dataUrl = `data:${image.mime};base64,${image.bytes.toString('base64')}`;
      const raw = await be.ask({ outcome }, { relevance: QUESTION }, AbortSignal.timeout(TIMEOUT_MS), [{ id: 'capture', mime: image.mime, dataUrl }]);
      const { resolve } = await import('@byokit/decide');
      const a = resolve(QUESTION, raw.relevance);
      const reason = a.personReason || a.rationale || OPTIONS[String(a.answer)] || '';
      row = a.abstained ? { path: c.name, verdict: 'unsure', reason: `not confident enough (${a.reason})`, cached: false }
        : { path: c.name, verdict: a.answer === 'correct' ? 'pass' : a.answer === 'wrong' ? 'fail' : 'unsure', reason, cached: false };
    } catch (e) {
      const code = (e as { code?: string }).code;
      // The kit reports a signed-out binary, a bad model id and a used-up plan all as 'process', so ask the binary which.
      if (code === 'subscription_required' || (code === 'process' && !be.signedIn()))
        throw new UsageError(`judge: ${(e as Error).message} (sign-in ${cfg.judge.config_dir})`, `Sign in once with your Claude plan: ${be.signIn}`);
      const hint = code === 'process' ? ` (check judge.model ${model} and your plan's usage limit)` : '';
      judged.push({ path: c.name, verdict: 'unsure', reason: `the judge did not answer: ${(e as Error).message}${hint}`, cached: false });
      continue;
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ verdict: row.verdict, reason: row.reason, model })}\n`, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {} // an unwritable cache costs a repeat request, not this verdict
    judged.push(row);
  }
  return { model, judged, notJudged };
}
