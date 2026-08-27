# Decisions

Short records of choices that are not obvious from the code, and would
otherwise be re-litigated.

---

## 2026-08-27 — A size threshold is a percentile, and one finding makes one claim

**Decision.** `risk.blast_radius` splits into a breadth finding (10+ files for a
request under 200 characters) and a volume finding,
`risk.unverified_large_diff` (1,800+ churned lines with no check green). Size
thresholds are set from a measured percentile of the real corpus, not chosen.

**Context.** The 400-line threshold was known to be wrong since 0.2.0 and left for
later. Measured over a 1,952-run store (609 with a diff) it was the **62nd
percentile** — median churn is 207 — and the finding fired on 24.8% of every run
that touched a file, 126 of 151 firings coming from that arm alone.

Two things surfaced that the threshold discussion had not anticipated:

- **The conjunction was not selecting a risk class.** `churn >= 400 && !passed`
  reads like "big change nobody checked", but median churn is *higher* among runs
  that verified green (249) than among runs that did not (191). The two conditions
  are effectively independent in this corpus, so the arm was the median diff
  intersected with an unrelated fact. 85% of its firings (121 of 143) already
  carried a `verify.*` finding, so it was largely restating one.
- **One id covering two claims made the text false, not just vague.** 44 of the 143
  firings changed exactly one file, under a headline counting files and a detail
  about "wide diffs from narrow asks". No single wording can be honest about both
  breadth and volume, which is why this is a split and not a rewrite.

**Consequences.** The pair fires on 64 runs — 10.5% of runs with a diff, from 24.8%.
Both stay `scope`/`medium`, so no verdict moved. `risk.unverified_large_diff` must
never describe a change as wide or spread out: roughly half its firings are
single-file, and a test pins that.

The `verification !== "passed"` gate is kept even though the independence result
invites dropping it (58 firings without it). The finding's claim is that a diff is
both too large to review by hand and unbacked by a check — the gate is that claim,
and the wording now states it.

**This is the fourth defect found by corpus measurement rather than by fixtures.**
Every fixture passed throughout, and would have passed at any threshold: a fixture
pins that the code does what its author meant, and here what the author meant was
a number that described the median run.

---

## 2026-08-26 — One OpenCode source, two backends, and a check that tests for data

**Decision.** `OpenCodeSource` reads `opencode.db` and prefers it, falling back
to the legacy `storage/` directory. It stays **one registered source with two
backends**, and `available()` now asks whether there is data rather than whether
there is a directory.

**Context.** OpenCode migrated its session store from a JSON object graph to
SQLite in February 2026 and left the old directory behind. `available()` was one
`statSync` on `storage/session`. That directory still existed, so the source
reported itself healthy, `discover()` returned the same 344 frozen files every
time, and `ingest` reported success for six months while 1,072 sessions
accumulated somewhere it never looked.

Nothing was broken in a way anything could see. That is the whole lesson: **a
presence check on a container is not a check that the container has anything in
it**, and "no new data" is indistinguishable from "I stopped being able to read
your data" unless something measures freshness. This is the same shape as the
2026-08-21 Node floor entry below — a check that tested for existence rather
than for truth.

**Why one source rather than two.** `makeRunId` keys on the source *name*, so a
second source also called `opencode` would mint identical run ids for the same
session and the two would fight over one row, while `isUnchanged`'s
`WHERE source_file = ?` lookup would match neither and silently report
"unchanged". Two backends behind one name has no such problem, and lets
`discover()` return the union: the database wins wherever both have a session,
and legacy-only sessions still come through for installs that never migrated.

**Why the backends share every mapping function.** The migration moved the data
without redesigning it — `message.data` and `part.data` hold the same JSON minus
the three identity fields that became columns. So the read layer is the only
thing that differs, and a shim puts `id`/`sessionID`/`messageID` back. Forking
the parser would have been quicker and would have let a detector change apply to
one backend and not the other; a test asserts both produce byte-identical `Run`s
instead.

**Ordering is by id, never by timestamp.** The migration collapsed
`part.time_created` *and* `message.time_updated` onto the migration instant for
every pre-existing row — 10,739 messages across 1,140 of 1,416 sessions on the
store this was found against. Only `message.time_created` survived. Id order was
validated against time order across all 41,347 messages and 25,573 parts with
zero inversions, which is also why the file importer already sorted that way.
The regression test builds a session whose parts all carry one identical
timestamp, in reverse insertion order, with a four-part assistant turn — the
multi-part turn is the point, because a fixture of one part per message has
nothing to misorder and will pass against a broken sort.

**Read-only, with no fallback.** The connection is opened `{ readOnly: true }`
with `query_only`. If a WAL database has no `-shm` index the open fails, and the
fix is *not* to retry read-write: writing into someone's agent data directory to
read their history is not a trade this tool makes. It reports what would help
instead.

**Consequences.**

- Re-ingesting is safe unflagged: session ids survived, `makeRunId` is
  deterministic, so existing runs update in place. Verified against a copy of a
  real store — 518 runs to 1,952, zero duplicates, zero lost.
- `ingest` gained a per-source freshness report and a 30-day silence warning.
  Generic on purpose; the next source to go quiet will go quiet differently.
- `Source` gained optional `notes()` and `close()`. A database-backed source
  holds an OS handle, and the registry hands out singletons to a long-lived
  `serve`.
- `OPENCODE_DB` overrides the database path, and `dbPath()` also consults
  `dirname(OPENCODE_STORAGE_DIR)` — not cosmetic: every existing OpenCode test
  sets that variable, and without the clause they would resolve the database
  from `$HOME` and start reading the developer's real session history.
- The next migration is already staged. `opencode.db` carries an empty
  `session_message` table with its indexes built; `hasPopulatedSessionMessage()`
  is the tripwire for the day OpenCode starts writing to it.

---

## 2026-08-21 — The Node floor is 22.13 (supersedes the 2026-08-17 entry)

**Decision.** `engines.node` is `>=22.13.0`. This reverses "The Node floor is 24,
not 22.5" below. Node 22 LTS is supported from 22.13.0 up.

**Context.** The earlier entry was right about the mechanism and wrong about the
boundary. `node:sqlite` did land in 22.5 behind `--experimental-sqlite`, and a
`bin` script still cannot set a flag for its own process. But the flag was
dropped in 23.4.0 (2024-12-10) and **backported to the 22 line in 22.13.0
(2025-01-06)** — nineteen months before that entry was written. This was not a
decision overtaken by a later release. It was wrong on the day it was made, and
the log should say which kind of wrong it is.

Measured rather than reasoned, this time. On 22.18.0 the module imports
unflagged, `new DatabaseSync(':memory:')` works, the full suite passes 275/275,
and `flightrec demo` + `flightrec list` run end to end. On 21.1.0 and 20.18.1 the
import throws `ERR_UNKNOWN_BUILTIN_MODULE`, so the failure the earlier entry
describes is real — it just starts one line lower than it claimed.

**Why it mattered enough to revisit.** `>=24.0.0` is not a harmless
over-declaration. npm emits `EBADENGINE`, which is a hard install failure under
pnpm or `engine-strict`, and 22 is the LTS most people are actually running. The
floor was turning away users to protect against a failure that does not occur on
the versions being turned away.

Nothing else in the tree needs a modern runtime: no `Object.groupBy`,
`Promise.withResolvers`, Set methods, `RegExp.escape`, iterator helpers or import
attributes; `tsconfig` targets ES2023; Biome needs ≥14 and TypeScript ≥16. The
floor is caused by exactly one import, `src/store.ts`.

**How the mistake was made, which is the reusable part.** The earlier entry says
the floor was found by "a CI matrix leg pinned to the declared floor" failing.
That leg was 22.5.x, where `node:sqlite` genuinely *is* flagged. The observation
was correct; the inference was too broad. The evidence supported "raise the floor
within 22.x" and was read as "leave the 22 line."

**Floor legs are pinned to an exact version. `X.x` is not a floor.** The matrix
ran `24.x`, which `setup-node` resolves to the newest 24 release — so the leg
that existed to keep `engines.node` honest was testing whatever shipped most
recently and had never once tested `>=24.0.0`. A floating spec cannot verify a
lower bound. The new leg is the literal `22.13.0`, and `release.yml` runs the
pre-publish `npm run check` on it too.

**Consequences.**

- `.nvmrc` pins 22.13.0. The policy is unchanged — the floor, not the latest —
  because `node:sqlite` API drift is still the largest external risk and it
  shows up on the oldest supported runtime first.
- The macOS leg moves to the floor, preserving its original intent: when it was
  written, `24.x` *was* the floor.
- `@types/node` moves to `^22.20.1`, per the rule below that the types track the
  floor. This matters more at 22.13 than it did at 24: with 24-era types, code
  using a Node 24-only API would typecheck cleanly and then fail at runtime on
  the floor. Verified against TypeScript 7.0.2 — `tsc --noEmit` is clean and all
  275 tests pass on both 22.13.0 and 26.1.0.
- The coverage job stays a single modern leg, but its stated reason is retired.
  Coverage thresholds landed in 22.8, which the floor now clears; it is one leg
  because three would prove nothing extra.
- Rejected again, unchanged from the earlier entry: re-exec'ing with
  `--experimental-sqlite` to support 22.5–22.12. It hides an experimental
  dependency behind a process spawn, and 22.13 is old enough that the versions
  it would buy are not worth it.

Recording the reversal rather than editing the earlier entry, per the run-tape
precedent below. The earlier entry was reasoned from a release note; this one is
measured against the runtimes themselves — 22.18.0 works, 21.1.0 and 20.18.1
throw. Measurement wins, same as last time.

---

## 2026-08-18 — Elapsed time is not evidence of waste

**Decision.** Duration does not decide a verdict. Analyzer 1.2.0 removed the
`duration ≥ 300s` arm from the cascade rule that assigns `wasteful`; repetition
and spend remain.

**Context.** The rule was evaluated before the rule that assigns `unchanged`, so
`unchanged` had a five-minute ceiling nobody had stated. Measured over the
509-run store: **0 of 54** no-diff runs longer than five minutes had ever
received it. Every run in the 5–15, 15–60 and 60+ minute buckets was `wasteful`,
without exception.

That collides with what the label is for. `README.md` describes `unchanged` as
"a question, a review, an investigation… deliberately not a criticism" — and a
review thorough enough to be worth having takes longer than five minutes. The
long half of the category was being called waste by construction.

**How it was found.** Not by the test suite, which was green, and not by
reasoning about the rules — by bucketing real verdicts against duration and
noticing a zero where there should have been a spread. The same method as the
2026-08-16 corpus entry below.

**The fixtures already disagreed with the rule.** `fixtureLongNoDiff` asks why a
job is slow, reads six files, and correctly identifies an unindexed sequential
scan — graded `wasteful` for taking nineteen minutes. Two tests asserted that
behaviour while their own comments argued against it: one said "`unchanged` is
for runs that were not trying to change anything", which described the fixture it
was failing. `fixtureQuestion` exists only because the long fixture could not
reach `unchanged`, and its comment said so.

**Also worth recording:** the *detector* was honest the whole time.
`risk.duration_no_diff` says "that is sometimes correct — investigation, code
reading, a question answered". Only the verdict rule overstated it. A detector
and a verdict rule reading the same field can disagree, and nothing checks that
they don't.

**Consequences.**

- 22 runs moved `wasteful` → `unchanged`; 31 long no-diff runs stayed `wasteful`
  because cost or repetition backed them. Runs under five minutes: unaffected.
  `wasteful` 24.4% → 20.0%, `unchanged` 42.8% → 47.2%.
- The `no-diff-brief` label rule is `no-diff-no-signal`; it no longer tests
  brevity, and a rule whose name outruns its condition is the defect being fixed.
- **A hole this opens, stated rather than discovered later:** unknown cost counts
  as 0, so a long no-diff run on an unpriced model with no repetition is now
  `unchanged` whatever it really cost. Tokens are recorded even when price is
  not, so a token-based signal is the way to close it. Choosing that over
  asserting waste from elapsed time is deliberate.
- `flightrec regrade` exists because of this change. A store cannot be regraded
  by `ingest` once its transcripts are purged, and at the time of this change 35
  of the 509 stored runs' source files still existed.

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

---

## 2026-08-17 — The Node floor is 24, not 22.5

**Decision.** `engines.node` is `>=24.0.0`. Node 22 LTS is not supported.

**Context.** The project documented `>=22.5` on the grounds that `node:sqlite`
landed in 22.5. It does exist there — behind `--experimental-sqlite`. The flag
was only dropped in 23.4. A `bin` script cannot add a flag to its own process,
so on any Node 22 the CLI fails at `new DatabaseSync(...)` with
`ERR_UNKNOWN_BUILTIN_MODULE`. The documented floor had therefore never worked.

This was found by a CI matrix leg pinned to the declared floor — the leg existed
specifically to check that the floor was real rather than aspirational, and on
its first run it wasn't.

**Alternatives rejected.** Keeping 22 and documenting the flag: a CLI that only
works when the user remembers an experimental flag is not a CLI. Re-exec'ing
with the flag set: hides an experimental dependency behind a process spawn, and
the failure mode when it goes wrong is worse than the honest error.

**Consequences.**

- 24 is the active LTS, so this is a supported line rather than a bleeding edge.
- `.nvmrc` pins **the floor**, not the latest. The largest external risk to this
  project is `node:sqlite` API drift, so development happens against the oldest
  supported runtime.
- CI runs the floor and the current release. Do not remove the floor leg; it is
  the only thing that keeps `engines` honest.

---

## 2026-08-17 — The demo fixtures are product code under `src/`

**Decision.** The synthetic builders live in `src/demo/`, not `test/`.

**Context.** `src/cli.ts` used to `await import("../test/fixtures.js")` to serve
`flightrec demo`. Test scaffolding was therefore a runtime dependency of the
shipped binary, which left two bad options at publish time: ship the whole test
tree in the tarball, or ship a `demo` command that throws
`ERR_MODULE_NOT_FOUND` for every npm user — and `demo` is the first command a
new user runs.

**Consequences.**

- `files` can be a clean `dist/src` allowlist with no test code in the package.
- The test suite imports the same builders from `src/demo/`, so what the demo
  shows and what the detectors are pinned against cannot drift apart.
- **Do not "tidy" these back under `test/`.** It looks like misplaced test code
  and it is not; moving it silently breaks the shipped demo, and the failure
  only appears in an installed package, never in the repo.
- `src/demo/index.ts` saves and restores `CLAUDE_CONFIG_DIR` /
  `OPENCODE_STORAGE_DIR` around seeding. Without that, running `demo` in-process
  leaves the environment pointing at throwaway fixture data and every later
  ingest silently reads the wrong tree.

---

## 2026-08-17 — Biome, with four rules deliberately disabled

**Decision.** One dev tool for lint, format and import order. Four recommended
rules are off because they fight idioms this codebase uses on purpose.

**Context.** `dependencies` is empty and stays empty, but the constraint that
matters is transitive *dev* sprawl. ESLint plus typescript-eslint plus an
import-order plugin plus Prettier plus eslint-config-prettier is five direct dev
dependencies and roughly a hundred transitive ones. Biome is one, with no
transitive JS dependencies, and covers all three jobs.

**The four rules, and why each is off.**

- `complexity/useLiteralKeys` — the codebase reads `process.env["X"]` and
  `json["field"]` throughout. Bracket access on an index signature is correct
  under `noUncheckedIndexedAccess`; this rule wanted 204 changes to dot access.
- `suspicious/noAssignInExpressions` — `while ((m = re.exec(s)) !== null)` and
  `??=` are the canonical forms. Rewriting them is strictly worse.
- `correctness/noVoidTypeReturn` — `return sendJson(res, …)` in `src/server.ts`
  is a deliberate early-return idiom that keeps the routing table flat.
- `suspicious/noControlCharactersInRegex` — `src/checkOutput.ts` strips ANSI
  escapes. The control characters are the entire point of the pattern.

**Consequences.** Re-enabling any of these produces a large diff that changes no
behaviour. `@biomejs/biome` is pinned to an exact version and Dependabot is told
to skip it, because a formatter bump reformats the codebase and fails
`npm run lint` until someone reruns `lint:fix`. Upgrade it deliberately, in its
own commit, and add the SHA to `.git-blame-ignore-revs`.

---

## 2026-08-17 — Published as `coding-agent-flight-recorder`, unscoped

**Decision.** The npm package and the GitHub repository are both
`coding-agent-flight-recorder`. The binary stays `flightrec`; the project is still
called Agent Flight Recorder in prose.

**Context.** `agent-flight-recorder` is registered on npm and cannot be used. Worth
recording precisely, because the first version of this entry got it wrong by calling
the holder "actively published": it is three versions pushed within one hour on
25 May 2026, deprecated the same day with *"Renamed to @j___avi/tokentrace"*, and
untouched since. npm does not release deprecated names, so it is unavailable
regardless — but that is a fair basis for a name-transfer request to npm support
later, which an actively maintained package would not have been.

`flightrec` is also taken as a package name, though not as a binary name.

**Why unscoped rather than a scope.** A scope was the first choice, then the npm
account turned out to be `siarhei.piatrenka`, which would have made the scope
`@siarhei.piatrenka/…` — valid but awkward, with a dot in it. Weighed against a
short unscoped name that matches the repository, the unscoped name won on the thing
that matters most for a CLI: what a stranger types.

**Consequences.**

- Package name, repository name and README title now agree, which removes the alias
  note a mismatch would have needed. The repository was renamed while still private,
  the only free moment to do it.
- `publishConfig.access` was dropped: it is meaningful only for scoped packages.
  `--access public` stays in `release.yml` as an explicit statement of intent.
- The first publish needs a broad npm token, because a granular token can be limited
  to a scope but not to a package that does not yet exist. It is tightened to the
  package immediately afterwards.
- The `flightrec` binary name is kept: npm does not reserve bin names, and a
  collision only affects someone who globally installs both packages.

---

## 2026-08-17 — The entry guard resolves `argv[1]`, and releases install the tarball

**Decision.** `src/cli.ts` resolves `process.argv[1]` through `realpathSync`
before comparing it to `import.meta.url`. Installing the packed tarball and
running the binary through its `bin` symlink is a release gate.

**Context.** The guard used to compare `import.meta.url` directly against
`pathToFileURL(process.argv[1])`. `import.meta.url` is always the real file;
`process.argv[1]` is whatever the caller typed. npm installs `bin` entries as
symlinks, so for any global or `npm link` install the two never matched, `main()`
never ran, and **the process exited 0 having printed nothing** — indistinguishable
from success, and it would have been every npm user's first experience of the
tool.

The project had never exercised that path. Every invocation in development,
in the npm scripts, and in the test suite ran `dist/src/cli.js` directly, where
`argv[1]` already is the real path.

**Consequences.**

- `test/cli.test.ts` invokes the CLI through a symlink it creates, so this cannot
  regress silently.
- Before publishing, `npm pack` then install the tarball into a scratch
  directory and run `./node_modules/.bin/flightrec demo` with a fresh `HOME`.
  Checking `npm pack --dry-run` output is not sufficient: it verifies the file
  list, not that the entry point runs.
- General form of the lesson: the packaged artifact is a different program from
  the repository, and only running it as a user would tests the difference.

---

## 2026-08-17 — `tsconfig` names its ambient types explicitly

**Decision.** `"types": ["node"]` is set rather than relying on automatic
`@types` inclusion.

**Context.** TypeScript 7 no longer pulls in every package under
`node_modules/@types` implicitly the way 5.x did. On upgrading, every reference
to `process`, `console` and each `node:*` import failed to resolve until the
dependency was named.

**Consequences.** The one ambient type surface this project uses is now
documented in the config, compilation does not scan unrelated `@types`
packages, and an `@types/*` package installed as a side effect of some other
tool cannot silently widen the global namespace. `@types/node` tracks the
`engines` floor — when the floor moves, move the types with it.

---

## 2026-08-17 — Secret-path detection excludes templates and directories

**Decision.** `classifyPath` no longer treats a committed env *template* or a
*directory* named `secrets/` as secret-bearing.

**Context.** Measured against a 484-run corpus, `risk.secret_file_write` was
wrong far more often than it was right: 36 of 41 path hits were false, and
because the finding is high severity it forces the verdict to `risky`. Seven
runs were graded `risky` on nothing else.

Two independent causes, both in the patterns:

- `/(^|\/)\.env(\.|$)/` matches `.env.example` exactly as readily as
  `.env.production`. `.env.example` was the single most-flagged path in the
  corpus — 17 hits — and is by convention a committed template of placeholders.
- `/(^|\/)(secrets?|credentials?)[./_-]/` included `/` in the character class,
  so a *directory* named `secrets/` matched. That reported
  `scripts/secrets/create-intake-secrets.sh` and
  `packages/shared/src/secrets/index.ts` as credential files. Code that manages
  secrets is not a secret.

**Consequences.** After the fix, on the same corpus: runs with a secret-file
finding fell from 15 to 3, and the only paths still flagged are two genuine
`.env` files. `risky` fell from 40 runs to 30, `productive` rose from 37 to 44.

This is the third defect found by corpus measurement and not by fixtures, after
`verify.unbacked_claim` and `loop.churn`. The pattern across all three is the
same: a detector that passes every fixture can still be mostly wrong, because
the fixture and the detector were written by the same person from the same
assumption. Precision is only observable against data nobody authored.

---

## 2026-08-17 — Evidence quotes the match, not the head of the message

**Decision.** `verify.unbacked_claim` excerpts the window around the matched
claim rather than the first 220 characters of the message.

**Context.** On the same corpus, 22 of 46 evidence excerpts (48%) showed a
message's opening — a plan heading, a summary preamble — while the claim that
triggered the finding sat further down and was not visible. Reading those
findings, they looked like false positives. They were not: every flagged message
genuinely contained a claim. The detection was right and the citation was
useless, which is indistinguishable from being wrong if you are the person
trying to check it.

**Consequences.** Excerpts now contain the matched claim in 46 of 46 cases, with
a leading `…` when text was trimmed. CONTRIBUTING already required evidence to
point at real event indices; the same standard applies to what the excerpt
actually shows. When adding a detector whose trigger is a text match, quote the
match.

---

## 2026-08-17 — Finding ids identify instances; `detectorOf` identifies detectors

**Decision.** Instance-scoped finding ids stay as they are. Aggregation goes
through `detectorOf()` in `src/model.ts` rather than a new stored field.

**Context.** Three detectors embed a hash in the id — `loop.churn.<sha(path)>`,
`loop.repeat_failure.<sha(cmd)>`, `loop.identical_call.<sig>` — so that a run
churning four files produces four findings rather than one lumped together. That
is right: each has its own evidence and its own suggested rule.

The cost only shows up at scale. On a real corpus `GROUP BY finding_id` returns
about 130 rows of mostly-singletons, and `stats()` had to fall back to grouping
by category and severity, which cannot answer "which detector fires most often
for me".

**Why a helper and not a column.** Every id is `<category>.<name>` with an
optional third segment, verified by enumerating all 16 emission sites — so the
detector is derivable and needs no migration, no change to the stored `Finding`
shape, and no risk of the two drifting apart. Adding a field would have meant
touching the published document shape days before first release for information
already present in it.

**Consequences.** `flightrec corpus` groups on `detectorOf`. If a future detector
uses a different id shape, it must still be `<category>.<name>[.<instance>]`.

---

## 2026-08-17 — Redaction covers tool input, and precise rules run first

**Decision.** Tool *input* is scrubbed as well as tool output, and the generic
credential-named-variable rule runs last.

**Context.** Both defects were found by pointing `flightrec corpus` at this
project's own demo data on the day the command was written. The audit reported a
surviving credential shape in synthetic fixtures that were supposed to be clean.

- **Tool input was never redacted.** `redact()` was applied to command output and
  tool result text only. When an agent writes a credential into a file, the
  credential is in the Edit call's `new_string` or the Write call's `content` —
  so the store kept it verbatim. That is exactly the case
  `risk.secret_file_write` exists to flag, which made it the worst place in the
  codebase to have the gap.
- **`Authorization: Bearer <token>` leaked its token.** The generic KEY=value
  rule ran first, matched the key `Authorization` with the *word* `Bearer` as a
  six-character value, and rewrote the line to `Authorization=[redacted]
  <token>`. The dedicated bearer rule could then never match, because the prefix
  it needed had been destroyed. The token survived in full.

**Consequences.**

- `redactDeep()` walks tool input and scrubs strings while preserving structure,
  because the analyzers and the dashboard read known keys out of that object.
- Pattern order is load-bearing: **specific before generic.** A new pattern goes
  above the catch-all, and auth scheme words (`Bearer`, `Basic`, `Digest`) are
  never treated as secret values.
- Redaction still does not hide the *finding*: a test asserts the secret-file
  write is reported even though the value is masked. A mitigation that concealed
  the evidence would defeat the tool.
- The store now audits itself. `flightrec corpus` reports masks applied and any
  surviving credential shape, reporting pattern labels only and never the value.

---

## 2026-08-17 — Synthesis, then specifics, then remedy, then evidence

**Decision.** Tab order is Postmortem · Findings · Firewall · Files · Commands ·
Timeline, and Postmortem is always the default.

**Context.** Findings was the fifth of six tabs and Firewall the sixth, so the
first four panels a reader met were evidence. Testing against a real corpus made
the consequence obvious: the two panels carrying the product's actual claim —
what is wrong, and what to do about it — were the two you had to go looking for.

The competitive position here is actionable insight. A transcript viewer already
shows you what happened; nothing else says whether the diff is trustworthy. An
interface that leads with a timeline is presenting itself as the former.

**Why not Findings first.** That was the first attempt, and it over-corrected on
two counts. The **lede** sits above the tab strip and already states the one loud
thing, so the first tab does not need to carry "what is wrong" — that is already
answered before any tab is read. And once the stop point moved to the top of the
Postmortem tab, the objection that the narrative buried the actionable content no
longer held: the Postmortem panel now opens with the headline and the stop point,
which is the whole picture in one read.

So the strip reads as a drill-down — synthesis, then the specific findings, then
the remedies, then the evidence — rather than as a ranking of importance. The
Postmortem tab carries no Risk flags section, so it does not duplicate the
Findings tab sitting next to it.

**On the evidence order.** Files · Commands · Timeline is increasing granularity:
the outcome, then the actions that produced it, then everything. Timeline was
briefly placed ahead of the other two, which was simply wrong — it is the longest
and least actionable panel in the product.

**Consequences.**

- Files and Commands are demoted, not dismissed — they are the citations behind
  the findings, and both mark the rows a finding actually named.
- Promoting Findings, even briefly, exposed how noisy repeated absolute paths
  were in its evidence text. The project root is now stated once and stripped
  from the rest — a fix worth keeping regardless of tab order.
- The default tab never varies by run. A default that moves depending on what a
  run contains makes the panel you land on unpredictable, which costs more than
  the occasional better-chosen starting point buys.
- `flightrec report` markdown keeps its own order — Goal, Risk flags, stop point,
  then the narrative. It is a standalone artifact with no tabs to drill into, so
  a reader scanning it in a pull request wants the problems at the top.

---

## 2026-08-17 — The run tape is open by default (supersedes the 2026-08-16 entry)

**Decision.** The tape renders expanded. This reverses "The run tape moved behind
a disclosure" from the dark-theme entry above.

**Context.** The original reasoning was that the tape answers "what shape was
this run" while the reader's first question is "do I need to care". That is sound
reasoning and it turned out to be wrong. Used against a real corpus, the tape is
the fastest way to see a run's shape and it was being missed entirely behind a
summary element that gave no hint of what it hid.

Recording the reversal rather than quietly editing the earlier entry, because a
decision log that only contains decisions that held is not a log — it is a
brochure. The earlier entry was reasoned; this one is measured, and measurement
wins.

---

## 2026-08-17 — Verification in the tail is not waste

**Decision.** The stop-point narrative distinguishes three tails, and states its
own confidence.

**Context.** `stopSection` said *"Nothing was changed on disk after that point, so
the tail was pure overhead"* whenever no edits followed — including when the tail
was nothing but tests. `checksAfter` was already computed, returned in the same
object, and printed one line above the sentence that contradicted it.

This is the third defect of exactly this shape, after `loop.churn` firing when
checks ran between edits and `verify.unbacked_claim` missing the phrasings the
agent used. The pattern: **a detector that treats "no diff" as "no value" is
wrong whenever the run was confirming work rather than doing it.** Worth naming,
because it will come up again.

**Consequences.**

- Three cases: edits followed (may be the useful ones), only checks followed
  (verification, not waste), nothing followed (genuinely overhead).
- The stop point now states a confidence, because there was none and its absence
  invited it to be read as more certain than a heuristic deserves. A
  verification-only tail lowers it explicitly.
- Timestamps in prose are formatted, and fixed to UTC rather than locale —
  `toLocaleString` would make stored markdown differ between machines, and
  determinism is the product.

---

## 2026-08-17 — A fifth verdict, because `questionable` was two things

**Decision.** `unchanged` joins the four existing labels, taking the no-diff-and-brief
branch of the cascade. It renders muted rather than as a fifth alarm colour.

**Context.** Rule 8 of `assignLabel` returned `questionable` for a run that
changed nothing in under five minutes with no repetition. Rule 7 returned the same
label for a run that changed files and never checked them. Those are opposite
situations: one did not try to modify the repository, the other modified it without
evidence.

Measured over a real 493-run corpus the effect was stark — `questionable` was **60%
of every run**, and roughly two thirds of those had changed nothing at all. A label
covering 60% of everything carries no information, which is exactly why someone
would have to ask what it means.

After the split: `questionable` 16%, `unchanged` 44%. `productive`, `wasteful` and
`risky` are unmoved, because no rule other than 8 changed.

**Why a new label rather than better prose.** The tool's headline question is
*should I trust this diff*. When there is no diff the question does not apply, and a
taxonomy that cannot say so will keep hedging. This was also the last moment the
change was free: labels become an API on first publish — the `--label` filter, the
API responses, and the `label` column in every user's store.

**Consequences.**

- `unchanged` is **visually quiet** — grey-blue, not green and not amber. It is 44%
  of runs and they need no attention; the previous problem was that 44% of runs
  shouted. A label that recedes is doing its job.
- **Rule 2 deliberately stays `questionable`.** A run whose writes went through the
  shell is *uncertain*, not unchanged. The project already went out of its way to
  keep "the diff is not visible" separate from "nothing changed"; sweeping it into
  `unchanged` would assert something the trace cannot support. A test pins this.
- `Analysis.labelRule` records which branch fired, so the UI can explain the verdict
  instead of only stating it. It lives in `analysis_json`, so no schema migration.
- `ANALYZER_VERSION` is now **read**, not just recorded. It was stored from the
  start and never used, so a store graded by an older analyzer kept its old labels
  silently. `flightrec list` and the dashboard now say so and name the counts. The
  store is an archive — telling someone to delete it is not an answer.

**Still open, measured but not decided.** Rule 3 sends a no-diff run over five
minutes to `wasteful` even with no repetition and under a dollar spent. On the same
corpus that is 21 of 90 such runs; the other 69 were driven by cost or repetition.
A ten-minute code review is not waste, and `risk.duration_no_diff`'s own text admits
as much — so the label and the finding disagree. Restricting `wasteful` to
repetition or real spend is defensible and would move those 21 runs. Left as a
decision rather than folded in silently.
