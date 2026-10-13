import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import type { Backend, Question } from '@byokit/decide';
import { agentRun, askAgent, claudeBin, type JudgeChoice, notStartable } from './agents.js';
import { type Config, home, KEY_ROUTES, parseDuration, UsageError } from './config.js';
import { downscaleToPng, type Verdict } from './media.js';

// The relevance judge: one question about one downscaled capture and the claim's outcome line, asked through a
// BYOKit decide backend on the user's own plan or key: the claude-code route, the answerer backend over another
// agent's CLI, or a key route (the kit's openai backend on the user's API key).

export type Capture = { name: string; bytes: Buffer; sha256: string; media: Verdict };
export type Judged = { path: string; sha256: string; verdict: 'pass' | 'fail' | 'unsure'; reason: string; cached: boolean };

const MAX_SIDE = 1280; // long edge sent to the model, in pixels
const MAX_CALLS = 10; // model requests per check; later captures are unsure
const VERSION = 2; // bump when QUESTION or the cache key changes, so older cached verdicts are not reused
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

// The answer the answerer asks its agent for: the kit's reply shape for each choice question.
const answerSchema = (questions: Record<string, Question>) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: 'object', properties: { probabilities: { type: 'object', properties: Object.fromEntries(Object.keys(q.kind === 'choice' ? q.options : {}).map((o) => [o, { type: 'number', minimum: 0, maximum: 1 }])), required: Object.keys(q.kind === 'choice' ? q.options : {}) }, rationale: { type: 'string' }, personReason: { type: 'string' } }, required: ['probabilities'] }])),
  required: Object.keys(questions),
});

export function isExecutable(path: string): boolean {
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

// Is claude signed in to this sign-in folder? Reads only the binary's non-secret auth status, as the kit does.
// It runs in a scratch folder with a scratch HOME, so nothing else of the user's is read.
export function claudeLoggedIn(bin: string, configDir: string): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'done-done-judge-'));
  try {
    const r = spawnSync(bin, ['--safe-mode', '--setting-sources', '', 'auth', 'status'], { cwd: scratch, encoding: 'utf8', timeout: 30_000, env: { HOME: scratch, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configDir } });
    return r.status === 0 && JSON.parse(r.stdout).loggedIn === true;
  } catch {
    return false;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const KIT = '@byokit/decide@0.8.0';
export const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`);

// The kit is an optional peer dependency, so a plain install stays small; it loads only when a capture needs judging.
async function kit() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18))
    throw new UsageError(`judge: the judge needs Node 22.18 or later (this is ${process.versions.node})`, 'Install Node 22.18 or later, then re-run this command');
  try {
    return { ...(await import('@byokit/decide/claude-code')), ...(await import('@byokit/decide')) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw e;
    // A verify run's detached runner has no command of the user's to repeat, so it names the rerun of its run.
    const [cmd, dir] = process.argv.slice(2);
    const again = cmd === '__runner' ? ['rerun', '--run', basename(dir)] : process.argv.slice(2);
    throw new UsageError(`judge: the judge needs the optional ${KIT} kit, which is not installed`, `${cmd === 'check' || cmd === 'receipt' ? 'Run this check' : 'Run it again'} with the kit: npx -y --allow-git=all -p github:umeranjum17/done-done-axi -p ${KIT} done-done-axi ${again.map(quote).join(' ')}`);
  }
}

export type Judge = { ask: Backend['ask']; resolve: typeof import('@byokit/decide/slim').resolve; lastError: () => string; signIn: string; signedIn: () => boolean };

// The backend for one judge choice. It checks everything that needs no model call, so doctor can use it too.
// record: where the answerer writes its agent call record (the claude-code route starts no agent of ours);
// questions: what each request asks, so the answerer can ask its agent for that answer shape; attempts: asks per request
// when the answer is malformed.
export async function backend(cfg: Config, choice: JudgeChoice, record = () => '', questions: Record<string, Question> = { relevance: QUESTION }, attempts = 1): Promise<Judge & { detail: string }> {
  if (Object.hasOwn(KEY_ROUTES, choice.route)) {
    const name = KEY_ROUTES[choice.route];
    // The kit never reads the environment: done-done reads the key here and hands it only to the kit.
    const key = process.env[name];
    if (!key) throw new UsageError(`judge: ${choice.route} needs your own API key in ${name}, which is not set`, `Export ${name} with your key, then re-run this command`);
    const { openai, resolve } = await kit();
    const ask = openai({ model: choice.model, key, supportsImages: true, maxRetries: 0 }).ask;
    return { ask, resolve, lastError: () => '', signIn: '', signedIn: () => true, detail: `${name} is set and the judge kit is present` };
  }
  const timeoutMs = parseDuration(cfg.agent_timeout)!;
  const override = cfg.agent_path_override[choice.agent];
  if (choice.route !== 'claude-code') {
    const run = agentRun(cfg, choice.agent, choice.model);
    const bin = run.path;
    if (!bin) throw new UsageError(`judge: ${notStartable(choice.agent, override)}`, `Install ${choice.agent}, or ask the user for another judge and save it: done-done init --judge <agent> --judge-model <model>`);
    const { answerer, resolve } = await kit();
    let lastError = '';
    // An answer the kit cannot read (all-zero probabilities, an option left out) would abstain on every question as if
    // the judge were unsure, so it is asked again like any malformed answer.
    const check = (answer: Record<string, unknown>) => {
      const bad = Object.entries(questions).filter(([k, q]) => /^(malformed|no answer)/.test(resolve(q, answer[k] as Parameters<typeof resolve>[1]).reason ?? '')).map(([k]) => k);
      return bad.length ? `no probabilities for ${bad.join(', ')} that are each 0 to 1 and sum to 1: ${JSON.stringify(answer).slice(0, 200)}` : '';
    };
    // The kit hides a failed call's message from the verdict, so the real cause is kept here for the result.
    const ask: Backend['ask'] = answerer({
      name: choice.route,
      leaves: true,
      supportsImages: true,
      ask: async (prompt, _signal, images) => {
        lastError = '';
        const attached = images.map((img) => ({ name: `${img.id}.${img.mime.split('/')[1]}`, bytes: Buffer.from(img.dataUrl.slice(img.dataUrl.indexOf(',') + 1), 'base64') }));
        // A tool-less call runs in its own scratch folder, so the CLI sees the attached capture and nothing else.
        const a = await askAgent({ ...run, prompt, schema: answerSchema(questions), check, cwd: tmpdir(), tools: 'none', attempts, record: record(), images: attached });
        lastError = a.ok ? '' : a.error ?? 'no answer';
        if (!a.ok) throw new Error(lastError);
        return JSON.stringify(a.answer);
      },
    }).ask;
    return { ask, resolve, lastError: () => lastError, signIn: '', signedIn: () => true, detail: `${choice.agent} at ${bin} and the judge kit are present; it judges with every tool off` };
  }
  const bin = claudeBin(cfg);
  const dir = cfg.judge.claude_code.config_dir;
  const signIn = `CLAUDE_CONFIG_DIR=${dir} ${bin || 'claude'} auth login`;
  const where = '~/.done-done/config.yaml';
  if (!bin) throw new UsageError(`judge: ${notStartable('claude', override)}`, override ? `Fix agent_path_override.claude in ${where}, or install Claude Code` : 'Install Claude Code, or set agent_path_override.claude to its absolute path');
  if (!isAbsolute(dir)) throw new UsageError(`judge: judge.claude_code.config_dir must be an absolute path (got ${dir})`, `Fix judge.claude_code.config_dir in ${where}`);
  if (!existsSync(dir)) throw new UsageError(`judge: no Claude sign-in at ${dir}`, `Sign in once with your Claude plan: mkdir -p ${dir} && ${signIn}`);
  const { claudeCode, resolve } = await kit();
  // The real folder, so a link to ~/.claude is refused here as a config error, not later per capture.
  const real = realpathSync(dir);
  try {
    const ask = claudeCode({ bin, configDir: real, model: choice.model, timeoutMs }).ask;
    return { ask, resolve, lastError: () => '', signIn, signedIn: () => claudeLoggedIn(bin, real), detail: `claude binary at ${bin}, a sign-in folder and the judge kit are present (login is checked only when a capture is judged)` };
  } catch (e) {
    throw new UsageError(`judge: ${(e as Error).message} (claude ${bin}, judge.claude_code.config_dir ${dir})`, 'Set judge.claude_code.config_dir to a folder of its own, not your ~/.claude');
  }
}

// The image to send: the original when it already fits, else a downscaled PNG; a reason when neither works.
export function prepare(c: Capture): { mime: string; bytes: Buffer } | string {
  const mime = `image/${c.media.type}`;
  if (Math.max(c.media.w ?? 0, c.media.h ?? 0) <= MAX_SIDE) return { mime, bytes: c.bytes };
  const small = downscaleToPng(c.bytes, c.media.type, MAX_SIDE);
  return small ? { mime: 'image/png', bytes: small } : `${c.media.type} is ${c.media.w}x${c.media.h} and cannot be downscaled (only 8-bit PNG and JPEG that are not extremely long are), so capture a PNG or JPEG at most ${MAX_SIDE}px on its long side`;
}

// One request about the named images: each question's answer after the floors, or why the judge did not answer.
// A signed-out or non-subscription claude-code sign-in is a usage error, since no later request can do better.
export async function askJudge(cfg: Config, be: Judge, choice: JudgeChoice, state: unknown, questions: Record<string, Question>, images: Record<string, { mime: string; bytes: Buffer }>): Promise<Record<string, ReturnType<Judge['resolve']>> | string> {
  try {
    const raw = await be.ask(state, questions, AbortSignal.timeout(parseDuration(cfg.agent_timeout)!), Object.entries(images).map(([id, i]) => ({ id, mime: i.mime, dataUrl: `data:${i.mime};base64,${i.bytes.toString('base64')}` })));
    return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, be.resolve(q, raw[k])]));
  } catch (e) {
    const code = (e as { code?: string }).code;
    const why = be.lastError() || (e as Error).message;
    // The kit reports a signed-out binary, a bad model id and a used-up plan all as 'process', so ask the binary which.
    if (choice.route === 'claude-code' && (code === 'subscription_required' || (code === 'process' && !be.signedIn())))
      throw new UsageError(`judge: ${why} (sign-in ${cfg.judge.claude_code.config_dir})`, `Sign in once with your Claude plan: ${be.signIn}`);
    const hint = code === 'process' ? ` (check judge.model ${choice.model} and your plan's usage limit)` : Object.hasOwn(KEY_ROUTES, choice.route) ? ` (check judge.model ${choice.model} and the key in ${KEY_ROUTES[choice.route]})` : '';
    return `the judge did not answer: ${why}${hint}`;
  }
}

export const judgeable = (c: Capture) => c.media.type === 'png' || c.media.type === 'jpeg';

// A judge's cached answer in the run store, one file per input key: an unreadable entry is a miss, and an unwritable
// cache costs a repeat request, never a verdict.
export function readCache(dir: string, key: string) {
  try {
    return JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}
export function writeCache(dir: string, key: string, value: unknown) {
  const file = join(dir, `${key}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch {}
}

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
    const hit = readCache(dir, key);
    if (['pass', 'fail', 'unsure'].includes(hit?.verdict) && typeof hit.reason === 'string') {
      judged.push({ path: c.name, sha256: c.sha256, verdict: hit.verdict, reason: hit.reason, cached: true });
      continue;
    }
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
    const answers = await askJudge(cfg, be, choice, { outcome }, { relevance: QUESTION }, { capture: image });
    if (typeof answers === 'string') {
      judged.push({ path: c.name, sha256: c.sha256, verdict: 'unsure', reason: answers, cached: false });
      continue;
    }
    const a = answers.relevance;
    const reason = a.personReason || a.rationale || OPTIONS[String(a.answer)] || '';
    const row: Judged = a.abstained ? { path: c.name, sha256: c.sha256, verdict: 'unsure', reason: `not confident enough (${a.reason})`, cached: false }
      : { path: c.name, sha256: c.sha256, verdict: a.answer === 'correct' ? 'pass' : a.answer === 'wrong' ? 'fail' : 'unsure', reason, cached: false };
    writeCache(dir, key, { verdict: row.verdict, reason: row.reason, route, model });
    judged.push(row);
  }
  return { judged, notJudged, choice };
}
