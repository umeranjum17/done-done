<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/wordmark-dark.svg">
  <img src="docs/media/wordmark-light.svg" alt="done-done" width="300">
</picture>

### No proof, no "done".

done-done won't accept "done" without real, fresh proof from your product, captured at the exact commit being called done.

[![Node 22.5+](https://img.shields.io/badge/node-22.5%2B-3fb950?logo=nodedotjs&logoColor=white)](https://nodejs.org) [![Status: early preview](https://img.shields.io/badge/status-early%20preview-d29922)](#whats-next) [![npm: done-done-axi](https://img.shields.io/npm/v/done-done-axi?logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/done-done-axi)

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/flow-dark.svg">
  <img src="docs/media/flow-light.svg" alt="How it works: capture your real app, tie every file to the exact commit, then check: pass with exit 0 or fail with exit 1." width="710">
</picture>

<br><br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/hero-dark.svg">
  <img src="docs/media/hero-light.svg" alt="A terminal: done-done records a run of a demo notes app and the check passes. After a code change, the same check fails because the proof is for an older commit." width="560">
</picture>

</div>

## Why

"Done" is easy to say. Screenshots get reused, recordings go stale, and a green test run is not the app.

done-done runs your capture and ties every screenshot, recording and log it saves to the exact commit. When someone says "done", it checks the proof they point to: is it really there, is it a real picture or video, is it from this commit, and is it new? If not, the check fails. If it can't tell, it says so instead of passing.

## See it work

Four moments from a demo notes app. Every picture is real output from the current build.

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/run-dark.svg"><img src="docs/media/run-light.svg" alt="done-done run sync records one screenshot for the current commit and passes." width="400" align="top"></picture>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/pass-dark.svg"><img src="docs/media/pass-light.svg" alt="A Checks block cites the new screenshot, and done-done check passes." width="400" align="top"></picture>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/reasons-dark.svg"><img src="docs/media/reasons-light.svg" alt="done-done check fails: one screenshot is from an older commit, one file is empty, one is a blank frame." width="400" align="top"></picture>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/config-dark.svg"><img src="docs/media/config-light.svg" alt="done-done run stops with exit 2 because the config has an unknown key." width="400" align="top"></picture>

done-done is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run without setup.
- It's built for agents: [TOON](https://github.com/toon-format/spec) output by default (`--json` and `--full` when needed), and every result names the next command in its `help` lines.
- The skill below only handles discovery; agents learn done-done by using it.

## Use It From Your Agent

You need Node 22.5 or later and git. Give your agent the done-done skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills), naming your agent with `-a`:

```sh
npx skills add umeranjum17/done-done-axi --skill done-done -a claude-code -y
```

Use `-a codex` or `-a opencode` for those agents. `-a` and `-y` skip the installer's four prompts and keep it from writing skill folders for agents you do not use.

The skill lands in this project (`.claude/skills/done-done/` for Claude Code, `.agents/skills/done-done/` for Codex and opencode) next to a `skills-lock.json`: commit both so teammates and CI get it too. Or add `-g` to install it once for all your projects (`~/.claude/skills/` for Claude Code) and leave the project untouched.

That is the entire setup - no npm install needed.
The skill tells your agent to use `done-done` if it is on PATH and otherwise run the npm package `done-done-axi` through `npx`, so the CLI comes along on demand:

```sh
npx -y done-done-axi --help
```

The skill stays a short stub and sends the agent to `--help` and the bare command for current instructions, so an installed copy cannot go stale against a newer CLI.

Then, in agents that expose skills as slash commands (Claude Code, for example), invoke it directly:

```
/done-done prove the app in this repo works
```

Or just ask in plain words - "prove the app in this repo works", "is this really done?", "gate this PR on proof" - and the agent loads the skill on its own.

## Other Ways to Use done-done

The skill is the recommended path, but it is not the only one.

### Manual CLI

**1. Install**

```sh
npm install -g --prefix ~/.local --allow-git=all github:umeranjum17/done-done-axi
```

`--prefix ~/.local` installs into your home folder, so it needs no `sudo`. `--allow-git=all` is needed on npm 12, which blocks GitHub installs by default (verified accepted on npm 10). This installs two names for the same CLI: `done-done-axi` and the short `done-done` used below. If `done-done --version` then says "command not found", add `~/.local/bin` to your `PATH`: `export PATH="$HOME/.local/bin:$PATH"`.

To skip the install, run `npx -y --allow-git=all github:umeranjum17/done-done-axi` wherever this README says `done-done`.

Once 0.1.0 is published, the registry line takes over as the install:

```sh
npm install -g --prefix ~/.local done-done-axi
```

<!-- TODO(dd-npm-name): when done-done-axi 0.1.0 is published, flip the primary back to the registry line above and make `npx -y done-done-axi` the skip-the-install path. -->

**2. Set it up in your app's repo**

```sh
cd your-app
done-done init
```

`init` writes a minimal `.done-done.yaml` (only if you don't already have one) that names your app. It never overwrites an existing config. Evidence lives outside the repo, in `~/.done-done/evidence/<app>`, so it outlives the checkout that captured it. Then describe how to capture proof — swap the command for whatever drives your real app and saves screenshots, recordings or logs:

```yaml
journeys:
  smoke:
    command: npm test > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log
```

The command runs from the repo root with `DONE_DONE_EVIDENCE_ROOT` (a new folder for this run in the evidence root) and `DONE_DONE_RUN_ID` set, and `${RUN_ID}` in it is replaced. A run that writes nothing into its folder fails.

Commit the config, because proof only counts from a clean tree:

```sh
git add .done-done.yaml
git commit -m "Add done-done"
```

**3. Run it, then check it**

```sh
done-done run smoke
done-done check --outcome "it starts" ~/.done-done/evidence/your-app/*/*.log
```

Each command prints one machine-readable result. By default it is [TOON](https://github.com/toon-format/spec) (the compact AXI convention), and a passing check shows `result: pass`. Add `--json` for JSON, or `--full` to list every evidence file or finding instead of the first few. After later runs, use the `run_id` the result prints in place of the first `*`.

When a check passes, save a receipt and re-verify it later:

```sh
done-done receipt --outcome "it starts" ~/.done-done/evidence/your-app/*/*.log
done-done receipt --verify "$(git rev-parse HEAD)"
```

Run `done-done` with no arguments to see the current config and the next step.

## What it checks

- 🔗 **Tied to a commit**: Every run records the commit, and whether there were uncommitted changes.
- 🖼️ **Real media**: Empty, cut-off, blank or tiny screenshots fail. Videos must hold real frames (needs `ffprobe`).
- ⏱️ **Fresh**: Proof from an older commit fails. Commits that only touch docs can be set to keep it fresh.
- ♻️ **Not reused**: Proof made only of files already used for a different claim fails, and so does citing the same file twice.
- 🧾 **Honest claims**: Reads a pull request's `## Checks` block — from a file, a URL, or stdin — and makes sure every line is filled in.
- 📌 **Verifiable later**: `receipt` records a passing check against the exact commit and the sha256 of every file it cited; `receipt --verify` re-checks it from any checkout of that commit on the same machine (a merge gate or a fresh clone), or in CI once the evidence folder is copied there ([how](docs/reference.md#where-proof-lives)).
- 👀 **Shows the outcome** (opt-in): `--judge` asks a model on your own Claude plan whether each screenshot is the right screen for the claim; a wrong screen fails.
- 🔒 **Safe in CI**: `--trusted-ref origin/main` reads the rules from your main branch, so a pull request can't loosen them.

Every answer is an exit code: **0** pass, **1** fail, **2** usage or config error, **3** can't tell either way.

## Learn more

- [Full reference](docs/reference.md): every `init`, `run`, `check` and `receipt` option, the Checks block rules, each file check, and both config files.
- [Report a problem or ask a question](https://github.com/umeranjum17/done-done-axi/issues)

## What's next

So far: `init`, `run`, `check`, `receipt` and the opt-in screenshot judge. Coming next: help writing the proof steps for your app.

## Develop

```sh
git clone https://github.com/umeranjum17/done-done-axi
cd done-done-axi
npm install
npm install -g --prefix ~/.local .   # optional: links this checkout as done-done on your PATH
npm test   # builds, then runs the end-to-end tests against throwaway git repos
npm run build:skill              # regenerate skills/done-done/SKILL.md from src/skill.ts
npm run build:skill -- --check   # fail if the committed skill is out of date (CI runs this)
```

To try an unreleased commit without cloning, run it straight from GitHub (npm 12 needs `--allow-git=all`):

```sh
npx -y --allow-git=all github:umeranjum17/done-done-axi --help
```

`dist/` is committed, so installing from GitHub needs no build step. `npm test` rebuilds it and fails while the rebuilt `dist/` differs from the commit, so commit `dist/` with your change.

The terminal pictures (hero, run, pass, reasons, config) are real output from the current build; redraw them with `npx tsc && node docs/media/make.mjs`. The wordmark and the flow picture are hand-made SVGs.
