# done-done reference

Everything `run`, `check` and the config files do. For the overview and quick start, see the [README](../README.md).

## Install

Not on npm yet, so install from source:

```sh
git clone https://github.com/umeranjum17/done-done
cd done-done && npm install && npm run build && npm link
```

Requires Node 22.5 or later and git. `ffprobe` is optional. Without it, videos are reported as "not verified" and the check is inconclusive, never a pass.

## Use

### Run a journey

Describe your journeys in `.done-done.yaml` at the repo root:

```yaml
app: notes
evidence:
  root: .verify-artifacts          # gitignore this; evidence never goes in the repo
  ignore_paths: ["docs/**", "*.md"]  # commits touching only these keep evidence fresh
journeys:
  review:
    command: node scripts/capture-review.mjs --out .verify-artifacts/${RUN_ID}
```

Then run it:

```sh
done-done run review
```

`run` does four things:
- records HEAD, its tree, and whether tracked files were dirty;
- runs the command, with `${RUN_ID}` substituted and `DONE_DONE_RUN_ID` / `DONE_DONE_EVIDENCE_ROOT` exported;
- hashes every file the command created or changed under the evidence root;
- writes a run record to `<root>/.done-done/runs/<run-id>.json`.

A non-zero command exit, or a run that wrote nothing, fails.

For a proof you drive by hand or through an agent:

```sh
done-done run --open      # prints a run id
# ...capture into the evidence root...
done-done run --close <run-id>
```

You can also run a one-off command without a journey: `done-done run -- <command>`.
Run `done-done` outside wrappers that expand `${...}` themselves (`systemd-run` does): put such a wrapper inside the command, or it eats `${RUN_ID}`.

### Check a claim

```sh
done-done check --outcome "notes sync between two devices" .verify-artifacts/<run-id>/after.png
done-done check --from pr-body.md                 # or a GitHub PR URL (needs gh)
```

`check` looks only at the files the claim names. It never scans the whole folder.

With `--from`, it reads the newest `## Checks` block:

```
## Checks
outcome: <what a user can now do>
repro: <command that failed before and passes now, or n/a>
proof: <verify skill or command that drove the real product>
evidence: <paths of the evidence files, or "not proven: <cause>">
```

**Form rules for the Checks block:**
- all four lines must be present;
- `proof` names a command or path;
- `proof` names the repo's verify skill (`.agents/skills/verify-<app>`) when it has one, otherwise it says "no verify skill";
- a fix PR needs a repro.

**Each cited file must pass these checks:**

| Check | Rule |
|---|---|
| Not empty | The file must contain bytes. |
| Valid media | The magic bytes match the extension. PNG and JPEG are complete (end markers present) and at least 64×64. PNG is not a blank frame. WebP and GIF are not truncated. MP4/MOV and WebM/MKV decode at least two video packets (`ffprobe`). Text and log files hold text; JSON parses. |
| Fresh | The file is in a run record whose commit is HEAD. The one exception: if the only commits since the run touch `ignore_paths`, the evidence still counts. An empty commit does not count as touching only `ignore_paths`. |
| Clean | The run was not dirty, unless `evidence.allow_dirty: true`. The run command also exited 0. |
| Not reused | Fails when the files are byte-identical within one claim. Also fails when every file was already used to prove a different claim in this repo; the ledger is `$DONE_DONE_HOME/hashes`. |

Files that are in no run record give an inconclusive result: nothing ties them to a commit.

`evidence: not proven: <cause>` is inconclusive too. A repo can set `checks.not_proven: allow`, but that setting is honoured only when the config is read from a trusted ref (`--trusted-ref`).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | pass |
| 1 | fail |
| 2 | usage or config error |
| 3 | inconclusive (could not be proven either way) |

### In CI or a merge gate

```sh
done-done check --from "$PR_URL" --trusted-ref origin/main
```

`--trusted-ref` reads `.done-done.yaml` from that ref instead of the PR branch. This matters because repo keys can loosen the bar and journeys run commands.

## Config

There are two files. Unknown keys are an error in both.

**Global:** `~/.done-done/config.yaml`. Override the location with `DONE_DONE_HOME`.

```yaml
evidence:
  local_root: ~/.done-done/evidence   # evidence root for repos that set none (<local_root>/<app>)
```

**Project:** `<repo>/.done-done.yaml`.

| Key | Default |
|---|---|
| `app` | repo directory name |
| `skill` | `.agents/skills/verify-<app>` |
| `journeys.<name>.command` | none |
| `evidence.root` | `<local_root>/<app>` |
| `evidence.allow_dirty` | `false` |
| `evidence.ignore_paths` | `[]` |
| `checks.not_proven` | `inconclusive`; `allow` is honoured only from `--trusted-ref` |
| `checks.fix_title` | `^(fix\|bugfix\|hotfix)\b`: titles that need a repro |

**Precedence:** built-in defaults, then the global file, then the project file.

Global-only keys describe the machine. Project-only keys describe the project. Setting a key in the wrong file is an error (exit 2), not something silently ignored.

