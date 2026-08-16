/**
 * Normalized agent-run trace schema.
 *
 * This module is the contract between importers (Claude Code today; OpenCode/Codex
 * later) and everything downstream. Analyzers, the postmortem generator, the store
 * and the web UI read *only* these types. An importer's whole job is to fill them in.
 *
 * Design rule: every field a source may not provide is `null`-able and means
 * "unknown". Nothing here defaults to a fabricated zero.
 */

import { createHash } from "node:crypto";

import type { CheckOutcome } from "./checkOutput.js";

export type { CheckOutcome } from "./checkOutput.js";

export const SCHEMA_VERSION = "1.0";

/**
 * Deliberately small and source-agnostic. A source-specific entry that doesn't map
 * cleanly becomes "other" plus a schema-drift note, never a dropped event.
 */
export type EventKind =
  | "user_message"
  | "assistant_message"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "system"
  | "compaction"
  | "other";

export type Severity = "info" | "low" | "medium" | "high";
export type FindingCategory =
  | "loop"
  | "scope"
  | "secrets"
  | "destructive"
  | "verification"
  | "efficiency";
export type Label = "productive" | "questionable" | "wasteful" | "risky";
export type CommandCategory = "test" | "build" | "lint" | "vcs" | "pkg" | "shell";
export type EditOp = "create" | "edit" | "multi_edit" | "notebook" | "delete" | "unknown";

export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export interface TraceEvent {
  idx: number;
  ts: string | null; // ISO 8601
  kind: EventKind;
  text?: string | null; // truncated display text
  role?: string | null;
  toolName?: string | null;
  toolUseId?: string | null;
  toolInput?: Record<string, unknown>;
  /** tool_result only; null = unknown, not "fine" */
  ok?: boolean | null;
  error?: string | null;
  model?: string | null;
  rawType?: string | null;
}

export interface FileEdit {
  eventIdx: number;
  ts: string | null;
  path: string;
  op: EditOp;
  linesAdded: number | null;
  linesRemoved: number | null;
  toolUseId?: string | null;
  /** false when the call errored or was denied */
  applied: boolean;
  diffHunks: string[];
}

export interface Command {
  eventIdx: number;
  ts: string | null;
  command: string;
  category: CommandCategory;
  ok: boolean | null;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  interrupted: boolean;
  /** attempted but blocked by a permission rule or hook */
  denied: boolean;
  /**
   * The command plausibly wrote to the working tree. Diffs assembled from
   * edit-tool calls cannot see these changes, so this flag is what stops the
   * analyzers reading "no tool edits" as "no changes".
   */
  mutatesFiles: boolean;
  /**
   * Outcome parsed from a recognised test/build/lint output format. Present
   * only when a known framework summary was found — the sources this tool
   * reads do not record exit codes, so this is usually the only machine
   * evidence available about whether a check actually passed.
   */
  check?: CheckOutcome | null;
}

/** Stable key for "is this the same command again". */
export function normalizedCommand(c: Command): string {
  return c.command
    .split(/\s+/)
    .join(" ")
    .trim()
    .replace(/[;&|]+$/, "");
}

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  byModel: Record<string, ModelUsage>;
  /** null = unknown. Never 0-by-default. */
  costUsd: number | null;
  costIsEstimate: boolean;
  unpricedModels: string[];
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    byModel: {},
    costUsd: null,
    costIsEstimate: true,
    unpricedModels: [],
  };
}

export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

export interface Evidence {
  eventIdx: number;
  ts?: string | null;
  label: string;
  excerpt: string;
}

export interface SuggestedRule {
  kind: string;
  rule: string;
  implementation?: string;
  settingsJson?: { permissions?: Record<string, string[]> };
}

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  detail: string;
  evidence: Evidence[];
  suggestedRules: SuggestedRule[];
  firstEventIdx: number | null;
  /** what would have fired at firstEventIdx */
  stopTrigger?: string | null;
}

/**
 * One bounded unit of agent work: a goal, some tool calls, an outcome.
 *
 * Note this is NOT the same as one transcript file. A Claude Code session file is
 * appended to across resumes and can span days; runs are segmented out of it.
 */
export interface Run {
  runId: string;
  source: string; // claude_code | opencode | codex | ...
  sessionId: string;
  segment: number;
  projectPath: string | null;
  gitBranch: string | null;
  agentVersion: string | null;
  models: string[];
  startedAt: string | null;
  endedAt: string | null;
  durationS: number | null;
  goal: string | null;
  goalIsKnown: boolean;
  events: TraceEvent[];
  fileEdits: FileEdit[];
  commands: Command[];
  usage: Usage;
  compactions: number;
  sourceFile: string | null;
  schemaDrift: string[];
}

export function makeRunId(source: string, sessionId: string, segment: number): string {
  const h = createHash("sha1")
    .update(`${source}:${sessionId}:${segment}`)
    .digest("hex")
    .slice(0, 12);
  return `${source.slice(0, 2)}-${h}`;
}

// --- derived helpers ---------------------------------------------------------

export function filesTouched(run: Run): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of run.fileEdits) {
    if (e.applied && !seen.has(e.path)) {
      seen.add(e.path);
      out.push(e.path);
    }
  }
  return out;
}

export function linesAdded(run: Run): number {
  return run.fileEdits.reduce((n, e) => n + (e.applied ? (e.linesAdded ?? 0) : 0), 0);
}

export function linesRemoved(run: Run): number {
  return run.fileEdits.reduce((n, e) => n + (e.applied ? (e.linesRemoved ?? 0) : 0), 0);
}

export function netDiffLines(run: Run): number {
  return linesAdded(run) + linesRemoved(run);
}

export function toolCalls(run: Run): TraceEvent[] {
  return run.events.filter((e) => e.kind === "tool_call");
}

/**
 * Commands that ran (or may have run) and plausibly changed files the trace
 * cannot show. A denied command changed nothing, so it is excluded; a command
 * with an unknown outcome is included, because unknown is not "no".
 */
export function unrecordedWrites(run: Run): Command[] {
  return run.commands.filter((c) => c.mutatesFiles && !c.denied && c.ok !== false);
}

/**
 * True when the recorded diff is known to be incomplete. Callers must not read
 * `netDiffLines(run) === 0` as "the repository is unchanged" when this holds.
 */
export function diffMayBeIncomplete(run: Run): boolean {
  return unrecordedWrites(run).length > 0;
}

/**
 * A run with no tool calls, no diff and effectively no duration: a stray
 * keystroke, a cancelled prompt, a health-check ping. Real on disk, but noise
 * in a list whose job is to surface the runs worth reviewing.
 */
export function isTrivialRun(run: Run): boolean {
  return (
    toolCalls(run).length === 0 &&
    netDiffLines(run) === 0 &&
    run.commands.length === 0 &&
    (run.durationS ?? 0) < 60
  );
}

// --- small utilities ---------------------------------------------------------

export function truncate(s: unknown, n = 2000): string | null {
  if (s === null || s === undefined) return null;
  const str = String(s);
  return str.length <= n ? str : `${str.slice(0, n)}\n… [${str.length - n} more chars]`;
}

export function parseTs(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "number") {
    const ms = v > 1e11 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return String(v);
}

export function secondsBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return (db - da) / 1000;
}
