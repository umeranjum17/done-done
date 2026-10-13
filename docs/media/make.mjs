// Regenerates the README terminal pictures from real runs of the built CLI.
// Usage: npx tsc && node docs/media/make.mjs
// Runs dist/cli.js in a throwaway HOME against a fictional "notes" app, then draws
// what it printed as light and dark terminal SVGs in this folder.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const CLI = join(OUT, '..', '..', 'dist', 'cli.js');

// ---- 1. A fictional app, driven for real -------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'done-done-media-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
const repo = join(home, 'notes');
const env = {
  PATH: `${join(home, 'bin')}:${process.env.PATH}`, HOME: home, DONE_DONE_HOME: join(home, '.done-done'),
  GIT_AUTHOR_NAME: 'Umer', GIT_AUTHOR_EMAIL: 'umer@example.com', GIT_COMMITTER_NAME: 'Umer', GIT_COMMITTER_EMAIL: 'umer@example.com',
};
mkdirSync(join(repo, 'src'), { recursive: true });
mkdirSync(join(home, 'bin'));
writeFileSync(join(home, 'bin', 'done-done'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
writeFileSync(join(repo, 'src', 'sync.js'), 'export const sync = () => "ok";\n');
const yaml = 'app: notes\njourneys:\n  sync:\n    command: node capture.mjs\n';
writeFileSync(join(repo, '.done-done.yaml'), yaml);
// The demo "capture": draws a small, different screenshot each run, like a real capture would.
writeFileSync(join(repo, 'capture.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
const out = process.env.DONE_DONE_EVIDENCE_ROOT, id = process.env.DONE_DONE_RUN_ID, seed = [...(id ?? "")].reduce((a, c) => a + c.charCodeAt(0), 0);
const chunk = (t, d) => { const l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(d.length); c.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d]))); return Buffer.concat([l, Buffer.from(t), d, c]); };
export const png = (w, h, px) => { const hd = Buffer.alloc(13); hd.writeUInt32BE(w, 0); hd.writeUInt32BE(h, 4); hd[8] = 8; hd[9] = 2;
  const raw = Buffer.alloc(h * (w * 3 + 1)); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hd), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); };
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(out + '/after.png', png(320, 200, (x, y) => [(x + seed) % 256, (y * 2) % 256, 180]));
  console.log('  synced a note on two devices, saved after.png');
}
`);
const sh = (cmd) => execFileSync('sh', ['-c', cmd], { cwd: repo, env, encoding: 'utf8' });
sh('git init -q -b main && git add -A && git commit -qm "Start notes"');

// Run a command line in the demo repo; keep what it printed, with $HOME shown as ~.
const term = (cmd) => {
  const r = spawnSync('sh', ['-c', cmd], { cwd: repo, env, encoding: 'utf8' });
  return { cmd, code: r.status, out: (r.stdout + r.stderr).replaceAll(home, '~').trimEnd() };
};
const checks = (evidence) => `## Checks\noutcome: notes sync between two devices\nrepro: n/a: no bug\nproof: no verify skill - done-done run sync\nevidence: ${evidence}\n`;

const run = term('done-done run sync');
const id = run.out.match(/^run_id: (\S+)/m)?.[1];
if (run.code !== 0 || !id) throw new Error(`done-done run sync failed (exit ${run.code}):\n${run.out}`);
const after = join(env.DONE_DONE_HOME, 'evidence', 'notes', id, 'after.png');
writeFileSync(join(repo, 'pr-body.md'), checks(after));
const body = term('cat pr-body.md');
const pass = term('done-done check --from pr-body.md');
writeFileSync(join(repo, 'src', 'sync.js'), 'export const sync = () => "fast";\n');
const commit = term('git commit -qam "Speed up sync"');
const stale = term('done-done check --from pr-body.md');

writeFileSync(join(repo, 'empty.png'), '');
writeFileSync(join(repo, 'blank.png'), execFileSync(process.execPath, ['--input-type=module', '-e',
  `import { png } from './capture.mjs'; process.stdout.write(png(320, 200, () => [250, 250, 250]));`], { cwd: repo }));
writeFileSync(join(repo, 'pr-body.md'), checks(`${after}, empty.png, blank.png`));
const reasons = term('done-done check --from pr-body.md');

writeFileSync(join(repo, '.done-done.yaml'), yaml.replace('journeys:', 'journys:'));
const config = term('done-done run sync');
for (const [name, r, want] of [['run', run, 0], ['pass', pass, 0], ['stale', stale, 1], ['reasons', reasons, 1], ['config', config, 2]])
  if (r.code !== want) throw new Error(`${name}: expected exit ${want}, got ${r.code}\n${r.out}`);

// ---- 2. Draw it ----------------------------------------------------------------------------

const THEMES = {
  light: { bg: '#f6f8fa', bar: '#eaeef2', border: '#d0d7de', fg: '#1f2328', dim: '#59636e', prompt: '#8250df', pass: '#1a7f37', fail: '#cf222e' },
  dark: { bg: '#161b22', bar: '#21262d', border: '#30363d', fg: '#e6edf3', dim: '#8b949e', prompt: '#d2a8ff', pass: '#3fb950', fail: '#ff7b72' },
};
const FS = 16, CW = 9.6, LH = 24, PAD = 22, BAR = 40; // big enough to read on a phone
let COLS = 80; // set per picture
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PROMPT = '~/notes $ ';

// One output line -> [class, text] spans.
function spans(line) {
  let m;
  if ((m = line.match(/^(result: )(pass.*)$/))) return [['d', m[1]], ['p b', m[2]]];
  if ((m = line.match(/^(result: )(fail.*|inconclusive.*)$/))) return [['d', m[1]], ['f b', m[2]]];
  if ((m = line.match(/^(error: )(.*)$/))) return [['f b', m[1]], ['', m[2]]];
  if ((m = line.match(/^(\s*)(fail|inconclusive),(.*)$/))) return [['', m[1] + m[2]], ['f b', m[3]]];
  if ((m = line.match(/^([a-z_]+(?:\[\d+\](?:\{[^}]*\})?)?: )(.*)$/))) return [['d', m[1]], ['', m[2]]];
  return [['', line]];
}

// Session -> rows: {kind: 'cmd'|'out', spans, cmdLen}
function rows(session) {
  const out = [];
  for (const r of session) {
    out.push({ kind: 'cmd', spans: [['c', PROMPT], ['b', r.cmd]], cmdLen: r.cmd.length });
    if (!r.out) continue;
    for (const line of r.out.split('\n')) {
      // Wrap long lines at a space or after a slash (or mid-word if they must), indenting the rest; colours carry over.
      let flat = spans(line).flatMap(([c, t]) => [...t].map((ch) => [c, ch]));
      do {
        let cut = flat.length;
        if (cut > COLS) {
          const chars = flat.slice(0, COLS + 1).map(([, ch]) => ch);
          cut = Math.max(chars.lastIndexOf(' '), chars.slice(0, COLS).lastIndexOf('/') + 1);
          if (cut < COLS / 2) cut = COLS;
        }
        const piece = [];
        for (const [c, ch] of flat.slice(0, cut)) piece.length && piece.at(-1)[0] === c ? (piece.at(-1)[1] += ch) : piece.push([c, ch]);
        out.push({ kind: 'out', spans: piece });
        flat = flat.slice(cut).filter((x, i, a) => i > 0 || x[1] !== ' ');
        if (flat.length) flat = [['', ' '], ['', ' '], ['', ' '], ['', ' '], ...flat];
      } while (flat.length > 4);
    }
  }
  return out;
}

const text = (row, y) => {
  const len = row.spans.reduce((n, [, t]) => n + t.length, 0);
  const body = row.spans.map(([c, t]) => (c ? `<tspan class="${c}">${esc(t)}</tspan>` : esc(t))).join('');
  return `<text xml:space="preserve" x="${PAD}" y="${y}"${len ? ` textLength="${(len * CW).toFixed(1)}" lengthAdjust="spacing"` : ''}>${body}</text>`;
};

function frame(t, height, title, inner, css = '') {
  const W = Math.round(COLS * CW + PAD * 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
text{font:${FS}px ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;fill:${t.fg};white-space:pre}
.d{fill:${t.dim}}.c{fill:${t.prompt}}.p{fill:${t.pass}}.f{fill:${t.fail}}.b{font-weight:600}
.t{font-size:14px;font-weight:600;fill:${t.dim}}${css}
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="10" fill="${t.bg}" stroke="${t.border}"/>
<path d="M0.5 ${BAR}V10.5a10 10 0 0 1 10-10h${W - 21}a10 10 0 0 1 10 10V${BAR}z" fill="${t.bar}" stroke="${t.border}"/>
<circle cx="20" cy="20" r="6" fill="#ff5f57"/><circle cx="40" cy="20" r="6" fill="#febc2e"/><circle cx="60" cy="20" r="6" fill="#28c840"/>
<text class="t" x="${W / 2}" y="25" text-anchor="middle">${esc(title)}</text>
<clipPath id="body"><rect x="1" y="${BAR + 1}" width="${W - 2}" height="${height - BAR - 2}"/></clipPath>
<g clip-path="url(#body)">${inner}</g>
</svg>
`;
}

// A still picture of one or more commands, ending with the exit code of the last one.
function still(t, session, title) {
  const rs = [...rows(session), { kind: 'out', spans: [['d', `exit ${session.at(-1).code}`]] }];
  const height = BAR + 32 + (rs.length - 1) * LH + 22;
  return frame(t, height, title, rs.map((r, i) => text(r, BAR + 32 + i * LH)).join('\n'));
}

// The hero opens on a finished screen, which is also what static previews and no-motion
// readers see; then each scene types out on a cleared screen; then it loops.
function animated(t, finished, scenes, title) {
  const steps = []; // {r, start, end, row, typing, shown}
  let now = 0, maxRows = 0;
  for (const [n, session] of [finished, ...scenes].entries()) {
    const rs = rows(session), first = steps.length;
    rs.forEach((r, row) => {
      if (!n) {
        steps.push({ r, row, start: 0, shown: true });
      } else if (r.kind === 'cmd') {
        now += 0.5;
        steps.push({ r, row, start: now, typing: r.cmdLen * 0.045 });
        now += r.cmdLen * 0.045 + 0.45;
      } else {
        steps.push({ r, row, start: now });
        now += 0.07;
      }
      if (r.kind === 'out' && /^result/.test(r.spans.map((x) => x[1]).join(''))) now += 1.6;
    });
    steps.push({ r: { spans: [['c', PROMPT]] }, row: rs.length, start: now, idle: true, shown: !n });
    now += n ? 2.6 : 4.5; // hold on the finished scene
    for (const st of steps.slice(first)) st.end = now - 0.3;
    maxRows = Math.max(maxRows, rs.length + 1);
  }
  const T = now;
  const pct = (x) => ((x / T) * 100).toFixed(2);
  let css = '', inner = '';
  steps.forEach((st, i) => {
    const y = BAR + 32 + st.row * LH;
    css += st.shown
      ? `\n@keyframes l${i}{0%,${pct(st.end)}%{opacity:1}${pct(st.end + 0.01)}%,100%{opacity:0}}.l${i}{animation:l${i} ${T.toFixed(2)}s linear infinite}`
      : `\n@keyframes l${i}{0%,${pct(st.start)}%{opacity:0}${pct(st.start + 0.01)}%,${pct(st.end)}%{opacity:1}${pct(st.end + 0.01)}%,100%{opacity:0}}.l${i}{opacity:0;animation:l${i} ${T.toFixed(2)}s linear infinite}`;
    if (st.idle) {
      inner += `\n<g class="l${i}">${text(st.r, y)}<rect class="cur" x="${PAD + PROMPT.length * CW}" y="${y - 16}" width="${CW}" height="20" fill="${t.fg}" opacity=".7"/></g>`;
    } else if (st.typing) {
      // A cover in the background colour slides right one character at a time; the cursor rides its edge.
      const n = st.r.cmdLen, x0 = PAD + PROMPT.length * CW, end = st.start + st.typing;
      css += `\n@keyframes k${i}{0%,${pct(st.start)}%{transform:translateX(0)}${pct(end)}%,100%{transform:translateX(${(n * CW).toFixed(1)}px)}}.k${i}{animation:k${i} ${T.toFixed(2)}s steps(${n},end) infinite}`;
      css += `\n@keyframes h${i}{0%,${pct(end + 0.45)}%{opacity:1}${pct(end + 0.46)}%,100%{opacity:0}}.h${i}{animation:h${i} ${T.toFixed(2)}s linear infinite}`;
      inner += `\n<g class="l${i}">${text(st.r, y)}<g class="k${i}"><rect x="${x0}" y="${y - 17}" width="${(n * CW + 20).toFixed(1)}" height="${LH}" fill="${t.bg}"/><rect class="h${i}" x="${x0}" y="${y - 16}" width="${CW}" height="20" fill="${t.fg}" opacity=".7"/></g></g>`;
    } else inner += `\n<g class="l${i}">${text(st.r, y)}</g>`;
  });
  css += `\n@keyframes blink{50%{opacity:0}}.cur{animation:blink 1s steps(1) infinite}`;
  // Without motion, only the finished screen shows (its lines are the only ones visible by default).
  css += `\n@media (prefers-reduced-motion:reduce){g[class]{animation:none!important}}`;
  const height = BAR + 32 + (maxRows - 1) * LH + 22;
  return frame(t, height, title, inner, css);
}

for (const [name, t] of Object.entries(THEMES)) {
  const put = (file, svg) => writeFileSync(join(OUT, `${file}-${name}.svg`), svg);
  COLS = 48;
  put('hero', animated(t, [pass, commit, stale], [[run, pass], [commit, stale]], 'done-done in a demo notes app'));
  put('run', still(t, [run], 'Record a run'));
  put('pass', still(t, [body, pass], 'Fresh proof passes'));
  put('reasons', still(t, [reasons], 'Weak proof is blocked'));
  // Only the error line: the help hint that follows it adds nothing here.
  const errLine = config.out.split('\n').find((l) => l.startsWith('error: ')) ?? config.out.split('\n')[0];
  put('config', still(t, [{ ...config, out: errLine }], 'Mistakes stop early'));
}
console.log(`wrote hero, run, pass, reasons and config (light and dark) to ${OUT}`);
