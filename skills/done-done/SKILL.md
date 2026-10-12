---
name: done-done
description: "Prove the real app works before work is called done: done-done runs a capture of the real product, ties every screenshot, recording and log it writes to the exact commit, then checks that cited evidence is real, fresh and not reused. Use when the user asks to prove a change or app works, asks whether a task is really done, wants screenshots, recordings or logs captured as evidence, or wants a pull request gated on proof."
user-invocable: false
---

# done-done

"No proof, no done." done-done is a CLI you drive for the user: they say what should be proven, you
run the commands, read the results and report them. It is deterministic, offline and model-free.

## Run it

Use `done-done` when it is on PATH. Otherwise run it with nothing installed:

```sh
npx -y --allow-git=all github:umeranjum17/done-done
```

The first npx run builds it (about 20 seconds); later runs take a few seconds. Wherever this skill
or a result says `done-done`, use the same form.

For current commands, flags and config, run the CLI rather than relying on memory:

- `done-done` (bare, inside the repo): this repo's proof setup and the next step
- `done-done --help`: every command and flag

## The flow

1. Run bare `done-done` in the repo and follow its `help` line.
2. `init` once, then give `.done-done.yaml` a journey whose command drives the real product and
   writes screenshots, recordings or logs into the evidence root. A unit test run is not the app.
3. `run` the journey, then `check` the files it recorded against the outcome the user asked for.
   Proof counts only from a clean, committed tree. `receipt` records a passing check for HEAD.
4. Every command prints one TOON result: read `result` and do what its `help` lines say.
5. Report only what the result says. `fail` or `inconclusive` is not done: fix the cause and
   re-run, or tell the user exactly what is still unproven.
