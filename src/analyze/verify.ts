/**
 * Did anything actually confirm the work?
 *
 * This is the part that separates a flight recorder from a transcript viewer. The
 * agent saying "all tests pass" is text. A `pytest` invocation exiting non-zero is
 * evidence. Where the two disagree, only one of them is in this module.
 */

import {
  type Command,
  type Evidence,
  type Finding,
  filesTouched,
  netDiffLines,
  normalizedCommand,
  type Run,
} from "../model.js";

const CHECK_CATEGORIES = new Set(["test", "build", "lint"]);

/**
 * Phrasings that assert the work is verified.
 *
 * Validated against a real Claude Code corpus: an earlier version matched only
 * "all tests pass"-style prose and missed every claim the agent actually made
 * — "41/41 tests pass", "66/66 passing", "typecheck clean", "builds clean",
 * "All 41 existing tests still pass". Since this detector is what catches an
 * agent overclaiming, a miss here is silence exactly when it matters.
 *
 * False positives are cheap: the finding only fires when verification did not
 * pass, so a true claim backed by a green run produces nothing.
 */
const CLAIM_RE = new RegExp(
  [
    // prose forms
    /all (the )?tests? (now )?pass/.source,
    /tests? are (now )?passing/.source,
    /tests? still pass/.source,
    /everything (now )?works/.source,
    /the build (now )?succeeds/.source,
    /verified (that )?it works/.source,
    /confirmed (it )?works/.source,
    /all green/.source,
    /should (now )?work correctly/.source,
    // numeric forms — "41/41 tests pass", "66/66 passing", "all 41 tests pass"
    /\d+\s*\/\s*\d+\s+(tests?\s+)?pass(es|ed|ing)?\b/.source,
    /\ball \d+ [^.\n]{0,24}?pass(es|ed|ing)?\b/.source,
    // "clean" forms — "typecheck clean", "builds clean", "lint is clean"
    /\b(typecheck|type-check|typechecks|build|builds|lint|compile)\s+(is\s+|are\s+)?clean\b/.source,
  ].join("|"),
  "i",
);

export type VerificationStatus = "passed" | "failed" | "mixed" | "not_run" | "unknown";

export interface CategoryTally {
  run: number;
  passed: number;
  failed: number;
  unknown: number;
}

export interface Verification {
  status: VerificationStatus;
  checksRun: number;
  passed: number;
  failed: number;
  unknown: number;
  lastCheck: Command | null;
  byCategory: Record<string, CategoryTally>;
  /** Individual assertions, summed from recognised runner output. */
  assertionsPassed: number | null;
  assertionsFailed: number | null;
  /** Which runners were recognised, e.g. ["node:test", "tsc"]. */
  frameworks: string[];
  summary: string;
}

function summarize(v: Omit<Verification, "summary">): string {
  if (v.status === "not_run") return "no tests, build or lint were run";
  const head = Object.entries(v.byCategory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, c]) => {
      const noun = `${cat} ${c.run === 1 ? "run" : "runs"}`;
      const base = `${c.passed} of ${c.run} ${noun} passed`;
      return c.unknown ? `${base} (${c.unknown} inconclusive)` : base;
    })
    .join(", ");
  // Where a runner printed real counts, they are far more informative than
  // "1 of 1 test run passed" — that phrasing counts invocations, not tests.
  if (v.assertionsPassed === null && v.assertionsFailed === null) return head;
  const parts: string[] = [];
  if (v.assertionsPassed !== null) parts.push(`${v.assertionsPassed} passed`);
  if (v.assertionsFailed) parts.push(`${v.assertionsFailed} failed`);
  return parts.length ? `${head} — ${parts.join(", ")} across the run` : head;
}

export function analyzeVerification(run: Run): Verification {
  const checks = run.commands.filter((c) => CHECK_CATEGORIES.has(c.category));

  const base: Omit<Verification, "summary"> = {
    status: "not_run",
    checksRun: checks.length,
    passed: 0,
    failed: 0,
    unknown: 0,
    lastCheck: checks.at(-1) ?? null,
    byCategory: {},
    assertionsPassed: null,
    assertionsFailed: null,
    frameworks: [],
  };

  if (checks.length === 0) return { ...base, summary: summarize(base) };

  // Roll up the runner-reported counts. Only the last invocation of a given
  // normalized command counts, so a suite that failed then passed is not
  // double-counted as both.
  const finalByCommand = new Map<string, Command>();
  for (const c of checks) finalByCommand.set(normalizedCommand(c), c);
  const frameworks = new Set<string>();
  for (const c of finalByCommand.values()) {
    if (!c.check) continue;
    frameworks.add(c.check.framework);
    if (c.check.passed !== null)
      base.assertionsPassed = (base.assertionsPassed ?? 0) + c.check.passed;
    if (c.check.failed !== null)
      base.assertionsFailed = (base.assertionsFailed ?? 0) + c.check.failed;
  }
  base.frameworks = [...frameworks].sort();

  for (const c of checks) {
    const b = (base.byCategory[c.category] ??= { run: 0, passed: 0, failed: 0, unknown: 0 });
    b.run++;
    if (c.ok === true) {
      base.passed++;
      b.passed++;
    } else if (c.ok === false) {
      base.failed++;
      b.failed++;
    } else {
      base.unknown++;
      b.unknown++;
    }
  }

  // Status is decided by the *final* state of each distinct check, not by totals:
  // a test that failed then passed is a fixed test, not a failure.
  const final = new Map<string, boolean | null>();
  for (const c of checks) final.set(normalizedCommand(c), c.ok);
  const outcomes = [...final.values()];

  if (outcomes.every((o) => o === true)) base.status = "passed";
  else if (outcomes.some((o) => o === false)) {
    base.status = outcomes.every((o) => o !== true) ? "failed" : "mixed";
  } else base.status = "unknown";

  return { ...base, summary: summarize(base) };
}

/**
 * Quote the window around the matched claim, not the head of the message.
 *
 * Measured against a real corpus, 22 of 46 excerpts were showing the first 220
 * characters of a long message while the claim itself sat further down — so
 * roughly half the citations did not contain the thing they were citing, and a
 * correct finding read as a false positive. Evidence that cannot be checked is
 * worth nothing regardless of whether the underlying detection was right.
 */
function claimExcerpt(text: string, width = 220): string {
  const m = CLAIM_RE.exec(text);
  if (!m) return text.slice(0, width);
  // Keep a little context before the claim so it reads as a sentence.
  const start = Math.max(0, m.index - 60);
  const body = text.slice(start, start + width);
  return (start > 0 ? "…" : "") + body;
}

/** The agent claimed success; check whether anything backs that up. */
export function unverifiedClaimFindings(run: Run, v: Verification): Finding[] {
  const claims = run.events.filter(
    (e) => e.kind === "assistant_message" && e.text && CLAIM_RE.test(e.text),
  );
  if (claims.length === 0 || v.status === "passed") return [];

  const notRun = v.status === "not_run";
  const detail = notRun
    ? "The run states that the work is verified, but no test, build or lint command was " +
      "executed anywhere in it. The claim has nothing behind it."
    : `The run claims success while the checks it ran ended in state '${v.status}'. The ` +
      `transcript and the exit codes disagree; the exit codes are the evidence.`;
  const severity = notRun ? (netDiffLines(run) > 0 ? "high" : "medium") : "high";

  return [
    {
      id: "verify.unbacked_claim",
      title: "Claimed success without passing verification",
      severity,
      category: "verification",
      detail,
      evidence: claims.slice(0, 4).map<Evidence>((e) => ({
        eventIdx: e.idx,
        ts: e.ts,
        label: "claim",
        excerpt: claimExcerpt(e.text ?? ""),
      })),
      firstEventIdx: claims[0]?.idx ?? null,
      suggestedRules: [
        {
          kind: "require_verification",
          rule: "Require a passing test command before the run is allowed to finish",
          implementation:
            "Stop hook that exits 2 when the run changed files but no test command exited zero, " +
            "forcing the agent to keep working",
        },
      ],
    },
  ];
}

export function noVerificationFindings(run: Run, v: Verification): Finding[] {
  if (v.status !== "not_run" || netDiffLines(run) === 0) return [];
  const files = filesTouched(run);
  return [
    {
      id: "verify.never_ran",
      title: `${files.length} file(s) changed, nothing was run to check them`,
      severity: "medium",
      category: "verification",
      detail:
        "The run modified the working tree without executing a single test, build or lint " +
        "command. The diff may be correct — but this run produced no evidence either way, so " +
        "reviewing it is entirely on you.",
      evidence: [{ eventIdx: 0, label: "changed files", excerpt: files.slice(0, 10).join(", ") }],
      firstEventIdx: null,
      suggestedRules: [
        {
          kind: "require_verification",
          rule: "Add the project's test command to CLAUDE.md and require it after edits",
          implementation:
            "Stop hook: if file edits occurred and no test ran, exit 2 with the command to run",
        },
      ],
    },
  ];
}

export function allVerificationFindings(run: Run, v: Verification): Finding[] {
  return [...unverifiedClaimFindings(run, v), ...noVerificationFindings(run, v)];
}
