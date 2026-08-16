/**
 * Detectors for the shapes that mean "the agent is stuck".
 *
 * Nothing in a transcript says "I am looping". Stuckness only exists at the level
 * of the whole run: the same call issued again, the same test failing again, a file
 * edited back to what it was. Each detector below returns Findings carrying real
 * event indices so the UI can jump to the evidence.
 */

import { createHash } from "node:crypto";

import {
  type Command,
  type Evidence,
  type FileEdit,
  type Finding,
  normalizedCommand,
  type Run,
  secondsBetween,
  type TraceEvent,
} from "../model.js";

/** brief: "repeated identical tool call 3+ times" */
export const IDENTICAL_CALL_THRESHOLD = 3;
/** brief: "failed the same command/test multiple times" */
export const SAME_FAILURE_THRESHOLD = 2;
export const FILE_CHURN_THRESHOLD = 4;
const STALL_SECONDS = 300;
const STALL_MIN_EVENTS = 8;
/** Commands that constitute feedback — the same set verify.ts grades on. */
const CHECK_CATEGORIES = new Set(["test", "build", "lint"]);

const sha = (s: string, n = 16): string => createHash("sha1").update(s).digest("hex").slice(0, n);

/** Stable stringify: key order must not affect whether two calls count as identical. */
function canonical(obj: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  try {
    return JSON.stringify(walk(obj)) ?? String(obj);
  } catch {
    return String(obj);
  }
}

function signature(tool: string, input: unknown): string {
  return sha(`${tool}|${canonical(input)}`);
}

function short(s: string | null | undefined, n = 160): string {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = m.get(k);
    if (arr) arr.push(item);
    else m.set(k, [item]);
  }
  return m;
}

export function detectIdenticalCalls(run: Run): Finding[] {
  // Read-only exploration repeats are normal and not interesting.
  const skip = new Set(["TodoWrite", "Glob"]);
  const calls = run.events.filter((e) => e.kind === "tool_call" && !skip.has(e.toolName ?? ""));
  const groups = groupBy(calls, (e) => signature(e.toolName ?? "", e.toolInput ?? {}));

  const findings: Finding[] = [];
  for (const [sig, evs] of groups) {
    if (evs.length < IDENTICAL_CALL_THRESHOLD) continue;
    const tool = evs[0]?.toolName ?? "tool";
    const arg = short(canonical(evs[0]?.toolInput).slice(0, 300));
    findings.push({
      id: `loop.identical_call.${sig}`,
      title: `${tool} called ${evs.length}× with identical arguments`,
      severity: evs.length >= 5 ? "high" : "medium",
      category: "loop",
      detail:
        `The same ${tool} call was issued ${evs.length} times with byte-identical arguments. ` +
        `Repeating an identical call cannot produce new information unless the world changed ` +
        `in between, so this is either a retry loop or the agent losing track of what it already did.`,
      evidence: evs.slice(0, 6).map<Evidence>((e, i) => ({
        eventIdx: e.idx,
        ts: e.ts,
        label: `call #${i + 1}`,
        excerpt: arg,
      })),
      firstEventIdx: evs[IDENTICAL_CALL_THRESHOLD - 1]?.idx ?? null,
      stopTrigger: `the ${IDENTICAL_CALL_THRESHOLD}rd identical ${tool} call`,
      suggestedRules: [
        {
          kind: "loop_budget",
          rule: `Stop the run after ${IDENTICAL_CALL_THRESHOLD} identical ${tool} calls`,
          implementation:
            "PreToolUse hook keeping a per-session hash count of (tool, input) and returning " +
            "permissionDecision=deny past the budget",
        },
      ],
    });
  }
  return findings;
}

export function detectRepeatedFailures(run: Run): Finding[] {
  const failed = run.commands.filter((c) => c.ok === false);
  const groups = groupBy(failed, normalizedCommand);

  const findings: Finding[] = [];
  for (const [cmd, cs] of groups) {
    if (cs.length < SAME_FAILURE_THRESHOLD) continue;
    const first = cs[0] as Command;
    const isCheck =
      first.category === "test" || first.category === "build" || first.category === "lint";
    findings.push({
      id: `loop.repeat_failure.${sha(cmd, 12)}`,
      title: `\`${short(cmd, 70)}\` failed ${cs.length}×`,
      severity: cs.length >= 3 || isCheck ? "high" : "medium",
      category: "loop",
      detail:
        `The same ${first.category} command failed ${cs.length} times across the run. ` +
        `Repeated identical failure is the clearest available signal that the agent's model of ` +
        `the problem is wrong and more attempts won't fix it.`,
      evidence: cs.slice(0, 5).map<Evidence>((c, i) => ({
        eventIdx: c.eventIdx,
        ts: c.ts,
        label: `failure #${i + 1}`,
        excerpt: short(c.stderrTail ?? c.stdoutTail, 240),
      })),
      firstEventIdx: cs[SAME_FAILURE_THRESHOLD - 1]?.eventIdx ?? null,
      stopTrigger: `the 2nd failure of \`${short(cmd, 50)}\``,
      suggestedRules: [
        {
          kind: "failure_budget",
          rule: `Escalate to a human after 2 identical failures of \`${short(cmd, 60)}\``,
          implementation:
            "PostToolUse hook counting non-zero exits per normalized command; on the 2nd, inject " +
            "additionalContext telling the agent to stop and report rather than retry",
        },
      ],
    });
  }
  return findings;
}

export function detectFileChurn(run: Run): Finding[] {
  const applied = run.fileEdits.filter((e) => e.applied);
  const groups = groupBy(applied, (e) => e.path);

  const findings: Finding[] = [];
  for (const [path, edits] of groups) {
    if (edits.length < FILE_CHURN_THRESHOLD) continue;
    const base = path.split("/").pop() ?? path;

    // Churn only means "guessing" if nothing was checked in between. Measured
    // against a real corpus, 6 of 11 churn findings had tests or a typecheck
    // running between the edits — that is iteration, and calling it a
    // never-verified hypothesis was simply wrong. Still reported, because a
    // heavily rewritten file is worth a look, but not at the same severity.
    const first = Math.min(...edits.map((e) => e.eventIdx));
    const last = Math.max(...edits.map((e) => e.eventIdx));
    const checksBetween = run.commands.filter(
      (c) => CHECK_CATEGORIES.has(c.category) && c.eventIdx > first && c.eventIdx < last,
    ).length;
    const verified = checksBetween > 0;

    findings.push({
      id: `loop.churn.${sha(path, 12)}`,
      title: verified
        ? `${base} rewritten ${edits.length}× (checked in between)`
        : `${base} rewritten ${edits.length}×`,
      severity: verified
        ? edits.length < 7
          ? "low"
          : "medium"
        : edits.length < 7
          ? "medium"
          : "high",
      category: "loop",
      detail: verified
        ? `\`${path}\` was edited ${edits.length} times in one run, with ` +
          `${checksBetween} test/build/lint run(s) in between. That is iteration against ` +
          `feedback rather than guesswork, so it is reported for visibility only — a heavily ` +
          `rewritten file is still worth reading before you accept the diff.`
        : `\`${path}\` was edited ${edits.length} times in one run and nothing was run to ` +
          `check it in between. High churn with no feedback usually means the agent is guessing ` +
          `at a fix rather than diagnosing it — each edit is a hypothesis it never verified.`,
      evidence: edits.slice(0, 8).map<Evidence>((e, i) => ({
        eventIdx: e.eventIdx,
        ts: e.ts,
        label: `edit #${i + 1} (${e.op})`,
        excerpt: `+${e.linesAdded ?? 0}/-${e.linesRemoved ?? 0} lines`,
      })),
      firstEventIdx: edits[FILE_CHURN_THRESHOLD - 1]?.eventIdx ?? null,
      stopTrigger: `the ${FILE_CHURN_THRESHOLD}th edit to ${base}`,
      suggestedRules: [
        {
          kind: "churn_budget",
          rule: `Flag when one file is edited more than ${FILE_CHURN_THRESHOLD} times per run`,
          implementation: "PreToolUse hook on Edit|Write counting edits per file_path",
        },
      ],
    });
  }
  return findings;
}

/** An edit that undoes a previous edit to the same file: A→B then B→A. */
export function detectReverts(run: Run): Finding[] {
  const seen = new Map<string, number>();
  const reverts: Array<{ from: number; to: number; path: string }> = [];

  for (const e of run.fileEdits) {
    if (!e.applied || e.diffHunks.length === 0) continue;
    const before = e.diffHunks
      .filter((l) => l.startsWith("-"))
      .map((l) => l.slice(1))
      .join("\n");
    const after = e.diffHunks
      .filter((l) => l.startsWith("+"))
      .map((l) => l.slice(1))
      .join("\n");
    if (!before && !after) continue;

    const key = `${e.path}|${sha(before, 12)}|${sha(after, 12)}`;
    const inverse = `${e.path}|${sha(after, 12)}|${sha(before, 12)}`;
    const prior = seen.get(inverse);
    if (prior !== undefined) reverts.push({ from: prior, to: e.eventIdx, path: e.path });
    seen.set(key, e.eventIdx);
  }

  if (reverts.length === 0) return [];
  const paths = [...new Set(reverts.map((r) => r.path))].sort();
  return [
    {
      id: "loop.revert",
      title: `${reverts.length} edit(s) undone later in the same run`,
      severity: "medium",
      category: "loop",
      detail:
        "An edit was later reversed back to its previous content in the same run. The work " +
        "between those two points produced no net change to the file and is the clearest form " +
        "of wasted effort a diff can show.",
      evidence: reverts.slice(0, 6).map<Evidence>((r) => ({
        eventIdx: r.to,
        label: `reverts edit at event ${r.from}`,
        excerpt: r.path,
      })),
      firstEventIdx: Math.min(...reverts.map((r) => r.to)),
      stopTrigger: "an edit being undone",
      suggestedRules: [
        {
          kind: "review",
          rule: `Review agent edits to ${paths.slice(0, 3).join(", ")} before accepting`,
          implementation: "No automated rule — this one wants a human diff review",
        },
      ],
    },
  ];
}

/** A long tail of activity after the last file change produced nothing. */
export function detectStall(run: Run): Finding[] {
  const applied = run.fileEdits.filter((e) => e.applied);
  if (applied.length === 0) return [];

  const lastEdit = applied.reduce<FileEdit>(
    (a, b) => (b.eventIdx > a.eventIdx ? b : a),
    applied[0] as FileEdit,
  );
  const tail = run.events.filter((e) => e.idx > lastEdit.eventIdx);
  if (tail.length < STALL_MIN_EVENTS) return [];

  const elapsed = secondsBetween(lastEdit.ts, run.endedAt);
  if (elapsed === null || elapsed < STALL_SECONDS) return [];

  const mins = Math.floor(elapsed / 60);
  return [
    {
      id: "loop.stall_tail",
      title: `${mins} min of activity after the last file change`,
      severity: "medium",
      category: "efficiency",
      detail:
        `The run continued for ${mins} minutes and ${tail.length} events after the final edit, ` +
        `without changing anything else. Unless that tail was verification work, it is time and ` +
        `tokens spent on nothing.`,
      evidence: [
        {
          eventIdx: lastEdit.eventIdx,
          ts: lastEdit.ts,
          label: "last file change",
          excerpt: lastEdit.path,
        },
      ],
      firstEventIdx: lastEdit.eventIdx,
      stopTrigger: "the last file change, after which nothing else changed",
      suggestedRules: [
        {
          kind: "time_budget",
          rule: "Alert when >5 minutes pass with no file change and no test run",
          implementation:
            "Stop hook checking elapsed-since-last-edit before allowing the agent to continue",
        },
      ],
    },
  ];
}

export function allLoopFindings(run: Run): Finding[] {
  return [
    ...detectIdenticalCalls(run),
    ...detectRepeatedFailures(run),
    ...detectFileChurn(run),
    ...detectReverts(run),
    ...detectStall(run),
  ];
}

/** exported for tests */
export type { TraceEvent };
