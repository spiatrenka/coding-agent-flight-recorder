# Agent Flight Recorder — prior art and positioning

Pre-build analysis, written August 2026 before any implementation existed; the MVP that
followed is derived from it. Kept unedited as a record of why the project is shaped the
way it is. Two caveats for a later reader: it names around thirty third-party tools with
claims that were accurate at the time and will not stay that way, and §7 (out of scope)
still governs what this project will and will not become.

---

## 1. What the tool has to answer

The original user story reduces to one question that no existing tool answers:

> **A run just finished. Should I trust the diff, and should it have been stopped earlier?**

That question is not about tokens, and not about the transcript. It is about the **repository outcome**
of a bounded agent run. Everything below is graded against it.

---

## 2. The landscape, in five layers

### Layer 1 — Usage meters
`ccusage`, `Claude-Code-Usage-Monitor`, SessionWatcher, `/cost`, `/usage`, the Console usage page.

These read the same JSONL (or the API billing side) and total up tokens and dollars. `ccusage` now
covers ~16 agent CLIs and does 5-hour block reporting; the monitors add burn-rate prediction.

- **Answer:** "how much did I spend."
- **Never answer:** "on what," "was it worth it," "did anything break."
- Cost is aggregated by *day / block / project*, which is the wrong unit. The unit of value in
  agentic coding is **one run against one repository**, and no meter has that grain.

### Layer 2 — Transcript viewers and exporters
`claude-devtools`, `lm-assist`, `simonw/claude-code-transcripts`, `claude-code-log`,
`claude-conversation-extractor`, CCHV, Mantra, the browser-based session viewers.

These are genuinely good and heavily used — 50k+ devs on claude-devtools alone. They reconstruct
what the terminal collapsed: every tool call, every Read, inline Edit diffs, subagent trees,
per-turn token attribution, compaction boundaries, cross-session search.

- **Answer:** "what happened, verbatim."
- **Never answer:** "was that good." They are *renderers*. They present the run at the same
  fidelity and the same length as the run itself, which means reviewing a 40-minute session still
  costs you real minutes. There is no verdict, no summary of net effect, no notion of a wasted run.
- Their model of the world stops at the transcript boundary. None of them cross into
  "what is the state of the working tree now, and did the tests the agent claimed to run actually pass."

### Layer 3 — Enterprise telemetry
`CLAUDE_CODE_ENABLE_TELEMETRY=1` → OTLP → SigNoz / Grafana+Prometheus+Loki (`claude-code-otel`) /
CloudWatch **Coding Agent Insights** (which now also ingests Codex and Copilot).

Rich and official: token metrics, cost, session counts, tool decision accept/reject rates, active
time, API error/retry counters, `prompt.id` correlation across a single prompt's fan-out.

- **Answer:** "how is the fleet behaving," at team/org grain.
- **Wrong grain and wrong consumer.** These are dashboards for a platform lead measuring adoption
  and spend, not a forensic record for the developer who has to decide whether to `git checkout .`
  in the next 60 seconds. Metrics aggregate; a postmortem must be specific.
- Requires a collector, a backend, and org buy-in. Nothing an individual dev turns on after a bad run.

### Layer 4 — LLM/agent observability platforms
Langfuse, LangSmith, Braintrust, Arize AX/Phoenix, AgentOps, Confident AI, Helicone, Datadog LLM Obs.

Span-centric tracing of agents *you* instrument, plus an eval layer (LLM-as-judge, trace-to-dataset
loops, regression suites).

- Built for agents you *write*, not agents you *use*. Claude Code is a closed harness — you don't
  own its call sites, so the SDK-instrumentation model doesn't apply.
- Cloud-first by default; the payload here is your source code, your `.env` spillage, your stack
  traces. Egress is a non-starter for a lot of teams, mine included.
- Even where they self-host, they score **trace quality**, not **repository outcome**. A trace can
  be flawless and the run still worthless: agent read 30 files, reasoned beautifully, changed nothing.
- Reimplementing this layer is explicitly out of scope, and rightly so: it is how the project
  would die.

### Layer 5 — Guardrails
`PreToolUse` hooks (shell/HTTP/MCP/prompt handlers), `permissions` deny rules,
`claude-code-permissions-hook`, Morph Reflexes, sandboxed execution.

The enforcement primitives are strong and well documented: exit 2 blocks a tool call and feeds
stderr back to the model; `hookSpecificOutput.permissionDecision: "deny"` does the same via JSON;
a hook's deny holds even under `bypassPermissions`; HTTP hooks can POST to `localhost`.

- **The loop is open.** Deny rules are written from imagination, in advance, by someone guessing
  which failure modes matter. Nothing feeds *observed* incidents back into the ruleset. You don't
  get a rule for `rm -rf` on a build directory until after the day it costs you an hour.

---

## 3. The gaps

**G1 — Nobody joins the trace to the repository.**
Every layer above stops at the transcript boundary. The thing that actually decides whether a run
was worth it — the diff, tests green, build passing, scope of blast radius — lives on the other
side of that boundary. Trace-level success and repo-level success are different variables and the
correlation is weaker than anyone assumes.

**G2 — There is no verdict artifact.**
No tool produces a thing you can read in 30 seconds that says *"wasteful: 41 minutes, $3.10,
zero diff, the same pytest invocation failed four times."* Viewers show; they don't judge.
The absence of a verdict is why nobody reviews runs — the review costs more than the run.

**G3 — Waste is a shape, not an event.**
There is no line in the JSONL that says "I am stuck." Stuckness is only visible over the *whole*
run: the same `Bash` command run 5 times, an Edit oscillating a file between two states,
the same assertion failing repeatedly, real spend with an empty diff. Per-event tools —
which is all of them — structurally cannot see this. It requires whole-run analysis with the run
as the unit of computation.

**G4 — Cost is decoupled from outcome, and is now partly unknowable.**
`ccusage` says $4.20. Nobody says $4.20 *for what*. Worse: on subscription plans there is no
per-session USD ground truth, and the old per-message cost field is unreliable/absent in current
transcripts. So cost must be **modelled from token counters and labelled as an estimate**, and the
honest answer for some sessions is `unknown`. A tool that silently prints `$0.00` is lying, and the
brief is right to demand `unknown` instead.

**G5 — Post-hoc review has no habit and no memory.**
Transcripts auto-purge after 30 days (`cleanupPeriodDays`). The evidence for "does this agent keep
making the same mistake" deletes itself before the pattern is visible. Derived analysis has to be
archived at ingest, independently of the source file.

**G6 — Review doesn't survive delegation.**
The moment more than one person's runs matter — a team, a handoff, an autonomous bot opening PRs —
manual transcript reading collapses. You need a per-run verdict that a *second* person can act on
without replaying the session.

---

## 4. What this tool is, positioned against the above

A **local, post-hoc, per-run forensic layer that terminates at the repository, not at the transcript.**

| | Meters | Viewers | OTel | LLM obs | **Flight Recorder** |
|---|---|---|---|---|---|
| Unit | day/block | message | metric point | span | **one run** |
| Verdict | ✗ | ✗ | ✗ | trace score | **repo outcome label** |
| Loop/waste detection | ✗ | ✗ | ✗ | partial | **first-class** |
| Diff & blast radius | ✗ | per-edit | ✗ | ✗ | **whole-run** |
| Guardrails from evidence | ✗ | ✗ | ✗ | ✗ | **generated from findings** |
| Local-only | ✓ | ✓ | ✗ | mostly ✗ | **required** |
| Needs setup before the run | — | — | ✓ | ✓ | **no — works retroactively** |

The last row is the strongest property and worth protecting: **it works on runs that already
happened.** Every instrumentation-based approach requires the decision to observe to precede the
event worth observing. Reading transcripts off disk means the tool is useful five minutes after you
install it, on the bad run you just had.

---

## 5. Hard constraints found during research

These drove specific implementation decisions.

**C1 — The transcript format is explicitly unstable.**
Anthropic's own docs: *"The entry format is internal to Claude Code and changes between versions,
so scripts that parse these files directly can break on any release."*
→ The parser must be **tolerant by construction**: never fail a run on an unknown `type`, never
require a field, record unknown event types as `schema_drift` warnings surfaced in the UI, and
carry the per-event `version` string so a drift can be attributed to a release. Extraction is
best-effort; a missing field yields `unknown`, never `0`.

**C2 — 30-day auto-purge.** Ingest is an archival act. The derived trace + postmortem must be
self-contained in the local store and readable after the JSONL is gone.

**C3 — Layout varies more than the docs suggest.** `~/.claude/projects/<slug>/<uuid>.jsonl` is the
documented shape, but some builds nest under a `sessions/` subdirectory, `CLAUDE_CONFIG_DIR`
relocates the whole tree, and slugs over 200 chars are truncated-plus-hashed so they are **not
reversible into a path**.
→ Discover by recursive glob, honour the env var, and take the project path from the per-event
`cwd` field rather than decoding the directory name.

**C4 — A file is not a run.** Resuming appends to the same file for days; `/branch` and
`--fork-session` create new IDs; two terminals resuming the same session interleave into one
transcript; `/clear` starts a fresh conversation while keeping the session.
→ **Segment each transcript into runs**: split on idle gaps and on `/clear`. Compaction is
marked inline rather than split on, because it happens mid-task and cutting there would sever a
single logical run. The run — a goal, some work, an outcome — is the postmortem unit. This is the single
most consequential modelling decision in the MVP.

**C5 — Compaction rewrites history mid-session.** It must appear on the timeline (it explains
"why did it forget and redo that") and it distorts token accounting.

**C6 — Transcripts contain secrets.** Source, paths, branch names, and anything a tool printed —
including a `cat .env`. Local-first is a requirement, not a preference. Ingest redacts
high-confidence secret patterns in stored command output.

**C7 — Cost must be modelled.** `message.usage` gives four counters: `input_tokens`,
`output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. Cache reads are cheap,
cache writes are not; ignoring the split misprices a long session badly. USD needs a model→price
table, which goes stale. → Price table is **data, not code**, cost is always labelled `estimated`,
and absent a price entry the answer is `unknown`.

**C8 — Diffs are already in the transcript.** Edit tool results carry a `structuredPatch`
(hunks with `oldStart`/`newStart`/`lines`); `oldString`/`newString` on the tool input is the
fallback. → Line-level diff stats without touching git, and therefore without needing the repo to
still be in that state.

**C9 — Hooks are the enforcement path, and they take HTTP.**
`PreToolUse` accepts an HTTP handler POSTing to a local URL, and a hook deny holds even under
`bypassPermissions`. → "Firewall recommendations" should not be prose. They should compile to a
concrete `settings.json` deny rule or a hook payload, so v2 enforcement is a config change rather
than a rewrite. The MVP emits the rules and does not arm them.

**C10 — Attempted ≠ executed.** A denied tool call still appears in the transcript, as a call with
an error/denial result. Blocked destructive attempts are *signal about the agent's disposition* and
must be flagged separately from executed ones — a run where the agent tried `rm -rf` and was stopped
is not a clean run.

---

## 6. Design decisions that follow

1. **Deterministic first, LLM never required.** Not a purity stance — determinism means the same
   session always yields the same verdict, which makes the detectors themselves regression-testable.
   A rule-based postmortem is also the eval harness for a future LLM narrator: you can only measure
   whether the model's summary is better if you have a fixed baseline. Cost of running: zero.
   Data egress: zero. Works offline.
2. **Normalized trace schema at the boundary.** Importers produce `Run / Event / ToolCall /
   FileEdit / Command`; every analyzer and the whole UI consume only that. Adding OpenCode or Codex
   is then one file implementing one protocol, with zero changes downstream. This is the reason the
   importer is a package, not a function.
3. **Findings are data.** Each risk flag carries `id`, `severity`, `evidence[]` (pointers to real
   event indices), and a suggested rule. The postmortem is a *rendering* of findings, and the
   firewall section is a *different rendering of the same findings*. One detector, three surfaces.
4. **Grade the run, not the transcript.** `productive / questionable / wasteful / risky` are
   assigned from repo-facing evidence — the diff, verification signal, loop count — with `risky`
   able to override any other label, because a run that touched secrets is not "productive" no
   matter how good the diff was.
5. **Honest unknowns everywhere.** Cost, verification status, and goal are all `unknown`-capable.
   Fabricated confidence is the failure mode that would make this tool unusable for the thing it's
   for.

## 7. Explicitly out of scope for the MVP

Live blocking; multi-user/server deployment; LLM narration; semantic search; git integration beyond
what the transcript already contains; generic LLM tracing; anything that requires configuration
before the run being analysed.

## 8. Where this fits a larger agent pipeline

For autonomous runs (bots that open PRs without a human watching), this is the **verification and
evaluation layer** — the piece that decides whether a run's output deserves to become a PR, and the
place per-run cost attribution actually lives. The generator produces the diff; the flight recorder
is the evaluator's evidence base. That separation is why the postmortem is machine-readable JSON
first and a web page second.
