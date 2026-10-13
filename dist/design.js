import { askJudge, backend, judgeable, prepare } from './judge.js';
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
    layout: { defect: 'Elements are misaligned, squeezed, badly wrapped or stacked wrongly, a control is far too small or large for its place, or text is hard to read against its background.', look: 'describe how the main elements line up and space out' },
};
const NONE = 'Nothing like this is in the image.';
const FLOOR = 0.7;
// A cheap model sometimes answers six questions with the schema itself, so a malformed answer is asked once more.
const ASK_ATTEMPTS = 2;
const SCREEN = 'The image "screen" is an app\'s screen exactly as captured, edge to edge: everything in it, its edges included, is the app. Answer what you see and measure, not whether it looks intended. For a defect, name the element and where it is in personReason, for example "header avatar, top left".';
const MOCK = ' The image "mock" is the approved design for that screen. Answer about the screen, and count a difference from the mock that a user would see as broken under its kind (a moved, missing or resized element is layout). A difference in live data such as names, numbers or times is not a defect, and neither is an element drawn the same shape as in the mock.';
const questions = (mock) => Object.fromEntries(Object.entries(KINDS).map(([kind, k]) => [kind, { kind: 'choice', instructions: `Write the rationale first: ${k.look}. ${SCREEN}${mock ? MOCK : ''}`, options: { defect: k.defect, none: NONE }, floor: FLOOR, personReason: true, images: mock ? ['screen', 'mock'] : ['screen'] }]));
// Why a file cannot be judged, or its image as sent.
function image(c) {
    if (c.media.status !== 'ok')
        return `${c.name}: ${c.media.why}`;
    if (!judgeable(c))
        return `${c.name}: only PNG and JPEG screens are judged`;
    const i = prepare(c);
    return typeof i === 'string' ? `${c.name}: ${i}` : i;
}
// records: where each answerer call leaves its record (design-<stamp>-<n>.agent.json), never the prompt.
export async function design(cfg, choice, screens, records) {
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
        const shot = image(s);
        const mock = s.mock && image(s.mock);
        if (typeof shot === 'string' || typeof mock === 'string') {
            out.push({ ...row, verdict: 'unsure', defects: [], reason: `not judged: ${typeof shot === 'string' ? shot : mock}` });
            continue;
        }
        const withMock = !!mock;
        call = `${records}/design-${stamp}-${n + 1}`;
        if (!backends.has(withMock))
            backends.set(withMock, await backend(cfg, choice, () => `${call}.agent.json`, questions(withMock), ASK_ATTEMPTS));
        const answers = await askJudge(cfg, backends.get(withMock), choice, { screen: withMock ? 'a screenshot next to its approved mock' : 'a screenshot' }, questions(withMock), { screen: shot, ...(mock && { mock }) });
        if (typeof answers === 'string') {
            out.push({ ...row, verdict: 'unsure', defects: [], reason: answers });
            continue;
        }
        const defects = Object.entries(answers).filter(([, a]) => a.answer === 'defect').map(([kind, a]) => ({ kind, where: (a.personReason || a.rationale || 'not named').slice(0, 200) }));
        const unsure = Object.entries(answers).filter(([, a]) => a.abstained).map(([kind]) => kind);
        const reason = unsure.length ? `not confident enough about ${unsure.join(', ')}` : undefined;
        out.push({ ...row, verdict: defects.length ? 'fail' : unsure.length ? 'unsure' : 'pass', defects, ...(reason && { reason }) });
    }
    return out;
}
