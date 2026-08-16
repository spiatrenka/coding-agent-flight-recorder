# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with one project-specific rule worth stating up front:

> **A change to detector semantics is a minor bump at minimum.** The same run
> producing a different verdict is user-visible behaviour, not an internal
> detail — even when no signature changed.

## [Unreleased]

## [0.1.0] - 2026-08-16

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
- CLI: `ingest`, `list`, `report`, `serve`, `stats`, `demo`.

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
- `loop.revert` and `loop.stall_tail` are implemented and fixture-tested but
  have never fired on a real corpus, so their thresholds are unvalidated.

[Unreleased]: https://github.com/spiatrenka/agent-flight-recorder/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/spiatrenka/agent-flight-recorder/releases/tag/v0.1.0
