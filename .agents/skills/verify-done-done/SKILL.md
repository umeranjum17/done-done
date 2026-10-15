---
name: verify-done-done
description: Drive the done-done CLI the way a user does and capture proof it works. Use when proving a done-done change, capturing evidence, or keeping the feature map honest.
---

# verify-done-done

Scaffolded by `done-done init` from this repo's own files (surface: CLI). Where a step says to find something, the first drive finds it and records it there.

## Launch

node dist/cli.js --help

Ready when the launch command runs with no error (exit 0, or a prompt waiting for input). Tear down what you started; never kill by process name.
When the repo's .done-done.yaml has an instance block, done-done already runs the app at $DONE_DONE_BASE_URL (its own port and HOME): BASE is then that URL, never a hard-coded port.

## Doctor

Read-only: is this instance worth driving? Process up, right build, port owned by us, auth valid. each run uses its own invocation; never drive a shared session the user owns.

## Drive

Harness: tmux/PTY. Prefer the repo's real handles (routes, commands, labels) over coordinates:

- Main command: what README.md says a user runs first

## Evidence

Capture terminal transcripts, exit codes and side effects (files written, rows inserted). Exercise the real user path, not internal setters; done-done's judge checks every capture in the run folder against the outcome, so save only captures of the resulting state there and keep any of earlier steps outside it; verify side effects alongside what is visible. Evidence goes to the run folder `done-done run` prints. Every drive uses these done-done primitives:

- Matrix: when .done-done.yaml sets a matrix block, each journey runs once per theme x width x form cell with DONE_DONE_THEME, DONE_DONE_WIDTH, DONE_DONE_FORM and DONE_DONE_CELL set: name each capture with its cell suffix, so every cell is captured or skipped with a reason, never silently missing.
- DOM: when .done-done.yaml sets a dom block, write next to each capture its page-check record, the capture's name with .dom.json for its extension (home.dark.390w.png -> home.dark.390w.dom.json): {"url": "<page url>", "overflow": <true when content is wider than the viewport>, "overflowing": ["<element>", ...], "console_errors": ["<message>", ...], "failed_requests": [{"url": "<url>", "status": <HTTP status, 0 when none>}], "squashed_text": [{"element": "<element>", "text": "<text>", "chars": <width in characters>, "lines": <n>, "words": <n>}]}; with your browser tool (for example chrome-devtools-axi): overflow from eval "() => { const w = document.documentElement.clientWidth; return { overflow: document.documentElement.scrollWidth > w, overflowing: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > w + 1).slice(0, 10).map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')) } }", console errors from console --type error, failed requests (status 400 or more, or no response) from network, squashed_text from eval "() => { const ctx = document.createElement('canvas').getContext('2d'); const out = []; for (const e of document.querySelectorAll('body *')) { const nodes = [...e.childNodes].filter((n) => n.nodeType === 3 && n.data.trim()); const text = nodes.map((n) => n.data).join(' ').replace(/\s+/g, ' ').trim(); const s = getComputedStyle(e); const w = e.offsetWidth; const h = e.offsetHeight; if (!(e instanceof HTMLElement) || !text || !e.getClientRects().length || ((w <= 1 || h <= 1) && s.overflow !== 'visible') || s.visibility !== 'visible') continue; ctx.font = s.fontStyle + ' ' + s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily; const chars = w / (ctx.measureText('abcdefghijklmnopqrstuvwxyz').width / 26); const words = text.split(' ').length; const tops = new Set(); for (const n of nodes) { const r = document.createRange(); r.selectNodeContents(n); for (const b of r.getClientRects()) if (b.width) tops.add(Math.round(b.top)); } if ((chars < 8 && ctx.measureText(text).width > w + 1) || tops.size > words) out.push({ element: e.tagName.toLowerCase() + (e.id ? '#' + e.id : e.classList[0] ? '.' + e.classList[0] : ''), text: text.slice(0, 40), chars: Math.round(chars * 10) / 10, lines: tops.size, words }); } return out; }" exactly as written (in every frame, an embedded one too).
- Text: for a text outcome, save the CLI output, log or JSON itself as a .txt, .log or .json capture; the check needs it to hold text and JSON to parse.
- Secrets: never write a secret (key, token, password, Bearer header) into evidence or logs; verify scans them and fails the run on a hit.
- Spends: a journey with `spends:` runs only after the user approves the spend at verify's gate; never run it another way.
- Before/after: with `base_ref` set, verify also drives the base ref into the run folder's before/; save the same captures under the same names there, so each pairs with its base capture.

## Cleanup

Stop the instances this run started and remove scratch state. Evidence survives cleanup: never delete the run folder.
