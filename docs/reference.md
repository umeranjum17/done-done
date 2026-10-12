# done-done reference

Everything `init`, `run`, `check`, `receipt` and the config files do. For the overview and quick start, see the [README](../README.md).

## Install

For the install steps, see the [README quick start](../README.md#quick-start). done-done needs Node 22.18 or later and git. `ffprobe` is optional. Without it, videos are reported as "not verified" and the check is inconclusive, never a pass.

## Use

### Set up a repo

```sh
done-done init
```

`init` writes a minimal `.done-done.yaml` only when one does not exist, and adds the evidence root (`.proof/` by default, or `evidence.root` from an existing config) to `.gitignore` when git does not already ignore it. It never rewrites the config: re-running is a no-op and a customized `.done-done.yaml` is left byte-for-byte; `.gitignore` gains a line only when the ignore entry is missing. A malformed `.done-done.yaml` makes `init` exit 2 with the file named and untouched. It prints what it wrote and the next step.

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
done-done check --from pr-body.md                 # a file, `-` for stdin, or a GitHub PR URL (needs gh)
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
- if the repo has its verify skill (`.agents/skills/verify-<app>`), `proof` names it (`verify-<app>`); otherwise `proof` names some `verify-` skill or says "no verify skill";
- a fix PR needs a repro (checked against the PR title, so only for a PR URL; a local file has no title).

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

### Judge relevance (opt-in)

The checks above prove a screenshot is real, fresh and tied to a commit. They do not prove it shows the outcome. `--judge` adds that one question: is this capture the correct screen for the outcome, or the wrong one (another screen, an error, a dialog or keyboard hiding the content)?

```sh
done-done check --judge --from pr-body.md
done-done receipt --judge --from pr-body.md
```

- **Off by default.** Turn it on per run with `--judge`, or for a project with `judge.enabled: true`. With it off, nothing changes and no model is asked.
- **One question per capture.** Each cited PNG or JPEG goes to the model with the claim's `outcome:` line and nothing else: no repo, no paths, no other files. Text, log and video evidence are not judged, and the result says so.
- **Your own Claude plan, through BYOKit.** The judge uses [`@byokit/decide`](https://www.npmjs.com/package/@byokit/decide)'s Claude Code backend, which runs your own `claude` binary against a sign-in folder kept only for done-done. done-done never reads, copies or stores a credential. Sign in once:

  ```sh
  mkdir -p ~/.done-done/claude && CLAUDE_CONFIG_DIR=~/.done-done/claude claude auth login
  ```

- **Bounded.** Captures longer than 1280 px on their long side are downscaled first (8-bit PNG; a larger JPEG is reported unsure). One request per capture, a 120-second timeout, no retries.
- **Cached.** Verdicts are kept in `$DONE_DONE_HOME/judge/`, keyed by the capture's sha256, the outcome text and the model, so a re-run asks no model.
- **Only runs on a passing check.** When the deterministic checks already fail, no capture is judged.

| Verdict | Result | Exit |
|---|---|---|
| `pass`: the capture shows the outcome | pass | 0 |
| `fail`: wrong screen | fail | 1 |
| `unsure`: the model said it cannot tell, or was less than 80% sure, or did not answer | inconclusive | 3 |

The result gains a `judge` block with the model and, for each judged file, its verdict, a short reason and whether it came from the cache. A missing sign-in, a sign-in that is not a Claude subscription, a bad model id or a missing `claude` binary is a config error (exit 2) whose `help` line is the command to fix it. The judge's confidence is the model's own estimate, not a calibrated score.

### Record a receipt

A receipt ties one passing check to one commit and to the exact bytes it cited, so a merge step or CI can re-verify the same proof later.

```sh
done-done receipt --from pr-body.md       # or --outcome "<claim>" <files...>, or --from -
done-done receipt --verify <head>         # read-only: check a recorded receipt
```

`receipt` takes the same claim inputs as `check` and runs that check. It writes `<root>/.done-done/receipts/<head>.json` only when the check passes on the current HEAD, the tracked tree is clean, and the check cited at least one evidence file; a dirty tracked tree, a failed or inconclusive check, a pass that cited no evidence (for example `not proven:` allowed by trusted config), or a moved HEAD writes nothing and exits non-zero. The record holds the repo, the head and tree sha, the claim outcome, and every cited file with its sha256 and a timestamp.

`receipt --verify <head>` changes nothing. It succeeds only when the receipt exists, is PASS, the current HEAD is still that head, and every cited file still hashes to the recorded sha256. A missing or malformed receipt and a hash mismatch are failures (exit 1), not usage errors.

### Output

`run`, `check` and `receipt` print one machine-readable result on stdout. By default it is [TOON](https://github.com/toon-format/spec) in the AXI convention (the shape `no-mistakes axi status` uses): scalar `key: value` lines, tabular arrays, and a `help` list that names the exact next command. `--json` prints the same result as JSON. `--full` lists every evidence file or finding; without it, lists longer than five rows are truncated and the count of dropped rows is reported (`evidence_omitted` or `findings_omitted`).

Running `done-done` with no subcommand prints the repo's config state (`config: present | missing | none`), its journeys and run count, and the next step. Usage and config errors also print one result: an `error` field and a `help` line with the recovery command (for example `done-done init` when no config exists).

`init` keeps its plain, human-readable output.

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
done-done receipt --from - --trusted-ref origin/main < pr-body.md   # record the pass
done-done receipt --verify "$HEAD"                                   # re-verify later
```

`--trusted-ref` reads `.done-done.yaml` from that ref instead of the PR branch. This matters because repo keys can loosen the bar and journeys run commands. `check --from -` and `receipt --from -` read the `## Checks` block from stdin, so a CI job can pipe the pull request body straight in.

## Config

There are two files. Unknown keys are an error in both.

**Global:** `~/.done-done/config.yaml`. Override the location with `DONE_DONE_HOME`.

```yaml
evidence:
  local_root: ~/.done-done/evidence   # evidence root for repos that set none (<local_root>/<app>)
judge:                                # used only when the judge is on
  model: claude-sonnet-5-5            # the default
  bin: /usr/local/bin/claude          # default: the first `claude` on PATH
  config_dir: ~/.done-done/claude     # the default; a sign-in folder for done-done only
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
| `judge.enabled` | `false`: judge relevance on every `check` and `receipt` |

**Precedence:** built-in defaults, then the global file, then the project file.

Global-only keys describe the machine. Project-only keys describe the project. Setting a key in the wrong file is an error (exit 2), not something silently ignored.

