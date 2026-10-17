// Generates skills/done-done/SKILL.md: a minimal skill that defers to the live CLI, so installed
// copies never restate commands or flags that can go stale.
//
//   npm run build:skill              # write the file
//   npm run build:skill -- --check   # exit 1 if the committed file differs from the generated one
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The command an agent runs when done-done is not on PATH: the npm package.
const NPX = 'npx -y done-done-axi';

const DESCRIPTION =
  'Prove the real app works before work is called done: done-done runs a capture of the real product, ties every screenshot, ' +
  'recording and log it writes to the exact commit, then checks that cited evidence is real, fresh and not reused. ' +
  'Use when the user asks to prove a change or app works, asks whether a task is really done, wants screenshots, ' +
  'recordings or logs captured as evidence, or wants a pull request gated on proof.';

const SKILL = `---
name: done-done
description: ${JSON.stringify(DESCRIPTION)}
license: Apache-2.0
argument-hint: "[what to prove, e.g. the app in this repo works]"
metadata:
  author: umeranjum17
  hermes:
    tags: [proof, evidence, verification, screenshots, ci, axi]
    category: devops
---

# done-done

"No proof, no done." done-done captures proof from the real product, ties every screenshot, recording
and log to the exact commit, and checks that cited proof is real, fresh and not reused. You run it for
the user; they only say what should be proven.

## Current guidance lives in the CLI

Do not follow command or config details from memory or from this file - installed copies go stale.
Get the current source of truth from the CLI.

First run \`command -v done-done\`. If it prints a path, run \`done-done\` as shown below. If not, run
\`${NPX}\` wherever this file or done-done output says \`done-done\` - nothing to install.

- \`done-done\` (no arguments, inside the repo) for this repo's proof setup and the next step
- \`done-done --help\` for every command and flag, the journey format and the exact \`## Checks\` block
- \`done-done <command> --help\` for one command's usage and flags

Results are TOON: read \`result\` and follow the \`help\` lines through
\`init\`, \`doctor\`, \`run\`, \`verify\`, \`check\` and \`receipt\`. Proof comes from driving the real product, not from a unit test run, and counts only from a committed
tree: commit the done-done setup (config, capture script) before you capture. \`fail\` or
\`inconclusive\` is not done: fix the cause and re-run, or tell the user exactly what is still unproven.
A run waiting at its gate (\`awaiting_approval\`) is the user's call: show them its findings and captures, and run
\`done-done respond\` only with their answer and reason. Never approve or skip on your own; \`overridden\` is not done either.
A journey that \`spends\` runs only after the user approves spending: \`done-done run <journey>\` refuses it, so ask the user and use \`verify\`.

For a web page, \`done-done look <url>\` is the look step a journey calls: it captures the page at a 390x844 phone viewport
with its page-check record and exits 1 on squashed, clipped or cut-off UI, naming each element. A hit fails the journey;
never wrap it in \`|| true\` or log the exit and go on. A journey in \`.done-done.yaml\` that calls it:

\`\`\`yaml
journeys:
  inbox-look:
    command: done-done look http://127.0.0.1:3000/inbox --out "$DONE_DONE_EVIDENCE_ROOT/inbox.png"
\`\`\`

done-done starts a coding agent the user chose. When it says no agent is set, ask the user which agent
(and model) to use and save their answer with the command it prints; never choose one for them.

done-done runs its own agent: \`done-done verify\` drives the journey, then a judge the user chose, in a
fresh session of its own, looks at each capture. \`check\` and \`receipt\` start the judge too,
and nothing turns it off: there is no result without it. When it says no judge is set, ask the user which
judge (and model) to use and save their answer with the command it prints; never choose one for them. When
the judge fails, report its error to the user; never call the work proven without a judge pass.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/done-done\` explicitly - fetch the current CLI
guidance, then prove that. If it is empty, infer what to prove from the conversation.
`;

const target = fileURLToPath(new URL('../skills/done-done/SKILL.md', import.meta.url));
if (process.argv.includes('--check')) {
  let actual = '';
  try {
    actual = readFileSync(target, 'utf8');
  } catch {}
  if (actual !== SKILL) {
    console.error('skills/done-done/SKILL.md is out of date. Run `npm run build:skill` and commit the result.');
    process.exit(1);
  }
  console.log('skills/done-done/SKILL.md is up to date.');
} else {
  writeFileSync(target, SKILL);
  console.log(`Wrote ${target}`);
}
