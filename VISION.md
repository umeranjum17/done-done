# Vision

done-done is one of three tools. Each tool does one job well.

## The three tools

- **sign-off** is the main communication board between agents or projects and the user. It has a written contract for how projects communicate.
- **done-done** is the main verification tool.
- **learn-from-mistakes** is the main retro tool.

## Rules for all three tools

- **Each tool works alone.** The skill and the CLI work with or without the other two tools. They work with or without an agent supervisor.
- **Together, they connect well.** Small written contracts join them. No tool needs another tool to work.
- **Each tool owns primitives.** A primitive is a small building block that works for any project. When a project needs custom behaviour, that behaviour becomes a new primitive. It never becomes a fork.
- **One migration, no old copy.** An existing project moves once from its local pieces to the tool's primitives. It keeps no old copy. A new project starts from the tool's base.
- **The user sets everything.** Nothing runs automatically. Users bring their own agents, models and accounts. The tools have zero hosted cost.
- **The best human-computer interaction on every surface.** This applies to the CLI, the skill, the output and the docs.
- **Kun's tool patterns.** Each tool is an [AXI](https://axi.md) CLI. Output is [TOON](https://github.com/toon-format/spec) by default. Every result names the next command in its `help` lines. Agents install the skill with `npx skills`. The CLI ships on npm.

## done-done's role

done-done is the one verify system for all projects. It does not accept "done" without proof.

What ships now:

- **Proof per commit.** Each claim is proven at the exact commit. Each run keeps a run record.
- **The judge the user picks.** Any agent and model the user chooses runs, the author's own too (a fresh session of its own). done-done never picks one.
- **A gate that asks the user.** When the judge says fail or unsure, the run stops and waits. The user answers with `respond`.
- **Sign-off messages.** `signoff` writes a run's gate or evidence in the sign-off contract v1 shape and prints the post command; it never posts, and done-done works without sign-off (see the [reference](docs/reference.md)).
- **Receipts.** A receipt records a passing check, the commit and the hash of each file. You can check it again later.
- **Maintain.** `maintain` keeps the verify skill in step with the code.
- **Fix loop.** `auto_fix.maintain` lets done-done fix verify skill drift, and `auto_fix.verify` lets it fix the product after a failed verify, with the same config shape as no-mistakes.
- **Run-instance harness.** An `instance` block starts the app under test per run, on its own port, with its own HOME and XDG folders, and stops it at the end.
- **Capture matrix.** One verify run captures every theme x width x form cell the repo asks for; each cell is captured or skipped with a reason.
- **DOM assertions.** With a `dom` block, each captured screen's page-check record must be clean: no horizontal overflow, squashed, clipped or cut-off UI, or console error or failed request that an allow list does not name.
- **Base-ref before.** With `base_ref`, `verify` drives the base ref too and judges each head capture together with its base capture.
- **Text evidence.** The judge reads text captures (logs, JSON, CLI output) as well as screens; see the [reference](docs/reference.md).

What comes next:

- More project-agnostic primitives.
- Help to write the proof steps for your app.

Custom behaviour from a project becomes a new primitive in done-done.

## Works with

- **sign-off.** sign-off owns the communication contract: the schema doc and the validator. When sign-off is present, done-done consumes them and sends asks, reports and evidence through the contract. Without sign-off, done-done works alone.
- **learn-from-mistakes.** It reads failed, overridden and waiting runs.
- **[Firstmate](https://github.com/kunchenguid/firstmate).** A supervisor can call done-done. A supervisor is not necessary.
- **[no-mistakes](https://github.com/kunchenguid/no-mistakes).** done-done uses the same config shape and the same fix-loop idea.
- **quota-axi.** It follows the same Kun tool patterns.

### The communication contract

These four rules keep every report and evidence card the same on the board, so the user does less work.

1. **One strict, versioned schema per message kind.** The kinds that cross tools are ask, report, evidence, gate or approval, and retro finding. sign-off owns the contract doc and a validator. A post that does not match is refused with a clear fix message. It is never shown half-broken.
2. **Every producer emits exactly that shape.** done-done evidence and gates, learn-from-mistakes reports and findings, and any project all use the same shape.
3. **Shared conformance tests.** Each kind has a fixture. Each tool's CI runs the fixtures against the validator.
4. **Each skill teaches the exact command and shape.** It gives one worked example, so agents use the tool right the first time.
