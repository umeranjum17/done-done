<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/wordmark-dark.svg">
  <img src="docs/media/wordmark-light.svg" alt="done-done" width="300">
</picture>

### No proof, no "done".

done-done won't accept "done" without real, fresh proof from your product, captured at the exact commit being called done.

[![Node 22.5+](https://img.shields.io/badge/node-22.5%2B-3fb950?logo=nodedotjs&logoColor=white)](https://nodejs.org) [![Status: early preview](https://img.shields.io/badge/status-early%20preview-d29922)](#whats-next) [![npm: not published yet](https://img.shields.io/badge/npm-not%20published%20yet-8b949e?logo=npm&logoColor=white)](#quick-start)

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/hero-dark.svg">
  <img src="docs/media/hero-light.svg" alt="A terminal: done-done records a run of a demo notes app and the check passes. After a code change, the same check fails because the proof is for an older commit." width="620">
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

## Quick start

You need Node 22.5 or later and git. done-done is not on npm yet, so install it from source.

**1. Install**

```sh
git clone https://github.com/umeranjum17/done-done
cd done-done
npm install && npm run build && npm link
```

**2. Tell it how to capture proof.** In your app's repo, add `.done-done.yaml`. Swap `npm test` for whatever drives your real app and saves screenshots, recordings or logs.

```yaml
evidence:
  root: .proof
journeys:
  smoke:
    command: npm test > .proof/${RUN_ID}.log
```

Keep proof out of git, and commit, because proof only counts from a clean tree:

```sh
echo .proof/ >> .gitignore
git add .gitignore .done-done.yaml
git commit -m "Add done-done"
```

**3. Run it, then check it**

```sh
done-done run smoke
done-done check --outcome "it starts" .proof/*.log
```

You should see `result: PASS` twice. After later runs, use the run id that `done-done run` prints in place of `*`.

## What it checks

- 🔗 **Tied to a commit**: Every run records the commit, and whether there were uncommitted changes.
- 🖼️ **Real media**: Empty, cut-off, blank or tiny screenshots fail. Videos must hold real frames (needs `ffprobe`).
- ⏱️ **Fresh**: Proof from an older commit fails. Commits that only touch docs can be set to keep it fresh.
- ♻️ **Not reused**: Proof made only of files already used for a different claim fails, and so does citing the same file twice.
- 🧾 **Honest claims**: Reads a pull request's `## Checks` block and makes sure every line is filled in.
- 🔒 **Safe in CI**: `--trusted-ref origin/main` reads the rules from your main branch, so a pull request can't loosen them.

Every answer is an exit code: **0** pass, **1** fail, **2** usage or config error, **3** can't tell either way.

## Learn more

- [Full reference](docs/reference.md): every `run` and `check` option, the Checks block rules, each file check, and both config files.
- [Report a problem or ask a question](https://github.com/umeranjum17/done-done/issues)

## What's next

This is the first slice: `run` and `check`. Coming next: a saved receipt for each passing check, an AI check that a screenshot really shows what it claims, a setup command, and help writing the proof steps for your app.

## Develop

```sh
npm install
npm test   # builds, then runs the end-to-end tests against throwaway git repos
```

The README pictures are real output from the current build. To redraw them: `npm run build && node docs/media/make.mjs`.
