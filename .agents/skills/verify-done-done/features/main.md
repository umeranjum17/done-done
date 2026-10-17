# Main command

Part of the done-done verification map; reached at what README.md says a user runs first.

## Sub-features

- Open/seal a native evidence run, check its captures, record a receipt and verify its caller HEAD.
- The [`look` step](../../../../docs/reference.md#look-check) a journey calls: the e2e journey's fixture repo runs `look-clipped` on `test/fixtures/look/clipped.html` (a card title clipped by its box), which must fail the run naming `h3.card-title`, and `look-fixed` on `test/fixtures/look/fixed.html`, which must pass; both captures must be 390x844 and are copied to the outer run folder as `<run-id>.look-clipped.png` and `<run-id>.look-fixed.png`. Needs Chrome or Chromium on PATH. Open both captures: the clipped title shows one line, the fixed one shows all of it.
- Agent calls that stop early: a streaming agent (pi, opencode, codex, `acp:<target>`) that prints nothing for 5 minutes is stopped, and a provider rate limit (HTTP 429, a usage limit) ends any call at its first line. Both name the agent's stderr and, for a drive, the call record. Drive it with `agent: pi` and `agent_path_override.pi` set to a stand-in script that writes `Error: 429 weekly usage limit reached, resets at <time>` to stderr and keeps printing; run `done-done doctor --probe` and capture the output as `probe-429.txt`. It must finish in seconds with `probe,missing` naming the limit and its reset time. A stand-in that writes a warning and then sleeps must fail the probe after 30 seconds, with the warning in its reason and its fix line.
- Check or receipt citations with [`--citation-base <dir>`](../../../../docs/reference.md#check-a-claim). The existing e2e journey covers a same-named wrong cwd file, omitted-flag compatibility, unchanged absolute citations, missing evidence rejection and unrecorded evidence rejection with `--judge`, plus execution of suggested receipt and remote gate commands.

## How to get to it (user POV)

what README.md says a user runs first.

## Driving it with tmux/PTY

1. Launch the app as SKILL.md says and wait until it is ready.
2. Run `done-done run e2e` (or `node dist/cli.js run e2e`) from this repo. `journeys/e2e.mjs` drives a synthetic git repository and saves the transcript plus its capture into the outer run folder. To prove an installed tarball rather than local dist, set `DONE_DONE_TEST_CLI` to the absolute installed `done-done-axi/dist/cli.js` path. Use a private HOME, DONE_DONE_HOME and disk-backed TMPDIR. Every assertion must pass; the transcript prints each command, its output, exit code and the fixture HEAD.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/main.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

## Gotchas

See the [citation lookup contract](../../../../docs/reference.md#check-a-claim) rather than changing cwd or `evidence.root` to work around missing files. The journey disables positive relevance judging for its synthetic screen, but exercises judge-enabled missing/unrecorded controls; hosted judge acceptance remains covered by the CLI integration tests.
