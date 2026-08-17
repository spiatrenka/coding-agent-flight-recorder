# Contributing

Thanks for looking. This document is the review bar — what a change has to
clear to land. The [README](README.md) is the how-to for using and extending
the tool; this file is what a reviewer will hold a pull request against.

---

## The non-negotiables

These are the constraints that make the tool worth using. A change that breaks
one of them will not land, however good it is otherwise.

**Determinism is the product.** The same run must always produce the same
verdict, byte for byte. That is why there is no model in the analysis path —
see [Why the postmortem has no LLM in it](README.md#why-the-postmortem-has-no-llm-in-it).
A test asserts postmortems are byte-identical across two runs. Do not introduce
wall-clock reads, iteration over unordered collections, or anything else that
makes output depend on when or where it ran.

**Zero runtime dependencies.** `dependencies` is empty and stays empty. This is
a tool that reads your private transcripts; every package added is another
party in that. A pull request that adds one needs a `docs/DECISIONS.md` entry
arguing the case, not just a review approval.

**Unknown is not false, and not zero.** `boolean | null` for command success
and `number | null` for cost mean *unknown*, and are handled distinctly from
`false` and `0` everywhere. This is the single most important invariant in the
codebase. Neither agent records exit codes, so a command's success is often
genuinely unknowable; reporting that as "failed" would be a confident claim
built on missing data. The same goes for cost: an unpriced model must never
turn into "$0.00 spent, nothing changed."

**Detectors never throw.** A malformed transcript degrades one field, not the
run, and never the whole scan. Unrecognised shapes are recorded as
`schema_drift` and carried through.

**The type discipline is deliberate.** `strict` plus `noUncheckedIndexedAccess`,
so every array and record access is `T | undefined` and gets narrowed at the
call site rather than asserted away. The only `as` casts in the codebase are on
`node:sqlite` row shapes, which the driver types as `unknown`.

---

## Setting up

Node 24+ — see [the note on the floor](#why-node-24) below.

```bash
npm install        # builds via prepare
npm run check      # lint, typecheck, test — the gate
npm run test:fast  # inner loop, no rebuild
npm run coverage   # same tests, with thresholds enforced
```

`npm run check` is what CI runs. If it passes locally it will pass there, with
one exception: CI also runs on macOS, and the suite is hermetic by design, so a
platform-specific failure means a real portability bug.

Formatting is Biome's, not yours — `npm run lint:fix` before committing. The
config turns off the rules that fight this codebase's deliberate idioms
(bracket index access, the `while ((m = re.exec(s)))` pattern, early return of
a void call); everything else is on.

---

## Adding a detector

A detector is a pure function `Run → Finding[]` in one of
`src/analyze/{loops,risk,verify,cost}.ts`, wired into `src/analyze/index.ts`.

The `Finding` contract is stricter than it looks:

- **`evidence` must point at real event indices.** The dashboard turns them
  into jump links and the postmortem quotes them. A finding you cannot navigate
  to is an accusation without a citation.
- **`suggestedRules` is not optional decoration.** The postmortem prose and the
  firewall section are two renderings of the *same* finding. A finding with no
  suggested rule renders as a complaint with no remedy.

Then a fixture case in `test/findings.test.ts` or `test/detectors.test.ts`,
built with the `Builder` in `src/demo/fixtures.ts`.

### Then check it against a real corpus

**Fixtures pin behaviour. They do not establish it.** A fixture proves the
detector does what you wrote; it cannot tell you whether what you wrote is
right, because you wrote both.

So before proposing a detector — or a change to an existing one — measure it:

```bash
flightrec ingest --db /tmp/corpus.db   # your own history, into a scratch store
npm run corpus -- --db /tmp/corpus.db  # fire counts, flagged paths, redaction audit
rm /tmp/corpus.db
```

Then compare in **both directions**: what fired that should not have, and what
should have fired and did not. Read the sensitive-paths table by eye — precision
is only visible there, and that is where the worst defect so far was hiding. The second direction is the one
people skip, and it is where both of the real defects were:

- `verify.unbacked_claim` matched only prose forms like "all tests pass" and
  was silent against every claim the agent actually made — "41/41 tests pass",
  "typecheck clean", "66/66 passing". A high-severity detector, passing all its
  fixtures, that had never once fired on real data.
- `loop.churn` fired on 11 files, but 6 of them had a test or typecheck running
  *between* the edits. The finding's own text called each edit "a retry without
  new information", which was false in the majority of the cases it reported.

Both detectors that once had no corpus evidence — `loop.revert` and
`loop.stall_tail` — now have it: over 484 real runs they fire on 3 and 42 runs
respectively. That only became visible on a corpus large enough to contain the
behaviour; a 25-transcript sample showed neither. If your detector fires on a
corpus, say so in the pull request, with counts. That is the evidence that
matters most.

See [`docs/DECISIONS.md`](docs/DECISIONS.md) for the full record.

---

## Adding a source importer

The API and a worked example are in the README:
[Adding another agent](README.md#adding-another-agent). Don't duplicate that
here — **the README owns the how-to, this file owns the review bar.**

The bar:

- **Report facts over models.** If the agent records its own cost or its own
  diff summary, use it. `estimate()` must leave an already-known value alone.
- **Distinguish denied from failed.** A blocked destructive command is a
  different event from one that ran and failed, and the risk detectors grade
  them separately.
- **Parse tolerantly by construction.** Unknown entry or part types become
  `schema_drift`, never an exception. Both formats are documented as changing
  between releases.
- **A file is not a run.** Segment on idle gap and on explicit session
  boundaries. `FLIGHTREC_IDLE_GAP` controls the threshold.
- **Take the project path from per-event `cwd`,** not from the directory slug.
  Slugs are truncated and hashed for long paths.
- **Fixtures must be synthetic.** Write a builder like
  `src/demo/opencodeFixtures.ts`. Never commit a real transcript — see
  [SECURITY.md](SECURITY.md).
- Register in `src/sources/index.ts`, and add a contract case to
  `test/sources.test.ts`.

`src/sources/stubs.ts` holds a `CodexSource` stub that is registered but
unavailable. It is the natural first importer to write.

---

## Changing the dashboard

`src/web/index.html` is plain HTML with an inline script — no build step, no
module system, and invisible to `tsc`. Every other file is type-checked; this
one is covered only by `test/dashboard.test.ts`, which is exactly why a whole
class of bug lived there undetected through several releases.

The contract that test enforces: `/api/runs` serves **snake_case** SQL rows,
`/api/runs/:id` serves **camelCase** model objects. The test wraps payloads in
a Proxy that throws on a snake_case read that does not exist. `toolInput` is
exempt — those keys are the agent's vocabulary, not ours.

If you add a render function, add it to that test's list.

---

## Pull requests

- One behaviour change per pull request, plus the test that pins it.
- Commit subjects are imperative, single-line, and usually carry a colon clause
  naming the cause: *"Fix blank dashboard detail pane: UI read snake_case, API
  serves camelCase"*. Not Conventional Commits — deliberately.
- Update `CHANGELOG.md` under `## [Unreleased]`.
- Add a `docs/DECISIONS.md` entry when you make a choice someone will otherwise
  re-litigate in six months.
- **A change to detector semantics is at minimum a minor version bump**, because
  the same run producing a different verdict is user-visible behaviour, not an
  internal detail.

### Out of scope

Settled, and listed in [`docs/ANALYSIS.md`](docs/ANALYSIS.md) §7. Raising them
again needs new evidence, not a new argument:

- Live blocking or enforcement. The firewall section *proposes* rules; arming
  them is a deliberate v2 with its own consent design.
- LLM narration or an LLM judge, anywhere in the analysis path.
- Multi-user, cloud, or team dashboards.
- Git integration beyond what the transcript records.

---

## Why Node 24

`node:sqlite` landed in Node 22.5 but stayed behind `--experimental-sqlite`
until 23.4, and a `bin` script cannot set that flag for its own process. 24 is
the active LTS and the lowest version this actually runs on. `.nvmrc` pins the
floor rather than the latest, deliberately: the largest external risk to this
project is `node:sqlite` API drift, so develop against the oldest version we
support.

---

## Code of Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
