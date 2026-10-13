---
name: done-done
description: "Prove the real app works before work is called done: done-done runs a capture of the real product, ties every screenshot, recording and log it writes to the exact commit, then checks that cited evidence is real, fresh and not reused. Use when the user asks to prove a change or app works, asks whether a task is really done, wants screenshots, recordings or logs captured as evidence, or wants a pull request gated on proof."
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

First run `command -v done-done`. If it prints a path, run `done-done` as shown below. If not, run
`npx -y --allow-git=all github:umeranjum17/done-done-axi` wherever this file or done-done output says `done-done` - nothing to install.

- `done-done` (no arguments, inside the repo) for this repo's proof setup and the next step
- `done-done --help` for every command and flag, the journey format and the exact `## Checks` block
- `done-done <command> --help` for one command's usage and flags

Results are TOON: read `result` and follow the `help` lines through
`init`, `doctor`, `run`, `check` and `receipt`. Proof comes from driving the real product, not from a unit test run, and counts only from a committed
tree: commit the done-done setup (config, capture script) before you capture. `fail` or
`inconclusive` is not done: fix the cause and re-run, or tell the user exactly what is still unproven.

done-done starts a coding agent the user chose. When it says no agent is set, ask the user which agent
(and model) to use and save their answer with the command it prints; never choose one for them.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/done-done` explicitly - fetch the current CLI
guidance, then prove that. If it is empty, infer what to prove from the conversation.
