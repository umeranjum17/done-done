import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
const VERSION = 1; // bump when QUESTION changes, so older cached verdicts are not reused
const QUESTION: Question = {
  kind: 'choice',
  instructions: 'The image is a screenshot cited as proof that the outcome in the state was achieved. Judge only what is visible in it.',
  options: {
    correct: 'The screenshot shows the screen and state the outcome describes.',
    wrong: 'The screenshot shows a different screen, an error, a crash, a dialog or overlay (such as a keyboard) hiding the content, or a state that contradicts the outcome.',
    unclear: 'The screenshot cannot settle it: it is unreadable, or the outcome names nothing that could be visible on a screen.',
  },
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

async function backend(cfg: Config): Promise<{ ask: Backend['ask']; signIn: string }> {
  const bin = cfg.judge.bin || onPath('claude');
  const dir = cfg.judge.config_dir;
  const signIn = `CLAUDE_CONFIG_DIR=${dir} ${bin || 'claude'} auth login`;
  if (!bin) throw new UsageError('judge: no claude binary on PATH; install Claude Code or set judge.bin in ~/.done-done/config.yaml', 'Install Claude Code, or set judge.bin to its absolute path');
  if (!isAbsolute(bin) || !isAbsolute(dir)) throw new UsageError(`judge: judge.bin and judge.config_dir must be absolute paths (got ${bin}, ${dir})`, 'Fix judge.bin or judge.config_dir in ~/.done-done/config.yaml');
  if (!existsSync(dir)) throw new UsageError(`judge: no Claude sign-in at ${dir}`, `Sign in once with your Claude plan: mkdir -p ${dir} && ${signIn}`);
  const { claudeCode } = await import('@byokit/decide/claude-code');
  try {
    return { ask: claudeCode({ bin, configDir: dir, model: cfg.judge.model, timeoutMs: TIMEOUT_MS }).ask, signIn };
  } catch (e) {
    throw new UsageError(`judge: ${(e as Error).message} (judge.bin ${bin}, judge.config_dir ${dir})`, 'Set judge.config_dir to a folder of its own, not your ~/.claude');
  }
}

// The image to send: the original when it already fits, else a downscaled PNG; a reason when neither works.
function prepare(c: Capture): { mime: string; bytes: Buffer } | string {
  const mime = `image/${c.media.type}`;
  if (Math.max(c.media.w ?? 0, c.media.h ?? 0) <= MAX_SIDE) return { mime, bytes: c.bytes };
  const small = c.media.type === 'png' ? downscalePng(c.bytes, MAX_SIDE) : undefined;
  return small ? { mime: 'image/png', bytes: small } : `${c.media.type} is ${c.media.w}x${c.media.h}; only 8-bit PNGs are downscaled, so capture a PNG or an image at most ${MAX_SIDE}px on its long side`;
}

export async function judge(cfg: Config, outcome: string, captures: Capture[]): Promise<{ model: string; judged: Judged[]; notJudged: string[] }> {
  const model = cfg.judge.model;
  const dir = join(home(), 'judge');
  const judged: Judged[] = [];
  const notJudged: string[] = [];
  let be: Awaited<ReturnType<typeof backend>> | undefined;
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
    be ??= await backend(cfg);
    let row: Judged;
    try {
      const dataUrl = `data:${image.mime};base64,${image.bytes.toString('base64')}`;
      const raw = await be.ask({ outcome }, { relevance: QUESTION }, AbortSignal.timeout(TIMEOUT_MS), [{ id: 'capture', mime: image.mime, dataUrl }]);
      const { resolve } = await import('@byokit/decide');
      const a = resolve(QUESTION, raw.relevance);
      const reason = a.personReason ?? a.rationale ?? '';
      row = a.abstained ? { path: c.name, verdict: 'unsure', reason: `not confident enough (${a.reason})`, cached: false }
        : { path: c.name, verdict: a.answer === 'correct' ? 'pass' : a.answer === 'wrong' ? 'fail' : 'unsure', reason, cached: false };
    } catch (e) {
      const code = (e as { code?: string }).code;
      // The kit reports a signed-out or refused sign-in, a bad model id and a crashed binary all as one failure.
      if (code === 'process' || code === 'subscription_required')
        throw new UsageError(`judge: ${(e as Error).message} (model ${model}, sign-in ${cfg.judge.config_dir})`, `Sign in once with your Claude plan: ${be.signIn}`);
      judged.push({ path: c.name, verdict: 'unsure', reason: `the judge did not answer: ${(e as Error).message}`, cached: false });
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ verdict: row.verdict, reason: row.reason, model })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    judged.push(row);
  }
  return { model, judged, notJudged };
}
