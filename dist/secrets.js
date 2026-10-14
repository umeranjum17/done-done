// Primitive 15 (evidence secret scan): a verify run's text evidence and logs must hold no secret. A hit names the file,
// line and pattern, never the matched value.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
// Common secret shapes. key-value flags a key, secret, token or password value of 8 characters or more with no spaces or quotes; an auth value needs 24 characters with letters and digits.
const SHAPES = {
    'private-key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    'github-token': /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/,
    'api-key': /\b(?:sk-[\w-]{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|xox[abprs]-[\w-]{10,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36})/,
    bearer: /\bbearer\s+[\w.~+/-]{20,}=*/i,
    'key-value': /(?:(?:key|secret|token|passw(?:or)?d)\w*["']?\s*[:=]\s*["']?[^\s"']{8,}|auth\w*["']?\s*[:=]\s*["']?(?=[\w+/.-]*\d)(?=[\w+/.-]*[A-Za-z])[\w+/.-]{24,})/i,
};
// Every file under `paths` (files or folders), minus binaries such as images: a NUL byte in the first 8 KB marks one.
function textFiles(paths) {
    return paths.flatMap((p) => {
        if (!existsSync(p))
            return [];
        if (statSync(p).isDirectory())
            return textFiles(readdirSync(p).map((n) => join(p, n)));
        const fd = openSync(p, 'r');
        try {
            const head = Buffer.alloc(8192);
            return head.subarray(0, readSync(fd, head, 0, 8192, 0)).includes(0) ? [] : [p];
        }
        finally {
            closeSync(fd);
        }
    });
}
export function scanSecrets(paths, cfg) {
    const shapes = [
        ...Object.entries(SHAPES).map(([n, re]) => [n, new RegExp(re.source, `${re.flags}g`)]),
        ...Object.entries(cfg.patterns).map(([n, re]) => [n, new RegExp(re, 'g')]),
    ];
    const allow = cfg.allow.map((re) => new RegExp(re));
    const leaks = [];
    for (const file of textFiles(paths))
        readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
            for (const [pattern, re] of shapes) {
                if ([...text.matchAll(re)].some((hit) => !allow.some((a) => a.test(hit[0]))))
                    leaks.push({ file, line: i + 1, pattern });
            }
        });
    return leaks;
}
