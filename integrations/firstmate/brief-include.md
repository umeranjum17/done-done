
## Proof with done-done
Before you report done, load the done-done skill and follow it. Install it once per machine with
`npx skills add umeranjum17/done-done --skill done-done -g -y`. The CLI is `done-done` (`done-done --help`);
if that fails, report that the CLI is missing instead of writing proof by hand.

1. If the repo has no `.done-done.yaml`, run `done-done init`, then add a journey to it that drives the real
   app and writes its screenshots, recordings or logs under `$DONE_DONE_EVIDENCE_ROOT/$DONE_DONE_RUN_ID`
   (done-done exports both to the journey command). Commit `.done-done.yaml`, the journey script and `.gitignore`.
2. Commit your change, then run `done-done run <journey>` from the repo root. Proof only counts from a clean,
   committed tree.
3. Write a Checks block that cites the run's files by the paths `run` printed:
   ```
   ## Checks
   outcome: <what a user can now do>
   repro: <command that failed before and passes now; n/a only when the PR title is not a fix>
   proof: <the repo's verify-<app> skill, or "no verify skill - done-done run <journey>">
   evidence: <the run's files, for example .proof/<run-id>/after.png>
   ```
   Put it at the end of the PR body. With no PR, put it in `checks.md` in your task's data folder outside the
   worktree (`<firstmate home>/data/<task-id>/checks.md`).
4. From the repo root, `done-done check --from <the PR URL or that checks.md>` must exit 0. Then run
   `done-done receipt --from <the same>` to record the pass for your head commit.
5. Keep the proof past cleanup: the worktree is deleted at teardown, so copy the receipt file `receipt` printed
   and every cited file to `proof/` in your task's data folder.

Exit 1 (fail) or 3 (inconclusive) is never done: fix the proof and re-run, or report what done-done found.
`evidence: not proven: <cause>` is inconclusive (3) and gets no receipt: report the task as not proven, never as done.
Any commit after the receipt makes the proof stale: run, check and receipt again on the new head.
