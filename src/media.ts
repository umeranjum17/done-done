import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

// Result of validating one evidence file: ok, fail (the file is bad) or unverified (could not tell).
export type Verdict = { status: 'ok' | 'fail' | 'unverified'; type: string; why?: string; w?: number; h?: number };

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
  const std = pngLumaStd(b);
  if (std !== undefined && std < BLANK_STD) return { status: 'fail', type: 'png', why: `png is a blank frame (luminance spread ${std.toFixed(4)})` };
  return { status: 'ok', type: 'png', w, h };
}

// Decodes an 8-bit non-interlaced PNG to RGB (alpha is dropped).
// Other variants return undefined: callers skip what needs pixels and keep the structural checks.
export function pngPixels(b: Buffer): { w: number; h: number; rgb: Uint8Array } | undefined {
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
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
  if (colour === 3 && !palette) return undefined;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  const stride = w * channels;
  if (raw.length < h * (stride + 1)) return undefined;
  const rgb = new Uint8Array(w * h * 3);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
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
    for (let x = 0; x < w; x++) {
      let r, g, bl;
      if (colour === 3) {
        const k = cur[x] * 3;
        [r, g, bl] = [palette![k], palette![k + 1], palette![k + 2]];
      } else if (channels >= 3) [r, g, bl] = [cur[x * channels], cur[x * channels + 1], cur[x * channels + 2]];
      else r = g = bl = cur[x * channels];
      const o = (y * w + x) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = bl;
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, rgb };
}

// Standard deviation of luminance (0..1), sampled across each row.
function pngLumaStd(b: Buffer): number | undefined {
  const px = pngPixels(b);
  if (!px) return undefined;
  const { w, h, rgb } = px;
  let n = 0, sum = 0, sq = 0;
  const step = Math.max(1, Math.floor(w / 256));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x += step) {
      const o = (y * w + x) * 3;
      const l = (0.299 * rgb[o] + 0.587 * rgb[o + 1] + 0.114 * rgb[o + 2]) / 255;
      n++;
      sum += l;
      sq += l * l;
    }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

// Shrinks a PNG by a whole box factor until its long side fits `max`, and re-encodes it as 8-bit RGB.
export function downscalePng(b: Buffer, max: number): Buffer | undefined {
  const px = pngPixels(b);
  if (!px) return undefined;
  const k = Math.ceil(Math.max(px.w, px.h) / max);
  const w = Math.floor(px.w / k), h = Math.floor(px.h / k);
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) sum += px.rgb[((y * k + dy) * px.w + x * k + dx) * 3 + c];
        raw[y * (w * 3 + 1) + 1 + x * 3 + c] = Math.round(sum / (k * k));
      }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    head.write(type, 4, 'latin1');
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 8, 2, 0, 0, 0]);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function jpeg(b: Buffer): Verdict {
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return { status: 'fail', type: 'jpeg', why: 'jpeg truncated (no end-of-image marker)' };
  for (let off = 2; off + 9 < b.length && b[off] === 0xff; off += 2 + b.readUInt16BE(off + 2)) {
    const m = b[off + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = b.readUInt16BE(off + 5), w = b.readUInt16BE(off + 7);
      if (w < MIN_SIDE || h < MIN_SIDE) return { status: 'fail', type: 'jpeg', why: `jpeg is ${w}x${h}, smaller than ${MIN_SIDE}x${MIN_SIDE}` };
      return { status: 'ok', type: 'jpeg', w, h };
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
