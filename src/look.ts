import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './config.js';
import { domRecord, LOOK, type PageCheck, SQUASHED_TEXT } from './dom.js';
import { findBin } from './agents.js';

// done-done look: opens one page in headless Chrome at a phone viewport over the DevTools protocol (Node's own
// WebSocket, no browser library), writes the screenshot and its page-check record next to it, and returns the record.
// Chrome runs without its sandbox so it starts in containers and CI: point look at your own app, not untrusted sites.

const BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const WAIT = 30_000;

export async function look(url: string, capture: string, width: number, height: number): Promise<PageCheck> {
  const bin = process.env.DONE_DONE_CHROME ? findBin(process.env.DONE_DONE_CHROME) : BROWSERS.map(findBin).find(Boolean);
  if (!bin) throw new UsageError(`look needs Chrome or Chromium: ${process.env.DONE_DONE_CHROME ? `DONE_DONE_CHROME=${process.env.DONE_DONE_CHROME} is not an executable` : `none of ${BROWSERS.slice(0, 4).join(', ')} is on PATH`}`, 'Install Chrome or Chromium, or set DONE_DONE_CHROME to its binary');
  const profile = mkdtempSync(join(tmpdir(), 'done-done-look-'));
  const chrome = spawn(bin, ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws: WebSocket | undefined;
  try {
    // Chrome prints its DevTools address on stderr once it listens; it exiting first is the real cause, so show its words.
    let said = '';
    const port = await within<string>(WAIT, 'Chrome did not start', (done, fail) => {
      chrome.stderr!.on('data', (d) => {
        said += d;
        const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said);
        if (m) done(m[1]);
      });
      chrome.on('error', (e) => fail(new Error(`Chrome (${bin}) did not start: ${e.message}`)));
      chrome.on('exit', (code) => fail(new Error(`Chrome (${bin}) exited ${code} before it listened: ${said.trim().split('\n').slice(-3).join(' ') || 'no output'}`)));
    });
    const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const target = pages.find((p) => p.type === 'page');
    if (!target) throw new Error('Chrome opened no page to drive');
    const sock = new WebSocket(target.webSocketDebuggerUrl);
    ws = sock;
    await within<void>(WAIT, 'Chrome DevTools did not connect', (done, fail) => {
      sock.onopen = () => done();
      sock.onerror = () => fail(new Error('Chrome DevTools connection failed'));
    });
    let id = 0;
    const waiting = new Map<number, { done: (v: any) => void; fail: (e: Error) => void }>();
    const on = new Map<string, (p: any) => void>();
    const died = (why: string) => { for (const w of waiting.values()) w.fail(new Error(why)); waiting.clear(); };
    sock.onclose = () => died(`the Chrome DevTools connection closed before ${url} was captured`);
    chrome.on('exit', (code) => died(`Chrome (${bin}) exited ${code} before ${url} was captured`));
    sock.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        if (msg.error) w.fail(new Error(`Chrome DevTools: ${msg.error.message}`));
        else w.done(msg.result);
      } else on.get(msg.method)?.(msg.params);
    };
    const send = (method: string, params: object = {}): Promise<any> =>
      new Promise((done, fail) => {
        waiting.set(++id, { done, fail });
        sock.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression: string) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`the look measurement threw in ${url}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };

    // What the page logged and fetched, for the record's console_errors and failed_requests.
    const consoleErrors: string[] = [];
    const failed: { url: string; status: number }[] = [];
    const requests = new Map<string, string>();
    on.set('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a: any) => a.value ?? a.description ?? '').join(' ')); });
    on.set('Runtime.exceptionThrown', (p) => consoleErrors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
    on.set('Network.requestWillBeSent', (p) => requests.set(p.requestId, p.request.url));
    on.set('Network.responseReceived', (p) => { if (p.response.status >= 400) failed.push({ url: p.response.url, status: p.response.status }); });
    on.set('Network.loadingFailed', (p) => { if (!p.canceled) failed.push({ url: requests.get(p.requestId) ?? '', status: 0 }); });
    for (const d of ['Page', 'Runtime', 'Network']) await send(`${d}.enable`);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });

    const loaded = within<void>(WAIT, `${url} did not finish loading in ${WAIT / 1000}s`, (done) => on.set('Page.loadEventFired', () => done()));
    loaded.catch(() => {}); // a navigation error below is the cause to report, not this wait
    const nav = await send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`${url} did not load: ${nav.errorText}`);
    await loaded;
    // Web fonts change text widths, so measure once they are in and two frames have painted.
    await evaluate('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))');
    const record: PageCheck = { url, ...(await evaluate(`(${LOOK})()`)), console_errors: consoleErrors, failed_requests: failed, squashed_text: await evaluate(`(${SQUASHED_TEXT})()`) };
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(capture, Buffer.from(shot.data, 'base64'));
    writeFileSync(domRecord(capture), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    ws?.close();
    chrome.kill('SIGKILL');
    await new Promise((r) => (chrome.exitCode === null && chrome.signalCode === null ? chrome.once('exit', r) : r(null)));
    rmSync(profile, { recursive: true, force: true });
  }
}

// A promise that fails with `why` after `ms`; its timer alone never keeps the process running.
function within<T>(ms: number, why: string, run: (done: (v: T) => void, fail: (e: Error) => void) => void): Promise<T> {
  return new Promise<T>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(why)), ms).unref();
    run((v) => (clearTimeout(timer), done(v)), (e) => (clearTimeout(timer), fail(e)));
  });
}
