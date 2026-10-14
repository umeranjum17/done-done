// Primitive 14 (DOM assertions): page-level defects a screenshot judge misses. The recipe (not done-done) writes one
// page-check record next to each captured screen, named as the capture with .dom.json for its extension
// (home.dark.390w.png -> home.dark.390w.dom.json), so a matrix cell's record carries its DONE_DONE_CELL suffix:
//   {"url": "<page url>", "overflow": <true when content is wider than the viewport>, "overflowing": ["<element>", ...],
//    "console_errors": ["<message>", ...], "failed_requests": [{"url": "<request url>", "status": <HTTP status, 0 when none>}]}
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// The .done-done.yaml dom block: present turns the check on.
export type Dom = { allow_console: string[]; allow_requests: string[]; fail_on_overflow: boolean };
type PageCheck = { url: string; overflow: boolean; overflowing: string[]; console_errors: string[]; failed_requests: { url: string; status: number }[] };

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
    || !Array.isArray(r.failed_requests) || !r.failed_requests.every((q) => isMap(q) && typeof q.url === 'string' && typeof q.status === 'number'))
    return [`page-check record ${basename(path)} is not {url, overflow, overflowing, console_errors, failed_requests: [{url, status}]}`];
  const allowed = (list: string[], s: string) => list.some((re) => new RegExp(re).test(s));
  return [
    ...(dom.fail_on_overflow && r.overflow ? [`${r.url} overflows the viewport horizontally${r.overflowing?.length ? ` (${r.overflowing.join(', ')})` : ''}`] : []),
    ...r.console_errors.filter((m) => !allowed(dom.allow_console, m)).map((m) => `${r.url} console error: ${m}`),
    ...r.failed_requests.filter((q) => (q.status === 0 || q.status >= 400) && !allowed(dom.allow_requests, q.url)).map((q) => `${r.url} request failed (${q.status || 'no response'}): ${q.url}`),
  ];
}
