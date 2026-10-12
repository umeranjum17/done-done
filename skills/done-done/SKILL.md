---
name: done-done
description: "Prove the real app works before work is called done: done-done runs a capture of the real product, ties every screenshot, recording and log it writes to the exact commit, then checks that cited evidence is real, fresh and not reused. Use when the user asks to prove a change or app works, asks whether a task is really done, wants screenshots, recordings or logs captured as evidence, or wants a pull request gated on proof."
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
Get the current source of truth from the CLI:

- `npx -y --allow-git=all github:umeranjum17/done-done` (no arguments, inside the repo) for this repo's proof setup and the next step
- `npx -y --allow-git=all github:umeranjum17/done-done --help` for every command and flag

You do not need done-done installed - invoke it as `npx -y --allow-git=all github:umeranjum17/done-done <args>` (the first run builds it, about
20 seconds). If `done-done` is already on PATH, use it directly. If done-done output shows a follow-up
command starting with `done-done`, run it the same way.

Results are TOON (`init` prints plain text): read `result` and follow the `help` lines through
`init`, `run`, `check` and `receipt`. Proof comes from driving the real product, not from a unit test run. `fail` or
`inconclusive` is not done: fix the cause and re-run, or tell the user exactly what is still unproven.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/done-done` explicitly - fetch the current CLI
guidance, then prove that. If it is empty, infer what to prove from the conversation.
