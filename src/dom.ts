// Primitive 14 (DOM assertions): page-level defects a screenshot judge misses. The recipe (not done-done) writes one
// page-check record next to each captured screen, named as the capture with .dom.json for its extension
// (home.dark.390w.png -> home.dark.390w.dom.json), so a matrix cell's record carries its DONE_DONE_CELL suffix:
//   {"url": "<page url>", "overflow": <true when content is wider than the viewport>, "overflowing": ["<element>", ...],
//    "console_errors": ["<message>", ...], "failed_requests": [{"url": "<request url>", "status": <HTTP status, 0 when none>}],
//    "squashed_text": [{"element": "<element>", "text": "<its text, ~40 chars>", "chars": <width>, "lines": <n>, "words": <n>}],
//    "clipped_text": [{"element": "<element>", "text": "<its text>", "by": "<the container that cuts it>"}],
//    "cut_off": [{"element": "<element>", "text": "<its text>", "edges": ["left" | "right" | "top", ...]}]}
// squashed_text, clipped_text and cut_off are optional, so a record written before them stays valid.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// The .done-done.yaml dom block: present turns the check on.
export type Dom = { allow_console: string[]; allow_requests: string[]; fail_on_overflow: boolean };
type Squashed = { element: string; text: string; chars: number; lines: number; words: number };
type Clipped = { element: string; text: string; by: string };
type Cut = { element: string; text: string; edges: string[] };
export type PageCheck = { url: string; overflow: boolean; overflowing: string[]; console_errors: string[]; failed_requests: { url: string; status: number }[]; squashed_text?: Squashed[]; clipped_text?: Clipped[]; cut_off?: Cut[] };

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
    const s = getComputedStyle(e); const w = e.offsetWidth; const h = e.offsetHeight;
    if (!(e instanceof HTMLElement) || !text || !e.getClientRects().length || ((w <= 1 || h <= 1) && s.overflow !== 'visible') || s.visibility !== 'visible') continue;
    ctx.font = s.fontStyle + ' ' + s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily;
    const chars = w / (ctx.measureText('abcdefghijklmnopqrstuvwxyz').width / 26); const words = text.split(' ').length; const tops = new Set();
    for (const n of nodes) { const r = document.createRange(); r.selectNodeContents(n); for (const b of r.getClientRects()) if (b.width) tops.add(Math.round(b.top)); }
    if ((chars < 8 && ctx.measureText(text).width > w + 1) || tops.size > words)
      out.push({ element: e.tagName.toLowerCase() + (e.id ? '#' + e.id : e.classList[0] ? '.' + e.classList[0] : ''), text: text.slice(0, 40), chars: Math.round(chars * 10) / 10, lines: tops.size, words });
  }
  return out;
}`.replace(/\s*\n\s*/g, ' ');

// The rest of the look measurement, run in the page by `done-done look` next to SQUASHED_TEXT. A part of an element only
// shows inside every ancestor that clips it (overflow other than visible; html and body clip as the viewport, so they are
// the edges, not containers). Text is clipped when part of it shows and part runs past a hidden or clip container on an
// axis without text-overflow: ellipsis or a line clamp; an element is cut off when part of what shows lies past the
// left, right or top edge of the viewport (the page is at its top, so nothing above it can be scrolled to). Something
// entirely outside its container or the viewport is hidden on purpose (a closed drawer, a visually hidden label), not cut;
// a cut element's children are not listed again.
// ponytail: the main frame only, and a transform or clip-path that hides part of a box is not seen; measure each frame
// and clip-path when those show up.
export const LOOK = `() => {
  const vw = document.documentElement.clientWidth; const vh = document.documentElement.clientHeight; const out = { clipped_text: [], cut_off: [] }; const cut = new Set();
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : e.classList[0] ? '.' + e.classList[0] : '');
  const own = (e) => [...e.childNodes].filter((n) => n.nodeType === 3 && n.data.trim()).map((n) => n.data).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 40);
  const clips = (e) => { const out = []; for (let a = e; a && a !== document.body && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { const r = a.getBoundingClientRect(); out.push({ a, s, l: r.left + a.clientLeft, t: r.top + a.clientTop, r: r.left + a.clientLeft + a.clientWidth, b: r.top + a.clientTop + a.clientHeight }); } } return out; };
  const shows = (b) => b.r - b.l > 1 && b.b - b.t > 1;
  for (const e of document.querySelectorAll('body *')) {
    const s = getComputedStyle(e); const rect = e.getBoundingClientRect();
    if (!e.getClientRects().length || s.visibility !== 'visible' || rect.width < 1 || rect.height < 1) continue;
    const boxes = clips(e.parentElement);
    const box = boxes.reduce((v, c) => ({ l: Math.max(v.l, c.l), t: Math.max(v.t, c.t), r: Math.min(v.r, c.r), b: Math.min(v.b, c.b) }), { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom });
    if (!shows(box)) continue;
    const text = own(e);
    const parent = [...cut].some((c) => c.contains(e));
    const edges = [box.l < -1 && 'left', box.r > vw + 1 && 'right', box.t < -1 && 'top'].filter(Boolean);
    if (edges.length && box.r > 0 && box.l < vw && box.b > 0 && box.t < vh && !parent) { cut.add(e); out.cut_off.push({ element: name(e), text, edges }); }
    if (!text) continue;
    const t = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
    for (const n of e.childNodes) if (n.nodeType === 3 && n.data.trim()) { const g = document.createRange(); g.selectNodeContents(n); for (const q of g.getClientRects()) if (q.width) { t.l = Math.min(t.l, q.left); t.t = Math.min(t.t, q.top); t.r = Math.max(t.r, q.right); t.b = Math.max(t.b, q.bottom); } }
    if (t.l === Infinity || t.t >= vh || t.b <= 0) continue;
    for (const c of clips(e)) {
      if (c.r - c.l <= 1 || c.b - c.t <= 1 || !(t.r > c.l && t.l < c.r && t.b > c.t && t.t < c.b) || !['hidden', 'clip'].some((v) => v === c.s.overflowX || v === c.s.overflowY)) continue;
      const x = ['hidden', 'clip'].includes(c.s.overflowX) && c.s.textOverflow !== 'ellipsis' && (t.l < c.l - 1 || t.r > c.r + 1);
      const y = ['hidden', 'clip'].includes(c.s.overflowY) && c.s.webkitLineClamp === 'none' && (t.t < c.t - 1 || t.b > c.b + 1);
      if (x || y) { out.clipped_text.push({ element: name(e), text, by: c.a === e ? 'its own box' : name(c.a) }); break; }
    }
  }
  return { overflow: document.documentElement.scrollWidth > vw, overflowing: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > vw + 1).slice(0, 10).map(name), ...out };
}`.replace(/\s*\n\s*/g, ' ');

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((s) => typeof s === 'string');
// An optional record list: absent, or every item has an element and text and passes `more`.
const list = (a: unknown, more: (q: Record<string, unknown>) => boolean) => a === undefined || (Array.isArray(a) && a.every((q) => isMap(q) && typeof q.element === 'string' && typeof q.text === 'string' && more(q)));
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
    || !list(r.squashed_text, (q) => [q.chars, q.lines, q.words].every((n) => typeof n === 'number'))
    || !list(r.clipped_text, (q) => typeof q.by === 'string') || !list(r.cut_off, (q) => strings(q.edges)))
    return [`page-check record ${basename(path)} is not {url, overflow, overflowing, console_errors, failed_requests: [{url, status}], squashed_text: [{element, text, chars, lines, words}], clipped_text: [{element, text, by}], cut_off: [{element, text, edges}]}`];
  const allowed = (list: string[], s: string) => list.some((re) => new RegExp(re).test(s));
  return [
    ...lookIssues({ ...r, overflow: dom.fail_on_overflow && r.overflow }),
    ...r.console_errors.filter((m) => !allowed(dom.allow_console, m)).map((m) => `${r.url} console error: ${m}`),
    ...r.failed_requests.filter((q) => (q.status === 0 || q.status >= 400) && !allowed(dom.allow_requests, q.url)).map((q) => `${r.url} request failed (${q.status || 'no response'}): ${q.url}`),
  ];
}

// The look defects a page-check record shows: horizontal overflow, squashed, clipped and cut-off text or elements.
export function lookIssues(r: PageCheck): string[] {
  const quoted = (t: string) => (t ? ` "${t}"` : '');
  return [
    ...(r.overflow ? [`${r.url} overflows the viewport horizontally${r.overflowing?.length ? ` (${r.overflowing.join(', ')})` : ''}`] : []),
    ...(r.squashed_text ?? []).map((q) => `${r.url} squashed text: ${q.element} "${q.text}" is ${q.chars} characters wide (lines ${q.lines}, words ${q.words})`),
    ...(r.clipped_text ?? []).map((q) => `${r.url} clipped text: ${q.element}${quoted(q.text)} is cut by ${q.by}`),
    ...(r.cut_off ?? []).map((q) => `${r.url} cut off: ${q.element}${quoted(q.text)} runs past the ${q.edges.join(' and ')} edge of the viewport`),
  ];
}
