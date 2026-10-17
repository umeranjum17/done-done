import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { home } from './config.js';
import { askJudge, backend, prepare, readCache, screen, VERSION, writeCache } from './judge.js';
import { decodePixels } from './media.js';
// The defect kinds, each its own question. Each asks for something the judge can see and measure, not whether it was
// meant that way: a cheap model talks itself out of a judgment ("an intentional style", "the viewer's border"), not out of
// a measurement. look is what the judge writes in its rationale before it answers.
export const KINDS = {
    aspect: {
        defect: 'An avatar, profile picture, app icon or logo mark (a symbol or a face, not a word) is drawn more than 1.3 times wider than tall, or more than 1.3 times taller than wide; or a circle is drawn as an oval; or a photo shows people or objects flattened or stretched.',
        look: 'list each avatar, profile picture, app icon, logo mark and photo with its drawn width x height in pixels',
    },
    'clipped-text': { defect: 'Some text is cut: letters cut off by an edge of the image or of their container, or a word or line that stops mid-way with no ellipsis.', look: 'name any label whose letters touch or cross an edge of the image or of its container' },
    overlap: { defect: 'Two elements are drawn over each other: text over text, a control over content, or content under the status bar, clock or system bars.', look: 'name any two elements that touch or cover each other' },
    'off-screen': { defect: 'An element is cut by the left, right or top edge of the image, so part of it is missing. Content cut by the bottom edge of a scrolling list is not this.', look: 'name any element that touches or crosses the left, right or top edge' },
    'blank-strip': {
        defect: 'A plain band with nothing in it runs along a whole edge of the image (left, right, top or bottom), in a colour different from the screen background beside it, such as a black bar beside a light screen; or a region of the image is left unpainted. The image is the screen captured edge to edge, with no border, margin, frame, crop or letterbox bars of its own, so black side bars or letterboxing mean the app did not fill the screen: that is this defect.',
        look: 'describe what runs along each of the four edges of the image and its colour next to the background colour; any band there is part of the screenshot',
    },
    'squashed-text': {
        defect: 'A text block is squashed: it renders narrower than about 8 characters while its text does not fit, or it is broken onto more lines than it has words, such as a title wrapped one letter per line in a narrow column.',
        look: 'name each text block rendered narrower than about 8 characters while its text does not fit, or with more lines than words, with how many characters wide its column is and how many lines and words it takes',
    },
    layout: { defect: 'Elements are misaligned, squeezed, badly wrapped or stacked wrongly, a control is far too small or large for its place, or text is hard to read against its background.', look: 'describe how the main elements line up and space out' },
};
const NONE = 'Nothing like this is in the image.';
const FLOOR = 0.7;
// A cheap model sometimes answers seven questions with the schema itself, so a malformed answer is asked once more.
const ASK_ATTEMPTS = 2;
const SCREEN = 'The image "screen" is an app\'s screen exactly as captured, edge to edge: everything in it, its edges included, is the app. Answer what you see and measure, not whether it looks intended. For a defect, name the element and where it is in personReason, for example "header avatar, top left".';
const MOCK = ' The image "mock" is the approved design for that screen. Answer about the screen, and count a difference from the mock that a user would see as broken under its kind (a moved, missing or resized element is layout). A difference in live data such as names, numbers or times is not a defect, and neither is an element drawn the same shape as in the mock. A dialog, sheet, menu, popover or toast is approved only where the mock draws that same overlay in the same place: then it covers or cuts the app as in the mock and is no defect of its own; one the mock lacks, or draws elsewhere, is judged like any other element.';
const questions = (mock) => Object.fromEntries(Object.entries(KINDS).map(([kind, k]) => [kind, { kind: 'choice', instructions: `Write the rationale first: ${k.look}. ${SCREEN}${mock ? MOCK : ''}`, options: { defect: k.defect, none: NONE }, floor: FLOOR, personReason: true, images: mock ? ['screen', 'mock'] : ['screen'] }]));
// A measured blank strip: a band along a whole edge, at least STRIP.min of that side deep, in one colour (each channel
// within STRIP.tolerance of the edge line's colour) with nothing in it (at most STRIP.content of its pixels off that
// colour), and at least STRIP.contrast apart from the screen's main colour on some channel. The band grows inward while
// at least half of each line is its colour, so a nav rail or a bar holds its icons or title and counts as content; a
// band that reaches halfway in is the screen's own background (a whole uniform screen is the blank-frame check's).
// A band the mock has too (same edge, depth within STRIP.alike of that side, colour within STRIP.contrast per channel)
// is approved design and is not reported.
// ponytail: one fixed threshold set; it misses a strip close to the main colour (a black bar on a near-black dark screen).
// The judge's blank-strip question stays the second signal; tune STRIP when that shows up.
// A fully transparent pixel is never part of a band or the main colour, so a transparent margin is not a strip.
const STRIP = { min: 0.02, tolerance: 24, contrast: 64, content: 0.005, alike: 0.03 };
function bands(c) {
    const p = c.media.status === 'ok' && screen(c) ? decodePixels(c.bytes, c.media.type) : undefined;
    if (!p)
        return undefined;
    const { w, h, rgb, clear } = p;
    // The screen's main colour: its most common colour, at 16 levels per channel.
    const counts = new Uint32Array(4096);
    for (let i = 0; i < rgb.length; i += 3)
        if (!clear[i / 3])
            counts[((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4)]++;
    const top = counts.indexOf(Math.max(...counts));
    const main = [(top >> 8) * 16 + 8, ((top >> 4) & 15) * 16 + 8, (top & 15) * 16 + 8];
    const out = [];
    for (const edge of ['left', 'right', 'top', 'bottom']) {
        const side = edge === 'left' || edge === 'right';
        const depth = side ? w : h; // how far in a band can reach
        const span = side ? h : w; // the length of the edge
        // The pixel offset `d` lines in from this edge, `s` along it.
        const at = (d, s) => 3 * (side ? s * w + (edge === 'left' ? d : w - 1 - d) : (edge === 'top' ? d : h - 1 - d) * w + s);
        const lineMeasured = (d) => {
            for (let s = 0; s < span; s++)
                if (!clear[at(d, s) / 3])
                    return true;
            return false;
        };
        let ref = 0;
        while (ref < depth && !lineMeasured(ref))
            ref++;
        if (ref === depth)
            continue;
        const sum = [0, 0, 0];
        let n = 0;
        for (let s = 0; s < span; s++) {
            const i = at(ref, s);
            if (clear[i / 3])
                continue;
            n++;
            for (let k = 0; k < 3; k++)
                sum[k] += rgb[i + k];
        }
        const colour = sum.map((v) => Math.round(v / n));
        const off = (i) => colour.some((v, k) => Math.abs(rgb[i + k] - v) > STRIP.tolerance);
        let deep = 0;
        let stray = 0;
        let seen = 0;
        for (let d = 0; d < depth / 2; d++) {
            let miss = 0;
            let looked = 0;
            for (let s = 0; s < span; s++) {
                const i = at(d, s);
                if (clear[i / 3])
                    continue;
                looked++;
                if (off(i))
                    miss++;
            }
            if (!looked)
                continue;
            if (miss > looked / 2)
                break;
            stray += miss;
            seen += looked;
            deep = d + 1;
        }
        if (deep >= depth / 2 || deep < depth * STRIP.min || stray > seen * STRIP.content)
            continue;
        if (colour.every((v, k) => Math.abs(v - main[k]) < STRIP.contrast))
            continue;
        out.push({ edge, colour, deep, share: deep / depth });
    }
    return out;
}
function describe({ edge, colour, deep, share }) {
    const side = edge === 'left' || edge === 'right';
    const hex = `#${colour.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    return { kind: 'blank-strip', where: `${edge} edge: a plain ${hex} band ${deep} px deep (${Math.round(100 * share)}% of the ${side ? 'width' : 'height'}), full ${side ? 'height' : 'width'}, with nothing in it` };
}
// The screen's blank strips, less any band its approved mock has too. unresolved: the screen has a band but its mock
// cannot be measured, so whether the band is approved is unknown.
export function blankStrips(s) {
    const found = bands(s) ?? [];
    const approved = s.mock ? bands(s.mock) : [];
    if (!approved)
        return { defects: [], unresolved: found.length > 0 };
    const alike = (b, m) => b.edge === m.edge && Math.abs(b.share - m.share) <= STRIP.alike && b.colour.every((v, k) => Math.abs(v - m.colour[k]) < STRIP.contrast);
    return { defects: found.filter((b) => !approved.some((m) => alike(b, m))).map(describe), unresolved: false };
}
// Why a file cannot be judged, or its image as sent.
function image(c) {
    if (c.media.status !== 'ok')
        return `${c.name}: ${c.media.why}`;
    if (!screen(c))
        return `${c.name}: only PNG and JPEG screens are judged`;
    const i = prepare(c);
    return typeof i === 'string' ? `${c.name}: ${i}` : i;
}
// records: where each answerer call leaves its record (design-<stamp>-<n>-<request>.agent.json), never the prompt.
// The judge's answer is cached in the run store per exact input (screen and mock bytes, questions, route and model), so
// the same input gets the same verdict on every run: one request per new input, none for a repeat. A judge that does not
// answer stops the command with its cause.
export async function design(cfg, choice, screens, records) {
    const dir = join(home(), 'runs', cfg.app, 'design');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = [];
    const backends = new Map();
    let call = '';
    for (const [n, s] of screens.entries()) {
        const row = { path: s.name, ...(s.mock && { mock: s.mock.name }) };
        // A bad file fails (an empty, truncated or blank-frame screen); one that cannot be judged is unsure.
        if (s.media.status === 'fail') {
            out.push({ ...row, verdict: 'fail', defects: [], reason: `${s.name}: ${s.media.why}` });
            continue;
        }
        // A measured strip fails the screen even when the judge cannot be sent it.
        const strips = blankStrips(s);
        const defects = strips.defects;
        let reason;
        const shot = image(s);
        const mock = s.mock && image(s.mock);
        let cached = false;
        if (typeof shot === 'string' || typeof mock === 'string')
            reason = `not judged: ${typeof shot === 'string' ? shot : mock}`;
        else {
            const withMock = !!mock;
            const key = createHash('sha256').update(JSON.stringify([VERSION, s.sha256, s.mock?.sha256 ?? null, questions(withMock), choice.route, choice.model])).digest('hex');
            const hit = readCache(dir, key);
            cached = Array.isArray(hit?.defects) && Array.isArray(hit?.unsure);
            let judge = cached ? hit : undefined;
            if (!cached) {
                call = `${records}/design-${stamp}-${n + 1}`;
                if (!backends.has(withMock))
                    backends.set(withMock, await backend(cfg, choice, (request) => `${call}-${request}.agent.json`, questions(withMock), ASK_ATTEMPTS));
                const answers = await askJudge(cfg, backends.get(withMock), choice, { screen: withMock ? 'a screenshot next to its approved mock' : 'a screenshot' }, questions(withMock), { screen: shot, ...(mock && { mock }) });
                judge = {
                    defects: Object.entries(answers).filter(([, a]) => a.answer === 'defect').map(([kind, a]) => ({ kind, where: (a.personReason || a.rationale || 'not named').slice(0, 200) })),
                    unsure: Object.entries(answers).filter(([, a]) => a.abstained).map(([kind]) => kind),
                };
                writeCache(dir, key, { ...judge, route: choice.route, model: choice.model });
            }
            if (judge) {
                defects.push(...judge.defects);
                if (judge.unsure.length)
                    reason = `not confident enough about ${judge.unsure.join(', ')}`;
            }
        }
        if (strips.unresolved)
            reason = 'approved mock could not be measured; give a PNG or JPEG mock';
        out.push({ ...row, verdict: defects.length ? 'fail' : reason ? 'unsure' : 'pass', defects, ...(reason && { reason }), ...(cached && { cached }) });
    }
    return out;
}
