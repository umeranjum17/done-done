# Main command

Part of the done-done verification map; reached at what README.md says a user runs first.

## Sub-features

- Open/seal a native evidence run, check its captures, record a receipt and verify its caller HEAD.
- The [`look` step](../../../../docs/reference.md#look-check) a journey calls: the e2e journey's fixture repo runs `look-clipped` on `test/fixtures/look/clipped.html` (a card title clipped by its box), which must fail the run naming `h3.card-title`, and `look-fixed` on `test/fixtures/look/fixed.html`, which must pass; both captures must be 390x844 and are copied to the outer run folder as `<run-id>.look-clipped.png` and `<run-id>.look-fixed.png`. Needs Chrome or Chromium on PATH. Open both captures: the clipped title shows one line, the fixed one shows all of it.
- Agent calls that stop early: a streaming agent (pi, opencode, codex, `acp:<target>`) that prints nothing for 5 minutes is stopped, and a provider rate limit (HTTP 429, a usage limit) ends any call at its first line. Both name the agent's stderr and, for a drive, the call record. Drive it with `agent: pi` and `agent_path_override.pi` set to a stand-in script that writes `Error: 429 weekly usage limit reached, resets at <time>` to stderr and keeps printing; run `done-done doctor --probe` and capture the output as `probe-429.txt`. It must finish in seconds with `probe,missing` naming the limit and its reset time. A stand-in that writes a warning and then sleeps must fail the probe after 30 seconds, with the warning in its reason and its fix line.
- First run: `init` says to commit `.done-done.yaml` and the verify skill before the first capture; a capture from a dirty tree fails `check` naming the fix; `status --run <id>` shows the evidence run record `run` printed (the e2e journey asserts it); `check` on a detached HEAD uses its commit as the claim id, so a fresh capture passes there; `init --journey` refuses an absolute path inside the repo and names the relative form (exit 2, nothing written). Drive: `node dist/cli.js init` in a fresh repo, `run`, `status --run`, `check`, and `init --journey smoke -- bash <abs path inside the repo>`. The integration tests in `test/cli.test.mjs` cover each.
- Judge setup: `init --judge` takes any agent and model, the coding agent's own too, and the judge kit installs with the tool; `doctor` reports the judge `missing` only until one is set, with the `init --judge` command. The integration tests in `test/cli.test.mjs` cover a same-agent judge and the doctor row.
- Check or receipt citations with [`--citation-base <dir>`](../../../../docs/reference.md#check-a-claim). The existing e2e journey covers a same-named wrong cwd file, omitted-flag compatibility, unchanged absolute citations, missing evidence rejection and unrecorded evidence rejection, plus execution of suggested receipt and remote gate commands.
- Verdict text for two failures: a `check --from <PR body>` that names evidence outside this checkout says it is not in this checkout and shows `--citation-base <dir>` first (re-capture advice only for files the run should have written under the evidence root); a `run <journey>` whose command exits non-zero names its first failing line in the reason, keeping the exit code. Drive: a Checks block naming a file that is not in the checkout, then a journey that prints `FAIL <test>` and exits 1. Prove: `help` leads with `--citation-base`, and `reason` reads `the run command exited 1: FAIL <test>`. Integration coverage: test/cli.test.mjs (the Checks-block file test and the `broken` run test).

## How to get to it (user POV)

what README.md says a user runs first.

## Driving it with tmux/PTY

1. Launch the app as SKILL.md says and wait until it is ready.
2. Run `done-done run e2e` (or `node dist/cli.js run e2e`) from this repo. `journeys/e2e.mjs` drives a synthetic git repository and saves the transcript plus its capture into the outer run folder. To prove an installed tarball rather than local dist, set `DONE_DONE_TEST_CLI` to the absolute installed `done-done-axi/dist/cli.js` path. Use a private HOME, DONE_DONE_HOME and disk-backed TMPDIR. Every assertion must pass; the transcript prints each command, its output, exit code and the fixture HEAD.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/main.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

## Gotchas

See the [citation lookup contract](../../../../docs/reference.md#check-a-claim) rather than changing cwd or `evidence.root` to work around missing files. done-done gives no result without its judge, so the fixture repo sets a stub judge (deterministic, never a model) and a stub agent doctor finds but no step starts; a real judge is proven by a judged `check` with the agent and judge the user set. The fixture's look journeys embed this checkout's absolute path, so a local pre-commit hook that refuses home paths stops the fixture commit; run it with that hook off for the throwaway repo only (for example `GIT_CONFIG_GLOBAL=/dev/null`).
