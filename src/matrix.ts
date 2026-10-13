// Primitive 2 (capture matrix): one verify run captures every theme x width x form cell
// the repo asks for (axes expanded, journeys run once per cell with the cell in env).
export type Cell = { theme?: string; width?: number; form?: string };
export type Matrix = { theme?: string[]; width?: number[]; form?: string[]; skip?: (Cell & { reason: string })[] };

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// Active only with at least one axis; a block with no axes is today's behaviour.
export const hasMatrix = (m: Matrix | null | undefined): boolean => !!m && (m.theme?.length ?? 0) + (m.width?.length ?? 0) + (m.form?.length ?? 0) > 0;

export function expandMatrix(m: Matrix): Cell[] {
  const each = <T>(a: T[] | undefined): (T | undefined)[] => [...new Set(a?.length ? a : [undefined])];
  const out: Cell[] = [];
  for (const theme of each(m.theme)) for (const width of each(m.width)) for (const form of each(m.form))
    out.push({ ...(theme !== undefined && { theme }), ...(width !== undefined && { width }), ...(form !== undefined && { form }) });
  return out;
}

// A skip entry is a partial cell: it drops every cell agreeing on each axis it names.
export function splitMatrix(m: Matrix): { required: Cell[]; skipped: { cell: Cell; reason: string }[] } {
  const required: Cell[] = [];
  const skipped: { cell: Cell; reason: string }[] = [];
  for (const cell of expandMatrix(m)) {
    const hit = (m.skip ?? []).find((s) =>
      (s.theme === undefined || s.theme === cell.theme) &&
      (s.width === undefined || s.width === cell.width) &&
      (s.form === undefined || s.form === cell.form));
    if (hit) skipped.push({ cell, reason: hit.reason });
    else required.push(cell);
  }
  return { required, skipped };
}

// The capture name suffix: theme and form as named, width with a w (390 -> 390w).
export const cellSuffix = (c: Cell): string => [c.theme, c.width === undefined ? undefined : `${c.width}w`, c.form].filter((x) => x !== undefined).join('.');

export const cellName = (c: Cell): string => [c.theme !== undefined && `theme=${c.theme}`, c.width !== undefined && `width=${c.width}`, c.form !== undefined && `form=${c.form}`].filter((x) => x !== false).join(', ') || 'default';

// Every cell's values in env for a journey run; DONE_DONE_CELL is the suffix captures are named with.
export const cellEnv = (c: Cell): Record<string, string> => ({ DONE_DONE_THEME: c.theme ?? '', DONE_DONE_WIDTH: c.width === undefined ? '' : String(c.width), DONE_DONE_FORM: c.form ?? '', DONE_DONE_CELL: cellSuffix(c) });

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A cell is captured when some file's base name holds its suffix as whole dot-parts,
// so theme dark does not match dark2 or dark-hc.
const covers = (base: string, suffix: string) => new RegExp(`(^|\\.)${esc(suffix)}(\\.|$)`).test(base);

// The full manifest: every required cell with the files that captured it, every skipped cell with its reason.
export function matrixManifest(m: Matrix, files: string[]) {
  const { required, skipped } = splitMatrix(m);
  const b = files.map((f) => f.split('/').pop() ?? f);
  return {
    cells: required.map((c) => ({ cell: cellName(c), suffix: cellSuffix(c), files: files.filter((_, i) => covers(b[i], cellSuffix(c))) })),
    skipped: skipped.map((s) => ({ cell: cellName(s.cell), reason: s.reason })),
  };
}

// Why a matrix block is not one, or '' when it is; the config error names the reason.
export function checkMatrix(v: unknown): string {
  if (!isMap(v)) return 'a mapping with optional theme, width, form and skip';
  for (const k of Object.keys(v)) if (!['theme', 'width', 'form', 'skip'].includes(k)) return `unknown key ${k} (theme, width, form, skip)`;
  const names = (a: unknown) => Array.isArray(a) && a.length && a.every((t) => typeof t === 'string' && t);
  const widths = (a: unknown) => Array.isArray(a) && a.length && a.every((w) => Number.isInteger(w) && (w as number) > 0);
  if (v.theme !== undefined && !names(v.theme)) return 'theme must be a non-empty list of names';
  if (v.form !== undefined && !names(v.form)) return 'form must be a non-empty list of names';
  if (v.width !== undefined && !widths(v.width)) return 'width must be a non-empty list of CSS pixel widths, e.g. [390, 1280]';
  if (v.skip !== undefined && !Array.isArray(v.skip)) return 'skip must be a list of partial cells with a reason';
  for (const s of (v.skip ?? []) as unknown[]) {
    if (!isMap(s)) return 'each skip entry must be a mapping';
    for (const k of Object.keys(s)) if (!['theme', 'width', 'form', 'reason'].includes(k)) return `unknown key ${k} in a skip entry (theme, width, form, reason)`;
    if (s.theme === undefined && s.width === undefined && s.form === undefined) return 'each skip entry must name at least one of theme, width, form';
    if ((s.theme !== undefined && !names([s.theme])) || (s.form !== undefined && !names([s.form])) || (s.width !== undefined && !widths([s.width])))
      return 'a skip entry names theme, width and form as the axes do';
    if (typeof s.reason !== 'string' || !s.reason.trim()) return 'each skip entry needs a reason';
  }
  if (!splitMatrix(v as Matrix).required.length) return 'every cell is skipped, so there is nothing to capture';
  return '';
}
