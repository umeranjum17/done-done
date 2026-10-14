// Primitive 14 (DOM assertions): page-level defects a screenshot judge misses. The recipe (not done-done) writes one
// page-check record next to each captured screen, named as the capture with .dom.json for its extension
// (home.dark.390w.png -> home.dark.390w.dom.json), so a matrix cell's record carries its DONE_DONE_CELL suffix:
//   {"url": "<page url>", "overflow": <true when content is wider than the viewport>, "overflowing": ["<element>", ...],
//    "console_errors": ["<message>", ...], "failed_requests": [{"url": "<request url>", "status": <HTTP status, 0 when none>}],
//    "squashed_text": [{"element": "<element>", "text": "<its text, ~40 chars>", "chars": <width>, "lines": <n>, "words": <n>}]}
// squashed_text is optional, so a record written before it stays valid.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// The .done-done.yaml dom block: present turns the check on.
export type Dom = { allow_console: string[]; allow_requests: string[]; fail_on_overflow: boolean };
type Squashed = { element: string; text: string; chars: number; lines: number; words: number };
type PageCheck = { url: string; overflow: boolean; overflowing: string[]; console_errors: string[]; failed_requests: { url: string; status: number }[]; squashed_text?: Squashed[] };

// The measurement the recipe passes to its browser tool's eval, so no agent invents one: every visible element with its
// own non-empty text is squashed when its box is under 8 characters wide (box width / the average glyph width of its
// font) while its text is wider than the box, or when its text sits on more line boxes than it has words.
// ponytail: glyph width ignores letter-spacing and text-transform, and words split on spaces, so a wide-tracked capital
// label measures a little narrow and a wrapped paragraph of Chinese or Japanese is one word; count words per script if those show up.
export const SQUASHED_TEXT = `() => {
  const ctx = document.createElement('canvas').getContext('2d'); const out = [];
  for (const e of document.querySelectorAll('body *')) {
    const nodes = [...e.childNodes].filter((n) => n.nodeType === 3 && n.data.trim());
    const text = nodes.map((n) => n.data).join(' ').replace(/\\s+/g, ' ').trim();
    const box = e.getBoundingClientRect(); const s = getComputedStyle(e);
    if (!text || !box.width || !box.height || s.visibility !== 'visible') continue;
    ctx.font = s.fontStyle + ' ' + s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily;
    const chars = box.width / (ctx.measureText('abcdefghijklmnopqrstuvwxyz').width / 26); const words = text.split(' ').length; const tops = new Set();
    for (const n of nodes) { const r = document.createRange(); r.selectNodeContents(n); for (const b of r.getClientRects()) if (b.width) tops.add(Math.round(b.top)); }
    if ((chars < 8 && ctx.measureText(text).width > box.width + 1) || tops.size > words)
      out.push({ element: e.tagName.toLowerCase() + (e.id ? '#' + e.id : e.classList[0] ? '.' + e.classList[0] : ''), text: text.slice(0, 40), chars: Math.round(chars * 10) / 10, lines: tops.size, words });
  }
  return out;
}`.replace(/\s*\n\s*/g, ' ');

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((s) => typeof s === 'string');
const badRegex = (s: string) => { try { new RegExp(s); return false; } catch { return true; } };

export const isDomRecord = (p: string) => p.endsWith('.dom.json');
export const domRecord = (capture: string) => capture.replace(/\.[^./]*$/, '') + '.dom.json';

// The dom block read from config, or the reason it is not one.
export function parseDom(v: unknown): Dom | string {
  if (v == null) v = {};
  if (!isMap(v)) return 'a mapping with optional allow_console, allow_requests and fail_on_overflow';
  for (const k of Object.keys(v)) if (!['allow_console', 'allow_requests', 'fail_on_overflow'].includes(k)) return `unknown key ${k} (allow_console, allow_requests, fail_on_overflow)`;
  for (const k of ['allow_console', 'allow_requests']) {
    if (v[k] !== undefined && !strings(v[k])) return `${k} must be a list of regular expressions`;
    const bad = ((v[k] ?? []) as string[]).find(badRegex);
    if (bad !== undefined) return `${k}: ${JSON.stringify(bad)} is not a valid regular expression`;
  }
  if (v.fail_on_overflow !== undefined && typeof v.fail_on_overflow !== 'boolean') return 'fail_on_overflow must be true or false';
  return { allow_console: (v.allow_console as string[]) ?? [], allow_requests: (v.allow_requests as string[]) ?? [], fail_on_overflow: (v.fail_on_overflow as boolean) ?? true };
}

// Every non-allowed issue the capture's page-check record shows; a missing or malformed record is an issue too.
export function domIssues(dom: Dom, capture: string): string[] {
  const path = domRecord(capture);
  let r: PageCheck;
  try {
    r = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return [code === 'ENOENT' ? `no page-check record ${basename(path)} next to it (the dom block needs one per captured screen)` : `page-check record ${basename(path)} does not read: ${code ?? (e as Error).message}`];
  }
  if (!isMap(r) || typeof r.url !== 'string' || typeof r.overflow !== 'boolean' || !strings(r.overflowing ?? []) || !strings(r.console_errors)
    || !Array.isArray(r.failed_requests) || !r.failed_requests.every((q) => isMap(q) && typeof q.url === 'string' && typeof q.status === 'number')
    || (r.squashed_text !== undefined && !(Array.isArray(r.squashed_text) && r.squashed_text.every((q) => isMap(q) && typeof q.element === 'string' && typeof q.text === 'string' && [q.chars, q.lines, q.words].every((n) => typeof n === 'number')))))
    return [`page-check record ${basename(path)} is not {url, overflow, overflowing, console_errors, failed_requests: [{url, status}], squashed_text: [{element, text, chars, lines, words}]}`];
  const allowed = (list: string[], s: string) => list.some((re) => new RegExp(re).test(s));
  return [
    ...(dom.fail_on_overflow && r.overflow ? [`${r.url} overflows the viewport horizontally${r.overflowing?.length ? ` (${r.overflowing.join(', ')})` : ''}`] : []),
    ...r.console_errors.filter((m) => !allowed(dom.allow_console, m)).map((m) => `${r.url} console error: ${m}`),
    ...r.failed_requests.filter((q) => (q.status === 0 || q.status >= 400) && !allowed(dom.allow_requests, q.url)).map((q) => `${r.url} request failed (${q.status || 'no response'}): ${q.url}`),
    ...(r.squashed_text ?? []).map((q) => `${r.url} squashed text: ${q.element} "${q.text}" is ${q.chars} characters wide (lines ${q.lines}, words ${q.words})`),
  ];
}
