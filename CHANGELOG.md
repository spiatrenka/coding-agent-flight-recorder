# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with one project-specific rule worth stating up front:

> **A change to detector semantics is a minor bump at minimum.** The same run
> producing a different verdict is user-visible behaviour, not an internal
> detail — even when no signature changed.

## [Unreleased]

### Changed

- **`risk.blast_radius` is split in two, and its line threshold moves from 400 to
  1,800.** The finding tested two unrelated things under one id and one headline:
  many files for a small ask (*breadth*), and many changed lines with nothing green
  (*volume*). Breadth keeps `risk.blast_radius`; volume becomes
  **`risk.unverified_large_diff`**.

  0.2.0 recorded that the 400-line threshold was wrong and left recalibrating it to
  a later release. Re-measured over a 1,952-run store — 609 runs with a diff — it was
  worse than that note estimated, and the threshold was not the only defect:

  - **400 lines was the 62nd percentile.** Median churn among runs with a diff is
    **207** (p75 819, p90 1826, p95 2724). A finding announcing a large change fired
    on **151 runs — 24.8% of every run that touched a file**. 126 of those 151 came
    from the lines arm alone.
  - **It mostly restated a finding already on the run.** 121 of the 143 lines-arm
    runs (85%) already carried a `verify.*` finding; 85 carried `verify.never_ran`.
  - **The `no passing verification` conjunct was not selecting anything.** Median
    churn is *higher* among runs that verified green (**249**) than among runs that
    did not (**191**). Size and lack-of-verification are effectively independent
    here, so `churn >= 400 && !passed` was the median diff intersected with an
    unrelated fact rather than a risk class.
  - **The text was false for half of what fired.** 44 of 143 lines-arm firings
    changed exactly **one** file and 52 changed two or fewer — reported under a title
    counting files and a detail arguing about "wide diffs from narrow asks".

  At 1,800 lines (the p90) the volume finding fires on **47** runs and breadth on
  **25**, so the pair covers **64 runs — 10.5% of runs with a diff**, down from
  24.8%. 22 of the 47 volume firings are still single-file, which is why the split
  was needed and not the threshold alone: `risk.unverified_large_diff` claims volume
  only, and its title and detail never describe a change as spread out.

  The `verification !== "passed"` gate is kept rather than dropped, though the
  independence result invites dropping it — without it the finding fires on 58 runs.
  The claim being made is that a diff is both too large to review line by line and
  unbacked by any check, and the new wording says exactly that.

  **No verdict changes.** Both findings stay `scope`/`medium`, and cascade rule 1
  needs `scope` at `high`; the verdict distribution over the store is unchanged
  across a full regrade. Run `flightrec regrade --all` to move an existing archive
  onto the new ids — stored runs keep `risk.blast_radius` until then, and the
  dashboard renders the stored title verbatim rather than breaking.

  `fixtureBigDiff` grew from 480 to 2,000 churned lines across the same two files,
  so the demo run still exercises the volume finding without tripping breadth.

## [0.3.0] - 2026-08-26

### Changed

- **The Node floor is now 22.13, down from 24.** `engines.node` is `>=22.13.0`.
  The 0.2.0 note below claims `node:sqlite` "stayed behind `--experimental-sqlite`
  until 23.4", so "any Node 22" fails with `ERR_UNKNOWN_BUILTIN_MODULE`. That was
  wrong when it was written, not overtaken since: the unflag shipped in 23.4.0 on
  2024-12-10 and was **backported to the 22 LTS line in 22.13.0 on 2025-01-06**.
  Verified on the floor itself: 22.13.0 imports the module unflagged and passes
  the whole suite, and the packaged tarball installs and runs there with no
  `EBADENGINE`. 21.1.0 and 20.18.1 still throw, so the floor is real — just
  lower than it was.

  This is a user-facing fix rather than housekeeping. `>=24.0.0` made npm emit
  `EBADENGINE`, a hard install failure under pnpm or `engine-strict`, and Node 22
  is the LTS most people run — so the declaration was turning away users to guard
  against a failure that does not occur on the versions it was turning away.

- **CI floor legs are pinned exactly.** The matrix ran `24.x`, which resolves to
  the newest 24 release, so the leg that existed to prove `engines.node` was
  honest had never actually tested `>=24.0.0`. The new leg is the literal
  `22.13.0`, on Linux and macOS, and `release.yml` runs the pre-publish
  `npm run check` on it too.

- `@types/node` moves to `^22.20.1`, tracking the floor as the project requires.
  With 24-era types, code using a Node 24-only API would typecheck and then fail
  at runtime on the floor.

### Added

- **`flightrec feedback [run-id]`** — a summary of one run short enough to paste
  into a chat window and safe enough to paste without reading it first. With no
  id it takes the newest run and says which one it picked.

  This exists because the most valuable report this project can get, "that
  verdict is wrong", was also the most awkward to send. The only thing to hand
  someone was `flightrec report --json`, which is the full record: prompts, file
  contents, absolute paths, commands. Asking a colleague to redact that by hand
  is asking them not to bother.

  **The boundary is an allowlist, not the redactor.** `redact()` finds
  credentials and is deliberately conservative — it does not strip a goal, a
  branch name or a repository path, and should not. So nothing in the summary
  copies a free-text field; every value is an enum, a number, a version string
  or a detector name. `redact()` still runs over the rendered output, where it
  should always be a no-op.

  Two tests carry that claim and fail differently on purpose: a canary run whose
  goal, branch, paths, commands, output and MCP server name are improbable
  tokens that must not appear in either the rendered or `--json` form; and a
  Proxy that throws if a forbidden field is *read at all*, so adding
  `finding.title` to the summary fails even when that title is benign. Finding
  titles are the specific trap — `loops.ts` builds them as ``​`<the actual shell
  command>` failed 3×``.

### Fixed

- **The OpenCode importer had been blind since 2026-02-15.** OpenCode migrated
  its session store from a JSON directory to SQLite (`opencode.db`) and left the
  old `storage/` tree in place. `available()` was a single `statSync` on
  `storage/session`, which still existed — so the source reported itself healthy,
  discovery returned the same frozen files every time, and every `ingest` since
  February said "0 new" and meant "broken". On the store this was found against
  that is **1,072 missing sessions**, 159 of them from this month alone.

  The importer now reads `opencode.db` and prefers it, falling back to the
  directory for installs old enough to still use one. Both backends share every
  mapping function, so a detector change cannot apply to one and not the other —
  a test asserts the two produce byte-identical `Run`s.

  Re-ingesting is safe and needs no flags: session ids survived the migration and
  `makeRunId` is deterministic, so existing runs are updated in place rather than
  duplicated. Expect the run count to jump — 449 to 1,877 here, in 14 seconds.

  Two traps in the migrated data, both now covered by tests. `part.time_created`
  and `message.time_updated` were **collapsed onto the migration instant** for
  every pre-existing row, so ordering or freshness taken from either would
  scramble six months of timelines; ordering comes from the id, which was checked
  against time order across 41,347 messages and 25,573 parts with zero
  inversions. And the connection is strictly read-only: this is live agent data,
  frequently with the agent running.

- **A source going quiet is now loud.** `ingest` reports, per source, how old the
  newest data it can see is; when a source the store already has runs from has
  seen nothing for 30 days, it says so and names the two likely causes. This is
  deliberately generic — the specific bug above is fixed, and the next importer
  to go stale will have a different cause. Against the February state it prints:
  *"the newest opencode data on this machine is 192 days old (2026-02-15), but
  this store already has opencode runs."*

  A narrower tripwire watches for the migration that is **already staged**:
  `opencode.db` ships an empty `session_message` table with its indexes built.
  When OpenCode starts writing there, `message` freezes and this importer would
  go quiet again — with no leftover directory to blame.

- **The wrong-verdict issue template could not express `unchanged`** — 47% of
  real runs. Both dropdowns listed four of the five verdicts, so the most common
  grade in a real store could not be reported as wrong. `LABELS` is now exported
  from `src/model.ts` as the single source of truth and a test compares the two.
- The same template still claimed `loop.revert` and `loop.stall_tail` "have
  never fired on a real corpus at all". The 0.2.0 changelog records them firing
  on 3 and 42 runs; the current store has 4 and 48. A reporter who checks that
  claim learns the project is unmaintained, so it is gone and a test forbids it.
- The bug-report template's command dropdown was missing `regrade`, `rm`,
  `corpus` and `feedback`. A test now reads the dispatch switch and asserts every
  command it finds is both offered there and documented in `USAGE`.
- The README had no way to report a wrong verdict — the only invitation on the
  page was a security line near the bottom.

- The lockfile still said `0.1.0` after the 0.2.0 release; regenerating it for
  the `engines` change corrected that too.

- The README no longer says `node:sqlite` is "experimental in Node 24" — it
  became a release candidate in 24.15.

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

[Unreleased]: https://github.com/spiatrenka/coding-agent-flight-recorder/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/spiatrenka/coding-agent-flight-recorder/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/spiatrenka/coding-agent-flight-recorder/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/spiatrenka/coding-agent-flight-recorder/releases/tag/v0.1.0
