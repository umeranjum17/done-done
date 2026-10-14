// Primitive 15 (evidence secret scan): a verify run's text evidence and logs must hold no secret. A hit names the file,
// line and pattern, never the matched value.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Secrets = { patterns: Record<string, string>; allow: string[] };
export type Leak = { file: string; line: number; pattern: string };

// Common secret shapes. key-value flags a key, secret, token or password value of 8 characters or more with no spaces or quotes; an auth value needs 24 characters with letters and digits.
const SHAPES: Record<string, RegExp> = {
  'private-key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  'github-token': /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/,
  'api-key': /\b(?:sk-[\w-]{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|xox[abprs]-[\w-]{10,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36})/,
  bearer: /\bbearer\s+[\w.~+/-]{20,}=*/i,
  'key-value': /(?:(?:key|secret|token|passw(?:or)?d)\w*["']?\s*[:=]\s*["']?[^\s"']{8,}|auth\w*["']?\s*[:=]\s*["']?(?=[\w+/.-]*\d)(?=[\w+/.-]*[A-Za-z])[\w+/.-]{24,})/i,
};

// Every file under `paths` (files or folders), minus binaries such as images: a NUL byte in the first 8 KB marks one.
function textFiles(paths: string[]): string[] {
  return paths.flatMap((p) => {
    if (!existsSync(p)) return [];
    if (statSync(p).isDirectory()) return textFiles(readdirSync(p).map((n) => join(p, n)));
    return readFileSync(p).subarray(0, 8192).includes(0) ? [] : [p];
  });
}

export function scanSecrets(paths: string[], cfg: Secrets): Leak[] {
  const shapes = [...Object.entries(SHAPES), ...Object.entries(cfg.patterns).map(([n, re]) => [n, new RegExp(re)] as const)];
  const allow = cfg.allow.map((re) => new RegExp(re));
  const leaks: Leak[] = [];
  for (const file of textFiles(paths))
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      for (const [pattern, re] of shapes) {
        const m = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
        if ([...text.matchAll(m)].some((hit) => !allow.some((a) => a.test(hit[0])))) leaks.push({ file, line: i + 1, pattern });
      }
    });
  return leaks;
}
