/**
 * A summary of one run small enough to paste into a chat window, and safe
 * enough to paste without reading it first.
 *
 * This exists because the most valuable report this project can receive — "that
 * verdict is wrong" — is also the most awkward one to send. `flightrec report
 * --json` is the full record: prompts, file contents, absolute paths, commands.
 * Asking a colleague to redact that by hand before sending it is asking them not
 * to bother.
 *
 * **The safety mechanism is the allowlist, not the redactor.** `redact()` finds
 * credentials; it is explicitly documented as conservative, because
 * over-redaction destroys the evidence value of a stored record. It does not and
 * should not strip a goal, a branch name or a repository path — and those are
 * exactly what leaks an employer. So nothing here copies a free-text field.
 * Every value below is an enum, a number, a version string, or a detector name.
 * `redact()` runs over the rendered output as a second line of defence, where it
 * should always be a no-op; if it ever is not, the allowlist has a bug.
 *
 * What is deliberately left out, and why it is not obvious:
 *
 * - **Finding titles and details.** These look like safe summaries and are not.
 *   `loops.ts` builds titles like `` `<the actual shell command>` failed 3× ``,
 *   and stop-point triggers carry file basenames. This is the single most likely
 *   thing for a future edit to add back.
 * - **Full finding ids.** The third segment is a hash of a file path or a
 *   command. One-way, but a stable identifier for a private path does not belong
 *   in a paste. `detectorOf()` keeps the part that carries the meaning.
 * - **Tool names, unless recognised.** MCP tools are named
 *   `mcp__<server>__<tool>` and `<server>` is routinely an internal system name.
 * - **schemaDrift strings.** They interpolate raw transcript field names. The
 *   count is the useful part; the detail is one local command away.
 * - **Timestamps.** `startedAt`/`endedAt` are working-hours metadata and explain
 *   no verdict. `durationS` does.
 *
 * Cost *is* included: `costUsd >= 1.0` is a verdict branch, so omitting it would
 * make half the `wasteful` grades unexplainable to whoever reads the paste.
 *
 * Nothing here writes, and nothing here sends.
 */

import type { Analysis } from "./analyze/index.js";
import { detectorOf, type Label, type Severity } from "./model.js";
import { redact } from "./redact.js";
import type { Store, StoredRun } from "./store.js";

/** Tool names safe to report verbatim. Everything else is bucketed. */
const SAFE_TOOL_NAMES = new Set([
  "Bash",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Glob",
  "Grep",
  "Task",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "TodoWrite",
  "bash",
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "list",
  "patch",
  "task",
  "webfetch",
]);

function bucketTool(name: string | null | undefined): string {
  if (!name) return "other";
  if (SAFE_TOOL_NAMES.has(name)) return name;
  return name.startsWith("mcp__") ? "mcp" : "other";
}

export interface FeedbackDetector {
  detector: string;
  severity: Severity;
  category: string;
  count: number;
}

export interface Feedback {
  runId: string;
  source: string;
  label: Label;
  labelRule: string;
  maxSeverity: Severity;
  trivial: boolean;
  synthetic: boolean;
  goalIsKnown: boolean;
  detectors: FeedbackDetector[];
  verification: {
    status: string;
    checksRun: number;
    passed: number;
    failed: number;
    frameworks: string[];
  };
  stopPoint: {
    detector: string;
    eventsAfter: number;
    minutesAfter: number | null;
    editsAfter: number;
    checksAfter: number;
  } | null;
  metrics: Analysis["metrics"];
  tools: { name: string; count: number }[];
  commands: { category: string; count: number }[];
  schemaDriftCount: number;
  analyzerVersion: string;
  packageVersion: string;
  nodeVersion: string;
  platform: string;
}

/**
 * Build the summary for one run, or null when the id is unknown.
 *
 * Reads only the allowlisted fields. A `StoredRun` carries the whole trace; the
 * discipline is that this function never touches a free-text member of it.
 */
export function buildFeedback(
  store: Store,
  runId: string,
  packageVersion: string,
): Feedback | null {
  const stored: StoredRun | null = store.getRun(runId);
  if (!stored) return null;

  const a = stored.analysis;

  const byDetector = new Map<string, FeedbackDetector>();
  for (const f of a.findings) {
    const detector = detectorOf(f.id);
    const seen = byDetector.get(detector);
    if (seen) seen.count++;
    else
      byDetector.set(detector, { detector, severity: f.severity, category: f.category, count: 1 });
  }

  const tools = new Map<string, number>();
  for (const e of stored.trace.events) {
    if (e.kind !== "tool_call") continue;
    const name = bucketTool(e.toolName);
    tools.set(name, (tools.get(name) ?? 0) + 1);
  }

  const commands = new Map<string, number>();
  for (const c of stored.trace.commands) {
    commands.set(c.category, (commands.get(c.category) ?? 0) + 1);
  }

  const byCount = <T extends { count: number }>(x: T, y: T): number => y.count - x.count;

  return {
    runId: a.runId,
    source: stored.trace.source,
    label: a.label,
    labelRule: a.labelRule,
    maxSeverity: a.maxSeverity,
    trivial: a.trivial,
    synthetic: Boolean(stored.synthetic),
    goalIsKnown: stored.trace.goalIsKnown,
    detectors: [...byDetector.values()].sort(byCount),
    verification: {
      status: a.verification.status,
      checksRun: a.verification.checksRun,
      passed: a.verification.passed,
      failed: a.verification.failed,
      frameworks: [...a.verification.frameworks],
    },
    stopPoint: a.stopPoint
      ? {
          detector: detectorOf(a.stopPoint.findingId),
          eventsAfter: a.stopPoint.eventsAfter,
          minutesAfter: a.stopPoint.minutesAfter,
          editsAfter: a.stopPoint.editsAfter,
          checksAfter: a.stopPoint.checksAfter,
        }
      : null,
    metrics: a.metrics,
    tools: [...tools].map(([name, count]) => ({ name, count })).sort(byCount),
    commands: [...commands].map(([category, count]) => ({ category, count })).sort(byCount),
    schemaDriftCount: stored.trace.schemaDrift.length,
    analyzerVersion: a.analyzerVersion,
    packageVersion,
    nodeVersion: process.version,
    platform: process.platform,
  };
}

const pair = (label: string, value: string): string => `  ${label.padEnd(16)}${value}`;

/** Render the summary. Short on purpose — a summary that grows is a report. */
export function formatFeedback(f: Feedback): string {
  const m = f.metrics;
  const out: string[] = [];

  out.push(`FLIGHTREC FEEDBACK  ${f.runId}${f.synthetic ? "  (synthetic demo run)" : ""}`);
  out.push("");
  out.push(pair("verdict", `${f.label}   (rule: ${f.labelRule}, max severity: ${f.maxSeverity})`));
  out.push(
    pair(
      "verification",
      `${f.verification.status}   ${f.verification.checksRun} check(s), ${f.verification.passed} passed, ${f.verification.failed} failed`,
    ),
  );
  if (f.verification.frameworks.length) {
    out.push(pair("runners", f.verification.frameworks.join(", ")));
  }
  out.push("");

  out.push(
    pair(
      "shape",
      `${m.filesChanged} file(s), +${m.linesAdded}/-${m.linesRemoved}, ${m.toolCalls} tool call(s), ${m.commands} command(s)`,
    ),
  );
  const dur = m.durationS === null ? "unknown" : `${Math.round(m.durationS)}s`;
  const cost =
    m.costUsd === null ? "unknown" : `$${m.costUsd.toFixed(2)}${m.costKnown ? "" : " (estimated)"}`;
  out.push(pair("", `${dur}, ${cost}, ${m.totalTokens} token(s), ${m.compactions} compaction(s)`));
  if (m.failedCommands || m.unrecordedWrites) {
    out.push(
      pair("", `${m.failedCommands} failed command(s), ${m.unrecordedWrites} unrecorded write(s)`),
    );
  }
  if (!f.goalIsKnown) out.push(pair("", "the goal could not be identified in this transcript"));
  out.push("");

  if (f.detectors.length) {
    out.push("  findings that fired");
    for (const d of f.detectors) {
      out.push(
        `    ${d.detector.padEnd(24)} ${d.severity.padEnd(7)} ${d.category}${d.count > 1 ? `  ×${d.count}` : ""}`,
      );
    }
  } else {
    out.push("  findings that fired    (none)");
  }
  out.push("");

  if (f.stopPoint) {
    const mins =
      f.stopPoint.minutesAfter === null ? "?" : String(Math.round(f.stopPoint.minutesAfter));
    out.push(
      pair(
        "stop point",
        `${f.stopPoint.detector} — ${f.stopPoint.eventsAfter} event(s), ${mins} min, ${f.stopPoint.editsAfter} edit(s), ${f.stopPoint.checksAfter} check(s) after`,
      ),
    );
    out.push("");
  }

  if (f.tools.length) {
    out.push(pair("tools", f.tools.map((t) => `${t.name}×${t.count}`).join("  ")));
  }
  if (f.commands.length) {
    out.push(pair("commands", f.commands.map((c) => `${c.category}×${c.count}`).join("  ")));
  }
  if (f.schemaDriftCount) {
    out.push(pair("schema drift", `${f.schemaDriftCount} unrecognised entry type(s)`));
  }
  out.push("");

  out.push(
    pair(
      "versions",
      `flightrec ${f.packageVersion}, analyzer ${f.analyzerVersion}, node ${f.nodeVersion}, ${f.platform}, source ${f.source}`,
    ),
  );
  out.push("");
  out.push("  Nothing was sent anywhere. No prompts, paths, file contents or commands");
  out.push("  are in the text above. Paste it to whoever gave you this tool, and say");
  out.push("  what verdict you expected — that line is the whole point.");
  out.push(`  Full detail stays on this machine:  flightrec report ${f.runId}`);

  // Defence in depth. The allowlist above is the actual boundary, so this
  // should always be a no-op; if it ever changes the output, that is a bug here.
  return redact(out.join("\n"));
}
