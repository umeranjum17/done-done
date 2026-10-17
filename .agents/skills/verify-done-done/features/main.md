# Main command

Part of the done-done verification map; reached at what README.md says a user runs first.

## Sub-features

- Open/seal a native evidence run, check its captures, record a receipt and verify its caller HEAD.
- The [`look` step](../../../../docs/reference.md#look-check) a journey calls: the e2e journey's fixture repo runs `look-clipped` on `test/fixtures/look/clipped.html` (a card title clipped by its box), which must fail the run naming `h3.card-title`, and `look-fixed` on `test/fixtures/look/fixed.html`, which must pass; both captures must be 390x844 and are copied to the outer run folder as `<run-id>.look-clipped.png` and `<run-id>.look-fixed.png`. Needs Chrome or Chromium on PATH. Open both captures: the clipped title shows one line, the fixed one shows all of it.
- Agent calls that stop early: a streaming agent (pi, opencode, codex, `acp:<target>`) that prints nothing for 5 minutes is stopped, and a provider rate limit (HTTP 429, a usage limit) ends any call at its first line. Both name the agent's stderr and, for a drive, the call record. Drive it with `agent: pi` and `agent_path_override.pi` set to a stand-in script that writes `Error: 429 weekly usage limit reached, resets at <time>` to stderr and keeps printing; run `done-done doctor --probe` and capture the output as `probe-429.txt`. It must finish in seconds with `probe,missing` naming the limit and its reset time. A stand-in that writes a warning and then sleeps must fail the probe after 30 seconds, with the warning in its reason and its fix line.
- First run: `init` says to commit `.done-done.yaml` and the verify skill before the first capture; a capture from a dirty tree fails `check` naming the fix; `status --run <id>` shows the evidence run record `run` printed (the e2e journey asserts it); `check` on a detached HEAD uses its commit as the claim id, so a fresh capture passes there; `init --journey` refuses an absolute path inside the repo and names the relative form (exit 2, nothing written). Drive: `node dist/cli.js init` in a fresh repo, `run`, `status --run`, `check`, and `init --journey smoke -- bash <abs path inside the repo>`. The integration tests in `test/cli.test.mjs` cover each.
- Judge setup: `init --judge` refuses the author's own agent and model and names the command for a judge that differs by agent or by model first; the judge row of `doctor` says the judge kit is needed and gives the `npx -y -p done-done-axi -p @byokit/decide@0.8.0 done-done-axi doctor` line. The integration tests in `test/cli.test.mjs` cover the refusal and the doctor fix text.
- Claude judge sign-in: the `claude-code` judge runs your own `claude` with your normal sign-in, with no sign-in folder of done-done's, no `HOME` or `CLAUDE_CONFIG_DIR` override and no separate `auth login` step. Drive: with `agent_path_override.claude` set to a stub that records its env, `doctor` shows the judge `ok` with a claude binary alone, and `check --judge` runs the stub with your `HOME` and no `CLAUDE_CONFIG_DIR`, `--safe-mode` and `--no-session-persistence`. A stub that reports not signed in fails the judged check with exit 2 naming `claude auth login`. A config that still has `judge.claude_code` stops with one line saying the key is gone. Integration coverage: the judge tests in `test/cli.test.mjs` (`judgeSetup`) and the doctor judge tests.
- Check or receipt citations with [`--citation-base <dir>`](../../../../docs/reference.md#check-a-claim). The existing e2e journey covers a same-named wrong cwd file, omitted-flag compatibility, unchanged absolute citations, missing evidence rejection and unrecorded evidence rejection with `--judge`, plus execution of suggested receipt and remote gate commands.
- Verdict text for two failures: a `check --from <PR body>` that names evidence outside this checkout says it is not in this checkout and shows `--citation-base <dir>` first (re-capture advice only for files the run should have written under the evidence root); a `run <journey>` whose command exits non-zero names its first failing line in the reason, keeping the exit code. Drive: a Checks block naming a file that is not in the checkout, then a journey that prints `FAIL <test>` and exits 1. Prove: `help` leads with `--citation-base`, and `reason` reads `the run command exited 1: FAIL <test>`. Integration coverage: test/cli.test.mjs (the Checks-block file test and the `broken` run test).

## How to get to it (user POV)

what README.md says a user runs first.

## Driving it with tmux/PTY

1. Launch the app as SKILL.md says and wait until it is ready.
2. Run `done-done run e2e` (or `node dist/cli.js run e2e`) from this repo. `journeys/e2e.mjs` drives a synthetic git repository and saves the transcript plus its capture into the outer run folder. To prove an installed tarball rather than local dist, set `DONE_DONE_TEST_CLI` to the absolute installed `done-done-axi/dist/cli.js` path. Use a private HOME, DONE_DONE_HOME and disk-backed TMPDIR. Every assertion must pass; the transcript prints each command, its output, exit code and the fixture HEAD.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/main.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

## Gotchas

See the [citation lookup contract](../../../../docs/reference.md#check-a-claim) rather than changing cwd or `evidence.root` to work around missing files. The journey disables positive relevance judging for its synthetic screen, but exercises judge-enabled missing/unrecorded controls; hosted judge acceptance remains covered by the CLI integration tests.
