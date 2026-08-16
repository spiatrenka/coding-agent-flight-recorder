# Decisions

Short records of choices that are not obvious from the code, and would
otherwise be re-litigated.

---

## 2026-08-16 — The Python port is retired

**Decision.** TypeScript is the single implementation. The Python port is no
longer maintained, tested, or shipped.

**Context.** The original delivery contained two implementations: a TypeScript
one (~3,400 lines) and a Python port (~2,900 lines) that was a genuine 1:1
translation — same ten detectors, same normalized schema, same dashboard HTML.
The stated reason for the port was to avoid locking the project to a Node
runtime.

**Why retire it.**

- **It was already out of sync.** None of the work since the initial import —
  the OpenCode importer, the corrected price table, shell-write detection, the
  trivial-run filter, the check-output resolver, the claim and churn fixes —
  exists in the Python version. Reconciling it would mean porting six commits
  and then paying that cost on every future change.
- **Two implementations means two sets of detector semantics.** The value of
  this tool is that the same run always produces the same verdict. Two
  independently-drifting codebases quietly destroy that property, and nothing
  in the test suite would have caught the divergence.
- **The runtime argument did not hold.** The TypeScript build has zero runtime
  dependencies and needs only Node 24+ for `node:sqlite`. The Python port
  needed 3.10+, which was *not* available on the machine this was developed on
  (3.8), so in practice it was the less portable of the two.

**Consequences.**

- `src/` is authoritative. There is no second implementation to keep in step.
- The Python port was never committed to this repository and is not published.
  It exists only as a local artefact on the machine it was retired on.
- If a non-Node runtime is ever genuinely needed, the right move is a fresh
  importer against the documented `Run` schema in `src/model.ts`, not a revival
  of the port.

---

## 2026-08-16 — Dark by default; one loud thing per screen

**Decision.** The dashboard ships dark, with light as a stored opt-in, and the
detail pane leads with a single actionable sentence.

**Context — theming.** This is a console you open after a bad run. Dark is the
default and only an explicit `light` choice is persisted. The stored theme is
applied by a tiny script in `<head>` before the stylesheet, because reading it
after first paint flashes the wrong theme. Every colour is a token defined in
both blocks; an audit found four hard-coded hex values, one of which
(`.chip[aria-pressed]` using `color:#fff` over a `var(--ink)` background) was
white-on-white in dark mode.

**Context — density.** The detail pane showed roughly twenty data points at
equal visual weight before telling you anything: a five-item crumb line, an
eight-cell stat grid, a chart, and six tabs. The run list repeated the verdict
as text next to cost, file count and duration, when the stripe and dot already
encoded it. Everything was emphasised, so nothing was.

**Consequences.**

- The run list is two lines: goal, then time and duration, with a `!` only when
  a high-severity finding exists. Cost and file counts are not triage signals.
- A **lede** sits directly under the verdict — the one sentence that decides
  what you do next, ordered by what would change a decision: a stop point beats
  a finding, a finding beats a clean bill of health. Measured across the corpus
  it is specific for 96% of runs; only 4% fall through to a generic headline.
- The stat grid is four cells with muted secondary detail, not eight equals.
- The run tape moved behind a disclosure. It is the most distinctive view here
  and still the wrong thing to lead with, because it answers "what shape was
  this run" and the reader's first question is "do I need to care".

---

## 2026-08-16 — The dashboard is smoke-tested against real payloads

**Decision.** `test/dashboard.test.ts` extracts the inline script from
`src/web/index.html`, runs every render function against payloads built by the
real pipeline, and fails on a throw or a snake_case read.

**Context.** The detail pane rendered nothing when a run was selected. The
markup was inherited from an implementation whose API served snake_case, while
this one serialises the model objects directly and serves camelCase. 65
property reads were wrong.

The symptom was oddly specific and worth recording: the **run list worked**
while the **detail pane was blank**. `/api/runs` returns SQL rows, which really
are snake_case, so the left rail was correct. `/api/runs/:id` returns the
nested JSON documents, which are camelCase. `tape()` was the first function
`renderRun()` calls inside its template literal, so it threw before any markup
was assigned and the panel simply stayed empty — no error visible in the UI.

**Why a test was needed.** The dashboard is plain HTML with an inline script:
no build step, no module system, no type checking. Every other file in the
project is covered by `tsc`; this one is covered by nothing, which is precisely
why a whole class of bug lived there undetected through several releases.

**On the assertion.** The obvious check — search the rendered markup for
`"undefined"` — is unusable. Real runs contain that word in file contents,
commit messages and branch names; it produced 190 false positives on the local
corpus. The test instead wraps the payload in a Proxy that throws when a
snake_case key is read that does not exist. The contract is camelCase, so such
a read is wrong by definition regardless of what the output looks like.
`toolInput` is exempt: those keys are the agent's vocabulary, not our schema,
and `file_path` is genuinely what Claude Code writes.

---

## 2026-08-16 — Build steps use Node's fs, not shell `cp`

**Decision.** File operations in npm scripts go through `node -e` and
`node:fs`, not `cp`/`rm`.

**Context.** The original build was `tsc && cp -r src/web dist/src/web`. That
is correct exactly once. On every rebuild `dist/src/web` already exists, so
`cp -r` copies *into* it — producing `dist/src/web/web/index.html` and leaving
the file the server actually reads untouched.

The failure is silent and nasty: dashboard edits never reach `dist` unless you
delete it first, so the UI appears not to respond to changes. It was confirmed
by appending a probe comment to `src/web/index.html`, rebuilding, and finding
the probe absent from `dist/src/web/index.html`.

**Consequences.** `fs.cpSync(..., { recursive: true })` overwrites in place and
is idempotent, so repeated builds converge. It also removes the dependency on
POSIX tools, whose `cp -r` trailing-slash semantics differ between BSD and GNU
anyway. `incremental: true` in tsconfig keeps warm rebuilds near 0.6s, which is
what makes it reasonable for `demo`/`ingest`/`serve` to build before running.

---

## 2026-08-16 — Detectors are validated against a real corpus, not only fixtures

**Decision.** A detector is not considered working until its behaviour has been
compared against ground truth computed independently from real session data.

**Context.** Every detector passed its fixture tests from day one. Running them
over a real Claude Code corpus and separately computing what *should* have
fired surfaced two defects that fixtures could not:

- `verify.unbacked_claim` matched only prose forms ("all tests pass") and missed
  every claim the agent actually made — "41/41 tests pass", "typecheck clean",
  "66/66 passing". A high-severity detector was silent by construction.
- `loop.churn` fired on 11 files, but 6 of those had tests or a typecheck
  running *between* the edits. The finding's own text called each edit "a
  hypothesis it never verified", which was false in the majority of cases.

**Consequences.** Fixtures pin behaviour; they do not establish it. When adding
a detector, run it over `flightrec ingest` output and check both directions —
what fired that should not have, and what should have fired and did not.
