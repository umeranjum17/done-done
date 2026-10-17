# done-done reference

Everything `init`, `doctor`, `run`, `check`, `receipt` and the config files do. For the overview and quick start, see the [README](../README.md).

## Install

For the install steps, see the [README](../README.md#use-it-from-your-agent). done-done needs Node 22.5 or later and git (the judge needs Node 22.18). `ffprobe` is optional. Without it, videos are reported as "not verified" and the check is inconclusive, never a pass.

## Use

### Set up a repo

```sh
done-done init
```

`init` writes a minimal `.done-done.yaml` only when one does not exist: just `app`, the repo directory name, so every checkout of the repo finds the same evidence (see [Where proof lives](#where-proof-lives)). It sets no `evidence.root`, so evidence goes outside the repo. When an existing config puts `evidence.root` inside the repo (an older `root: .proof`), `init` adds it to `.gitignore` when git does not already ignore it. A plain `init` never rewrites the config: re-running is a no-op and a customized `.done-done.yaml` is left byte-for-byte; `.gitignore` gains a line only when the ignore entry is missing. A malformed `.done-done.yaml` makes `init` exit 2 with the file named and untouched. Its result says whether the config was `written` or left `unchanged`, the evidence root, what it added to `.gitignore`, the verify skill outcome (`verify_skill`), and the next step.

`init` also scaffolds the verify skill at `skill` (default `.agents/skills/verify-<app>`) from the repo's own files: `SKILL.md`, plus `features/README.md` and one file per feature for up to five features (HTTP routes when the drive is a browser or curl, CLI commands when it is a terminal); `features/README.md` says how many more were found and not written. Only missing files are written, so an existing skill is left byte-identical and a re-run is a no-op. Each feature file has numbered drive and capture steps for what was found (a browser for a web UI, curl for an API route, the command and `--help` for a CLI); where detection found nothing (no start command, URL or feature), it writes the steps to find it and to record it in that file after the drive, never a TODO marker, and when the drive finds no feature, it writes one `features/main.md`. The `Evidence` section names the primitives a drive uses: the matrix cell suffix, the DOM page-check record, text captures, the secret scan, `spends` approval and `base_ref` pairs. A write failure or a symlink on the path skips the scaffold and reports why in `verify_skill`; the config is kept and `init` still exits 0. A `skill` path with a `..` segment is refused (exit 2) before anything is written. Commit `.done-done.yaml` and the verify skill before the first capture: a capture from a tree with uncommitted changes fails `check`, and `init` says so in its help.

```sh
done-done init --agent opencode --model opencode-go/muse-spark-1.3-contributor
```

`init --agent <agent> [--model <model>]` saves the coding agent done-done starts, and its model, into the global `~/.done-done/config.yaml` (`agent` and `agent_config.<agent>.model`), in place, keeping its comments and every other key; the result's `agent` says what was saved. Without `--agent`, when no agent is set, `init` asks in a terminal (a numbered list of agents, then of models; a wrong answer is named before the list asks again, and a typed opencode model must be one `opencode models` lists, or, when opencode is not on PATH, it is saved with a notice that it was not checked; any other agent's model, pi's included, is saved with that notice too) before it writes anything; elsewhere it writes the rest of the config, reports `agent: not set` with the line to ask the user and the save command, and exits 2. When a repo's `.done-done.yaml` sets a different agent, the result's `agent` says the saved agent is overridden by that one. An agent done-done cannot start, `--model` without `--agent`, or an opencode model that is not `provider/model` exits 2 before any write. done-done never picks an agent for you (see [Agents](#agents)). Headless `opencode run` needs `--auto` (or allows the evidence root, `~/.done-done`, in opencode's `external_directory` permission) for done-done to run.

Record a journey's capture recipe in the repo so any checkout can re-run the proof:

```sh
done-done init --journey smoke -- 'echo added: milk > $DONE_DONE_EVIDENCE_ROOT/${RUN_ID}.log'
```

`init --journey <name> -- <command>` writes `journeys.<name>.command` into `.done-done.yaml` (creating the file with the pinned `app` when missing) and reports `written` or `updated` with the journey name. `${RUN_ID}` in the command becomes the run id, exactly as in `run`. The recipe is committed, so an absolute path inside the repo is refused (exit 2, nothing written) with the relative form to use; name the path relative to the repo, or use a placeholder such as `${B:?}` that the caller sets. Commit the config: proof only counts from a clean tree.

```sh
done-done init --hook claude
```

`--hook claude` also adds a Claude Code SessionStart hook to the repo's `.claude/settings.json` (project scope; your `~/.claude` is never touched), so each session starts with the bare `done-done` state as context. The hook runs `command -v done-done >/dev/null && done-done || true`: without done-done on PATH it prints nothing and exits 0, so it never breaks a session. An existing settings file keeps every other key and hook; re-running adds no duplicate. The result's `claude_hook` says `added to .claude/settings.json` or `unchanged`. Any other `--hook` value exits 2 naming the supported values, and a malformed `.claude/settings.json` exits 2 untouched. Commit `.claude/settings.json` to share the hook.

```sh
done-done init --hook codex
```

`--hook codex` also adds a Codex SessionStart hook to the repo's `.codex/hooks.json` (project scope; your `~/.codex` is never touched), so each session starts with the bare `done-done` state as context. Same contract as the Claude hook: it runs `command -v done-done >/dev/null && done-done || true`, keeps every other key and hook, adds no duplicate on re-run, and the result's `codex_hook` says `added to .codex/hooks.json` or `unchanged`. A malformed `.codex/hooks.json` exits 2 untouched. Commit `.codex/hooks.json` to share the hook.

```sh
done-done init --hook opencode
```

`--hook opencode` instead writes a session-start plugin to the repo's `.opencode/plugins/done-done.js` (project scope; your `~/.config/opencode` is never touched), so the bare `done-done` state is added to the first message of each session, not at session open (opencode's plugin hooks cannot add context when a session is created). The plugin remembers sessions in memory, so a resumed session gets the state again after opencode restarts. That `chat.message` hook runs `command -v done-done >/dev/null && done-done || true` and waits for it (up to 30 seconds) before appending the output to the message: without done-done on PATH it appends nothing and never throws, so it never breaks a session. Other files in `.opencode/plugins/` are untouched; re-running adds no duplicate. The result's `opencode_plugin` says `added to .opencode/plugins/done-done.js` or `unchanged`. Delete the file to opt out. Commit it to share the plugin.

```sh
done-done init --hook gemini
```

`--hook gemini` adds a Gemini CLI SessionStart hook to the repo's `.gemini/settings.json` (project scope; your `~/.gemini` is never touched). Gemini CLI shows a hook's plain output only to you, so this hook pipes the bare `done-done` state through `node` into the JSON `hookSpecificOutput.additionalContext` that Gemini CLI adds to the session as context; without done-done on PATH it prints nothing and exits 0. Same merge contract as the Claude hook, and the result's `gemini_hook` says `added to .gemini/settings.json` or `unchanged`. Gemini CLI reads project settings only in a trusted folder and warns once before it runs a new project hook. Commit `.gemini/settings.json` to share the hook.

```sh
done-done init --hook pi
```

`--hook pi` writes an extension to the repo's `.pi/extensions/done-done.js` (project scope; your `~/.pi` is never touched). On the first prompt of each session its `before_agent_start` handler runs `command -v done-done >/dev/null && done-done || true` (up to 30 seconds) and adds the output as a message the model reads; without done-done on PATH it adds nothing and never throws. pi loads project extensions only after you trust the project. Same file contract as the opencode plugin: other files are untouched, a re-run adds no duplicate, an existing file with other content exits 2 untouched, and the result's `pi_extension` says `added to .pi/extensions/done-done.js` or `unchanged`. Commit it to share the extension.

`--hook` works with `--journey` too: `init --journey smoke --hook claude -- <command>` records the journey and adds the hook.

### Check the setup

```sh
done-done doctor
```

`doctor` answers "is this repo worth driving" and changes nothing except the `--probe` call record (the agent itself may keep its own session files). It checks nine items, each reported `ok`, `warning` or `missing` with the exact fix command (plus a `tool_gate` `warning` row when the agent is pi or codex; see [Agents](#agents)): `git` (inside a repository), `config` (a valid `.done-done.yaml`), `evidence_root` (writable), `verify_skill` (`.agents/skills/verify-<app>/SKILL.md`), `agent` (the coding agent the user set and its model; `missing` when none is set, with the command that saves the user's choice, or when it is not installed or done-done cannot start it yet; see [Agents](#agents)), `agent_settings` (each effective agent setting, `agent`, its model, effort, how many extra flags are set (never their values), binary and `agent_timeout`, and where it came from: the global config, `.done-done.yaml` or `default`), `judge` (`missing` when no judge is set, with the command that saves the user's choice; else the judge kit is present, and the route's own setup: for `claude-code` an executable `claude` binary (`agent_path_override.claude`, else PATH) and a sign-in folder, with login checked only when a capture is judged; for `answerer:<agent>` the agent on PATH; for `openai:key` the `OPENAI_API_KEY` variable and a `judge.model`; doctor does not call the model; it is checked even with no agent set), `ffprobe` (video evidence only) and `judge_choice` (the route and model the judge runs and the author it judges, see [Judge relevance](#judge-relevance): `ok` when the judge is another agent; `warning` when it is the author's agent at another model or in a fresh session (`model` or `session-only` independence), which the run still uses and which never fails `doctor`; `missing`, with no fix of its own, until the agent is set; `missing` when no judge is set or the config refuses it (the author's own agent and model, unless `judge.allow_same: true` in the global config, or a key route with no `judge.model`). Only the first three are required: `doctor` exits 0 when they are all ok and 2 otherwise, so missing optionals never fail the run. In a fresh repo with nothing set up, `doctor` names each missing piece, starting with `done-done init`.

```sh
done-done doctor --probe
```

`--probe` also asks the agent one JSON-schema question (one call at its model) and adds a `probe` item that is then required: `ok` only when the agent answers with a valid object. Codex is the exception: it cannot be asked tool-less, so its `probe` row is a `warning` that gives the reason and asks nothing (see [Agents](#agents)). The call record goes to `$DONE_DONE_HOME/agents/` (mode 0600); it keeps the agent, model, effort, extra flags, binary, schema, tools, cwd, timeout, argv, prompt size in bytes, timing, exit code, answer or error, and the last 2000 characters of stderr, never the prompt text. A failed probe row shows one clean line: the agent's last line that names an error, or else its last meaningful line, with no colour codes or stack frames and at most 200 characters. The raw stderr stays in the record.

#### Agents

done-done starts the coding agent you choose, and never picks one. `agent:` names exactly one (`claude`, `codex`, `opencode`, `pi`, `gemini` or `acp:<target>`); there is no auto-detection and no fallback list, so an agent that is not installed or cannot start stops the command with the reason. While no agent is set, a command that starts it asks in a terminal (a numbered list of agents, then of models) and saves the answer to the global config; anywhere else (an agent calling done-done) it exits 2 with `no agent is set: ask the user which agent to use (claude, codex, opencode, pi, gemini, acp:<target>); never pick one for them` and the command that saves the answer: `done-done init --agent <agent> --model <model>`. `doctor` reports an unset agent as missing with that same fix. The model is `agent_config.<agent>.model` (global config only), else the agent's cheap default (`claude-haiku-5-5` for claude, `opencode-go/muse-spark-1.3-contributor` for opencode, `flash-lite` for gemini; claude and opencode also default to `effort: low`). That table is the only place done-done names a default model, and `init` writes it into the global config. `agent_config.<agent>.effort` (`minimal`, `low`, `medium`, `high`, `xhigh` or `max`, or `''` for the CLI's own) goes to the CLI's own flag as written: `--effort` (claude), `-c model_reasoning_effort="<level>"` (codex), `--variant` (opencode) and `--thinking` (pi); gemini and `acp:<target>` have none, so an effort for them is a config error. `agent_args_override.<agent>` adds extra CLI flags after done-done's own (do not repeat a flag done-done passes), `agent_path_override.<agent>` starts that binary instead of the one on PATH, `acpx_path` names the acpx bridge, and `agent_timeout` (default `30m`) bounds each agent call: a verify drive, a maintain reader, the judge and the doctor probe. These defaults are the cost guard for those agents: done-done never defaults to a flagship model for them. codex, pi and `acp:<target>` have no public cheap alias, so with no `agent_config.<agent>.model` (for `acp:<target>`, `agent_config.acp:<target>.model`) they run their own configured model, which can be a flagship; that setting caps their cost. `agent: acp:<target>` (for example `acp:gemini`) starts any Agent Client Protocol agent through [acpx](https://github.com/openclaw/acpx), which you install yourself (`npm install -g acpx`). doctor reports an `acp:` agent missing, with that install step, when acpx is not on PATH or does not start.

Each call is a fresh, single-shot session that must answer one JSON object matching a schema. The prompt goes on stdin (claude, codex, pi, gemini, acp) or into a 0600 prompt file (opencode), never in argv. done-done can start claude (`claude -p --output-format json --json-schema <schema> --model <model> --no-session-persistence`, all tools off with `--tools ''`; tool-less calls also pass `--setting-sources ''` and run from a scratch folder, so no project settings or hooks load; read-only calls allow only `--tools Read,Grep,Glob` and pass `--setting-sources ''` and `--strict-mcp-config`, so no user settings or MCP servers load), opencode (`opencode run "Follow the attached instructions." --format json -m <provider/model> -f <prompt file>`, with the schema in the 0600 prompt file and every tool denied through `OPENCODE_PERMISSION` except on an edit step ([Drive by agent](#drive-by-agent), Scope)), pi (`pi -p --mode json --no-session --no-tools`, tools off for every read or probe call, since pi has no read-only mode that refuses outside reads, and `--model <model>` only when one is set) and gemini (`gemini -p "Follow the instructions on stdin." -o json -m <model> --approval-mode plan|auto_edit`, where `plan` is read-only for the probe and read steps and `auto_edit` is used for edit steps; `--skip-trust` is added only to the tool-less probe in its scratch folder, so repo calls keep Gemini's workspace trust gate) and codex (`codex exec --json --ephemeral [-m <model>]`, the answer being the last agent message of its JSONL events; an edit step runs in codex's `--sandbox workspace-write` with the run's evidence and scratch folders added by `--add-dir` and network on, so the drive can launch the app and talk to it, while it keeps your own codex config). codex cannot be a tool-less call: probed live on codex-cli 0.159.2 with your config.toml honored, its MCP server read a canary file outside the folder and `--disable multi_agent` left its multi-agent tools on, so done-done never starts codex tool-less: the judge exits with the reason, starting nothing; `doctor --probe` shows a warning with that reason and asks codex nothing; a codex maintain run records its read step as a coverage gap, still runs the plain checks, and ends blocked with that reason, as a gemini maintain run does. `acp:<target>` runs `acpx --cwd <dir> --format json --json-strict --deny-all --non-interactive-permissions deny [--model <model>] <target> exec --file -`, with the prompt and schema on stdin; every tool is denied. pi has no permission gate for edit steps, so doctor adds a `tool_gate` warning row whenever pi is the agent: every pi tool runs without approval. codex's sandbox covers its shell too, so doctor adds a `tool_gate` warning row whenever codex is the agent: a drive's recipe tool can write only where the drive may (see [Drive by agent](#drive-by-agent), Scope).

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

You can also run a one-off command without a journey: `done-done run -- <command>`. One word is taken as that whole shell command; several words are kept as given, each one quoted as needed, so a word holding spaces or shell metacharacters reaches the command intact (write them as you would write them inside `sh -c`).
A run whose command matches no repo-recorded journey says so in its `help`: the recipe is not in the repo, so nobody can re-run the proof from the config. Record it with `done-done init --journey <name> -- <command>` and commit.
Run `done-done` outside wrappers that expand `${...}` themselves (`systemd-run` does): put such a wrapper inside the command, or it eats `${RUN_ID}`.

#### Run-instance harness

One project-agnostic primitive: with an `instance` block, each journey, agent drive and `done-done run -- <command>` starts the app under test on its own port, with its own HOME and XDG folders, waits until it is ready, and stops it at the end:

```yaml
instance:
  command: node server.mjs
  ready: { url: http://127.0.0.1:$DONE_DONE_PORT/health }  # or { command: curl -sf $DONE_DONE_BASE_URL/ }
  ready_timeout: 30s
```

done-done picks a free local port it owns (a port that is already taken is never used) and passes `DONE_DONE_PORT` and `DONE_DONE_BASE_URL` to the instance, the journey and the agent drive, so a recipe uses `$DONE_DONE_BASE_URL` instead of a hard-coded port. For the app alone, HOME, XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME and TMPDIR point under the run's scratch folder; the journey keeps your own HOME, XDG and TMPDIR, and the agent drive keeps its own HOME and XDG. Readiness is HTTP 2xx for `ready.url` or exit 0 for `ready.command` (each probe is killed at the remaining timeout, so a hung command cannot hang the run); past `ready_timeout` the run fails and the instance is killed. The app's output goes to `instance.log` in the run folder, never with the evidence. The group is killed when its journey or agent drive ends, or on the next read after a dead runner. `done-done run --open` does not start the app; its caller starts and stops its own. No `instance` block keeps today's behaviour.

### Capture matrix

One verify run captures every theme x width x form-factor cell the repo asks for:

```yaml
matrix:
  theme: [light, dark]
  width: [390, 1280]
  form: [phone, desktop]
  skip:
    - { theme: dark, form: phone, reason: "dark phone ships next quarter" }
```

Each axis is optional; done-done expands the set axes into cells and drops skipped ones. Theme and form names use letters, digits, `-` and `_` (a dot would blur the capture names); widths are CSS pixels. A skip entry is a partial cell (any of `theme`, `width`, `form`) plus a `reason`: it drops every cell agreeing on each axis it names; a skip that matches no cell, or a matrix that skips every cell, is a config error. With no `matrix` block, journeys run once, as before.

`run` and `verify` run the journey once per required cell and a non-zero exit in any cell fails the run; `verify` also applies one `journeys.<name>.timeout` to all the cells together. Each cell's run gets `DONE_DONE_THEME`, `DONE_DONE_WIDTH`, `DONE_DONE_FORM` and `DONE_DONE_CELL` (the capture name suffix: `dark.390w.phone` for that cell) set. The recipe sets the app's theme and width from those values - done-done never knows how - and names each capture with its suffix. An agent drive instead names every cell and suffix in its prompt. The run record and `status` carry the manifest: every required cell with its captures, every skipped cell with its reason. Verify's check, `done-done check` and `receipt` all fail naming the missing cell when a non-skipped cell has no capture, so every proof of HEAD must cover every non-skipped cell: captured or skipped with a reason, never silently missing.

### Input guard

One verify run proves it did not change the inputs it reads (fixtures, data files): `inputs: ["data/**", "fixtures/seed.json"]` is a list of repo-relative paths or globs. done-done hashes every matching file, dotfiles and git-ignored files included, before the drive and again after; the check step fails naming each changed, appeared or disappeared path, never its contents, and the before/after hash lists go into the run record. An input that is absolute, has a `..` segment, reaches a folder through a symlink, or links outside the repo is refused with an error naming it. With no `inputs` key, a run behaves as before.

### DOM assertions

A capture judge misses page-level defects. With a `dom` block, a run also fails when a captured screen's page overflows the viewport horizontally, logged a console error, had a failed request or shows squashed, clipped or cut-off UI:

```yaml
dom:
  allow_console: ["favicon\\.ico"]   # console error regexes that do not fail
  allow_requests: ["/analytics/"]     # request URL regexes that do not fail
  fail_on_overflow: true              # default true
```

done-done never drives the browser: the recipe or journey writes one page-check record next to each capture (PNG, JPEG, WebP, GIF, MP4 or WebM), named as the capture with `.dom.json` for its extension (`home.dark.390w.png` -> `home.dark.390w.dom.json`, so a matrix cell's record carries its `DONE_DONE_CELL` suffix):

```json
{"url": "http://127.0.0.1:4100/", "overflow": true, "overflowing": ["div#wide"], "console_errors": ["boom"], "failed_requests": [{"url": "http://127.0.0.1:4100/x.js", "status": 404}],
 "squashed_text": [{"element": "h3.card-title", "text": "Approved", "chars": 1.6, "lines": 8, "words": 1}],
 "clipped_text": [{"element": "h3.card-title", "text": "Answered: the release notes are approved", "by": "its own box"}],
 "cut_off": [{"element": "div.clock", "text": "12:30", "edges": ["top"]}]}
```

With your browser tool, for example chrome-devtools-axi: `overflow` and `overflowing` from `eval` (document `scrollWidth` beyond `clientWidth`, and the elements whose right edge passes it), `console_errors` from `console --type error`, `failed_requests` (status 400 or more, or 0 for no response) from `network`, `squashed_text` from `eval` of done-done's measurement function, run in each frame of the page (an embedded frame too). It lists every visible HTML element with its own text (SVG text has no layout box and is skipped; widths are untransformed layout pixels, so a scaled ancestor does not shrink them) whose box is under 8 characters wide (its width over the average glyph width of its font) while its text is wider than the box, or whose text sits on more lines (distinct line boxes) than it has words: a title wrapped one letter per line in a narrow column. `squashed_text`, `clipped_text` and `cut_off` are optional, so a record written without them stays valid; [`done-done look`](#look-check) writes all of them, and the check fails on each `clipped_text` and `cut_off` item as it does on `squashed_text`. The scaffolded verify skill and the agent drive prompt carry the same recipe. Verify's check and `done-done check` fail naming the capture and each issue not on an allow list, and fail when a capture has no record or a record is not this shape. No `dom` block keeps today's behaviour.

### Look check

`done-done look` is the look step a journey calls on a web page. It opens the page in headless Chrome at a 390x844 phone viewport (a mobile device at 1x scale), measures the look defects in the DOM, writes the screenshot with its page-check record next to it, and exits 1 on any hit, naming the element, the kind and its text. No judge and no model: the same page gives the same answer.

```sh
done-done look http://127.0.0.1:3000/inbox --out "$DONE_DONE_EVIDENCE_ROOT/inbox.png"
done-done look ./public/inbox.html                     # a path on disk opens as its file:// URL
```

A journey in `.done-done.yaml` that calls it (one command per screen, `&&` between them, so the first hit stops the journey):

```yaml
journeys:
  inbox-look:
    command: >-
      done-done look "$DONE_DONE_BASE_URL/inbox" --out "$DONE_DONE_EVIDENCE_ROOT/inbox.png" &&
      done-done look "$DONE_DONE_BASE_URL/inbox/1" --out "$DONE_DONE_EVIDENCE_ROOT/answered.png"
```

`$DONE_DONE_BASE_URL` is set when the repo has an [`instance` block](#run-instance-harness); without one, name the page's URL. A hit fails the journey, so `done-done run` and `verify` fail with it. Never write `done-done look ... || true` or log the exit and go on: that is the gap this step closes.

- **What it measures.** In the page's main frame, after it loads and its web fonts are in:

  | Kind | A hit when |
  |---|---|
  | overflow | the page is wider than the viewport, so it scrolls sideways (the elements past the right edge are named) |
  | squashed text | done-done's [squashed-text measurement](#dom-assertions): a text block under 8 characters wide while its text does not fit, or on more lines than it has words |
  | clipped text | part of an element's text shows and part runs past a container that hides its overflow (`overflow: hidden` or `clip`), with no `text-overflow: ellipsis` (sideways) or line clamp (downwards): a card title cut to one line |
  | cut off | part of an element shows and part lies past the left, right or top edge of the viewport: a status-bar clock clipped at the top. The page is at its top, so content below the bottom edge is fine |

  Something entirely outside its container or the viewport is hidden on purpose (a closed drawer, a visually hidden label) and is not a hit; a cut element's children are not listed again. Content in a scrolling container (`overflow: auto` or `scroll`, such as a carousel) scrolls into view and is not clipped.
- **What it writes.** `--out <file.png>` (default `look.png` in `$DONE_DONE_EVIDENCE_ROOT` inside a journey, else in the current folder) gets the viewport screenshot, exactly the viewport size in pixels, and `<file>.dom.json` next to it the page-check record of [DOM assertions](#dom-assertions), with the page's console errors and failed requests too. look itself fails only on the four kinds above; with a `dom` block, verify's check also reads the record and applies its allow lists to console errors and failed requests.
- **Chrome.** look starts its own headless Chrome or Chromium (`google-chrome`, `google-chrome-stable`, `chromium` or `chromium-browser` on PATH, or `DONE_DONE_CHROME` naming the binary) with a throwaway profile, and removes both when it ends. It runs Chrome without its sandbox so it starts in containers and CI, so point it at your own app, not untrusted sites. No Chrome is a usage error (exit 2) that says how to install or point to one; a page that does not load (its network error, or no load event within 30 seconds) is exit 2 with the cause.
- **Limits.** Only the main frame is measured, not an embedded frame; a transform or `clip-path` that hides part of a box is not seen; nothing is clicked or scrolled first, so drive the page to the state to check (a URL per state) before you call look. Look at the capture too: a defect the DOM cannot see (a stretched image, a colour) is the [design check](#design-check)'s.

| Result | Exit |
|---|---|
| no hit | 0 |
| a hit of any kind | 1 |
| bad flags, no Chrome, or the page did not load | 2 |

### Base-ref before

A before/after change is judged as a pair. With `base_ref` set to a branch, tag or commit (for example `base_ref: origin/main`), `verify` drives the base ref too, after the head's drive and only when it passed:

```yaml
base_ref: origin/main
```

done-done checks the base ref out in a scratch git worktree of its own under the run folder (never your checkout) and removes it after. The same journey or agent drive runs there with the same `DONE_DONE_RUN_ID`, its own instance (when an `instance` block is set) and every matrix cell's env, and `DONE_DONE_EVIDENCE_ROOT` is the run folder's `before/`, so a journey must write its captures there, not to a path it builds itself. An agent drive is told it is at the base ref, where the outcome is not expected to hold. The run record keeps `base` (the ref and its commit). Each head capture pairs with the base capture of the same name, matrix cell suffix included (`home.dark.png` with `before/home.dark.png`): the judge gets both in one request (two images, or two texts for a text capture) and passes it only when the after capture shows the outcome as a change from before; a base capture is never judged against the outcome alone, and it may match its head capture byte for byte (the judge then sees no change). A head capture with no base capture of its name is reported (inconclusive, exit 3, with why the base drive failed when it did) and judged alone. Without `base_ref` (the default) nothing changes: each capture is judged alone.

### Check a claim

```sh
done-done check --outcome "notes sync between two devices" ~/.done-done/evidence/notes/<run-id>/after.png
done-done check --from pr-body.md                 # a file, `-` for stdin, or a GitHub PR URL (needs gh)
```

`check` looks only at the files the claim names. It never scans the whole folder.

`check` and `receipt` accept `--citation-base <dir>` for evidence paths supplied as arguments or in a Checks block, for example `done-done check --citation-base /path/to/captures --from pr-body.md`. Relative citations resolve against that directory; a relative base itself resolves against cwd. Absolute citations are unchanged. With the flag, the existing result `evidence` list contains resolved absolute paths. Without it, a relative citation resolves against the repo root first (so a check from a subdirectory finds the same evidence), then against the caller's cwd (so a shell-relative path typed for that shell still works). The flag does not relocate `--from`, change the caller repository/HEAD or config (`--trusted-ref` still selects trusted config), or change `evidence.root`: that remains the run-record, receipt and reuse-ledger store. All provenance, freshness and judge rules still apply. Passing checks preserve an explicit `--citation-base` in their suggested receipt or remote CI gate command; run the follow-up from the same cwd when the base is relative.

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
- a fix PR needs a repro (checked against the PR title; a local file or stdin uses the HEAD commit subject as its title).

**Each cited file must pass these checks:**

| Check | Rule |
|---|---|
| Not empty | The file must contain bytes. |
| Valid media | The magic bytes match the extension. PNG and JPEG are complete (end markers present) and at least 64×64. PNG is not a blank frame. WebP and GIF are not truncated. MP4/MOV and WebM/MKV decode at least two video packets (`ffprobe`). Text and log files hold text; JSON parses. |
| Fresh | The file is in a run record whose commit is HEAD. The one exception: if the only commits since the run touch `ignore_paths`, the evidence still counts. An empty commit does not count as touching only `ignore_paths`. |
| Clean | The run was not dirty, unless `evidence.allow_dirty: true`. The run command also exited 0. |
| Not reused | Fails when the files are byte-identical within one claim. Also fails when every file was already used to prove a different claim in this repo. A claim is named by `--claim-id <id>`, by default the current branch (with `--from <PR URL>`, the PR's branch; on a detached HEAD, the commit), so rewording the outcome is not reuse. One branch is one claim: several claims on one branch each need their own `--claim-id`, or they share one reuse scope. The ledger is `<root>/.done-done/ledger` in the evidence root, so each repo keeps its own (pin `app`, as `init` does, so two repos with the same directory name do not share one); `DONE_DONE_HOME` moves it only with the default evidence root. |

Files that are in no run record give an inconclusive result: nothing ties them to a commit. So does a file that more than one run record claims (possible only with records from before each run had its own folder). A file whose path is named in a run record but whose bytes no longer match fails as `changed after run <run-id>` (exit 1), not inconclusive: the path ties it to that run, so editing it after the run is tampering, not untied evidence.

`evidence: not proven: <cause>` is inconclusive too. A repo can set `checks.not_proven: allow`, but that setting is honoured only when the config is read from a trusted ref (`--trusted-ref`).

### Judge relevance

The checks above prove a capture is real, fresh and tied to a commit. They do not prove it shows the outcome. The judge adds that one question: is this capture the correct screen or text for the outcome, or the wrong one (another screen, an error, a dialog or keyboard hiding the content)?

```sh
done-done init --judge claude --judge-model claude-haiku-5-5   # once: the judge you choose
done-done verify --outcome "<what a user can now do>"          # judges by default
done-done check --judge --from pr-body.md                       # check and receipt only with --judge
```

- **On by default in `verify`, done-done's own agent.** `verify` starts the judge unless the user turns it off: `--no-judge` for one run, or `judge.enabled: false` in `.done-done.yaml` (`--judge` turns it back on for that run). `rerun` judges as its source run did, and `--no-judge` turns it off for that run; `judge.enabled` does not change a rerun. `check` and `receipt` start no model unless `--judge` or `judge.enabled: true`.

  | `judge.enabled` | `verify` | `rerun` | `check`, `receipt` |
  |---|---|---|---|
  | unset (default) | judge | as its source run | no judge (`--judge` turns it on) |
  | `true` | judge | as its source run | judge |
  | `false` | no judge (`--judge` turns it on) | as its source run | no judge (`--judge` turns it on) |

- **Set by the user, never picked.** The judge is exactly `judge.route` and `judge.model` from the global config: no auto pick, no PATH detection, no fallback. While none is set, a command that needs the judge asks in a terminal (a numbered list of judges, then of models) and saves the answer to the global config; anywhere else (an agent calling done-done) it exits 2 with `no judge is set: ask the user which judge to use (claude, opencode, pi, gemini); never pick one for them, and never the agent that did the work` and the command that saves the answer: `done-done init --judge <agent> --judge-model <model>` (`claude` is saved as `judge.route: claude-code`, `opencode`, `pi` and `gemini` as `answerer:<agent>`). An empty `judge.model` means that agent's `agent_config` model, else its cheap model; pi has no cheap model, so its judge needs `--judge-model` (or `agent_config.<agent>.model`), and init refuses one without a model, writing nothing. `judge.route: auto` from older configs is a config error (exit 2) naming the global config file; it says to delete the `judge.route` line in that file, then run that command (the file then loads, and the command saves the judge).
- **One question per capture.** Each cited capture that is in a done-done run record goes to the model with the claim's `outcome:` line and nothing else: no repo, no paths, no other files. The judge reads PNG and JPEG screens as images, and text captures (`.txt`, `.log`, `.json`, `.jsonl`, `.out`, `.err`, `.stdout`, `.stderr`, `.md`, `.csv`, `.xml`, `.html`, `.toon`) as text, asking whether the text shows the outcome; a wrong text capture fails as `judge says wrong output`. A text capture over 64 KiB is never cut: it is `unsure`, with a reason naming the cap, and no model is asked, so capture only the output the outcome is about. Video, WebP, GIF and other files are not judged, and the result lists them as `not_judged`. With `base_ref`, a head screen and its base screen are one question, and so are a head text capture and its base text capture (the judge sees both texts); a screen is never paired with text, see [Base-ref before](#base-ref-before).
- **Where a capture goes.** Each capture goes to the provider of the judge the user set, which may be a different provider than the author's; doctor's `judge_choice` row names it.
- **A fresh, tools-off call on your own plan, through BYOKit.** Each question is one single-shot call through [`@byokit/decide`](https://www.npmjs.com/package/@byokit/decide) on a route set by `judge.route`:
  - `claude-code`: BYOKit's Claude Code backend runs your own `claude` binary (`agent_path_override.claude`, else PATH) against a sign-in folder kept only for done-done (`judge.claude_code.config_dir`).
  - `answerer:<agent>`: BYOKit's answerer calls that coding agent's CLI through the same adapter as the [agent](#agents) itself, in a scratch folder holding only the capture, with every tool off and the capture attached (for example `answerer:opencode` on `opencode-go/muse-spark-1.3-contributor`). It uses the agent's existing login. How each CLI runs tools-off:
    - `opencode`: `OPENCODE_PERMISSION` denies every tool; the capture is an attached file (`-f`).
    - `pi`: `--no-tools`, and no extensions, skills, prompt templates or context files, so none of your own pi setup reaches the judge; the capture is an `@<file>` argument. The model is `judge.model`, else `agent_config.pi.model`; one of them must be set (done-done does not pick a judge model, and without one it stops with "no model for answerer:pi"), and it must be a built-in pi provider's model that reads images (`pi --list-models` shows which do).
    - `gemini`: plan mode plus a deny-all `--policy` file, which replaces your own policy folder and removes every tool, MCP ones too; the capture is an `@<file>` in the prompt, which Gemini CLI's own `@`-command code reads (outside the tool policy, per its source; not yet proven live, since Gemini CLI was not signed in on the test machine), only inside the scratch folder.
    - An `acp:<target>` agent cannot judge, since done-done cannot send it an image; doctor's `config` row says so when `judge.route` names one.
  - `openai:key`: a key-only route with no agent CLI. BYOKit's OpenAI backend sends the capture to the OpenAI Responses API on your own API key, which done-done reads from `OPENAI_API_KEY` and hands only to the kit (never printed or stored). Set `judge.model` to a model your key can use that reads images; there is no default. API billing applies. When `judge.model` equals the author's agent model, the judge is session-only and needs `judge.allow_same: true`, as with any same-model judge.

  done-done never reads, copies or stores a credential. The kit is an optional peer dependency, so a plain install stays small; the judge needs it and Node 22.18 or later. Without it, a judged `check` or `receipt` exits 2 with the command to run the same check with the kit, and `verify` with the command to rerun its run with the kit:

  ```sh
  npx -y -p done-done-axi -p @byokit/decide@0.8.0 done-done-axi check --judge --from pr-body.md
  ```

  In a project that installs done-done-axi, `npm install -D @byokit/decide@0.8.0` adds it for good. For the `claude-code` route, sign in once:

  ```sh
  mkdir -p ~/.done-done/claude && CLAUDE_CONFIG_DIR=~/.done-done/claude claude auth login
  ```

- **Bounded.** Captures longer than 1280 px on their long side are downscaled first to PNG (8-bit PNG or JPEG). One request per capture (or per base-ref pair), at most 10 requests per check (later captures are unsure), `agent_timeout` per request. An answer that cannot be read (a question left out, or probabilities that do not sum to 1) is asked once more; one that still cannot be read is `unsure` and not cached.
- **The judge is never the agent that did the work.** The author is the coding agent done-done starts (`agent:`), or `none` when it is not installed. An `acp:<target>` author counts as the agent its target names (`acp:claude-code` is claude), and an author with no known model is never `model` apart. doctor warns when the judge is the author's agent at another model. The result names how far apart they are: `agent` (another agent), `model` (the same agent at another model) or `session-only` (the same agent and model, in a fresh session). A `judge.route` and `judge.model` that are the author's own agent and model are a config error (exit 2) unless `judge.allow_same: true` in the global config. `allow_same` does not apply to a fix (`auto_fix.maintain` or `auto_fix.verify` above 0): there the judge triages what the fixer may fix, so a judge that is the fixer's agent, at any model, is refused with exit 2 before the run starts, with help that asks for another judge, and the fix path refuses it again.
- **Cached and recorded.** Verdicts are kept in `$DONE_DONE_HOME/runs/<app>/judge/`, keyed by the capture's sha256 (and its base capture's, for a pair), the outcome text, the route and the model, so a re-run asks no model. Each answerer call writes its agent's 0600 call record (what ran and what came back; never the prompt text) to the run's `agents/` folder under `verify`, else to `$DONE_DONE_HOME/agents/`; the `claude-code` route starts no agent of ours, so it writes none.
- **Only runs on a passing check.** When the deterministic checks already fail, no capture is judged, and a judge pass never turns a failed check into a pass.

| Verdict | Result | Exit |
|---|---|---|
| `pass`: the capture shows the outcome | pass | 0 |
| `fail`: wrong screen | fail | 1 |
| `unsure`: the model said it cannot tell, was less than 80% sure, or did not answer (a model error or a used-up plan) | inconclusive | 3 |

Under `verify`, a `fail` or `unsure` verdict does not end the run: it parks it at its [gate](#the-gate-and-respond).

The result gains a `judge` block with the route, the model, the independence, the author and, for each judged file, its verdict, a short reason and whether it came from the cache. For the `claude-code` route, a missing or signed-out sign-in folder, a sign-in that is not a Claude subscription, a sign-in folder that is (or links to) your own `~/.claude`, a missing `claude` binary or an `agent_path_override.claude` that is not an executable file, a missing `@byokit/decide` kit or a Node older than 22.18 is a config error (exit 2) whose `help` line is the command to fix it. The kit cannot tell a bad `judge.model` from a used-up plan, so both are `unsure` with a reason naming each. For `openai:key`, an unset `OPENAI_API_KEY` is a config error (exit 2) too, and a refused key or a bad `judge.model` is `unsure` with the HTTP status and a reason naming both. The judge's confidence is the model's own estimate, not a calibrated score.

### Design check

The checks above prove a screen is real and shows the outcome. `design` asks whether it looks right: the same judge looks at each captured screen and fails it on a visual defect.

```sh
done-done design shots/home.png shots/home.dark.png shots/home.small.png shots/home.large-font.png
done-done design shots/home.png --mock shots/home.png=design/home.png
```

- **One request per screen, the judge's route.** Each screen goes to the judge the user set (`judge.route` and `judge.model`; with none set, `design` asks for one as in [Judge relevance](#judge-relevance); `design` starts no coding agent, so it needs no `agent:`, and keeps the judge apart from the agent only when one is set), as one fresh, tools-off call through BYOKit with the screen and nothing else: no paths, no repo. The judge is never the author's own agent and model unless `judge.allow_same: true`. It needs no `judge.enabled`: running `design` is the opt-in. Each request writes its own 0600 call record to `$DONE_DONE_HOME/agents/` (`design-<stamp>-<n>-<request>.agent.json`, the request's number in this run), never the prompt. On the answerer route, a reply that is not valid JSON in the answer shape is tried again within its request, once. An answer the judge gives that cannot be read (a kind or an option left out, or probabilities that are all zero or do not sum to 1) is asked once more, so a screen costs one request, or two when the first answer is unreadable (up to four agent calls on the answerer route); a second unreadable answer makes the screen `unsure` with `the judge did not answer`, never a judge unsure about every kind. The judge's answer is cached in the run store (`$DONE_DONE_HOME/runs/<app>/design/`, one `<key>.json` file per input) per exact input: the screen and mock bytes, the questions, `judge.route` and `judge.model`, and the cache version of the release. A re-run of the same input asks no model and gives the same verdict, marked `cached: true`; a changed screen, mock, route or model is a new input. To have a cached verdict judged again, delete its `<key>.json` file; the next run asks the judge. An answer that never came (a model error) or cannot be read is not cached.
- **The defect kinds.** The judge answers one question per kind, and a screen fails on any kind it names:

  | Kind | Fails when |
  |---|---|
  | `aspect` | an image, photo, avatar, logo or icon is stretched or squashed (an avatar, app icon or logo mark more than 1.3 times wider than tall, or taller than wide) |
  | `clipped-text` | text is cut off at an edge or by its container, or cut mid-word without an ellipsis |
  | `overlap` | elements cover each other, or content sits under the status bar or system bars |
  | `off-screen` | an element is pushed past the left, right or top edge (content that scrolls below the bottom is fine) |
  | `blank-strip` | a blank, black or solid band where the app should paint, such as a black bar down one side; also measured from the pixels, below |
  | `squashed-text` | a text block rendered narrower than about 8 characters while its text does not fit, or broken onto more lines than it has words, such as a title wrapped one letter per line in a narrow column |
  | `layout` | elements misaligned, squeezed, badly wrapped or stacked wrongly, or text unreadable against its background |

- **Measured strips.** A blank strip is also measured from the pixels of each PNG or JPEG screen, before and apart from the judge: a band along a whole edge, at least 2% of that side deep, in one plain colour with nothing in it, and clearly apart from the screen's main colour. It fails the screen as `blank-strip` with its edge, colour and depth (`left edge: a plain #151815 band 132 px deep (12% of the width), full height, with nothing in it`), even when the judge is unsure or does not answer. A nav rail or bar that holds icons or a title is content, not a strip, and a screen that is all one colour is the blank-frame check's. A band its `--mock` has too (same edge, about as deep as a share of that side, and in about the same colour) is approved design and is not reported; a band the mock lacks still fails. If the mock is given but cannot be measured (not a PNG or JPEG, or undecodable), a band on the screen makes it `unsure` with the reason `approved mock could not be measured; give a PNG or JPEG mock` (exit 3), never a pass. A fully transparent pixel is never measured as part of a band, so a transparent margin is not a strip on a light or dark screen. The measure misses a strip close to the screen's main colour (a black bar on a near-black screen); the judge's question still covers it.
- **Mocks.** `--mock <screen>=<mock>` sends the screen and its approved mock in the same request, and the judge reports a difference from the mock as a defect of its kind (a moved, missing or resized element is `layout`); live data such as names, numbers and times is not a defect, and an element shaped as in the mock is not stretched. A dialog, sheet, menu, popover or toast is not a defect only where the mock draws that same overlay in the same place; one the mock lacks, or draws elsewhere, is judged like any other element. Repeat `--mock` per screen; a screen named only in `--mock` is still checked. Without a mock, the screen is judged alone.
- **Variants.** `design` judges the screens it is given and captures nothing. Capture each variant your change touches (dark theme, small width, large font) as its own screen and pass them all; a name such as `home.dark.png` or `home.large-font.png` keeps them apart, and each variant takes its own `--mock`. Pass the raw capture: the judge reads everything in the image as the app, so a device frame or letterbox band fails as a `blank-strip`.
- **From a verify flow.** Run it on the screens a journey writes, after the capture, so a failing screen fails the journey and the `verify` run with it: `journeys: { shots: { command: "node capture.mjs && done-done design $DONE_DONE_EVIDENCE_ROOT/*.png" } }`. Or run it as its own CI step on the captured screens.

| Verdict | Result | Exit |
|---|---|---|
| every screen `pass` | pass | 0 |
| a screen `fail`: the judge named a defect, a blank strip was measured, or the file is empty, truncated or a blank frame | fail | 1 |
| no fail, but a screen `unsure`: the judge was less than 70% sure about a kind, did not answer, or could not be sent the screen (not a PNG or JPEG, or one that cannot be downscaled) | inconclusive | 3 |

The result lists each screen (failing first, then unsure, then passing; `--full` for more than five) with its `verdict`, its `mock` when it had one, its `defects` (each a `kind` and `where`: the element and where it is on the screen) and a `reason` when it is unsure, plus the `judge` block (route, model, independence and author) and the counts. A missing screen or mock file, or a `--mock` without `=`, is a usage error (exit 2). The judge reads only what is visible, so a wide logo mark that is meant to be wide can fail without a mock; pass its mock to settle it.

### Record a receipt

A receipt ties one passing check to one commit and to the exact bytes it cited, so a merge step or CI can re-verify the same proof later.

```sh
done-done receipt --from pr-body.md       # or --outcome "<claim>" <files...>, or --from -
done-done receipt --verify <head>         # read-only: check a recorded receipt
```

`receipt` takes the same claim inputs as `check` and runs that check. It writes `<root>/.done-done/receipts/<head>.json` only when the check passes on the current HEAD, the tracked tree is clean, and the check cited at least one evidence file; a dirty tracked tree, a failed or inconclusive check, a pass that cited no evidence (for example `not proven:` allowed by trusted config), or a moved HEAD writes nothing and exits non-zero. The record holds the repo, the head and tree sha, the claim outcome, and every cited file with its sha256 and a timestamp. A judged receipt is schema 2 and adds a `judge` block: the route, model, independence and author, and each judged file's path, sha256 and verdict. A cited file is stored relative to the repo, or as `<evidence root>/<path>` when it is under an evidence root outside the repo, so the receipt still finds it from another checkout or a restored evidence root.

`receipt --verify <head>` changes nothing. The argument may be a full commit sha or a ref (`HEAD`, a branch or a tag), resolved to the commit with `git rev-parse --verify <arg>^{commit}` before the receipt lookup; an unresolvable argument fails with the same missing-receipt shape. It succeeds only when the receipt exists, is PASS, the current HEAD is still that head, and every cited file still hashes to the recorded sha256. A receipt whose `result` is `overridden` (written when someone moved a run past its gate with `respond`) always fails: it shows the `override` (approve or skip, who, why, when) and the judge block, and says the head is not proven, so a merge gate that runs `receipt --verify` refuses it. It reads schema 1 and 2; a schema 2 receipt also needs a well-formed `judge` block whose every verdict is `pass` for a cited file with the same sha256, and the result shows that block. A missing or malformed receipt and a hash mismatch are failures (exit 1), not usage errors. When the mismatched path is named in a run record, the failure names it as `changed after run <run-id>`.

### Verify a change in one run

```sh
done-done verify [<journey>] --outcome "<what a user can now do>"   # --no-wait, --wait (the default), or --foreground (CI)
done-done verify --outcome "<claim>" [--feature <name>]             # no journey: the author agent drives a verify skill feature
done-done respond [--run <run-id>] --action approve|skip --reason "<why>" | --action fix   # answer a run waiting at its gate
done-done status [--run <run-id>]                                   # the newest run of this checkout by default
done-done attach [--run <run-id>]                                   # stream the run's events to stderr until it ends, then show it
done-done logs --step <name> [--run <run-id>] [--full]              # one step's log, the last 50 lines unless --full
done-done rerun [--run <run-id>] [--wait | --no-wait]               # a new run of the same journey, from the failed step
done-done abort [--run <run-id>]                                    # stop a live run and its journey
done-done history [--limit <n>]                                     # this checkout's runs, newest first
```

`verify` writes `$DONE_DONE_HOME/runs/<app>/<run-id>/run.json` (schema 2), then starts a detached runner that drives the journey, checks the files it wrote and records a receipt (steps `resolve`, `drive`, `check`, `judge`, `triage` and `fix` (with `auto_fix.verify` above 0, see [Fix the product](#fix-the-product)), `gate`, `receipt`, `report`; `judge` runs unless `--no-judge` or `judge.enabled: false` (then `--judge` turns it on), and its output goes to `logs/judge.log`; with no judge set, `verify` asks for one or exits 2 before it starts a run, as in [Judge relevance](#judge-relevance)). The runner goes on when the command or shell that started it ends. It writes its pid, the journey's and the instance's process groups and a heartbeat to `run.json`, each step to `events.jsonl`, and step output to `logs/`. `run.json` keeps the run's inputs and step state; the head, tree, dirty flag and evidence come from the evidence run record it points to. `verify` waits until the run ends (`--wait`, the default), then prints it like `status`; `--no-wait` returns at once. A journey still running after `journeys.<name>.timeout` (default `30m`, e.g. `90s`) is killed with everything it started, and the run ends inconclusive (exit 3) with `journey timed out after <timeout>`. `status` only reads the store, except that an open run whose runner is gone (its pid is no longer alive, or it never wrote a pid and is still open after 60 s) is shown as `failed` at the step it was on and its journey's and instance's process groups are killed once (`journey.killed` and `instance.killed` markers in the run folder keep later reads from signalling again). Runs are stored per app, shared by every checkout of it; `status` shows the newest run of the current checkout and names its `repo`. `status --run <id>` also shows an evidence run record that `run` printed (its commit, dirty flag and files) when no verify run has that id.

`attach` prints each new event line to stderr while the run goes on, and exits when the run ends or its runner is gone. The step names for `logs --step` are the run's steps (`resolve`, `drive`, `check`, `judge` (unless `--no-judge`), `triage` and `fix` (when `auto_fix.verify` is above 0), `gate`, `receipt`, `report`; a `maintain` run has `locate`, `hygiene`, `source-wave`, `reconcile`, `report`, plus `triage` and `fix` when `auto_fix.maintain` is above 0).

#### Drive by agent

With no journey named and none configured (or with `--feature`), the drive step has the author agent (the `agent:` you set; with none set, `verify` asks as described in [Agents](#agents)) drive one feature of the verify skill the way a user does. It reads the skill's `SKILL.md` and `features/<name>.md`, launches the app, drives that feature, saves PNG screenshots of the resulting state (or, when the outcome shows in text, the CLI output, log or JSON as a text file) into the run's evidence folder (`$DONE_DONE_EVIDENCE_ROOT`) and stops what it started. The judge checks every capture there against the outcome, so the agent is told to keep captures of earlier steps (an empty or half-filled form, or text from before the outcome) in its scratch folder. `--feature <name>` picks the feature; without it, the only feature is used, or with several the agent picks the one the outcome is about and the run records it. The claim and the recipe paths go to the agent on stdin or in a prompt file, never in argv. The agent is told to follow the recipe and never add steps or data to make the outcome look true.

- **Scope.** The drive runs under the agent's own approval policy, in the repo, with the CLI scope listed below (the run's evidence folder and its scratch folder (`<run>/tmp`, also `$TMPDIR`) where that CLI can limit access to them): claude with `--permission-mode acceptEdits --allowedTools Bash --add-dir`, opencode with `OPENCODE_PERMISSION` allowing every folder outside the repo except your home folder, where only the run's evidence and scratch folders are allowed again (opencode's own data folder, its login and database, is always denied; a headless `opencode run` cannot answer a permission ask and auto-rejects it, so the drive would end with no answer, and done-done then names the refused permission), gemini with `--approval-mode auto_edit --allowed-tools run_shell_command --include-directories`, codex with `--sandbox workspace-write --add-dir`. Only codex sandboxes its shell. Each codex command runs in its own process namespace, so a server or browser bridge it starts in the background ends with that command; done-done's prompt tells codex, for every edit step (a drive, a maintain fix), to start what it needs, use it and stop it within one shell command. Its commands write only the repo, the run's evidence and scratch folders, `$TMPDIR` and `/tmp`, so a recipe tool that keeps state elsewhere fails under codex until you add that folder with `agent_args_override.codex: [--add-dir, <absolute folder>]`, and the drive's agent can then write there too. chrome-devtools-axi keeps its state in `~/.chrome-devtools-axi`, and without a local chrome-devtools-mcp it runs `npx -y chrome-devtools-mcp@latest`, which writes the npm cache: install chrome-devtools-mcp to a fixed prefix (`npm install --prefix <folder> chrome-devtools-mcp`), set `CHROME_DEVTOOLS_AXI_MCP_PATH` to its `build/src/bin/chrome-devtools-mcp.js`, and add only `<home>/.chrome-devtools-axi`. Adding `<home>/.npm` instead also works, but the agent can then change the packages npx runs later outside the sandbox. Codex's commands also cannot see your other processes, so a chrome-devtools-axi session you already use (the default one included) looks dead to them: the drive clears that session's page and collides with its bridge on its port, and fails with `No page is currently selected` or hangs. Give each drive a session of its own in the recipe, in the shell command that drives the browser: `export CHROME_DEVTOOLS_AXI_SESSION=done-done-$DONE_DONE_RUN_ID` (each run leaves a small folder under `~/.chrome-devtools-axi/sessions`). Elsewhere the drive's shell is not sandboxed: claude's Bash and gemini's run_shell_command can run any command the user can, and done-done only checks tracked files afterwards. The drive's environment sets `DONE_DONE_DRIVE` to its run id, and `respond`, `receipt`, `verify`, `rerun` and `maintain` exit 2 while it is set. That keeps the agent from answering its own gate, writing a receipt or starting a run by accident, and nothing more; it is not a sandbox: the drive's shell is not sandboxed, so an agent can unset the variable (`env -u DONE_DONE_DRIVE`) and then answer a gate or write a receipt, logged under the git user, or write the run or receipt files by hand. Pi has no permission gate, so doctor warns (`tool_gate`). An `acp:<target>` agent cannot drive (done-done runs ACP agents with every tool denied): `verify` exits 2. A drive that changes a tracked file in the repo fails, judged by the content of the tracked diff, so an edit to a file that was already modified before the drive counts too. The agent's output is capped at 64 MiB; past it the call is killed and the drive fails.
- **Bounded.** The agent runs in its own process group, bounded by `agent_timeout` (30m by default); the group is killed when the drive ends or times out. If the runner dies mid-drive, the group is killed the next time `status`, `abort` or `rerun` reads that run, as for journeys.
- **Judged.** The judge (never the author's agent and model, as in [Judge relevance](#judge-relevance)) judges each capture, unless `--no-judge`; with `--no-judge` the judge is off (its step shows `skipped`) and the drive parks at the gate with a finding that says so, since an agent drive needs a judge pass. A drive that reports a blocker or saves nothing the check accepts fails. A capture the judge did not read (a video or other file, anything but PNG, JPEG or text) parks the drive at the gate, as does a drive where no capture could be judged, so a passing judge never covers an unread capture.
- **Recorded.** The call goes to `agents/drive.json` (no prompt text), and the agent's answer (feature, captures, blocker) to `logs/drive.log`.
- **Usage errors (exit 2):** no verify skill, an unknown `--feature`, a journey and `--feature` together, no agent set outside a terminal, or an agent that cannot be started.

#### The gate and respond

When the judge says `fail` or `unsure` for a capture (or an agent drive has a capture the judge did not read, or no judged capture), the run parks at its `gate` step: `status: awaiting_approval`, exit 4, with one `ask-user` finding per problem (`gate-1`, ...). The runner exits; the run waits until someone answers it with `respond`:

- `--action approve --reason "<why>"`: the captures do show the outcome.
- `--action skip --reason "<why>"`: go on without a judge pass.
- `--action fix`: end the run `fail`; fix the product or the verify skill's recipe (`done-done maintain` checks the skill against the source), commit, then `rerun`.

Approve and skip need a non-empty `--reason`. Each answer is logged in `events.jsonl` (`step: gate`, the action, who answered (git `user.name`, else the OS user) and the reason) and kept in `run.json` as `response`. Approve and skip end the run `overridden`, never `pass` (exit 1; the spend gate differs, see [Journeys that spend](#journeys-that-spend)), and write a receipt with `result: overridden`, the `override` (action, who, why, when) and the judge's verdicts; `receipt --verify` refuses it. A run is answered once (a second `respond` exits 2). `abort` cancels a parked run. While a run waits at its gate, `verify` and `rerun` of the same claim (its `--claim-id`, else the branch it started on) in the same checkout exit 2, naming the waiting run and its `respond` and `abort` commands, so a new run never goes around the gate. A run waiting with neither key, recorded by an older build in the same checkout, blocks every `verify` and `rerun` there until it is answered or aborted. A run record that cannot be read or parsed stops `verify`, `rerun`, `status`, `respond`, `abort` and `history` (exit 2), naming the file to fix or remove.

#### Fix the product

`auto_fix: { verify: <n> }` (global or `.done-done.yaml`, as for maintain) lets done-done fix a failed verify with your agent up to n times; 0, the default, reports only. It needs the agent the user set (an `acp:<target>` agent cannot fix, exit 2) and, when the run judges, a judge that is never that agent at any model. Only a product failure is fixed: a journey that exited non-zero, an agent drive the product stopped (its blocker), or screens the judge calls wrong. A timeout, a secret, a check failure or a journey that spends is not.

- `triage`: the judge gets each wrong screen with the outcome: does the product miss a clear claim (fix), or may the claim be wrong, unclear or need a product decision (ask)? Any ask or unsure answer parks the run at the gate with every wrong screen and its class (`triage: fix` or `triage: ask`), and nothing is fixed. A mixed judge result (wrong screens plus unsure or unread captures) is never fixed either: the judge sorts the wrong screens, then they all park at the gate. Each sort is recorded in `agents/triage.json` (`triage-fix<k>.json` after attempt k, `triage-gate.json` for a mixed result after a fix).
- `fix`: an uncommitted change to a tracked file ends the run `blocked` with `dirty:` first, since the fix starts from the committed head. The agent then edits the product in a done-done worktree at that head (`<run>/fix`, detached), never in your checkout. Your checkout's ignored files (`node_modules`, `.env.local`; not done-done's own evidence root or `DONE_DONE_HOME`) are copied into it, and copied again over anything the agent did to them before each re-run, so the re-run sees the fix commit with your own ignored files. A fixer's edit to a still-ignored copied file is never committed and is copied over before the re-run. Plain code drops the attempt and ends the run `blocked` when the agent changes the verify skill, `.done-done.yaml`, a test file or a test-runner config, un-ignores a copied file of your checkout, makes a commit, changes your checkout (done-done's own folders in it, such as an in-repo evidence root, do not count), changes nothing, reports a blocker, or a copy of your ignored files into the worktree fails. Copies that are still ignored are removed from the worktree when the fix ends, whatever its result; a copy the fixer un-ignored is dropped with the attempt and stays only until the worktree is removed. Otherwise done-done commits the change and verifies again in the worktree: the fixer's call is `agents/fix-<k>.json`, the re-run's drive log `logs/fix<k>drive.log` and its run record `<run-id>-fix<k>`. A pass ends `changed` (exit 1, since your HEAD still fails) with the fix on a `done-done/verify-<run-id>` branch and a receipt for its commit; a re-run that parks at the gate keeps the branch. Still failing: the next attempt starts from the new failures, sorted again; when all n are used, the run is `blocked` (exit 1). `logs --step fix` shows each attempt.

#### Secrets in the evidence

After the drive, whether it passed or failed, and before the check, `verify` scans the run's text evidence (files with no NUL byte in their first 8 KB, so images are skipped) and the run folder's `logs/` and `agents/` for secrets: private key blocks (`private-key`), GitHub tokens (`github-token`), well-known key prefixes such as `sk-`, `AKIA`, `AIza`, `xox?-`, `glpat-` and `npm_` (`api-key`), `Bearer` headers (`bearer`), a `key`, `token`, `secret` or `password` name set to a value of 8 or more characters with no spaces or quotes, and an `auth` name set to a value of 24 or more characters with letters and digits (`key-value`). `secrets.patterns` in `.done-done.yaml` adds named regexes. A match that any `secrets.allow` regex matches is known-safe and skipped. Any other hit fails the run (exit 1) with `secrets: <file>:<line>: holds a secret (<pattern>)`: at `check` when the drive passed, and on a failed drive as `drive: secrets: <file>:<line>: holds a secret (<pattern>)`, which replaces the drive's own reason so no agent or instance text that could hold the value is printed. The file, line and pattern name are shown, never the value. A run whose logs hold a secret gets no fix agent. Remove the secret from the journey or app output and run again.

#### Journeys that spend

A journey with `spends: "<what a run spends>"` (for example `one live generation`) never runs until the user approves spending for that run. `verify` parks it before the drive: `status: awaiting_approval` at the `drive` step, exit 4, with one `ask-user` finding `spend-1`, and help that says to ask the user. `respond --action approve --reason "<who approved the spend>"` records `spend` (who, why, when) in `run.json`, then runs the journey and the rest of the run as usual, waiting like `verify`; `--action skip` ends the run `fail` with nothing spent; the gate takes only `approve` or `skip` (exit 2 otherwise). `run <journey>` refuses such a journey (exit 2, nothing runs) and prints the `verify` command that asks the user. Every new run asks again, `rerun` included, unless it reuses the source's drive. With `auto_fix.verify`, a failed spending run is not fixed or re-run, so one approval pays for one run; its reason says so. With a `matrix` block, the approval covers every required cell of that run, and the park names how many cells (it runs once per cell). A journey without `spends` is unchanged.

`rerun` starts a new run of the same journey and leaves the source run as it was. It reuses `resolve` when HEAD, the journey command and the verify skill are unchanged, and `drive` too when the source's drive record is clean and bound to that HEAD and the `inputs` patterns are the same as the source's ([Input guard](#input-guard)); every other step runs again, and the judge runs as in the source run, and `--no-judge` turns it off for that run; `judge.enabled` does not change a rerun. It refuses a source run that is still pending or running (exit 2), one whose journey's process group is still alive, a `maintain` run (exit 2; start a new one with `done-done maintain`), and any claim with a run waiting at its gate in the source's checkout (exit 2, as above). `--wait` (the default) waits for the new run and prints it; `--no-wait` returns at once, with exit 4 while the run is still running.

`abort` kills the runner's process group (a `maintain` run's agent calls run in it, so they stop too), then its journey's process group, and marks the run `cancelled`; `status` shows a cancelled run as failed (exit 1), with the step that was running marked `cancelled`. It exits 0 when it cancelled the run. A run that had already ended, or whose runner pid cannot be confirmed as this run's, is left alone and exits 1.

### Send a run to sign-off

```sh
done-done signoff [--run <run-id>]   # writes the message; never posts it
npx -y sign-off-axi post --kind <gate|evidence> --from <file>   # the command signoff prints
```

`signoff` writes one message in the [sign-off contract v1](https://github.com/umeranjum17/sign-off/blob/main/docs/contract.md) shape. A run waiting at its gate gets a `gate` (`<run>/signoff-gate.json`): key `dd-gate-<run-id>`, the first finding as `about` (its evidence folder is stripped, so it names the capture file), `run` with `run_id` and `commit`, options `approve` (Approve), `skip` (Skip the judge) and `fix` (Fix first; not on a spend gate), and `recommend_value` `fix` when the judge failed a capture, else `approve`. The board's answer is `done-done respond --action <value>`. A finished run with captures gets an `evidence` (`signoff-evidence.json` in the evidence folder of the run that made the captures, the source run for a rerun that reused its drive, the fix pass for a run `auto_fix.verify` fixed): key `dd-evidence-<run-id>`, the outcome as `about`, up to 12 PNG, JPEG, WebP, MP4 or WebM captures as `media` (paths relative to that folder) and `run` with `run_id`, `commit` and the four Checks lines (`repro` is the `done-done verify` command that made the run, at its commit, and on the fix branch when a fix pass made it). Both have `filer: done-done`. Every value is checked against the contract's limits first; one that breaks them (an outcome over 500 characters, a capture changed since the run) exits 2 and writes no file. done-done works the same without sign-off.

### Keep the verify skill true

```sh
done-done maintain        # --no-wait, --wait (the default), or --foreground (CI)
```

`maintain` checks the repo's verify skill against the source in a run of kind `maintain`, in the same store as `verify`, so `status`, `attach`, `logs`, `abort` and `history` work on it. Its pass reads only: it never edits the skill, the product code or git, and it records HEAD, `git status --porcelain --untracked-files=all` and the content of each changed or untracked path (regular files are hashed with sha256 as they are read; symlinks are compared by target text and never read through) before and after; if they differ, the run is `blocked` with a `repo-changed` finding. Its steps:

- `locate`: the verify skill (`skill`, default `.agents/skills/verify-<app>`) must have a `SKILL.md`; with none, the run ends `blocked` and points at `done-done init`.
- `hygiene` (plain code): every local markdown link in the skill must resolve (`dead-link`); `features/README.md` must exist (`index`), list each `features/*.md` file (`unlisted`) and list it only once (`duplicate`).
- `source-wave`: one fresh reader per feature file, at the configured agent (`agent`, `agent_config`). Every reader except claude's gets no tools (pi `--no-tools`, opencode and acp with every tool denied); codex and gemini cannot read tool-less at all, so their wave is not run: it is recorded as a coverage gap, and the run ends blocked with that reason, as for any agent done-done cannot start (use claude, opencode, pi or acp). Where readers run, plain code puts the feature file and the text of each tracked file it cites into the prompt, each file capped at 20,000 characters (a cut file is marked `[truncated after 20000 characters]` in the prompt, with no finding of its own) and all of a feature's cited text at 60,000 characters, with one `truncated` notice naming the feature and the cited files left out when any are dropped. Only claude readers get read-only tools in the repo (`--tools Read,Grep,Glob` with `--setting-sources ''` and `--strict-mcp-config`, so no user settings or MCP servers load): a live probe showed opencode reads through an in-repo symlink to an outside target, while claude refuses it. Each reader explains the feature from source and returns its drift (each statement the source contradicts, with the source file:line) and one live recipe. Readers run one after another; a run makes at most 30 recorded agent calls, each bounded by `agent_timeout`; a tool-less call that does not answer valid JSON is tried up to three times in all within its record, so a run starts at most 90 agent processes. A feature file longer than 20,000 characters is read only up to that cap, and a `truncated` notice names it; the notice is listed but does not make the result `drift`. A symlink on the skill path (the skill folder, its features folder, the index or a feature file) is a blocking `coverage` finding and is never read, so a committed link cannot send a file outside the repo to the agent; a skill reached through a symlinked ancestor is refused at `locate`. Readers cannot read outside the repo: claude runs without `--add-dir` or a permission bypass, so reads outside its working directory are refused.
- `reconcile`: the tool-less call names at most 500 recently changed paths, most recent first, and says how many older ones it left out (those get no `unmapped` check). Plain code checks each `path:line` the skill cites (`citation`) and each file:line a reader cites. A bare file name (`app.js:50`) is checked against the tracked files whose path ends with it, and the line must exist in one of them; no tracked match is a finding. A repo path (`src/app.js:50`) must be a tracked file too, so an untracked or ignored file is a citation finding in the skill and an unverified drift in a reader's answer. A bare name is a citation only when its extension is one that a tracked file has, so host:port text such as `api.example.com:8443` is ignored. A reader's drift cites files the same way, and its drift becomes a `drift` finding only when its citation exists, and unverified citations are listed under `unverified` in the run's status (and in the step log), with a count and the first few. An answer item in an unexpected shape, or a list field that is not a list, is listed there too and never trusted. One tool-less call merges the recipes into as few app states as it can and names files changed in the last 30 days (`git log`, outside the skill folder) that no feature covers; each one that is in that list becomes an `unmapped` finding. With no agent, the readers and this call do not run, but the plain checks still do. Gemini cannot be a reader yet: its no-tools mode is read-only plan mode, not tool-free, so a gemini run is `blocked` with one `coverage` finding and the plain checks still run.

The result is `clean` (no findings but notices, exit 0), `drift` (findings to fix by hand, or with `auto_fix`, exit 1), or `blocked` (no skill, a skill path that is a symlink or cannot be read, no usable agent, a reader that did not answer, more feature files than the call cap, or a repo that changed; exit 3). A blocked run still lists the findings from the plain checks it finished. `status` lists the findings (`--full` for all of them), each with an id, kind, file, line and what is wrong. Each agent call is recorded in `agents/<n>-<name>.json` in the run folder, without the prompt text; the readers' answers are in `logs/source-wave.log` and the merged recipes in `logs/reconcile.log`.

**Fix (`auto_fix`).** `auto_fix: { maintain: <n> }` (global or `.done-done.yaml`, merged step by step; the key and shape are no-mistakes' `auto_fix`) lets done-done fix a `drift` result up to n times; 0, the default, reports only. It needs the agent and the judge the user set, so with none set `maintain` asks in a terminal or stops with the command that saves the user's choice, and the judge is never the agent that fixes, at any model (`judge.allow_same` does not apply to the fix's judge). An `acp:<target>` agent cannot fix, since its tools are denied. Each attempt adds two steps:

- `triage`: one tool-less request to the judge (through the same BYOKit route that judges captures) with each `drift` finding, its feature file and about 20 lines of the cited source around the cited line: is the skill out of date, or may the product be wrong? Plain-code findings (`dead-link`, `index`, `unlisted`, `duplicate`, `citation`) and `unmapped` surfaces are skill gaps and are not asked. A finding the judge calls a product problem, or is not sure about, gets `action: ask-user` and ends the run `blocked`, with the reason starting `ask-user:`: the user decides, and maintain never edits product code.
- `fix`: the agent the user set gets the findings and edits the skill folder in a done-done worktree at HEAD (`<run>/fix`, detached), never in the user's checkout. A skill folder with uncommitted changes in the checkout is refused first, and so is any uncommitted change to a tracked file: the drift was found in the working tree, so a fix at HEAD would not match it; the run then ends `blocked` with a `dirty` finding that names the files (commit them, or set `auto_fix.maintain: 0`). Then plain code checks the attempt: any path changed outside the skill folder (tracked, new or ignored), a commit by the agent, or any change to the user's checkout ends the run `blocked`, and the attempt goes away with the worktree. Otherwise maintain runs its pass again in the worktree (records `agents/fix<k>-<n>-<name>.json`): clean ends the run `changed`: done-done commits the skill folder there and points a `done-done/maintain-<run-id>` branch at that one commit (your branch and checkout are untouched; `status` shows `fix` with the branch, commit, files and attempts; exit 0). Still `drift`: the next attempt starts from the new findings; when all n are used, the run is `blocked` with the findings that remain and no branch. The worktree is always removed; `logs --step fix` shows each attempt's summary, changed files and re-run result.

### Output

Every command prints one machine-readable result on stdout. By default it is [TOON](https://github.com/toon-format/spec) in the AXI convention (the shape `no-mistakes axi status` uses): scalar `key: value` lines, tabular arrays, and a `help` list that names the exact next command. `--json` prints the same result as JSON. `--full` lists every evidence file or finding; without it, lists longer than five rows are truncated and the count of dropped rows is reported (`evidence_omitted`, `findings_omitted`, `history_omitted` or `log_omitted`). `doctor` always lists every check: its rows (eight checks, nine with --probe, plus `tool_gate` when the agent is pi or codex) never truncate.

Running `done-done` with no subcommand prints the repo's config state (`config: present | missing | none`), its journeys, its run count (the runs `history` lists), whether `HEAD` has a valid receipt (`receipt: valid for HEAD <sha>`, or why not), and the next step; with a valid receipt the next step is to prove the next commit. `done-done --version` prints the version. Usage and config errors also print one result: the `command` that failed, an `error` field and a `help` line with the recovery command (for example `done-done init` when no config exists, or the command's valid flags after an unknown one).

`done-done --help` lists every command. `done-done <command> --help` (or `-h`) prints that command's usage lines and flags in the same shape for every command (plus the journey format for `init` and `run`, and the Checks block for `check` and `receipt`), and exits 0.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | pass |
| 1 | fail (also a run overridden at its gate) |
| 2 | usage or config error |
| 3 | inconclusive (could not be proven either way) |
| 4 | the run is still running, or a `verify` run waits at its gate (`verify`, `maintain --no-wait`, `rerun`, `status`, `respond`) |

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

**Global:** `~/.done-done/config.yaml`. Override the location with `DONE_DONE_HOME`. `done-done init` writes it, commented and at these defaults, when there is none, and never overwrites it. The agent keys have the same names, meanings and scopes as no-mistakes' global config.

```yaml
# agent: opencode                     # claude, codex, opencode, pi, gemini or acp:<target>, set by you (init --agent) and unset until then; .done-done.yaml may override it
agent_config:                         # model and effort per agent; global only
  claude: { model: claude-haiku-5-5, effort: low }
  opencode: { model: opencode-go/muse-spark-1.3-contributor, effort: low }
  gemini: { model: flash-lite }       # gemini has no effort flag
  # codex: { model: <model> }         # codex and pi have no cheap default: they run their own until you set one
agent_args_override: {}               # extra CLI flags per native agent, e.g. claude: [--permission-mode, plan]; codex: [--add-dir, <folder>] lets a codex drive's recipe tool write there (see Drive by agent, Scope)
agent_path_override: {}               # a binary per native agent instead of PATH, e.g. claude: /opt/claude/bin/claude
acpx_path: acpx                       # the acpx bridge for acp:<target>: a name on PATH or an absolute path
agent_timeout: 30m                    # one agent call: 90s, 30m or 1h
auto_fix:                             # per step, as no-mistakes; .done-done.yaml may set it too
  maintain: 0                         # times the agent may fix the verify skill; 0 reports only
  verify: 0                           # times the agent may fix the product after a failed verify; 0 reports only
evidence:
  local_root: ~/.done-done/evidence   # evidence root for repos that set none (<local_root>/<app>)
judge:                                # done-done's own judge; verify starts it by default
  # route: claude-code                # claude-code, answerer:<agent> (opencode, pi, gemini) or openai:key (reads OPENAI_API_KEY), set by you (`init --judge` saves the first three; `openai:key` is set by hand) and unset until then
  model: ''                           # default: that agent's agent_config model
  allow_same: false                   # true: accept a judge that is the author's own agent and model
  claude_code:                        # the claude-code route only
    config_dir: ~/.done-done/claude   # the default; a sign-in folder for done-done only
```

An `agent_config` entry merges with the defaults field by field, so `claude: { model: claude-sonnet-5-5 }` keeps `effort: low`; the other maps merge entry by entry. `done-done doctor` shows which file set each agent setting.

**Project:** `<repo>/.done-done.yaml`.

| Key | Default |
|---|---|
| `app` | repo directory name |
| `skill` | `.agents/skills/verify-<app>` |
| `journeys.<name>.command` | none |
| `journeys.<name>.spends` | none; what a run of the journey spends, so `verify` waits for the user approval, see [Journeys that spend](#journeys-that-spend) |
| `secrets.patterns`, `secrets.allow` | `{}` and `[]`; extra `<name>: <regex>` secret shapes and known-safe regexes, see [Secrets in the evidence](#secrets-in-the-evidence) |
| `journeys.<name>.timeout` | `30m`; a positive duration such as `90s` or `30m` (up to about 24 days), used by `verify` |
| `instance` | none; the app under test started per run, see [Run-instance harness](#run-instance-harness) |
| `matrix` | none, so each journey runs once; `theme`, `width`, `form` and `skip` set the [capture matrix](#capture-matrix) |
| `dom` | none; page-check records per capture, see [DOM assertions](#dom-assertions) |
| `inputs` | `[]`; repo-relative paths or globs the drive must leave alone, see [Input guard](#input-guard) |
| `base_ref` | none; a ref `verify` also drives, pairing its captures with the head's, see [Base-ref before](#base-ref-before) |
| `evidence.root` | `<local_root>/<app>`, outside the repo. A relative path is under the repo; an absolute path is used as-is |
| `evidence.allow_dirty` | `false` |
| `evidence.ignore_paths` | `[]` |
| `checks.not_proven` | `inconclusive`; `allow` is honoured only from `--trusted-ref` |
| `checks.fix_title` | `^(fix\|bugfix\|hotfix)\b`: titles that need a repro |
| `judge.enabled` | unset: `verify` judges, `check` and `receipt` only with `--judge`; `true`: `check` and `receipt` judge too; `false`: `verify` judges only with `--judge`. `rerun` judges as its source run did either way |
| `agent` | as in the global file; set here, it wins |
| `auto_fix.maintain` | as in the global file (`0`, report only); set here, it wins |
| `auto_fix.verify` | as in the global file (`0`, report only); set here, it wins |

**Precedence:** built-in defaults, then the global file, then the project file.

Global-only keys describe the machine. Project-only keys describe the project. Setting a global-only or project-only key in the wrong file is an error (exit 2), not something silently ignored.

