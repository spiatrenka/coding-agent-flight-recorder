# Agent Flight Recorder

[![npm](https://img.shields.io/npm/v/@spiatrenka/agent-flight-recorder)](https://www.npmjs.com/package/@spiatrenka/agent-flight-recorder)
[![node](https://img.shields.io/node/v/@spiatrenka/agent-flight-recorder)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![CI](https://github.com/spiatrenka/agent-flight-recorder/actions/workflows/ci.yml/badge.svg)](https://github.com/spiatrenka/agent-flight-recorder/actions/workflows/ci.yml)

Local post-hoc forensics for coding-agent runs. Reads the session data **Claude Code** and
**OpenCode** already write to your disk, segments it into runs, and produces a postmortem that
answers one question:

> **Should I trust this diff, and should the run have been stopped earlier?**

No instrumentation, no wrapper, no account. It works on runs that already happened.

```bash
npx @spiatrenka/agent-flight-recorder demo    # synthetic runs, every verdict
npx @spiatrenka/agent-flight-recorder serve   # dashboard at http://127.0.0.1:8787
```

**Nothing leaves your machine.** No network calls, no telemetry, no account, zero runtime
dependencies. The only network code in the project is a server that refuses to bind anything
but loopback.

Why this exists, and what it deliberately isn't: [`docs/ANALYSIS.md`](docs/ANALYSIS.md).
Decisions worth not re-litigating: [`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## Quickstart

Node 24+ (for `node:sqlite`). **Zero runtime dependencies.**

Against your own history, with the CLI installed globally:

```bash
npm install -g @spiatrenka/agent-flight-recorder
flightrec ingest
flightrec serve
```

### Or clone and build

```bash
npm install       # builds via prepare
npm run demo      # load synthetic runs covering every verdict
npm run serve     # dashboard at http://127.0.0.1:8787
```

Against your own history:

```bash
npm run ingest
npm run serve
```

`npm run` on its own lists everything. Arguments go after `--`:

| Script | Does | Builds first |
|---|---|---|
| `npm run demo` | load synthetic runs and exit | ✓ |
| `npm run ingest` | scan agent session data and analyse it | ✓ |
| `npm run serve` | dashboard on loopback (alias: `npm start`) | ✓ |
| `npm run list` | list analysed runs | |
| `npm run report -- <run-id>` | print one postmortem | |
| `npm run stats` | aggregate stats | |
| `npm run flightrec -- <cmd>` | escape hatch for any CLI command | |
| `npm run check` | lint, typecheck **and** test — the pre-commit gate | ✓ |
| `npm test` | build, then run the suite | ✓ |
| `npm run test:fast` | run the suite against the current build | |
| `npm run coverage` | the suite with thresholds enforced (94/80/92) | ✓ |
| `npm run lint` | Biome in CI mode — fails on a formatting difference | |
| `npm run lint:fix` | apply Biome's fixes and formatting | |
| `npm run typecheck` | `tsc --noEmit` | |
| `npm run build` / `rebuild` / `clean` | compile; `rebuild` cleans first | |

Formatting is Biome's, not yours. `npm run check` fails on a formatting difference, so run
`npm run lint:fix` before committing.

The three entry points build first so a fresh clone works; the read-only
commands skip it to stay fast. Builds are incremental — about 0.6s warm.

```bash
npm run list -- --label wasteful --source claude_code
npm run ingest -- --since-days 7 --force -v
npm run report -- cl-0ba5c9137399 --json
```

`npm link` puts the same CLI on your path as `flightrec`.

| Variable | Purpose |
|---|---|
| `CLAUDE_CONFIG_DIR` | where Claude Code stores transcripts (default `~/.claude`) |
| `OPENCODE_STORAGE_DIR` | where OpenCode stores sessions (default `~/.local/share/opencode/storage`) |
| `FLIGHTREC_HOME` | database location (default `~/.flightrec`) |
| `FLIGHTREC_IDLE_GAP` | seconds of silence that end a run (default `1800`) |
| `FLIGHTREC_PRICES` | JSON price table overriding the built-in cost model |

---

## Reading the code

Suggested order, roughly the data flow:

1. **`src/model.ts`** — the normalized trace schema. This is the contract; everything else is
   downstream of it. If this file makes sense, the rest will.
2. **`src/sources/claudeCode.ts`** — the only file that knows what Claude Code's JSONL looks like.
   Two things drive its shape: the format is documented as changing between releases, so parsing is
   tolerant by construction; and a transcript file is *not* a run, so it segments.
   **`src/sources/opencode.ts`** is the same job against a different shape — OpenCode stores an
   object graph rather than one file per session, and records more than a transcript does (its own
   cost figure, a repo-level diff summary, explicit tool status). Reading the two side by side is the
   fastest way to see what the `Source` seam actually buys.
3. **`src/analyze/`** — `loops.ts`, `risk.ts`, `verify.ts`, `cost.ts` are pure functions
   `Run → Finding[]`. `index.ts` orchestrates them and assigns the verdict.
4. **`src/postmortem.ts`** — renders the Analysis into prose and compiles findings into guardrails.
5. **`src/store.ts`** / **`src/server.ts`** / **`src/cli.ts`** — plumbing.

Type-level conventions worth knowing while reading:

- `strict` plus `noUncheckedIndexedAccess`, so array and record access is `T | undefined` and
  every lookup is narrowed at the call site rather than asserted away.
- `boolean | null` for command success and `number | null` for cost mean **unknown**, and are
  handled distinctly from `false` and `0` everywhere. This is the single most important invariant
  in the codebase — see "Honest unknowns" below.
- Detectors never throw. A parse failure degrades one field, not the run.
- The only `as` casts are on `node:sqlite` row shapes, which the driver types as `unknown`.

---

## What it shows

**Verdict.** Every run gets one of four labels, assigned from repository-facing evidence:

| | |
|---|---|
| **productive** | useful diff, checks passed or clear progress |
| **questionable** | partial progress, unresolved failures, or nothing run to verify the change |
| **wasteful** | no useful diff, repeated loops, or high cost/time for nothing |
| **risky** | sensitive files or dangerous commands involved |

`risky` overrides everything else. A run that wrote to `.env` is not "productive" no matter how
good the diff was.

**The run tape.** A time-proportional strip of the whole run: edits above the axis (height = lines
changed), command results below (red = failed), your prompts as dots, compaction as a dashed rule.
Everything after the recommended stop point is hatched. It shows the *shape* of a run — the thing
you cannot see by scrolling a transcript.

**Detectors.**

| Flag | Fires on |
|---|---|
| identical tool call | same tool + byte-identical arguments, 3+ times |
| repeated failure | same command failing 2+ times |
| file churn | one file edited 4+ times in a run |
| revert | an edit later undone back to its previous content |
| stall tail | >5 min of activity after the last file change |
| secret file write / read | `.env`, key material, cloud and registry credentials |
| config file write | CI workflows, Terraform, k8s, migrations, lockfiles |
| outside project | edits that escape the project root |
| destructive command | force push, hard reset, `git clean`, recursive delete, `terraform destroy`, piping curl to a shell… |
| destructive attempt | the same, but blocked or denied — reported separately |
| blast radius | many files or many lines relative to the request, unverified |
| unbacked claim | "all tests pass" with no passing test in the transcript |
| never verified | files changed and no test, build or lint ran |
| duration / cost with no diff | time or money spent, repository unchanged |

**Diffs the trace cannot see.** A diff assembled from edit-tool calls is blind to everything the
agent does through the shell — `tar -xzf`, a heredoc, `sed -i`, a redirect. Commands are classified
for write intent, and a run with no recorded edits but shell writes is reported as *the diff is not
visible* rather than *nothing changed*. The two are different claims and only one of them was
honest. Where OpenCode reports a repo-level diff summary, that fills the gap directly.

**Trivial runs.** A three-second session whose whole prompt was `.` is real on disk and noise in a
list. Those are still ingested and stored; `list` hides them unless you pass `--all`.

**Should it have been stopped?** The earliest point a stopping rule would have fired, plus exactly
what followed: how many events, how many minutes, how many further edits, how many further checks.

**Firewall recommendations.** Each finding compiles into a concrete guardrail — a `settings.json`
permission rule where a pattern can express it, a `PreToolUse` hook description where it needs
logic. **Nothing is enforced.** This release only proposes.

---

## What this is NOT

The space around this tool is crowded, and most of it solves a different problem. If one of these
is what you actually want, use the thing that does it well:

- **Not a usage meter.** It does not compete on spend totals — [`ccusage`](https://github.com/ryoppippi/ccusage)
  and the various usage monitors do that. Their unit is a day or a billing block; this one's unit
  is a single run, graded against the repository.
- **Not a transcript viewer.** It does not render your session for reading. `claude-devtools` and
  similar do that better. This **judges** a run; it does not **show** you one.
- **Not telemetry, and not an observability platform.** Nothing is instrumented. No OTLP, no
  collector, no exporter, no cloud. That is also why it can do something they cannot: it works
  retroactively, on runs that already finished, with no decision made in advance to record them.
- **Not a guardrail.** The firewall section *proposes* permission rules and hooks. Nothing is
  armed, nothing is blocked, nothing is written to your config. Enforcement is a deliberate v2 —
  it needs a consent design before it needs code.
- **Not an LLM judge.** There is no model anywhere in the analysis path, permanently and by
  design. See the section above.
- **Not a team dashboard.** One user, loopback bind, no authentication, no multi-user story.

---

## Why the postmortem has no LLM in it

Determinism is the feature. The same run always produces the same verdict, so:

- the detectors are regression-testable — 203 tests across 12 files, each pinned to a fixture or to
  a defect that actually occurred,
- nothing is invented — every sentence traces to a field in the trace,
- it costs nothing to run and works offline,
- and it becomes the fixed baseline a future LLM narrator can be measured against.

An LLM layer is a reasonable v2. It is not the foundation.

---

## Honest unknowns

Three things are reported as unknown rather than guessed, because a wrong number here is worse than
no number:

- **Cost.** Where the agent records what it was charged — OpenCode does — that figure is reported
  as fact and never overwritten by a model. Otherwise it is modelled from token counters against a
  price table stamped with the date it was last checked, because a price table that goes stale
  silently is worse than one that admits its age: the dollar thresholds in the risk detectors are
  calibrated in real money. Subscription plans have no per-run price at all and report `0`, which is
  treated as *unknown* and falls back to modelling. Unpriced models yield `null`, never `0`. Cache
  reads and cache writes are priced separately — collapsing them misprices a long agentic run badly.
- **Verification.** Neither agent records exit codes — measured across a real corpus, 0 of 108
  Claude Code Bash results carried one. So the outcome of a check is read from the runner's own
  summary (`ℹ fail 0`, `test result: ok. 12 passed`, `Found 3 errors`, `✖ 7 problems`), which is
  machine evidence rather than inference, and yields per-assertion counts an exit code never could.
  Where no known format matches and the output is ambiguous, the check is inconclusive, not passed.
  Adding this corrected nine runs that had been graded *productive* while their `tsc` or `eslint`
  had actually failed.
- **Goal.** A resumed segment with no user prompt says so instead of inventing one.

Each postmortem carries a confidence rating and the reasons behind it.

---

## Privacy

Everything is local: a SQLite file at `~/.flightrec/flightrec.db` and a server that refuses to bind
anything but loopback. Transcripts routinely capture whatever a command printed — including the
contents of a `.env` — so tool output is scrubbed of high-confidence credential patterns on the way
into the store. The original transcripts are untouched.

**What leaves your machine: nothing.** There are no HTTP clients in this project, no telemetry, no
update checks, no account. The only network code is a *server*, and it throws rather than binding
any interface outside `127.0.0.1`, `localhost` and `::1`.

Redaction is deliberately conservative, and that is a real trade: over-redaction destroys the
evidence value of the record, so it is a mitigation rather than a guarantee. **Treat
`~/.flightrec/flightrec.db` as exactly as sensitive as `~/.claude` itself.**

Ingest is also an *archival* act: Claude Code purges transcripts after 30 days by default, and this
database outlives them. `rm ~/.flightrec/flightrec.db` is the complete deletion path — there is
nowhere else state lives. See [SECURITY.md](SECURITY.md) for the full threat model.

---

## Layout

```
src/
  model.ts             normalized trace schema — the contract
  commands.ts          shell command classification + write-intent detection
  checkOutput.ts       read test/build/lint outcomes from runner output
  redact.ts            credential scrubbing at ingest
  sources/
    types.ts           the Source interface
    claudeCode.ts      JSONL parser + run segmentation
    opencode.ts        session/message/part graph reader
    stubs.ts           Codex seam
    index.ts           registry
  analyze/
    loops.ts           repetition, churn, reverts, stalls
    risk.ts            secrets, scope, destructive commands, blast radius
    verify.ts          did anything actually confirm the work
    cost.ts            token → USD with honest unknowns
    index.ts           orchestration, verdict, stop point
  postmortem.ts        deterministic narrative + firewall compilation
  store.ts             SQLite via node:sqlite
  server.ts            loopback HTTP API
  cli.ts               command line
  web/index.html       dashboard (no build step, no CDN)
  demo/
    fixtures.ts        synthetic Claude Code transcripts, one per verdict
    opencodeFixtures.ts synthetic OpenCode storage tree
    opencodeDemo.ts    demo sessions covering the OpenCode-only paths
    index.ts           seedDemo — what `flightrec demo` runs
test/                  12 files, 203 tests (node:test)
  detectors.test.ts    the core regression suite
  improvements.test.ts importer + analyzer regressions
  findings.test.ts     the finding ids nothing else asserts
  checkOutput.test.ts  runner-output parsing
  claudeCode.test.ts   defects found validating against a real corpus
  dashboard.test.ts    the inline UI script, which tsc cannot see
  server.test.ts       the HTTP API, over real sockets on port 0
  security.test.ts     loopback-only bind and static path traversal
  cli.test.ts          arg parsing, every command, and the bin entry
  ingest.test.ts       discovery, skip-unchanged, error containment
  sources.test.ts      the importer registry contract
  store.test.ts        filters, aggregates, and schema migration
docs/ANALYSIS.md       prior art and positioning
docs/DECISIONS.md      retired port, validation policy
```

The fixture builders live under `src/`, not `test/`, because `flightrec demo` is a shipped
command — they are product code that the test suite also happens to use. That keeps what the
demo shows and what the detectors are pinned against from drifting apart.

### Adding another agent

Implement `Source` from `src/sources/types.ts` and register it:

```ts
export class MyAgentSource implements Source {
  readonly name = "myagent";
  available(): boolean { /* … */ }
  discover(): DiscoveredFile[] { /* … */ }
  load(path: string): Run[] { /* … */ }
}
```

Fill in `Run`, `TraceEvent`, `FileEdit`, `Command` and `Usage` from `src/model.ts`. Every analyzer,
the postmortem generator, the store and the whole UI already consume only those types, so nothing
downstream changes — adding OpenCode touched no file outside `src/sources/`, the registry, and the
places that now had two sources to name. `src/sources/stubs.ts` marks where Codex goes.

Two things are worth copying from `opencode.ts` when you write one:

- **Report facts over models.** If the agent records its own cost or its own diff, use it and mark
  it non-estimated. `estimate()` will leave it alone.
- **Distinguish denied from failed.** A blocked destructive command changed nothing but says what
  the agent was willing to do unsupervised, and it is graded separately.

---

## Known limitations

- The transcript format is internal to Claude Code and documented as changing between releases.
  The parser is tolerant by construction — unknown entry types are recorded as schema drift and
  surfaced in the UI rather than dropped or fatal — but a large format change will degrade the
  detail available.
- `node:sqlite` is still marked experimental in Node 24. It is a single-writer local file here,
  which is the case it handles well, but the API could shift in a future Node release. This is why
  `.nvmrc` pins the floor rather than the latest.
- **Windows is untested.** CI covers Linux and macOS. The test glob is POSIX and the path guards
  are separator-sensitive; rather than claim support nobody has verified, it is left unclaimed.
- The `flightrec` binary name may collide if you have also installed the unrelated `flightrec`
  package from npm.
- Not affiliated with the unrelated `agent-flight-recorder` package on npm.
- Run segmentation uses an idle-gap heuristic. A run interrupted by a long lunch splits in two;
  `FLIGHTREC_IDLE_GAP` tunes it.
- Command success is read from exit codes where the transcript records them and inferred from
  output otherwise, which is conservative but not infallible. OpenCode records no exit code at all,
  so success there comes from the tool's own status, refined by the output.
- Diff data comes from the session record, not from git. It reflects what the agent did, not what
  survived in the working tree afterwards. Shell-mediated changes are *detected* but not measured —
  the run is marked as having an incomplete diff rather than a counted one.
- Subagent (`Task`) trees are recorded as tool calls but not yet expanded into nested timelines.

---

## Contributing

Pull requests welcome. [CONTRIBUTING.md](CONTRIBUTING.md) is the review bar — the constraints that
make this tool worth using (determinism, zero dependencies, honest unknowns) are load-bearing, and
it explains why before it explains how.

`npm run check` is the gate: lint, typecheck, tests. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

The threat model is specific — this tool reads your private transcripts. See
[SECURITY.md](SECURITY.md), and report vulnerabilities privately rather than in an issue.

## License

MIT © 2026 Sergey Petrenko. See [LICENSE](LICENSE).
