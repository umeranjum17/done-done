# Main command

Part of the done-done verification map; reached at what README.md says a user runs first.

## Sub-features

- Open/seal a native evidence run, check its captures, record a receipt and verify its caller HEAD.
- Check or receipt citations with `--citation-base <dir>` independent of cwd and the configured run store. The existing e2e journey covers a same-named wrong cwd file, omitted-flag compatibility, unchanged absolute citations, missing evidence rejection and unrecorded evidence rejection with `--judge`.

## How to get to it (user POV)

what README.md says a user runs first.

## Driving it with tmux/PTY

1. Launch the app as SKILL.md says and wait until it is ready.
2. Run `done-done run e2e` (or `node dist/cli.js run e2e`) from this repo. `journeys/e2e.mjs` drives a synthetic git repository and saves the transcript plus its capture into the outer run folder. To prove an installed tarball rather than local dist, set `DONE_DONE_TEST_CLI` to the absolute installed `done-done-axi/dist/cli.js` path. Use a private HOME, DONE_DONE_HOME and disk-backed TMPDIR. Every assertion must pass; the transcript prints each command, its output, exit code and the fixture HEAD.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/main.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

## Gotchas

`--citation-base` changes only citation lookup. Keep cwd at the caller repository; do not point `evidence.root` at the citation folder to work around missing files. The journey disables positive relevance judging for its synthetic screen, but exercises judge-enabled missing/unrecorded controls; hosted judge acceptance remains covered by the CLI integration tests.
