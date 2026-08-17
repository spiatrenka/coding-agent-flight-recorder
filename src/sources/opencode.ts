/**
 * OpenCode session importer.
 *
 * OpenCode stores sessions as a small object graph under
 * `~/.local/share/opencode/storage`, rather than one append-only file per
 * session the way Claude Code does:
 *
 *   session/<projectID>/<sessionID>.json   metadata, incl. a diff summary
 *   message/<sessionID>/<messageID>.json   one file per message
 *   part/<messageID>/<partID>.json         text, reasoning, tool calls, patches
 *   project/<projectID>.json               worktree path and vcs
 *
 * Three things make this source materially better than the Claude Code one,
 * and the importer is written to exploit all three:
 *
 * 1. Assistant messages carry a `cost` the agent computed itself. Where that
 *    is non-zero we report it as fact and mark the usage non-estimated, rather
 *    than modelling dollars from a price table that can go stale.
 *
 * 2. The session record carries `summary.{files,additions,deletions}` — a
 *    repository-level diff independent of the tool stream. That is the closest
 *    thing in either source to ground truth about what actually changed.
 *
 * 3. Tool calls carry an explicit `state.status`, so denial and error are
 *    distinguishable without string-matching output.
 *
 * Ordering is by id, not by directory order: OpenCode's ids are monotonic
 * within a session, which is what keeps parts attached to the right message
 * when timestamps collide.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { parseCheckOutput } from "../checkOutput.js";
import { classifyCommand, mutatesWorkingTree } from "../commands.js";
import {
  type EditOp,
  emptyUsage,
  makeRunId,
  parseTs,
  type Run,
  secondsBetween,
  truncate,
} from "../model.js";
import { redact, redactDeep } from "../redact.js";
import type { DiscoveredFile, Source } from "./types.js";

const IDLE_GAP_SECONDS = Number(process.env["FLIGHTREC_IDLE_GAP"] ?? 1800);
const MIN_EVENTS_PER_RUN = 2;

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "multiedit"]);
const SHELL_TOOLS = new Set(["bash", "shell", "run_command"]);

/** Part types we map. Anything else is recorded as drift, never dropped. */
const KNOWN_PART_TYPES = new Set([
  "text",
  "reasoning",
  "tool",
  "patch",
  "compaction",
  "step-start",
  "step-finish",
  "file",
  "agent",
  "subtask",
  "snapshot",
]);

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function storageDir(): string {
  const override = process.env["OPENCODE_STORAGE_DIR"];
  if (override) return override;
  const base = process.env["OPENCODE_DATA_DIR"] || join(homedir(), ".local", "share", "opencode");
  return join(base, "storage");
}

function readJson(path: string): Json | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(v) ? v : null;
  } catch {
    return null; // unreadable or half-written: skip, never fail the scan
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** `{ created, updated }` in epoch milliseconds. */
function timeOf(o: Json, key: string): string | null {
  const t = o["time"];
  if (!isRecord(t)) return null;
  return parseTs(t[key]);
}

export class OpenCodeSource implements Source {
  readonly name = "opencode";

  available(): boolean {
    try {
      return statSync(join(storageDir(), "session")).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * One "file" per session. The path is the session record; everything else is
   * resolved from the session id at load time.
   */
  discover(): DiscoveredFile[] {
    const root = join(storageDir(), "session");
    const out: DiscoveredFile[] = [];
    let projects: string[];
    try {
      projects = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(root, e.name));
    } catch {
      return [];
    }

    for (const dir of projects) {
      for (const path of listFiles(dir)) {
        try {
          const st = statSync(path);
          if (st.size === 0) continue;
          out.push({
            path,
            sessionId: basename(path, ".json"),
            // A session's own files change as it grows, but the session record
            // is rewritten on every update, so its mtime tracks the whole
            // session — which is what the ingest cache needs.
            mtime: st.mtimeMs / 1000,
            size: st.size,
          });
        } catch {
          /* skip */
        }
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  load(path: string): Run[] {
    const session = readJson(path);
    if (!session) return [];
    const sessionId = str(session["id"]) ?? basename(path, ".json");

    const messages = listFiles(join(storageDir(), "message", sessionId))
      .map(readJson)
      .filter((m): m is Json => m !== null)
      .sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));

    if (messages.length === 0) return [];

    return this.segment(messages)
      .map((seg, i) => this.buildRun(session, seg, path, i))
      .filter((r): r is Run => r !== null && r.events.length >= MIN_EVENTS_PER_RUN);
  }

  /** Same rule as the Claude Code importer: wall-clock silence ends a run. */
  private segment(messages: Json[]): Json[][] {
    const segments: Json[][] = [];
    let cur: Json[] = [];
    let prevTs: string | null = null;
    for (const m of messages) {
      const ts = timeOf(m, "created");
      const gap = secondsBetween(prevTs, ts);
      if (gap !== null && gap > IDLE_GAP_SECONDS && cur.length) {
        segments.push(cur);
        cur = [];
      }
      cur.push(m);
      if (ts) prevTs = ts;
    }
    if (cur.length) segments.push(cur);
    return segments;
  }

  private buildRun(session: Json, seg: Json[], path: string, segmentIdx: number): Run | null {
    const sessionId = str(session["id"]) ?? basename(path, ".json");
    const run: Run = {
      runId: makeRunId(this.name, sessionId, segmentIdx),
      source: this.name,
      sessionId,
      segment: segmentIdx,
      projectPath: str(session["directory"]),
      gitBranch: null,
      agentVersion: str(session["version"]),
      models: [],
      startedAt: null,
      endedAt: null,
      durationS: null,
      goal: null,
      goalIsKnown: false,
      events: [],
      fileEdits: [],
      commands: [],
      usage: emptyUsage(),
      compactions: 0,
      sourceFile: path,
      schemaDrift: [],
    };

    const drift = new Set<string>();
    let idx = 0;
    /** OpenCode reports cost per assistant message; sum only if non-zero. */
    let reportedCost = 0;
    let sawCost = false;

    for (const msg of seg) {
      const role = str(msg["role"]) ?? "unknown";
      const messageId = str(msg["id"]);
      const ts = timeOf(msg, "created");
      const model = str(msg["modelID"]);
      if (model && !run.models.includes(model)) run.models.push(model);

      const cwd = isRecord(msg["path"]) ? str((msg["path"] as Json)["cwd"]) : null;
      if (cwd) run.projectPath = run.projectPath ?? cwd;

      if (role === "assistant") {
        this.accumulateTokens(run, msg["tokens"], model);
        const c = num(msg["cost"]);
        if (c > 0) {
          reportedCost += c;
          sawCost = true;
        }
      }

      const parts = messageId
        ? listFiles(join(storageDir(), "part", messageId))
            .map(readJson)
            .filter((p): p is Json => p !== null)
            .sort((a, b) => String(a["id"]).localeCompare(String(b["id"])))
        : [];

      for (const part of parts) {
        const ptype = str(part["type"]) ?? "unknown";
        if (!KNOWN_PART_TYPES.has(ptype)) {
          drift.add(`unrecognised part type '${ptype}'`);
        }
        idx = this.handlePart(run, part, ptype, role, model, ts, idx);
      }
    }

    if (run.events.length === 0) return null;

    run.schemaDrift = [...drift].sort();
    const stamps = run.events.map((e) => e.ts).filter((t): t is string => Boolean(t));
    run.startedAt = stamps[0] ?? timeOf(session, "created");
    run.endedAt = stamps.at(-1) ?? timeOf(session, "updated");
    run.durationS = secondsBetween(run.startedAt, run.endedAt);

    // Cost: prefer what the agent says it was charged over anything we model.
    if (sawCost) {
      run.usage.costUsd = Math.round(reportedCost * 10_000) / 10_000;
      run.usage.costIsEstimate = false;
    }

    // Goal: the session title is a curated summary and beats the raw prompt,
    // but only the prompt proves a human actually asked for something here.
    const firstPrompt = run.events.find((e) => e.kind === "user_message" && e.text?.trim());
    const title = str(session["title"]);
    if (firstPrompt?.text) {
      const t = firstPrompt.text.replace(/\s+/g, " ").trim();
      run.goal = t.length > 400 ? `${t.slice(0, 400)}…` : t;
      run.goalIsKnown = true;
    } else if (title && segmentIdx === 0) {
      run.goal = title;
      run.goalIsKnown = true;
    }

    this.applySessionSummary(run, session, segmentIdx);
    return run;
  }

  /**
   * The session record carries a repo-level diff summary. It covers the whole
   * session rather than one segment, so it is only trusted for a single-segment
   * session — and only to *fill in* a diff the tool stream failed to capture,
   * never to overwrite one it did.
   */
  private applySessionSummary(run: Run, session: Json, segmentIdx: number): void {
    if (segmentIdx !== 0) return;
    const s = session["summary"];
    if (!isRecord(s)) return;
    const files = num(s["files"]);
    const added = num(s["additions"]);
    const removed = num(s["deletions"]);
    if (files === 0 && added === 0 && removed === 0) return;
    if (run.fileEdits.some((e) => e.applied)) return;

    // No edit-tool events but the session reports a diff: the work happened
    // through the shell. Record it as a single synthetic edit so downstream
    // "nothing changed" logic sees the truth.
    run.fileEdits.push({
      eventIdx: 0,
      ts: run.startedAt,
      path: `(${files} file(s) reported by session summary)`,
      op: "unknown",
      linesAdded: added,
      linesRemoved: removed,
      toolUseId: null,
      applied: true,
      diffHunks: [],
    });
  }

  private handlePart(
    run: Run,
    part: Json,
    ptype: string,
    role: string,
    model: string | null,
    ts: string | null,
    idx: number,
  ): number {
    const partTs = timeOf(part, "start") ?? ts;

    if (ptype === "text") {
      const text = str(part["text"]);
      if (!text?.trim()) return idx;
      run.events.push({
        idx: idx++,
        ts: partTs,
        kind: role === "user" ? "user_message" : "assistant_message",
        role,
        text: truncate(text, 4000),
        model,
        rawType: "text",
      });
      return idx;
    }

    if (ptype === "reasoning") {
      run.events.push({
        idx: idx++,
        ts: partTs,
        kind: "thinking",
        role: "assistant",
        text: truncate(part["text"], 2000),
        model,
        rawType: "reasoning",
      });
      return idx;
    }

    if (ptype === "compaction") {
      run.compactions++;
      run.events.push({
        idx: idx++,
        ts: partTs,
        kind: "compaction",
        rawType: "compaction",
        text: part["auto"] ? "context compacted automatically" : "context compacted",
      });
      return idx;
    }

    if (ptype === "tool") return this.handleTool(run, part, model, partTs, idx);

    // patch / file / agent / subtask / step-*: no analytic value on their own.
    // Recorded only so the event indices in findings stay meaningful.
    if (ptype === "step-start" || ptype === "step-finish") return idx;
    return idx;
  }

  private handleTool(
    run: Run,
    part: Json,
    model: string | null,
    ts: string | null,
    idx: number,
  ): number {
    const tool = str(part["tool"]) ?? "unknown";
    const state = isRecord(part["state"]) ? part["state"] : {};
    const status = str(state["status"]) ?? "unknown";
    const input = isRecord(state["input"]) ? state["input"] : {};
    const callId = str(part["callID"]);

    const errText = str(state["error"]);
    const denied = errText !== null && looksDenied(errText);
    const ok = status === "completed" ? true : status === "error" ? false : null;

    const callIdx = idx;
    run.events.push({
      idx: idx++,
      ts,
      kind: "tool_call",
      role: "assistant",
      toolName: tool,
      toolUseId: callId,
      toolInput: redactDeep(input),
      model,
      rawType: "tool",
    });

    const output = str(state["output"]);
    run.events.push({
      idx: idx++,
      ts,
      kind: "tool_result",
      role: "user",
      toolName: tool,
      toolUseId: callId,
      ok: denied ? false : ok,
      error: errText ? truncate(errText, 1500) : null,
      text: truncate(redact(output ?? errText ?? ""), 3000),
      rawType: "tool",
    });
    const resultIdx = idx - 1;

    if (EDIT_TOOLS.has(tool)) {
      this.recordEdit(run, tool, input, state, resultIdx, ts, ok === true, callId);
    } else if (SHELL_TOOLS.has(tool)) {
      this.recordCommand(run, input, output, errText, resultIdx, ts, ok, denied);
    }
    void callIdx;
    return idx;
  }

  private recordEdit(
    run: Run,
    tool: string,
    input: Json,
    state: Json,
    eventIdx: number,
    ts: string | null,
    applied: boolean,
    callId: string | null,
  ): void {
    const path = str(input["filePath"]) ?? str(input["path"]) ?? "unknown";
    const meta = isRecord(state["metadata"]) ? state["metadata"] : {};

    let op: EditOp = "edit";
    if (tool === "write") op = meta["exists"] === false ? "create" : "edit";
    else if (tool === "apply_patch" || tool === "patch") op = "multi_edit";

    let added = 0;
    let removed = 0;
    if (tool === "write") {
      added = countLines(String(input["content"] ?? ""));
    } else {
      added = countLines(String(input["newString"] ?? input["new_string"] ?? ""));
      removed = countLines(String(input["oldString"] ?? input["old_string"] ?? ""));
    }

    run.fileEdits.push({
      eventIdx,
      ts,
      path,
      op,
      linesAdded: added,
      linesRemoved: removed,
      toolUseId: callId,
      applied,
      diffHunks: buildHunks(input),
    });
  }

  private recordCommand(
    run: Run,
    input: Json,
    output: string | null,
    errText: string | null,
    eventIdx: number,
    ts: string | null,
    ok: boolean | null,
    denied: boolean,
  ): void {
    const cmd = String(input["command"] ?? "").trim();
    if (!cmd) return;

    const body = output ?? errText ?? "";
    // OpenCode reports a tool status but no exit code, so a "completed" bash
    // call still needs its output read before the check can be called passing.
    const check = parseCheckOutput(body);
    let resolved: boolean | null = ok;
    if (denied) resolved = false;
    else if (check) resolved = check.ok;
    else if (ok === true) resolved = inferOkFromOutput(body);

    run.commands.push({
      eventIdx,
      ts,
      command: cmd,
      category: classifyCommand(cmd),
      // OpenCode does not record an exit code; success comes from tool status,
      // refined by the output. Unknown stays unknown.
      ok: resolved,
      exitCode: null,
      check,
      stdoutTail: truncate(redact(body), 1200),
      stderrTail: errText ? truncate(redact(errText), 800) : null,
      interrupted: false,
      denied,
      mutatesFiles: mutatesWorkingTree(cmd),
    });
  }

  private accumulateTokens(run: Run, t: unknown, model: string | null): void {
    if (!isRecord(t)) return;
    const cache = isRecord(t["cache"]) ? t["cache"] : {};
    const i = num(t["input"]);
    const o = num(t["output"]) + num(t["reasoning"]);
    const cr = num(cache["read"]);
    const cc = num(cache["write"]);

    run.usage.inputTokens += i;
    run.usage.outputTokens += o;
    run.usage.cacheReadTokens += cr;
    run.usage.cacheCreationTokens += cc;

    const key = model ?? "unknown";
    const m = (run.usage.byModel[key] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    m.input += i;
    m.output += o;
    m.cacheRead += cr;
    m.cacheCreation += cc;
  }
}

// --- helpers -----------------------------------------------------------------

function countLines(s: string): number {
  if (s === "") return 0;
  return s.replace(/\n$/, "").split("\n").length;
}

/** Synthesise a unified-diff-ish preview so the revert detector has material. */
function buildHunks(input: Json): string[] {
  const oldStr = String(input["oldString"] ?? input["old_string"] ?? "");
  const newStr = String(input["newString"] ?? input["new_string"] ?? "");
  if (!oldStr && !newStr) return [];
  const out: string[] = [];
  for (const l of oldStr ? oldStr.split("\n") : []) {
    out.push(`-${l}`);
    if (out.length >= 60) return out.map(redact);
  }
  for (const l of newStr ? newStr.split("\n") : []) {
    out.push(`+${l}`);
    if (out.length >= 60) return out.map(redact);
  }
  return out.map(redact);
}

/**
 * OpenCode's permission system reports refusals through the tool error string.
 * Blocked is not the same as failed — a run where the agent tried something the
 * rules stopped is signal about its disposition, not about the code.
 */
function looksDenied(err: string): boolean {
  const e = err.toLowerCase();
  return [
    "specified a rule which prevents",
    "permission denied by",
    "rejected by the user",
    "user rejected",
    "not allowed to",
    "requires approval",
    "blocked by",
  ].some((s) => e.includes(s));
}

/** Conservative: only downgrade a "completed" command on an unambiguous signal. */
function inferOkFromOutput(out: string): boolean | null {
  const blob = out.toLowerCase();
  if (!blob.trim()) return true;
  const fail = [
    "traceback (most recent call last)",
    "test failed",
    "tests failed",
    "npm err!",
    "assertionerror",
    "fatal:",
    "command not found",
    "compilation failed",
    "build failed",
    "failures:",
  ];
  return !fail.some((m) => blob.includes(m));
}
