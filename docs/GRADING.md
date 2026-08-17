# How a run is graded

Every rule that assigns one of the five verdicts, in the order they are evaluated.
**First match wins** — a rule only applies when every rule above it failed, which
is the part worth reading carefully.

No model is involved. The same run always produces the same verdict, which is
what makes these rules arguable in the first place.

---

## Before anything: the trivial filter

Trivial runs are not a sixth verdict. They are still graded and stored, but
`flightrec list` and the dashboard hide them unless you pass `--all`. A run is
trivial only if **all four** hold:

```
toolCalls    === 0
netDiffLines === 0
commands     === 0
durationS     < 60
```

That is the three-second session whose whole prompt was `.`.

---

## The cascade

Severity ranks `info 0 · low 1 · medium 2 · high 3`.

| # | Condition | Verdict |
|---|---|---|
| 1 | any finding in `secrets` or `destructive` at ≥ medium, **or** `scope` at ≥ high | **risky** |
| 2 | no diff **and** shell writes may have happened **and** no loop findings | **questionable** |
| 3 | no diff **and** (duration ≥ 300s **or** cost ≥ $1.00 **or** a loop finding ≥ medium) | **wasteful** |
| 4 | diff **and** a loop finding ≥ medium **and** verification ≠ `passed` | **wasteful** |
| 5 | diff **and** verification === `passed` | **productive** |
| 6 | diff **and** verification is `failed` or `mixed` | **questionable** |
| 7 | diff **and** verification === `not_run` | **questionable** |
| 8 | no diff **and** under 300s **and** no loop findings | **unchanged** |
| 9 | anything left over | **questionable** |

### What each verdict means

- **productive** — files changed and every test, build or lint that ran ended green.
- **unchanged** — the repository was not modified. For a question, a review or an
  investigation that is the expected outcome, not a problem.
- **questionable** — something changed, but nothing proves it works; or a check is
  still failing; or the diff is not visible because the writes went through the shell.
- **wasteful** — time, money or repeated attempts went in and the repository came
  out unchanged.
- **risky** — a sensitive or destructive action happened. Overrides every other
  verdict, however good the diff was.

### Why `unchanged` exists

It was added in analyzer 1.1.0. Before that, rule 8 returned `questionable`, so
"the repository is untouched" and "the change has no evidence behind it" shared one
label. Measured over a real 493-run corpus that made `questionable` 60% of every
run — and roughly two thirds of those had changed nothing at all. Splitting them
took `questionable` to 16%, where it means exactly one thing and is worth acting on.

The tool's headline question is *should I trust this diff*. When there is no diff,
the question does not apply, and saying so is more useful than hedging.

---

## Which findings can force `risky`

Rule 1 is the only gate that overrides everything, so exactly which findings reach
it matters more than any other detail here. Four do. Two that look like they should,
do not.

| Finding | Category | Severity | Forces risky? |
|---|---|---|---|
| `risk.secret_file_write` | secrets | high | yes |
| `risk.secret_file_read` | secrets | medium | yes |
| `risk.destructive_command` | destructive | worst of the matched commands | yes, unless all were `low` |
| `risk.destructive_attempt` | destructive | medium | yes — even though it was blocked |
| `risk.outside_project` | scope | high | yes |
| `risk.config_file_write` | scope | medium | **no** — scope needs high |
| `risk.blast_radius` | scope | medium | **no** — scope needs high |
| `risk.cost_no_diff` | efficiency | medium, high ≥ $8 | **no** — expensive is not dangerous |
| `verify.unbacked_claim` | verification | medium / high | **no** |

Two of these are worth arguing with:

- **A blocked destructive command still forces `risky`.** It shows what the agent
  was willing to do unsupervised, and nothing stopped it except your permission
  rule — but it does mean a run where your guardrails *worked* is graded like one
  where they were absent.
- **$10 spent with no diff does not force `risky`.** It lands on `wasteful` via
  rule 3. Risky means dangerous, not expensive.

---

## How `verification` is computed

Rules 4, 5, 6 and 7 all turn on this, and rule 5 — the only path to `productive` —
needs it to be exactly `passed`.

```
checks = commands whose category is test, build or lint
if checks is empty                    → not_run

// keep only the LAST outcome per normalized command, so a suite that
// failed and then passed is not counted as both
outcomes = last outcome of each distinct check command

if every outcome is true              → passed
else if any outcome is false          → failed  (when none are true)
                                      → mixed   (when some are true)
else                                  → unknown
```

**`passed` requires every distinct check command to have ended green.** One
`npm run lint` that failed early and was never re-run keeps a run out of
`productive` permanently, however many times the tests passed afterwards — it lands
on `mixed` and falls to rule 6.

Neither Claude Code nor OpenCode records exit codes reliably, so outcomes are read
from the runner's own output. Where no known format matches, the check is
inconclusive rather than passed.

---

## Thresholds

| Name | Value | Note |
|---|---|---|
| long run | 300s | five minutes |
| expensive | $1.00 | **unknown cost counts as 0**, so an unpriced model can never be "expensive" — deliberate |
| changed | > 0 net diff lines | from edit-tool calls only; shell writes are invisible |

Loop findings, any of which at ≥ medium triggers rules 3 and 4:

| Finding | Fires at | Severity |
|---|---|---|
| `loop.identical_call` | 3 identical calls | medium, high at ≥ 5 |
| `loop.repeat_failure` | same command fails 2× | medium, high at ≥ 3 or if it is a check |
| `loop.churn` | file edited 4× | `low` if a check ran between the edits (under 7 edits), else medium, high at 7+ |
| `loop.revert` | an edit undone | medium |
| `loop.stall_tail` | ≥ 8 events and ≥ 300s after the last edit | medium |

`loop.churn` dropping to `low` when a check ran between the edits is deliberate, and
`low` is below the bar that drags a run toward `wasteful`. Editing a file repeatedly
while checking your work is iteration, not churn.

---

## Known soft spots

Stated rather than hidden, because these are the rules most likely to be wrong for
you:

- **The 300s and $1.00 thresholds are round numbers** with no evidence behind them.
- **Duration alone is weak evidence of waste.** Rule 3 sends a five-minute run with
  no diff to `wasteful`, and a long code review is not waste. Measured on one real
  corpus, 21 of 90 such runs triggered on duration alone; the other 69 were driven
  by cost or repetition.
- **Rule 9 is a fallback.** If runs are landing there, the cascade has a gap.

If you disagree with a grade, `npm run corpus` reports what fired across a whole
store, and a
[wrong-verdict issue](https://github.com/spiatrenka/coding-agent-flight-recorder/issues/new?template=wrong_verdict.yml)
is the most useful kind of report this project receives — detector accuracy is the
one quality signal it cannot generate for itself.

---

## Where this comes from

`assignLabel` in `src/analyze/index.ts` · `analyzeVerification` in
`src/analyze/verify.ts` · `isTrivialRun` in `src/model.ts` · thresholds in
`src/analyze/loops.ts` and `src/analyze/risk.ts`.

If this page and the code disagree, the code is right and this page is a bug.
