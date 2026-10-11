import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';
import { inflateSync } from 'node:zlib';

// Result of validating one evidence file: ok, fail (the file is bad) or unverified (could not tell).
export type Verdict = { status: 'ok' | 'fail' | 'unverified'; type: string; why?: string };

const MIN_SIDE = 64;
const BLANK_STD = 0.005;
const TEXT = new Set(['.log', '.txt', '.out', '.err', '.stdout', '.stderr', '.md', '.csv', '.json', '.jsonl', '.xml', '.html', '.toon']);
const EXT_TYPE: Record<string, string> = {
  '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif',
  '.mp4': 'mp4', '.mov': 'mp4', '.m4v': 'mp4', '.webm': 'webm', '.mkv': 'webm',
};

function sniff(b: Buffer): string | undefined {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  if (b.length >= 8 && b.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
}

export function checkMedia(path: string, b: Buffer): Verdict {
  const ext = extname(path).toLowerCase();
  const want = EXT_TYPE[ext];
  const got = sniff(b);
  if (b.length === 0) return { status: 'fail', type: want ?? 'file', why: 'empty (0 bytes)' };
  if (want && got !== want) return { status: 'fail', type: want, why: got ? `named ${ext} but the bytes are ${got}` : `not a valid ${want} (bad magic bytes)` };
  if (!want && got) return { status: 'fail', type: got, why: `named ${ext || 'without extension'} but the bytes are ${got}` };
  switch (want) {
    case 'png': return png(b);
    case 'jpeg': return jpeg(b);
    case 'webp':
      return b.readUInt32LE(4) === b.length - 8 ? { status: 'ok', type: 'webp' } : { status: 'fail', type: 'webp', why: 'webp truncated (RIFF size does not match file size)' };
    case 'gif':
      return b[b.length - 1] === 0x3b ? { status: 'ok', type: 'gif' } : { status: 'fail', type: 'gif', why: 'gif truncated (no trailer byte)' };
    case 'mp4':
    case 'webm':
      return video(path, want);
  }
  if (TEXT.has(ext)) {
    const head = b.subarray(0, 8192);
    if (head.includes(0)) return { status: 'fail', type: 'text', why: 'text file contains binary data' };
    const text = b.toString('utf8');
    if (!text.trim()) return { status: 'fail', type: 'text', why: 'only whitespace' };
    if (ext === '.json') {
      try {
        JSON.parse(text);
      } catch {
        return { status: 'fail', type: 'json', why: 'json does not parse' };
      }
    }
    return { status: 'ok', type: 'text' };
  }
  return { status: 'ok', type: 'file' };
}

function png(b: Buffer): Verdict {
  if (b.length < 45 || b.toString('latin1', b.length - 8, b.length - 4) !== 'IEND') return { status: 'fail', type: 'png', why: 'png truncated (no IEND chunk at the end)' };
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  if (w < MIN_SIDE || h < MIN_SIDE) return { status: 'fail', type: 'png', why: `png is ${w}x${h}, smaller than ${MIN_SIDE}x${MIN_SIDE}` };
  const std = pngLumaStd(b, w, h);
  if (std !== undefined && std < BLANK_STD) return { status: 'fail', type: 'png', why: `png is a blank frame (luminance spread ${std.toFixed(4)})` };
  return { status: 'ok', type: 'png' };
}

// Decodes 8-bit non-interlaced PNGs and returns the standard deviation of luminance (0..1).
// Other variants return undefined: the blank-frame guard is skipped, the file is still structurally checked.
function pngLumaStd(b: Buffer, w: number, h: number): number | undefined {
  const depth = b[24], colour = b[25], interlace = b[28];
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
  if (depth !== 8 || interlace !== 0 || !channels) return undefined;
  const idat: Buffer[] = [];
  let palette: Buffer | undefined;
  for (let off = 8; off + 8 <= b.length; ) {
    const len = b.readUInt32BE(off), kind = b.toString('latin1', off + 4, off + 8);
    if (kind === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    if (kind === 'PLTE') palette = b.subarray(off + 8, off + 8 + len);
    off += 12 + len;
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  const stride = w * channels;
  if (raw.length < h * (stride + 1)) return undefined;
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let n = 0, sum = 0, sq = 0;
  const step = Math.max(1, Math.floor(w / 256));
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, up = prev[i], c = i >= channels ? prev[i - channels] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = up;
      else if (filter === 3) p = (a + up) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = (row[i] + p) & 0xff;
    }
    for (let x = 0; x < w; x += step) {
      let r, g, bl;
      if (colour === 3) {
        if (!palette) return undefined;
        const k = cur[x] * 3;
        [r, g, bl] = [palette[k], palette[k + 1], palette[k + 2]];
      } else if (channels >= 3) [r, g, bl] = [cur[x * channels], cur[x * channels + 1], cur[x * channels + 2]];
      else r = g = bl = cur[x * channels];
      const l = (0.299 * r + 0.587 * g + 0.114 * bl) / 255;
      n++;
      sum += l;
      sq += l * l;
    }
    [prev, cur] = [cur, prev];
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

function jpeg(b: Buffer): Verdict {
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return { status: 'fail', type: 'jpeg', why: 'jpeg truncated (no end-of-image marker)' };
  for (let off = 2; off + 9 < b.length && b[off] === 0xff; off += 2 + b.readUInt16BE(off + 2)) {
    const m = b[off + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = b.readUInt16BE(off + 5), w = b.readUInt16BE(off + 7);
      if (w < MIN_SIDE || h < MIN_SIDE) return { status: 'fail', type: 'jpeg', why: `jpeg is ${w}x${h}, smaller than ${MIN_SIDE}x${MIN_SIDE}` };
      return { status: 'ok', type: 'jpeg' };
    }
  }
  return { status: 'fail', type: 'jpeg', why: 'jpeg has no frame header' };
}

// Counts packets rather than trusting the duration header, which browser recorders often leave empty.
function video(path: string, type: string): Verdict {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  if (r.error) return { status: 'unverified', type, why: `video not verified: ffprobe unavailable (${(r.error as NodeJS.ErrnoException).code})` };
  const packets = parseInt(r.stdout.trim(), 10);
  if (r.status !== 0 || !(packets >= 2)) return { status: 'fail', type, why: `${type} does not decode: ${(r.stderr.trim().split('\n')[0] || `${packets || 0} video packets`).slice(0, 160)}` };
  return { status: 'ok', type };
}
