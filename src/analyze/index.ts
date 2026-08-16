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

export const ANALYZER_VERSION = "1.0.0";

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

  const { label, reason } = assignLabel(run, verification, findings);
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
    findings,
    verification,
    stopPoint,
    metrics,
    maxSeverity,
    trivial: isTrivialRun(run),
    analyzerVersion: ANALYZER_VERSION,
  };
}

/**
 * Assign one of four labels. Risk always wins: a run that touched credentials is
 * not 'productive' regardless of how good the diff was.
 */
function assignLabel(
  run: Run,
  v: Verification,
  findings: Finding[],
): { label: Label; reason: string } {
  const risky = findings.filter(
    (f) =>
      ((f.category === "secrets" || f.category === "destructive") && sev(f) >= 2) ||
      (f.category === "scope" && sev(f) >= 3),
  );
  const worstRisk = risky[0];
  if (worstRisk) {
    return {
      label: "risky",
      reason:
        `${worstRisk.title.toLowerCase()} — sensitive or destructive actions take precedence ` +
        `over output quality`,
    };
  }

  const changed = netDiffLines(run) > 0;
  const loops = findings.filter((f) => f.category === "loop" && sev(f) >= 2);
  const longRun = (run.durationS ?? 0) >= 300;
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
      reason:
        `no edits recorded, but ${n} shell command(s) may have changed files — ` +
        `the diff is not visible in the transcript, so check the working tree`,
    };
  }

  if (!changed && (longRun || expensive || loops.length)) {
    const why: string[] = [];
    if (longRun) why.push(`${Math.floor((run.durationS ?? 0) / 60)} minutes`);
    if (expensive) why.push(`~$${(run.usage.costUsd ?? 0).toFixed(2)}`);
    if (loops.length) why.push(`${loops.length} repetition finding(s)`);
    const caveat = opaque ? " (shell writes may not be reflected)" : "";
    return { label: "wasteful", reason: `no file changes after ${why.join(", ")}${caveat}` };
  }

  if (changed && loops.length && v.status !== "passed") {
    return {
      label: "wasteful",
      reason:
        `${loops.length} repetition finding(s) and no passing verification — the diff exists ` +
        `but nothing shows it works`,
    };
  }

  if (changed && v.status === "passed") {
    return findings.some((f) => sev(f) >= 2)
      ? {
          label: "productive",
          reason: `${v.summary}, with ${findings.length} finding(s) worth a look`,
        }
      : { label: "productive", reason: `${files} file(s) changed and ${v.summary}` };
  }

  if (changed && (v.status === "failed" || v.status === "mixed")) {
    return { label: "questionable", reason: "files changed but verification is still failing" };
  }
  if (changed && v.status === "not_run") {
    return {
      label: "questionable",
      reason: "files changed, nothing run to confirm the change works",
    };
  }
  if (!changed && !longRun && !loops.length) {
    return {
      label: "questionable",
      reason: "no file changes — investigation or a question answered, not a code change",
    };
  }
  return { label: "questionable", reason: "partial progress with unresolved signals" };
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
