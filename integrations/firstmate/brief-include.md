
## Proof with done-done
Before you report done, load the done-done skill and follow it. If the skill is missing, install it with
`npx skills add umeranjum17/done-done-axi --skill done-done -g -a <your agent: claude-code, codex, opencode, pi or gemini-cli> -y`.
Run the CLI as `done-done` if it is on PATH; otherwise run `npx -y done-done-axi`
wherever this text or the skill says `done-done`. If done-done cannot run, report that instead of writing proof by hand.

1. If the repo has no `.done-done.yaml`, run `done-done init`. Then record a journey that drives the real app and
   writes its screenshots, recordings or logs into `$DONE_DONE_EVIDENCE_ROOT` (done-done sets it to the run's own
   folder): `done-done init --journey <name> -- <command>`, so the recipe lives in the repo and anyone can re-run the
   proof. Commit `.done-done.yaml` and the journey script. If `init` says no agent is set, ask the user which agent
   and model to use and run the command it prints; never choose one yourself.
2. Commit your change, then run `done-done run <journey>` from the repo root. Proof only counts from a clean,
   committed tree.
3. Write a Checks block (the shape `done-done --help` prints) that cites the run's files by the paths `run` printed:
   ```
   ## Checks
   outcome: <what a user can now do>
   repro: <command that failed before and passes now, or n/a; a fix PR needs one>
   proof: <the command or path that drove the real product; name the repo's verify-<app> skill, or say "no verify skill">
   evidence: <the evidence file paths, or "not proven: <cause>">
   ```
   Put it at the end of the PR body. With no PR, put it in `checks.md` in your task's data folder outside the
   worktree (`<firstmate home>/data/<task-id>/checks.md`).
4. From the repo root, `done-done check --from <the PR URL or that checks.md>` must exit 0. Then run
   `done-done receipt --from <the same>` to record the pass for your head commit. Both start done-done's judge,
   which reads each capture; there is no pass without it. If they say no judge is set, ask the user which judge and
   model to use and run the command it prints. If the judge fails, report its error; never call the task done.
5. The evidence and the receipt live outside the repo (`~/.done-done/evidence/<app>`), so they outlive the
   worktree. Only if the repo's `.done-done.yaml` sets `evidence.root` inside the repo, copy the receipt file
   `receipt` printed and every cited file to `proof/` in your task's data folder before teardown.

Exit 1 (fail) or 3 (inconclusive) is never done: fix the proof and re-run, or report what done-done found.
`evidence: not proven: <cause>` is inconclusive (3) and gets no receipt: report the task as not proven, never as done.
Any commit after the receipt makes the proof stale: run, check and receipt again on the new head.
