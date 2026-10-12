# done-done reference

Everything `init`, `doctor`, `run`, `check`, `receipt` and the config files do. For the overview and quick start, see the [README](../README.md).

## Install

For the install steps, see the [README](../README.md#use-it-from-your-agent). done-done needs Node 22.5 or later and git (the opt-in judge needs Node 22.18). `ffprobe` is optional. Without it, videos are reported as "not verified" and the check is inconclusive, never a pass.

## Use

### Set up a repo

```sh
done-done init
```

`init` writes a minimal `.done-done.yaml` only when one does not exist: just `app`, the repo directory name, so every checkout of the repo finds the same evidence (see [Where proof lives](#where-proof-lives)). It sets no `evidence.root`, so evidence goes outside the repo. When an existing config puts `evidence.root` inside the repo (an older `root: .proof`), `init` adds it to `.gitignore` when git does not already ignore it. A plain `init` never rewrites the config: re-running is a no-op and a customized `.done-done.yaml` is left byte-for-byte; `.gitignore` gains a line only when the ignore entry is missing. A malformed `.done-done.yaml` makes `init` exit 2 with the file named and untouched. Its result says whether the config was `written` or left `unchanged`, the evidence root, what it added to `.gitignore`, the verify skill outcome (`verify_skill`), and the next step.

`init` also scaffolds the verify skill at `skill` (default `.agents/skills/verify-<app>`) from the repo's own files: `SKILL.md`, plus `features/README.md` and one file per feature for up to five features (HTTP routes and CLI commands found in source); `features/README.md` says how many more were found and not written. Only missing files are written, so an existing skill is left byte-identical and a re-run is a no-op. Lines marked `TODO(live drive)` need one real drive before they can be trusted. A write failure or a symlink on the path skips the scaffold and reports why in `verify_skill`; the config is kept and `init` still exits 0. A `skill` path with a `..` segment is refused (exit 2) before anything is written.

Record a journey's capture recipe in the repo so any checkout can re-run the proof:

```sh
done-done init --journey smoke -- 'echo added: milk > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log'
```

`init --journey <name> -- <command>` writes `journeys.<name>.command` into `.done-done.yaml` (creating the file with the pinned `app` when missing) and reports `written` or `updated` with the journey name. `${RUN_ID}` in the command becomes the run id, exactly as in `run`. Commit the config: proof only counts from a clean tree.

```sh
done-done init --agent claude
```

`--agent claude` also adds a Claude Code SessionStart hook to the repo's `.claude/settings.json` (project scope; your `~/.claude` is never touched), so each session starts with the bare `done-done` state as context. The hook runs `command -v done-done >/dev/null && done-done || true`: without done-done on PATH it prints nothing and exits 0, so it never breaks a session. An existing settings file keeps every other key and hook; re-running adds no duplicate. The result's `claude_hook` says `added to .claude/settings.json` or `unchanged`. Any other `--agent` value exits 2 naming the supported values, and a malformed `.claude/settings.json` exits 2 untouched. Commit `.claude/settings.json` to share the hook.

```sh
done-done init --agent codex
```

`--agent codex` also adds a Codex SessionStart hook to the repo's `.codex/hooks.json` (project scope; your `~/.codex` is never touched), so each session starts with the bare `done-done` state as context. Same contract as the Claude hook: it runs `command -v done-done >/dev/null && done-done || true`, keeps every other key and hook, adds no duplicate on re-run, and the result's `codex_hook` says `added to .codex/hooks.json` or `unchanged`. A malformed `.codex/hooks.json` exits 2 untouched. Commit `.codex/hooks.json` to share the hook.

```sh
done-done init --agent opencode
```

`--agent opencode` instead writes a session-start plugin to the repo's `.opencode/plugins/done-done.js` (project scope; your `~/.config/opencode` is never touched), so the bare `done-done` state is added to the first message of each session, not at session open (opencode's plugin hooks cannot add context when a session is created). The plugin remembers sessions in memory, so a resumed session gets the state again after opencode restarts. That `chat.message` hook runs `command -v done-done >/dev/null && done-done || true` and waits for it (up to 30 seconds) before appending the output to the message: without done-done on PATH it appends nothing and never throws, so it never breaks a session. Other files in `.opencode/plugins/` are untouched; re-running adds no duplicate. The result's `opencode_plugin` says `added to .opencode/plugins/done-done.js` or `unchanged`. Delete the file to opt out. Commit it to share the plugin.

### Check the setup

```sh
done-done doctor
```

`doctor` answers "is this repo worth driving" and changes nothing except the `--probe` call record (the agent itself may keep its own session files). It checks eight items, each reported `ok` or `missing` with the exact fix command (plus a `tool_gate` `warning` row when the agent is pi; see [Agents](#agents)): `git` (inside a repository), `config` (a valid `.done-done.yaml`), `evidence_root` (writable), `verify_skill` (`.agents/skills/verify-<app>/SKILL.md`), `agent` (the coding agent done-done starts, its model and where it came from; `missing` when it is not installed or done-done cannot start it yet; see [Agents](#agents)), `judge` (an executable `claude` binary, a sign-in folder and the judge kit are present, and login is checked only when a capture is judged; the model is never called), `ffprobe` (video evidence only) and `judge_choice` (the claude judge that `--judge` runs, at `judge.model`: `ok` when the author is another agent that done-done can start; `missing` when the author is claude, in a fresh session, unless `judge.allow_same: true` in the global config, and also when no startable author is installed; `judge.route` is recorded and not used yet). Only the first three are required: `doctor` exits 0 when they are all ok and 2 otherwise, so missing optionals never fail the run. In a fresh repo with nothing set up, `doctor` names each missing piece, starting with `done-done init`.

```sh
done-done doctor --probe
```

`--probe` also asks the agent one JSON-schema question (one call at its model) and adds a `probe` item that is then required: `ok` only when the agent answers with a valid object. The call record goes to `$DONE_DONE_HOME/agents/` (mode 0600); it keeps the agent, model, schema, tools, cwd, timeout, argv, prompt size in bytes, timing, exit code, answer or error, and the last 2000 characters of stderr, never the prompt text. A failed probe row shows one clean line: the agent's last line that names an error, or else its last meaningful line, with no colour codes or stack frames and at most 200 characters. The raw stderr stays in the record.

#### Agents

done-done works with the coding agent you have. `agent:` names it (`claude`, `codex`, `opencode`, `pi` or `gemini`), or a fallback list such as `[opencode, claude]`, which moves on when an agent is not installed or done-done cannot start it yet; doctor names each installed agent it skipped. `agent: auto` (the default) takes the first of claude, codex, opencode, pi, gemini on PATH that done-done can start (claude, opencode, pi and gemini today). The model is `agent_config.<agent>.model` (global config only), else the agent's cheap default (`claude-haiku-5-5` for claude, `opencode-go/muse-spark-1.3-contributor` for opencode, `flash-lite` for gemini). That table is the only place done-done names a default model. These defaults are the cost guard for those agents: done-done never defaults to a flagship model for them. pi has no entry, so with no `agent_config.pi.model` pi runs its own configured model, which can be a flagship; set `agent_config.pi.model` to cap its cost. codex cannot be started yet.

Each call is a fresh, single-shot session that must answer one JSON object matching a schema. The prompt goes on stdin (claude, pi, gemini) or into a 0600 prompt file (opencode), never in argv. done-done can start claude (`claude -p --output-format json --json-schema <schema> --model <model> --no-session-persistence`, all tools off with `--tools ''`; tool-less calls also pass `--setting-sources ''` and run from a scratch folder, so no project settings or hooks load), opencode (`opencode run "Follow the attached instructions." --format json -m <provider/model> -f <prompt file>`, with the schema in the 0600 prompt file and every tool denied through `OPENCODE_PERMISSION`), pi (`pi -p --mode json --no-session`, tools off with `--no-tools` or read-only with `-t read,grep,find,ls`, and `--model <model>` only when one is set) and gemini (`gemini -p "Follow the instructions on stdin." -o json -m <model> --approval-mode plan|auto_edit`, where `plan` is read-only for the probe and read steps and `auto_edit` is used for edit steps; `--skip-trust` is added only to the tool-less probe in its scratch folder, so repo calls keep Gemini's workspace trust gate). pi has no permission gate for edit steps, so doctor adds a `tool_gate` warning row whenever pi is the agent: every pi tool runs without approval. codex comes next.

### Run a journey

Describe your journeys in `.done-done.yaml` at the repo root:

```yaml
app: notes
evidence:
  ignore_paths: ["docs/**", "*.md"]  # commits touching only these keep evidence fresh
journeys:
  review:
    command: node scripts/capture-review.mjs --out $DONE_DONE_EVIDENCE_ROOT
```

Then run it:

```sh
done-done run review
```

`run` does five things:
- records HEAD, its tree, and whether tracked files were dirty;
- creates a new folder for the run, `<root>/<run-id>/`. The run id is the time, the commit and a random suffix, so two runs never share one;
- runs the command, with `${RUN_ID}` substituted, `DONE_DONE_RUN_ID` exported, and `DONE_DONE_EVIDENCE_ROOT` set to the run's folder. The command's own stdout goes to stderr, so stdout carries only the result document;
- hashes every file in the run's folder. Every checkout of a repo shares the evidence root, so a run records only its own folder and never another run's files;
- writes a run record to `<root>/.done-done/runs/<run-id>.json`.

A non-zero command exit, or a run that wrote nothing, fails. A run that wrote nothing names its folder and the two names the command gets it under: `DONE_DONE_EVIDENCE_ROOT` and `DONE_DONE_RUN_ID` (or `${RUN_ID}` in the command).

For a proof you drive by hand or through an agent:

```sh
done-done run --open      # prints a run id
# ...capture into the folder it prints (evidence_root)...
done-done run --close <run-id>
```

You can also run a one-off command without a journey: `done-done run -- <command>`.
A run whose command matches no repo-recorded journey says so in its `help`: the recipe is not in the repo, so nobody can re-run the proof from the config. Record it with `done-done init --journey <name> -- <command>` and commit.
Run `done-done` outside wrappers that expand `${...}` themselves (`systemd-run` does): put such a wrapper inside the command, or it eats `${RUN_ID}`.

### Check a claim

```sh
done-done check --outcome "notes sync between two devices" ~/.done-done/evidence/notes/<run-id>/after.png
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
| Not reused | Fails when the files are byte-identical within one claim. Also fails when every file was already used to prove a different claim in this repo. A claim is named by `--claim-id <id>`, by default the current branch (with `--from <PR URL>`, the PR's branch; on a detached HEAD, pass `--claim-id`), so rewording the outcome is not reuse. One branch is one claim: several claims on one branch each need their own `--claim-id`, or they share one reuse scope. The ledger is `<root>/.done-done/ledger` in the evidence root, so each repo keeps its own (pin `app`, as `init` does, so two repos with the same directory name do not share one); `DONE_DONE_HOME` moves it only with the default evidence root. |

Files that are in no run record give an inconclusive result: nothing ties them to a commit. So does a file that more than one run record claims (possible only with records from before each run had its own folder). A file whose path is named in a run record but whose bytes no longer match fails as `changed after run <run-id>` (exit 1), not inconclusive: the path ties it to that run, so editing it after the run is tampering, not untied evidence.

`evidence: not proven: <cause>` is inconclusive too. A repo can set `checks.not_proven: allow`, but that setting is honoured only when the config is read from a trusted ref (`--trusted-ref`).

### Judge relevance (opt-in)

The checks above prove a screenshot is real, fresh and tied to a commit. They do not prove it shows the outcome. `--judge` adds that one question: is this capture the correct screen for the outcome, or the wrong one (another screen, an error, a dialog or keyboard hiding the content)?

```sh
done-done check --judge --from pr-body.md
done-done receipt --judge --from pr-body.md
```

- **Off by default.** Turn it on per run with `--judge`, or for a project with `judge.enabled: true`. With it off, nothing changes and no model is asked.
- **One question per capture.** Each cited PNG or JPEG that is in a done-done run record goes to the model with the claim's `outcome:` line and nothing else: no repo, no paths, no other files. Text, log and video evidence are not judged, and the result says so.
- **Your own Claude plan, through BYOKit.** The judge uses [`@byokit/decide`](https://www.npmjs.com/package/@byokit/decide)'s Claude Code backend, which runs your own `claude` binary against a sign-in folder kept only for done-done. done-done never reads, copies or stores a credential. The kit is an optional peer dependency, so a plain install stays small; the judge needs it and Node 22.18 or later. Without it, `--judge` exits 2 with the command to run the same check with the kit:

  ```sh
  npx -y --allow-git=all -p github:umeranjum17/done-done-axi -p @byokit/decide@0.6.5 done-done-axi check --judge --from pr-body.md
  ```

  In a project that installs done-done-axi, `npm install -D @byokit/decide@0.6.5` adds it for good. Sign in once:

  ```sh
  mkdir -p ~/.done-done/claude && CLAUDE_CONFIG_DIR=~/.done-done/claude claude auth login
  ```

- **Bounded.** Captures longer than 1280 px on their long side are downscaled first (8-bit PNG; a larger JPEG is reported unsure). One request per capture, at most 10 requests per check (later captures are unsure), a 120-second timeout, no retries.
- **Cached.** Verdicts are kept in `$DONE_DONE_HOME/judge/`, keyed by the capture's sha256, the outcome text and the model, so a re-run asks no model.
- **Only runs on a passing check.** When the deterministic checks already fail, no capture is judged.

| Verdict | Result | Exit |
|---|---|---|
| `pass`: the capture shows the outcome | pass | 0 |
| `fail`: wrong screen | fail | 1 |
| `unsure`: the model said it cannot tell, was less than 80% sure, or did not answer (a model error or a used-up plan) | inconclusive | 3 |

The result gains a `judge` block with the model and, for each judged file, its verdict, a short reason and whether it came from the cache. A missing or signed-out sign-in folder, a sign-in that is not a Claude subscription, a sign-in folder that is (or links to) your own `~/.claude`, a missing or non-executable `claude` binary, a missing `@byokit/decide` kit or a Node older than 22.18 is a config error (exit 2) whose `help` line is the command to fix it. The kit cannot tell a bad `judge.model` from a used-up plan, so both are `unsure` with a reason naming each. The judge's confidence is the model's own estimate, not a calibrated score.

### Record a receipt

A receipt ties one passing check to one commit and to the exact bytes it cited, so a merge step or CI can re-verify the same proof later.

```sh
done-done receipt --from pr-body.md       # or --outcome "<claim>" <files...>, or --from -
done-done receipt --verify <head>         # read-only: check a recorded receipt
```

`receipt` takes the same claim inputs as `check` and runs that check. It writes `<root>/.done-done/receipts/<head>.json` only when the check passes on the current HEAD, the tracked tree is clean, and the check cited at least one evidence file; a dirty tracked tree, a failed or inconclusive check, a pass that cited no evidence (for example `not proven:` allowed by trusted config), or a moved HEAD writes nothing and exits non-zero. The record holds the repo, the head and tree sha, the claim outcome, and every cited file with its sha256 and a timestamp. A cited file is stored relative to the repo, or as `<evidence root>/<path>` when it is under an evidence root outside the repo, so the receipt still finds it from another checkout or a restored evidence root.

`receipt --verify <head>` changes nothing. The argument may be a full commit sha or a ref (`HEAD`, a branch or a tag), resolved to the commit with `git rev-parse --verify <arg>^{commit}` before the receipt lookup; an unresolvable argument fails with the same missing-receipt shape. It succeeds only when the receipt exists, is PASS, the current HEAD is still that head, and every cited file still hashes to the recorded sha256. A missing or malformed receipt and a hash mismatch are failures (exit 1), not usage errors. When the mismatched path is named in a run record, the failure names it as `changed after run <run-id>`.

### Verify a change in one run

```sh
done-done verify [<journey>] --outcome "<what a user can now do>"   # --no-wait, --wait (the default), or --foreground (CI)
done-done status [--run <run-id>]                                   # the newest run of this checkout by default
done-done attach [--run <run-id>]                                   # stream the run's events to stderr until it ends, then show it
done-done logs --step <name> [--run <run-id>] [--full]              # one step's log, the last 50 lines unless --full
done-done rerun [--run <run-id>] [--wait | --no-wait]               # a new run of the same journey, from the failed step
done-done abort [--run <run-id>]                                    # stop a live run and its journey
done-done history [--limit <n>]                                     # this checkout's runs, newest first
```

`verify` writes `$DONE_DONE_HOME/runs/<app>/<run-id>/run.json` (schema 2), then starts a detached runner that drives the journey, checks the files it wrote and records a receipt (steps `resolve`, `drive`, `check`, `receipt`, `report`). The runner goes on when the command or shell that started it ends. It writes its pid, the journey's process group and a heartbeat to `run.json`, each step to `events.jsonl`, and step output to `logs/`. `run.json` keeps the run's inputs and step state; the head, tree, dirty flag and evidence come from the evidence run record it points to. `verify` waits until the run ends (`--wait`, the default), then prints it like `status`; `--no-wait` returns at once. A journey still running after `journeys.<name>.timeout` (default `30m`, e.g. `90s`) is killed with everything it started, and the run ends inconclusive (exit 3) with `journey timed out after <timeout>`. `status` only reads the store, except that an open run whose runner is gone (its pid is no longer alive, or it never wrote a pid and is still open after 60 s) is shown as `failed` at the step it was on and its journey's process group is killed once (a `journey.killed` marker in the run folder keeps later reads from signalling again). Runs are stored per app, shared by every checkout of it; `status` shows the newest run of the current checkout and names its `repo`.

`attach` prints each new event line to stderr while the run goes on, and exits when the run ends or its runner is gone. The step names for `logs --step` are the run's steps (`resolve`, `drive`, `check`, `receipt`, `report`).

`rerun` starts a new run of the same journey and leaves the source run as it was. It reuses `resolve` when HEAD, the journey command and the verify skill are unchanged, and `drive` too when the source's drive record is clean and bound to that HEAD; every other step runs again. It refuses a source run that is still pending or running (exit 2), and one whose journey's process group is still alive. `--wait` (the default) waits for the new run and prints it; `--no-wait` returns at once, with exit 4 while the run is still running.

`abort` signals the runner, then its journey's process group, and marks the run `cancelled`; `status` shows a cancelled run as failed (exit 1), with the step that was running marked `cancelled`. It exits 0 when it cancelled the run. A run that had already ended, or whose runner pid cannot be confirmed as this run's, is left alone and exits 1.

### Output

Every command prints one machine-readable result on stdout. By default it is [TOON](https://github.com/toon-format/spec) in the AXI convention (the shape `no-mistakes axi status` uses): scalar `key: value` lines, tabular arrays, and a `help` list that names the exact next command. `--json` prints the same result as JSON. `--full` lists every evidence file or finding; without it, lists longer than five rows are truncated and the count of dropped rows is reported (`evidence_omitted`, `findings_omitted`, `history_omitted` or `log_omitted`). `doctor` always lists every check: its rows (eight checks, nine with --probe, plus `tool_gate` when the agent is pi) never truncate.

Running `done-done` with no subcommand prints the repo's config state (`config: present | missing | none`), its journeys and run count, and the next step. Usage and config errors also print one result: the `command` that failed, an `error` field and a `help` line with the recovery command (for example `done-done init` when no config exists, or the command's valid flags after an unknown one).

`done-done --help` lists every command. `done-done <command> --help` (or `-h`) prints that command's usage lines and flags in the same shape for every command (plus the journey format for `init` and `run`, and the Checks block for `check` and `receipt`), and exits 0.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | pass |
| 1 | fail |
| 2 | usage or config error |
| 3 | inconclusive (could not be proven either way) |
| 4 | the run is still running (`verify --no-wait`, `rerun --no-wait`, `status`) |

`doctor` exits 2 when a required item (`git`, `config`, `evidence_root`, and `probe` with `--probe`) is missing.

### In CI or a merge gate

```sh
PR_BRANCH="$(gh pr view "$PR_URL" --json headRefName --jq .headRefName)"
done-done check --from "$PR_URL" --trusted-ref origin/main
done-done receipt --from - --trusted-ref origin/main --claim-id "$PR_BRANCH" < pr-body.md   # record the pass
done-done receipt --verify "$HEAD"                                   # re-verify later
```

Run `receipt --verify` with that head checked out and the evidence root in place (see below). `--trusted-ref` reads `.done-done.yaml` from that ref instead of the PR branch. This matters because repo keys can loosen the bar and journeys run commands. `check --from -` and `receipt --from -` read the `## Checks` block from stdin, so a CI job can pipe the pull request body straight in.

### Where proof lives

Evidence, run records (`<root>/.done-done/runs/`), receipts (`<root>/.done-done/receipts/<head>.json`) and the reuse ledger (`<root>/.done-done/ledger`) all live in the evidence root. By default that is `~/.done-done/evidence/<app>`, outside the repo, so they outlive the checkout that captured them: any checkout of the same repo on the same machine (a fresh clone, a merge gate's checkout) with `<head>` checked out runs `done-done receipt --verify <head>` and finds the same receipt and files. A checkout of a later commit, such as the merge or squash commit on main, does not verify: the receipt is for `<head>` only.

- **Same machine** (a merge gate, a fresh clone): check out `<head>`, nothing else. Every checkout reads the same `app` from the committed `.done-done.yaml`, so it resolves the same evidence root. Keep `app` pinned (`init` writes it); without it the app is the directory name, which differs between clones. Receipts are named by the full head sha, which is the same in every clone, shallow or not, so no repo commit is needed in the key, and a receipt verifies only where that commit is checked out.
- **CI on another machine**: the evidence is not there. Copy the evidence root to the job (for example upload `~/.done-done/evidence/<app>` as a build artifact from the job that captured the proof), restore it as `$DONE_DONE_HOME/evidence/<app>`, check out the head, and run `done-done receipt --verify <head>`.
- **`evidence.root` inside the repo** (an older `root: .proof`): still works, but the evidence is gitignored and goes away with that checkout, so only that checkout can re-verify.

## Config

There are two files. Unknown keys are an error in both.

**Global:** `~/.done-done/config.yaml`. Override the location with `DONE_DONE_HOME`.

```yaml
evidence:
  local_root: ~/.done-done/evidence   # evidence root for repos that set none (<local_root>/<app>)
agent: auto                           # also allowed in .done-done.yaml, which wins; see Agents
agent_config:                         # per-agent model; global only, a project file may not set it
  opencode: { model: opencode-go/muse-spark-1.3-contributor }
judge:                                # used only when the judge is on
  route: ''                           # recorded only; judge routes land next, and --judge runs the claude judge until then
  allow_same: false                   # true: accept the claude judge as the author's session-only judge; global only
  model: claude-haiku-5-5              # the default: cheap and reads images; set any model you like
  bin: /usr/local/bin/claude          # default: the first `claude` on PATH; an absolute path to an executable
  config_dir: ~/.done-done/claude     # the default; a sign-in folder for done-done only
```

**Project:** `<repo>/.done-done.yaml`.

| Key | Default |
|---|---|
| `app` | repo directory name |
| `skill` | `.agents/skills/verify-<app>` |
| `journeys.<name>.command` | none |
| `journeys.<name>.timeout` | `30m`; a positive duration such as `90s` or `30m` (up to about 24 days), used by `verify` |
| `evidence.root` | `<local_root>/<app>`, outside the repo. A relative path is under the repo; an absolute path is used as-is |
| `evidence.allow_dirty` | `false` |
| `evidence.ignore_paths` | `[]` |
| `checks.not_proven` | `inconclusive`; `allow` is honoured only from `--trusted-ref` |
| `checks.fix_title` | `^(fix\|bugfix\|hotfix)\b`: titles that need a repro |
| `judge.enabled` | `false`: judge relevance on every `check` and `receipt` |
| `agent` | as in the global file; set here, it wins |

**Precedence:** built-in defaults, then the global file, then the project file.

Global-only keys describe the machine. Project-only keys describe the project. Setting a global-only or project-only key in the wrong file is an error (exit 2), not something silently ignored.

