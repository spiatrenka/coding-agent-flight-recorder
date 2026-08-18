/**
 * Whole-run analysis: metrics, findings, verdict, stop point.
 *
 * Deterministic by construction. The same Run always produces the same Analysis,
 * which is what makes the detectors themselves testable and what makes a future
 * LLM narrator measurable against a fixed baseline.
 */

import {
  diffMayBeIncomplete,
  type Finding,
  filesTouched,
  isTrivialRun,
  type Label,
  linesAdded,
  linesRemoved,
  netDiffLines,
  type Run,
  SEVERITY_ORDER,
  type Severity,
  secondsBetween,
  toolCalls,
  totalTokens,
  unrecordedWrites,
} from "../model.js";
import { estimate } from "./cost.js";
import { allLoopFindings } from "./loops.js";
import { allRiskFindings } from "./risk.js";
import { allVerificationFindings, analyzeVerification, type Verification } from "./verify.js";

/**
 * Bumped when grading changes in a way that would relabel a stored run.
 *
 * 1.1.0 added the `unchanged` label, so a store graded by 1.0.0 still shows those
 * runs as `questionable`. `flightrec list` and the dashboard say so rather than
 * leaving a silent mix — the store is an archive, so deleting it is not an answer.
 *
 * 1.2.0 stopped treating elapsed time as evidence of waste, so long no-diff runs
 * that a 1.1.0 store graded `wasteful` are now `unchanged`. Since 1.2.0 `ingest`
 * regrades on an analyzer change instead of skipping unchanged files, so this is
 * the last version that needs `--force` to take effect.
 */
export const ANALYZER_VERSION = "1.2.0";

export interface StopPoint {
  eventIdx: number;
  ts: string | null;
  reason: string;
  trigger: string;
  findingId: string;
  eventsAfter: number;
  minutesAfter: number | null;
  editsAfter: number;
  checksAfter: number;
}

export interface Metrics {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  netDiffLines: number;
  toolCalls: number;
  commands: number;
  failedCommands: number;
  durationS: number | null;
  totalTokens: number;
  costUsd: number | null;
  costKnown: boolean;
  compactions: number;
  loopFindings: number;
  highFindings: number;
  /** commands that plausibly wrote files the trace cannot show */
  unrecordedWrites: number;
}

export interface Analysis {
  runId: string;
  label: Label;
  labelReason: string;
  /** Which branch of the cascade decided the label — the explanation, not decoration. */
  labelRule: LabelRule;
  findings: Finding[];
  verification: Verification;
  stopPoint: StopPoint | null;
  metrics: Metrics;
  maxSeverity: Severity;
  /** no tool calls, no diff, no commands, seconds long — noise, not a run */
  trivial: boolean;
  analyzerVersion: string;
}

const sev = (f: Finding): number => SEVERITY_ORDER[f.severity];

export function analyze(run: Run): Analysis {
  estimate(run.usage);
  const verification = analyzeVerification(run);

  const findings = [
    ...allLoopFindings(run),
    ...allVerificationFindings(run, verification),
    ...allRiskFindings(run, verification),
  ].sort(
    (a, b) => sev(b) - sev(a) || a.category.localeCompare(b.category) || a.id.localeCompare(b.id),
  );

  const { label, reason, rule } = assignLabel(run, verification, findings);
  const stopPoint = findStopPoint(run, findings);

  const metrics: Metrics = {
    filesChanged: filesTouched(run).length,
    linesAdded: linesAdded(run),
    linesRemoved: linesRemoved(run),
    netDiffLines: netDiffLines(run),
    toolCalls: toolCalls(run).length,
    commands: run.commands.length,
    failedCommands: run.commands.filter((c) => c.ok === false).length,
    durationS: run.durationS,
    totalTokens: totalTokens(run.usage),
    costUsd: run.usage.costUsd,
    costKnown: run.usage.costUsd !== null,
    compactions: run.compactions,
    loopFindings: findings.filter((f) => f.category === "loop").length,
    highFindings: findings.filter((f) => f.severity === "high").length,
    unrecordedWrites: unrecordedWrites(run).length,
  };

  const maxSeverity = findings.length
    ? findings.reduce((a, b) => (sev(b) > sev(a) ? b : a)).severity
    : "info";

  return {
    runId: run.runId,
    label,
    labelReason: reason,
    labelRule: rule,
    findings,
    verification,
    stopPoint,
    metrics,
    maxSeverity,
    trivial: isTrivialRun(run),
    analyzerVersion: ANALYZER_VERSION,
  };
}

/** Stable identifier for which branch of the cascade decided the label. */
export type LabelRule =
  | "risk-override"
  | "no-diff-opaque"
  | "no-diff-spent"
  | "changed-looping-unverified"
  | "changed-verified"
  | "changed-failing"
  | "changed-unverified"
  | "no-diff-no-signal"
  | "fallback";

/**
 * Assign one of five labels. Risk always wins: a run that touched credentials is
 * not 'productive' regardless of how good the diff was.
 *
 * `rule` names the branch that matched so the UI can say *why* rather than only
 * *what* — first match wins, so which branch fired is the whole explanation.
 */
function assignLabel(
  run: Run,
  v: Verification,
  findings: Finding[],
): { label: Label; reason: string; rule: LabelRule } {
  const risky = findings.filter(
    (f) =>
      ((f.category === "secrets" || f.category === "destructive") && sev(f) >= 2) ||
      (f.category === "scope" && sev(f) >= 3),
  );
  const worstRisk = risky[0];
  if (worstRisk) {
    return {
      label: "risky",
      rule: "risk-override",
      reason:
        `${worstRisk.title.toLowerCase()} — sensitive or destructive actions take precedence ` +
        `over output quality`,
    };
  }

  const changed = netDiffLines(run) > 0;
  const loops = findings.filter((f) => f.category === "loop" && sev(f) >= 2);
  const expensive = (run.usage.costUsd ?? 0) >= 1.0;
  const files = filesTouched(run).length;

  // An empty diff only means "nothing happened" when the trace could have seen
  // it happen. Work done through the shell — an extract, a heredoc, sed -i —
  // leaves no FileEdit, and calling that run wasteful is simply wrong.
  const opaque = diffMayBeIncomplete(run);
  if (!changed && opaque && !loops.length) {
    const n = unrecordedWrites(run).length;
    return {
      label: "questionable",
      rule: "no-diff-opaque",
      reason:
        `no edits recorded, but ${n} shell command(s) may have changed files — ` +
        `the diff is not visible in the transcript, so check the working tree`,
    };
  }

  // Duration is deliberately absent from this condition. A long run that changed
  // nothing is not evidence of waste — it is the shape of a code review, an
  // investigation, or a question that took real reading to answer. Measured over a
  // 509-run corpus, requiring elapsed time alone made `unchanged` unreachable above
  // five minutes (0 of 54 such runs got it) and accounted for 45% of every
  // `wasteful` verdict. What distinguishes spinning from investigating is
  // repetition or spend, and both are detected directly.
  if (!changed && (expensive || loops.length)) {
    const why: string[] = [];
    if (expensive) why.push(`~$${(run.usage.costUsd ?? 0).toFixed(2)}`);
    if (loops.length) why.push(`${loops.length} repetition finding(s)`);
    const caveat = opaque ? " (shell writes may not be reflected)" : "";
    return {
      label: "wasteful",
      rule: "no-diff-spent",
      reason: `no file changes after ${why.join(", ")}${caveat}`,
    };
  }

  if (changed && loops.length && v.status !== "passed") {
    return {
      label: "wasteful",
      rule: "changed-looping-unverified",
      reason:
        `${loops.length} repetition finding(s) and no passing verification — the diff exists ` +
        `but nothing shows it works`,
    };
  }

  if (changed && v.status === "passed") {
    return findings.some((f) => sev(f) >= 2)
      ? {
          label: "productive",
          rule: "changed-verified",
          reason: `${v.summary}, with ${findings.length} finding(s) worth a look`,
        }
      : {
          label: "productive",
          rule: "changed-verified",
          reason: `${files} file(s) changed and ${v.summary}`,
        };
  }

  if (changed && (v.status === "failed" || v.status === "mixed")) {
    return {
      label: "questionable",
      rule: "changed-failing",
      reason: "files changed but verification is still failing",
    };
  }
  if (changed && v.status === "not_run") {
    return {
      label: "questionable",
      rule: "changed-unverified",
      reason: "files changed, nothing run to confirm the change works",
    };
  }
  if (!changed && !loops.length) {
    // Not `questionable`. The repository is untouched and nothing suggests the run
    // was trying to change it — a question answered, a file read, a review. Calling
    // that "questionable" put it in the same bucket as an unverified diff, which is
    // the opposite situation, and made that label 60% of a real corpus.
    //
    // This branch used to also require the run to be brief, which quietly capped
    // `unchanged` at five minutes and sent every longer investigation to `wasteful`.
    // A thorough review takes longer than five minutes by definition.
    return {
      label: "unchanged",
      rule: "no-diff-no-signal",
      reason: "nothing was changed — a question, a review or an investigation, not a code change",
    };
  }
  return {
    label: "questionable",
    rule: "fallback",
    reason: "partial progress with unresolved signals",
  };
}

/** The earliest moment a stopping rule would have fired, plus what happened after. */
function findStopPoint(run: Run, findings: Finding[]): StopPoint | null {
  const candidates = findings.filter(
    (f) =>
      f.firstEventIdx !== null &&
      (f.category === "loop" || f.category === "destructive" || f.category === "secrets") &&
      sev(f) >= 2,
  );
  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => {
    const ai = a.firstEventIdx as number;
    const bi = b.firstEventIdx as number;
    if (bi !== ai) return bi < ai ? b : a;
    return sev(b) > sev(a) ? b : a;
  });

  const idx = best.firstEventIdx as number;
  const ev = run.events.find((e) => e.idx === idx) ?? null;
  const after = run.events.filter((e) => e.idx > idx);
  const editsAfter = run.fileEdits.filter((e) => e.eventIdx > idx && e.applied).length;
  const checksAfter = run.commands.filter(
    (c) => c.eventIdx > idx && ["test", "build", "lint"].includes(c.category),
  ).length;
  const secs = secondsBetween(ev?.ts ?? null, run.endedAt);

  // Don't recommend stopping if barely anything followed — that's noise.
  if (after.length < 5 && (secs ?? 0) < 120) return null;

  return {
    eventIdx: idx,
    ts: ev?.ts ?? null,
    reason: best.title,
    trigger: best.stopTrigger ?? best.title.toLowerCase(),
    findingId: best.id,
    eventsAfter: after.length,
    minutesAfter: secs === null ? null : Math.round((secs / 60) * 10) / 10,
    editsAfter,
    checksAfter,
  };
}

export type { Verification } from "./verify.js";
