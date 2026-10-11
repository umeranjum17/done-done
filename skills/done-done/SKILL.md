---
name: done-done
description: "Prove that the real product works before calling work done. done-done captures commit-bound evidence (screenshots, recordings, logs) by running a journey, then checks a claim's evidence is real, fresh, tied to the current commit and not reused. Use when asked to prove a change works, capture screenshots/recordings/logs as evidence, gate a pull request on real proof, or check that cited evidence is genuine."
user-invocable: false
---

# done-done

"No proof, no done." done-done runs your capture command and ties every file it writes to the exact
commit, then checks that the evidence a claim points to is really there, is a real image/video/log,
comes from the current commit, and is new. It is deterministic, offline and model-free.

The CLI is the source of truth. Run `done-done --help` for the current commands and flags.

## Install

The package ships a single `done-done` bin. If it is not already on your `PATH`, install it from the
packed tarball (or, once it is published, from the registry):

```sh
npm install -g ./done-done-<version>.tgz
done-done --help
```

Do not assume `npx -y done-done` works before the package is published. The full reference ships with
the package as `docs/reference.md`.

## Set up a repo

```sh
cd <repo>
done-done init
```

`init` writes a minimal `.done-done.yaml` only when one does not exist, and adds the evidence root
(`.proof/`) to `.gitignore`. It never overwrites an existing config: running it again changes
nothing, and a malformed `.done-done.yaml` makes it exit 2 and leave the file untouched.

Then describe how to capture proof in `.done-done.yaml`:

```yaml
app: notes
evidence:
  root: .proof                     # keep this out of git
  ignore_paths: ["docs/**"]        # commits touching only these keep evidence fresh
journeys:
  smoke:
    command: node scripts/capture.mjs --out .proof/${RUN_ID}
```

Commit `.done-done.yaml` and `.gitignore`, because proof only counts from a clean tree.

## Prove a change (capture)

```sh
done-done run smoke
```

`run` records HEAD, its tree and whether tracked files were dirty; runs the journey with `${RUN_ID}`
substituted; and hashes every file created or changed under the evidence root into
`.proof/.done-done/runs/<run-id>.json`. A non-zero command exit, a moved HEAD, or a run that wrote
nothing fails.

For a proof you drive by hand or through an agent:

```sh
done-done run --open          # prints a run id
# ...capture files under the evidence root...
done-done run --close <run-id>
```

A one-off command without a journey: `done-done run -- <command>`.

## Check a claim

```sh
done-done check --outcome "notes sync between two devices" .proof/<run-id>/after.png
done-done check --from pr-body.md            # newest "## Checks" block; or a GitHub PR URL
```

`check` looks only at the files the claim names. Each must exist and be non-empty; be valid real
media (magic bytes match the extension, complete, not blank or tiny; video is decoded with
`ffprobe`); be fresh (in a run record whose commit is HEAD — a diff of only `ignore_paths` keeps it
fresh); be clean (the run was not dirty and exited 0); and not reused (not byte-identical within the
claim, and not already used to prove a different claim in this repo).

## Exit codes

`0` pass, `1` fail, `2` usage or config error, `3` inconclusive.

## Honest outcomes — these are not a pass

- A cited file that is in no run record is **inconclusive (3)**: nothing ties it to a commit.
- Video evidence is "not verified" (inconclusive) when `ffprobe` is missing; without it a video
  cannot be proven. Install ffmpeg/ffprobe to verify it.
- `evidence: not proven: <cause>` is inconclusive (3). A repo may allow it only through a trusted
  ref (`--trusted-ref`), never from the working copy.
- Report only what you saw. The only pass is `result: PASS` on stdout with exit 0.

## In CI or a merge gate

```sh
done-done check --from "$PR_URL" --trusted-ref origin/main
```

`--trusted-ref` reads `.done-done.yaml` from that ref instead of the pull request branch, so a PR
cannot loosen the rules. `--from <URL>` needs the `gh` CLI.
