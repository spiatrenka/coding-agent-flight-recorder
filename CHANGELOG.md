# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with one project-specific rule worth stating up front:

> **A change to detector semantics is a minor bump at minimum.** The same run
> producing a different verdict is user-visible behaviour, not an internal
> detail — even when no signature changed.

## [Unreleased]

## [0.2.0] - 2026-08-18

### Changed

- **Elapsed time no longer decides a verdict.** Analyzer **1.2.0**. Rule 3 tested
  `duration ≥ 300s` and is evaluated before the rule that assigns `unchanged`, which
  gave that label a hard five-minute ceiling — measured over a real 509-run corpus,
  **0 of 54** no-diff runs longer than five minutes had ever received it. A thorough
  code review takes longer than five minutes by definition, so the long half of
  exactly the category `unchanged` exists for was being called waste.

  What replaced it is the evidence that was already there: repetition or spend. On
  the same corpus this relabelled **22** runs `wasteful` → `unchanged` and left **31**
  long no-diff runs still `wasteful`, because those had cost or a loop finding behind
  them. Runs under five minutes were untouched. `wasteful` went 24.4% → 20.0% and
  `unchanged` 42.8% → 47.2%.

  The fixture set already contained the counter-example: `longNoDiff` reads six files,
  correctly identifies an unindexed sequential scan and proposes the index — graded
  `wasteful` for taking nineteen minutes. Two other tests asserted the old behaviour
  while their own comments argued for the new one.

- The `no-diff-brief` label rule is now `no-diff-no-signal`, since it no longer tests
  brevity. Stored runs graded by an older analyzer keep the old id; the dashboard
  falls back to showing it verbatim rather than breaking.

- **`netDiffLines` is renamed `churnedLines`**, because it returns lines added *plus*
  lines removed — churn, not net change — and the old name had consequences rather
  than just being untidy. A run that rewrites 200 lines reports 400, so any threshold
  written in "lines" was effectively half what its author intended:
  `risk.blast_radius` fires above 400, which on a real 509-run store puts it at the
  **53rd percentile** of runs with a diff, for a finding titled "Large change
  surface". Recalibrating that threshold is deliberately left to a later release —
  it changes no verdict, since the finding is `scope`/`medium` and rule 1 needs
  `scope` at `high`. `docs/GRADING.md` said "net diff lines" and is corrected. The
  dashboard reads the old field name as a fallback so an un-regraded archive does not
  render every run as "nothing changed".

### Added

- **`flightrec regrade`** — re-grade stored runs from their stored traces, without
  re-reading transcripts. This is what makes an analyzer change reach an existing
  archive: Claude Code purges transcripts after about thirty days, so for most of a
  real store the stored trace is the only remaining copy and `ingest` has nothing to
  re-read. `--all` regrades every run rather than only out-of-date ones.

- **`flightrec rm`** — delete stored runs, by id or with `--project`, `--before` or
  `--synthetic`. `--dry-run` lists what would go; anything matching more than one run
  requires `--yes`. Findings go with the run.

  Until now the only documented removal path was deleting the whole database, which
  made "a credential survived redaction into one run" cost an entire archive — and
  `SECURITY.md` is explicit that redaction is a mitigation rather than a guarantee, so
  that case is expected rather than hypothetical. Two limits are documented rather
  than papered over: transcripts are never touched, so `ingest --force` restores a
  deleted run whose transcript still exists; and SQLite keeps freed pages until a
  `VACUUM`.

- **Synthetic runs are marked as such.** `flightrec demo` seeds into whatever store is
  configured — normally the real one — and those runs were previously identifiable
  only *incidentally*, by their temp-directory source path. They now carry a
  `synthetic` flag, are excluded from `flightrec corpus` (whose entire job is
  measuring real behaviour), and are badged `demo` in the dashboard.

  `corpus` reports the number excluded rather than silently dropping it, and
  `--include-synthetic` restores the old totals. A store containing *only* demo runs
  audits them normally, since otherwise the first thing a new user tries after `demo`
  would report nothing.

  Demo runs stored by an earlier version carry no flag. Because `demo` derives run
  ids from the fixture session id, re-running it marks the existing rows rather than
  duplicating them — so `flightrec demo` followed by `flightrec rm --synthetic --yes`
  clears legacy demo data from a real store.

### Fixed

- **An upgrade's first `ingest` says when it is regrading.** The fix below means a
  plain `ingest` can rewrite the analysis of every run it has ever stored, which is
  intended but is a much larger act than "scan for new transcripts". It now reports
  how many files were unchanged on disk and re-read only because grading changed.

- **An analyzer upgrade no longer leaves stale verdicts behind.** `isUnchanged()`
  compared only path, mtime and size, so a release that changed grading skipped every
  unchanged transcript and kept the old labels — and the CLI's response was to tell
  the user to re-run with `--force` themselves. It now also requires the stored runs
  from that file to have been graded by the running analyzer. Needs no new column:
  the version is already on `runs`.

## [0.1.0] - 2026-08-17

First public release.

### Added

- **Two importers.** Claude Code (JSONL, tolerant parsing, run segmentation on
  idle gap and `/clear`) and OpenCode (session/message/part object graph, with
  the agent's own cost figure and repo-level diff summary preferred over
  modelled values, and explicit tool status so a denied command is distinct
  from a failed one).
- **Around fourteen deterministic detectors** across loops, risk, verification
  and cost: identical tool-call repetition, repeated failure, file churn,
  reverts, stall tails, secret and config file writes, edits outside the
  project root, destructive commands and blocked destructive attempts, blast
  radius, unbacked claims, never-verified changes, and spend or duration with
  no diff. No model is involved in any of it.
- **Four verdicts** — `productive`, `questionable`, `wasteful`, `risky` — with
  `risky` overriding all others.
- **The run tape**, a time-proportional SVG of the whole run: edits above the
  axis scaled by lines changed, command results below, prompts as dots,
  compaction as a dashed rule, and everything after the recommended stop point
  hatched.
- **Stop-point analysis** — the earliest point a stopping rule would have
  fired, and what the run did after it.
- **Firewall recommendations.** Each finding compiles to a proposed
  `settings.json` permission rule or a `PreToolUse` hook. These are *proposed
  and never armed*; enforcement is a deliberate v2.
- **Loopback-only dashboard** and HTTP API. The bind address is not
  configurable to a public interface.
- **SQLite store** at `~/.flightrec/flightrec.db` with forward-compatible
  column migration, so a database written by an older build stays readable.
- **Credential redaction at ingest**, applied conservatively — see
  [SECURITY.md](SECURITY.md) for why that is a mitigation rather than a
  guarantee.
- **Honest unknowns throughout.** `boolean | null` for command success and
  `number | null` for cost mean *unknown*, handled distinctly from `false` and
  `0`. Neither agent records exit codes, so check outcomes are parsed from
  runner output instead.
- CLI: `ingest`, `list`, `report`, `serve`, `stats`, `demo`, `corpus`.
- **`flightrec corpus`** — audits a whole store in one command: verdict
  distribution, per-detector fire counts, verification status, command-outcome
  knowledge split by source, every path flagged as sensitive, and a redaction
  self-check that scans for credential shapes which escaped masking. `--json` for
  machine-readable output. This is the tooling behind the corpus check that
  `CONTRIBUTING.md` requires for any detector change.
- Every run has its own URL in the dashboard (`#run=<id>`), so a specific run can
  be linked in an issue or handed to a colleague.

### Changed during pre-release review

- **A fifth verdict, `unchanged`.** "The repository was not modified" and "the
  change has no evidence behind it" used to share `questionable`, which on a real
  493-run corpus made that one label 60% of every run — and roughly two thirds of
  those had changed nothing at all. Splitting them takes `questionable` to 16%,
  where it means exactly one thing. `unchanged` renders muted, because ~40% of runs
  carry it and they need no attention.
- **The verdict badge explains itself.** Click it for what the label means in
  general, which rule fired and the values that decided it, and what would change
  the verdict — "a passing test, build or lint would make this productive",
  derived from the cascade rather than invented.
- **`docs/GRADING.md`** documents every rule in evaluation order, including which
  findings force `risky`, which look like they should and do not, and the soft
  spots worth arguing with.
- `flightrec list` and the dashboard say when stored runs were graded by an older
  analyzer, instead of showing a silent mix of old and new labels. The store is an
  archive, so re-ingesting is a choice rather than a default.

These landed after the first draft of this file and before anything was
published, so they are part of 0.1.0 rather than a later version. Kept as their
own section because they are the result of using the tool against a real corpus,
which is worth being visible.

- **The detail pane reads as a drill-down.** Tab order is now Postmortem ·
  Findings · Firewall · Files · Commands · Timeline — synthesis, then specifics,
  then remedy, then evidence in increasing granularity. Findings and Firewall
  were previously fifth and sixth.
- **The run tape is expanded by default**, reversing an earlier decision — see
  `docs/DECISIONS.md`.
- Paths are grouped and shown relative to the project root in `what changed`,
  the Files tab and finding evidence. Files that escape the project keep their
  absolute form, since that is the notable case.
- Files and Commands mark the rows a finding actually named — sensitive and
  config files, denied and destructive commands — so the evidence connects to the
  verdict instead of just listing rows.
- Commands are ordered by what needs attention (denied, failed, destructive)
  rather than chronologically; the Timeline tab remains chronological.
- Long commands are truncated from the *middle*, never the tail, with the full
  text one click away. The tail is where `--force`, `| sh` and `> file` live.
- `rescan` and the theme toggle moved out of the verdict filter row, which now
  carries explicit `verdict` and `source` labels.

- **A verification tail is no longer called waste.** The stop-point narrative
  claimed "nothing changed on disk, so the tail was pure overhead" even when the
  tail was entirely tests — while printing the check count one line above.
- The stop point now states a confidence level; previously it offered none, which
  invited a heuristic to be read as a certainty.
- Stop-point timestamps are formatted rather than raw ISO strings, in the
  dashboard and in `flightrec report` alike. Fixed to UTC, because a
  locale-dependent rendering would make stored markdown differ between machines.

### Found and fixed by validating against a real corpus

Every item here was found by running the tool over 484 real runs and checking
what fired in both directions. None were visible to the test suite, which was
passing throughout. `docs/DECISIONS.md` records the pattern.

- **Redaction covered tool output but not tool input.** A credential the agent
  wrote into a file was stored verbatim in the Edit call's `new_string` — the
  exact case `risk.secret_file_write` exists to flag. Tool input is now scrubbed
  too, with structure preserved.
- **`Authorization: Bearer <token>` leaked its token.** The generic
  credential-named-variable rule ran first and matched the *word* `Bearer` as a
  six-character value, rewriting the line and destroying the prefix the bearer
  rule needed. Precise rules now run before the catch-all, and auth scheme words
  are never treated as secrets.
- Secret-path detection no longer flags committed env templates
  (`.env.example`) or directories named `secrets/`. On a 484-run corpus that
  removed 36 of 41 false hits and 10 incorrect `risky` verdicts.
- `verify.unbacked_claim` evidence now quotes the matched claim rather than the
  first 220 characters of the message.

### Notes

- **Requires Node 24+.** `node:sqlite` landed in 22.5 but stayed behind
  `--experimental-sqlite` until 23.4, and a `bin` script cannot set that flag
  for its own process.
- **Zero runtime dependencies**, and that is a maintained constraint rather
  than a coincidence.
- Both transcript formats are documented by their authors as changing between
  releases, so importer fixes may land in patch releases.
- The Python port that existed before this release is retired — see
  [`docs/DECISIONS.md`](docs/DECISIONS.md).
- `loop.revert` and `loop.stall_tail` now have corpus evidence: measured over
  484 real runs they fire on 3 and 42 runs respectively. Earlier notes calling
  them unvalidated were written against a 25-transcript sample.

[Unreleased]: https://github.com/spiatrenka/coding-agent-flight-recorder/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/spiatrenka/coding-agent-flight-recorder/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/spiatrenka/coding-agent-flight-recorder/releases/tag/v0.1.0
