import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Backend, Question } from '@byokit/decide';
import { askAgent, claudeBin, type JudgeChoice } from './agents.js';
import { type Config, home, UsageError } from './config.js';
import { downscalePng, type Verdict } from './media.js';

// The relevance judge: one question about one downscaled capture and the claim's outcome line, asked through a
// BYOKit decide backend on the user's own plan: the claude-code route, or the answerer backend over another agent's CLI.

export type Capture = { name: string; bytes: Buffer; sha256: string; media: Verdict };
export type Judged = { path: string; sha256: string; verdict: 'pass' | 'fail' | 'unsure'; reason: string; cached: boolean };

const MAX_SIDE = 1280; // long edge sent to the model, in pixels
const TIMEOUT_MS = 120_000; // one model request per capture, no retry
const MAX_CALLS = 10; // model requests per check; later captures are unsure
const VERSION = 2; // bump when QUESTION or the cache key changes, so older cached verdicts are not reused
const OPTIONS: Record<string, string> = {
  correct: 'The screenshot shows the screen and state the outcome describes.',
  wrong: 'The screenshot shows a different screen, an error, a crash, a dialog or overlay (such as a keyboard) hiding the content, or a state that contradicts the outcome.',
  unclear: 'The screenshot cannot settle it: it is unreadable, or the outcome names nothing that could be visible on a screen.',
};
// The answer the answerer asks its agent for: the kit's reply shape for the one question.
const ANSWER_SCHEMA = {
  type: 'object',
  properties: { relevance: { type: 'object', properties: { probabilities: { type: 'object', properties: Object.fromEntries(Object.keys(OPTIONS).map((k) => [k, { type: 'number' }])) }, rationale: { type: 'string' }, personReason: { type: 'string' } }, required: ['probabilities'] } },
  required: ['relevance'],
};
const QUESTION: Question = {
  kind: 'choice',
  instructions: 'The image is a screenshot cited as proof that the outcome in the state was achieved. Judge only what is visible in it.',
  options: OPTIONS,
  floor: 0.8,
  personReason: true,
  images: ['capture'],
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function onPath(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(dir, name);
    if (isAbsolute(path) && isExecutable(path)) return path;
  }
  return '';
}

const KIT = '@byokit/decide@0.8.0';
const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`);

// The kit is an optional peer dependency, so a plain install stays small; it loads only when a capture needs judging.
async function kit() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18))
    throw new UsageError(`judge: the judge needs Node 22.18 or later (this is ${process.versions.node})`, 'Install Node 22.18 or later, then re-run this command');
  try {
    return { ...(await import('@byokit/decide/claude-code')), ...(await import('@byokit/decide/slim')) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw e;
    throw new UsageError(`judge: the judge needs the optional ${KIT} kit, which is not installed`, `Run this check with the kit: npx -y --allow-git=all -p github:umeranjum17/done-done-axi -p ${KIT} done-done-axi ${process.argv.slice(2).map(quote).join(' ')}`);
  }
}

type Judge = { ask: Backend['ask']; resolve: typeof import('@byokit/decide/slim').resolve; lastError: () => string; signIn: string; signedIn: () => boolean };

// The backend for one judge choice. It checks everything that needs no model call, so doctor can use it too.
// record: where the answerer writes its agent call record (the claude-code route starts no agent of ours).
export async function backend(cfg: Config, choice: JudgeChoice, record = () => ''): Promise<Judge & { detail: string }> {
  if (choice.route !== 'claude-code') {
    const bin = onPath(choice.agent);
    if (!bin) throw new UsageError(`judge: ${choice.route} needs ${choice.agent} on PATH`, `Install ${choice.agent}, or set judge.route in ~/.done-done/config.yaml`);
    const { answerer, resolve } = await kit();
    let lastError = '';
    // The kit hides a failed call's message from the verdict, so the real cause is kept here for the result.
    const ask: Backend['ask'] = answerer({
      name: choice.route,
      leaves: true,
      supportsImages: true,
      ask: async (prompt, _signal, images) => {
        const dir = mkdtempSync(join(tmpdir(), 'done-done-judge-'));
        try {
          const files = images.map((img) => {
            const file = join(dir, `${img.id}.${img.mime.split('/')[1]}`);
            writeFileSync(file, Buffer.from(img.dataUrl.slice(img.dataUrl.indexOf(',') + 1), 'base64'), { mode: 0o600 });
            return file;
          });
          const a = askAgent({ agent: choice.agent, model: choice.model, prompt, schema: ANSWER_SCHEMA, cwd: dir, timeoutMs: TIMEOUT_MS, tools: 'none', record: record(), files });
          lastError = a.ok ? '' : a.error ?? 'no answer';
          if (!a.ok) throw new Error(lastError);
          return JSON.stringify(a.answer);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    }).ask;
    return { ask, resolve, lastError: () => lastError, signIn: '', signedIn: () => true, detail: `${choice.agent} at ${bin} and the judge kit are present` };
  }
  const bin = claudeBin(cfg);
  const dir = cfg.judge.claude_code.config_dir;
  const signIn = `CLAUDE_CONFIG_DIR=${dir} ${bin || 'claude'} auth login`;
  const where = '~/.done-done/config.yaml (judge.claude_code)';
  if (!bin) throw new UsageError(`judge: no claude binary on PATH; install Claude Code or set judge.claude_code.bin in ${where}`, 'Install Claude Code, or set judge.claude_code.bin to its absolute path');
  if (!isAbsolute(bin) || !isAbsolute(dir)) throw new UsageError(`judge: judge.claude_code.bin and judge.claude_code.config_dir must be absolute paths (got ${bin}, ${dir})`, `Fix bin or config_dir in ${where}`);
  if (!isExecutable(bin)) throw new UsageError(`judge: judge.claude_code.bin ${bin} is not an executable file`, `Fix bin in ${where} or install Claude Code`);
  if (!existsSync(dir)) throw new UsageError(`judge: no Claude sign-in at ${dir}`, `Sign in once with your Claude plan: mkdir -p ${dir} && ${signIn}`);
  const { claudeCode, resolve } = await kit();
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
    const ask = claudeCode({ bin, configDir: real, model: choice.model, timeoutMs: TIMEOUT_MS }).ask;
    return { ask, resolve, lastError: () => '', signIn, signedIn, detail: `claude binary at ${bin}, a sign-in folder and the judge kit are present (login is checked only when a capture is judged)` };
  } catch (e) {
    throw new UsageError(`judge: ${(e as Error).message} (judge.claude_code.bin ${bin}, judge.claude_code.config_dir ${dir})`, 'Set judge.claude_code.config_dir to a folder of its own, not your ~/.claude');
  }
}

// The image to send: the original when it already fits, else a downscaled PNG; a reason when neither works.
function prepare(c: Capture): { mime: string; bytes: Buffer } | string {
  const mime = `image/${c.media.type}`;
  if (Math.max(c.media.w ?? 0, c.media.h ?? 0) <= MAX_SIDE) return { mime, bytes: c.bytes };
  const small = c.media.type === 'png' ? downscalePng(c.bytes, MAX_SIDE) : undefined;
  return small ? { mime: 'image/png', bytes: small } : `${c.media.type} is ${c.media.w}x${c.media.h} and cannot be downscaled (only 8-bit PNGs that are not extremely long are), so capture a PNG or an image at most ${MAX_SIDE}px on its long side`;
}

export const judgeable = (c: Capture) => c.media.type === 'png' || c.media.type === 'jpeg';

// Verdicts are cached in the run store, per app, so a re-run or a later run of the same capture and claim asks no model.
// The answerer's agent call leaves a record in `records` (judge-<stamp>-<n>.agent.json), never the prompt.
export async function judge(cfg: Config, choose: () => JudgeChoice, outcome: string, captures: Capture[], records: string): Promise<{ judged: Judged[]; notJudged: string[]; choice?: JudgeChoice }> {
  const dir = join(home(), 'runs', cfg.app, 'judge');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const judged: Judged[] = [];
  const notJudged: string[] = [];
  let choice: JudgeChoice | undefined;
  let be: Judge | undefined;
  let calls = 0;
  let call = ''; // this capture's record path, without .json
  for (const c of captures) {
    if (!judgeable(c)) {
      notJudged.push(c.name);
      continue;
    }
    choice ??= choose();
    const { route, model } = choice;
    const key = createHash('sha256').update(JSON.stringify([VERSION, c.sha256, outcome, route, model])).digest('hex');
    const file = join(dir, `${key}.json`);
    try {
      const hit = JSON.parse(readFileSync(file, 'utf8'));
      if (['pass', 'fail', 'unsure'].includes(hit.verdict) && typeof hit.reason === 'string') {
        judged.push({ path: c.name, sha256: c.sha256, verdict: hit.verdict, reason: hit.reason, cached: true });
        continue;
      }
    } catch {}
    const image = prepare(c);
    if (typeof image === 'string') {
      judged.push({ path: c.name, sha256: c.sha256, verdict: 'unsure', reason: image, cached: false });
      continue;
    }
    if (calls++ >= MAX_CALLS) {
      judged.push({ path: c.name, sha256: c.sha256, verdict: 'unsure', reason: `not judged: one check sends at most ${MAX_CALLS} captures to the model, so cite fewer`, cached: false });
      continue;
    }
    call = join(records, `judge-${stamp}-${calls}`);
    be ??= await backend(cfg, choice, () => `${call}.agent.json`);
    let row: Judged;
    try {
      const dataUrl = `data:${image.mime};base64,${image.bytes.toString('base64')}`;
      const raw = await be.ask({ outcome }, { relevance: QUESTION }, AbortSignal.timeout(TIMEOUT_MS), [{ id: 'capture', mime: image.mime, dataUrl }]);
      const a = be.resolve(QUESTION, raw.relevance);
      const reason = a.personReason || a.rationale || OPTIONS[String(a.answer)] || '';
      row = a.abstained ? { path: c.name, sha256: c.sha256, verdict: 'unsure', reason: `not confident enough (${a.reason})`, cached: false }
        : { path: c.name, sha256: c.sha256, verdict: a.answer === 'correct' ? 'pass' : a.answer === 'wrong' ? 'fail' : 'unsure', reason, cached: false };
    } catch (e) {
      const code = (e as { code?: string }).code;
      const why = be.lastError() || (e as Error).message;
      // The kit reports a signed-out binary, a bad model id and a used-up plan all as 'process', so ask the binary which.
      if (route === 'claude-code' && (code === 'subscription_required' || (code === 'process' && !be.signedIn())))
        throw new UsageError(`judge: ${why} (sign-in ${cfg.judge.claude_code.config_dir})`, `Sign in once with your Claude plan: ${be.signIn}`);
      const hint = code === 'process' ? ` (check judge.model ${model} and your plan's usage limit)` : '';
      judged.push({ path: c.name, sha256: c.sha256, verdict: 'unsure', reason: `the judge did not answer: ${why}${hint}`, cached: false });
      continue;
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ verdict: row.verdict, reason: row.reason, route, model })}\n`, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {} // an unwritable cache costs a repeat request, not this verdict
    judged.push(row);
  }
  return { judged, notJudged, choice };
}
