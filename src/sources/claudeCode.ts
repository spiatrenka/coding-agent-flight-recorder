/**
 * Claude Code transcript importer.
 *
 * Reads ~/.claude/projects/(**)/*.jsonl (honouring CLAUDE_CONFIG_DIR) and produces
 * normalized Runs.
 *
 * Two things dominate the design of this file:
 *
 * 1. Anthropic documents the transcript entry format as *internal and subject to
 *    change between releases*. So: no schema validation, no required fields, no
 *    exceptions on unknown shapes. Anything unrecognised is recorded as schema
 *    drift and surfaced in the UI rather than dropped silently or fatal.
 *
 * 2. A transcript file is not a run. Resuming appends to the same file for days,
 *    and `/clear` starts a fresh conversation inside it. We segment into runs on
 *    idle gaps and on `/clear`. Compaction is marked inline, not split on — it
 *    happens mid-task and splitting there would cut a single logical run in half.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { parseCheckOutput } from "../checkOutput.js";
import { classifyCommand, mutatesWorkingTree } from "../commands.js";
import {
  type Command,
  type EditOp,
  emptyUsage,
  type FileEdit,
  makeRunId,
  parseTs,
  type Run,
  secondsBetween,
  type TraceEvent,
  truncate,
  type Usage,
} from "../model.js";
import { redact, redactDeep } from "../redact.js";
import type { DiscoveredFile, Source } from "./types.js";

export { classifyCommand } from "../commands.js";

/** Wall-clock silence that ends a run. Half an hour away means new work. */
const IDLE_GAP_SECONDS = Number(process.env["FLIGHTREC_IDLE_GAP"] ?? 1800);
const MIN_EVENTS_PER_RUN = 2;

const EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Update",
  "str_replace",
  "create_file",
  "str_replace_based_edit_tool",
  "ApplyPatch",
]);
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "bash_tool", "Shell", "run_command"]);

/**
 * Entry types we recognise. Anything outside this set is recorded as schema
 * drift and costs the run some confidence, so the set has to keep up with the
 * agent: an unknown-type warning that fires on every run carries no signal and
 * quietly downgrades every postmortem.
 *
 * The second group is metadata the agent writes but that carries no analytic
 * value — known and deliberately unmapped, not drift.
 */
const KNOWN_LINE_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "summary",
  "result",
  "progress",
  "attachment",
  "file-history-snapshot",
  "queued-command",
  "compact-boundary",
  "x-hook",
  // observed on Claude Code 2.1.x — UI and session bookkeeping
  "last-prompt",
  "queue-operation",
  "permission-mode",
  "mode",
  "ai-title",
  "bridge-session",
]);

/** Text markers Claude Code injects into user turns that aren't really user speech. */
const META_PREFIXES = [
  "<command-name>",
  "<local-command-stdout>",
  "<command-message>",
  "Caveat: The messages below",
  "<system-reminder>",
  "<bash-input>",
  "<user-prompt-submit-hook>",
];

type Json = Record<string, unknown>;

export function configDir(): string {
  return process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
}
export function projectsDir(): string {
  return join(configDir(), "projects");
}

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function blocks(content: unknown): Json[] {
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => b["text"] as string)
    .join("\n");
}

function isMetaText(t: string): boolean {
  const s = t.trimStart();
  return META_PREFIXES.some((p) => s.startsWith(p));
}

/** structuredPatch is a list of hunks: { oldStart, oldLines, newStart, newLines, lines[] } */
function countPatchLines(
  patch: unknown,
): { added: number; removed: number; preview: string[] } | null {
  if (!Array.isArray(patch) || patch.length === 0) return null;
  let added = 0;
  let removed = 0;
  const preview: string[] = [];
  for (const hunk of patch) {
    if (!isRecord(hunk)) continue;
    const lines = Array.isArray(hunk["lines"]) ? hunk["lines"] : [];
    for (const raw of lines) {
      const line = String(raw);
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
      if (preview.length < 60) preview.push(line);
    }
  }
  return { added, removed, preview };
}

/** Matches Python's splitlines(): a single trailing newline does not add a line. */
function countLines(s: string): number {
  if (s === "") return 0;
  return s.replace(/\n$/, "").split("\n").length;
}

function countStringDiff(oldStr: unknown, newStr: unknown): { added: number; removed: number } {
  return {
    added: countLines(typeof newStr === "string" ? newStr : ""),
    removed: countLines(typeof oldStr === "string" ? oldStr : ""),
  };
}

// --- the importer ------------------------------------------------------------

export class ClaudeCodeSource implements Source {
  readonly name = "claude_code";

  available(): boolean {
    try {
      return statSync(projectsDir()).isDirectory();
    } catch {
      return false;
    }
  }

  discover(): DiscoveredFile[] {
    const root = projectsDir();
    const out: DiscoveredFile[] = [];
    // Recursive: some builds nest transcripts under a `sessions/` subdirectory,
    // and long project paths get truncated+hashed directory names.
    const walk = (dir: string, depth = 0): void => {
      if (depth > 6) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith(".jsonl")) {
          try {
            const st = statSync(p);
            if (st.size > 0) {
              out.push({
                path: p,
                sessionId: basename(e.name, ".jsonl"),
                mtime: st.mtimeMs / 1000,
                size: st.size,
              });
            }
          } catch {
            /* unreadable file: skip, never fail the scan */
          }
        }
      }
    };
    walk(root);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  load(path: string): Run[] {
    const lines = this.readLines(path);
    if (lines.length === 0) return [];
    return this.segment(lines)
      .map((seg, i) => this.buildRun(seg, path, i))
      .filter((r): r is Run => r !== null && r.events.length >= MIN_EVENTS_PER_RUN);
  }

  private readLines(path: string): Json[] {
    const raw = readFileSync(path, "utf8");
    const out: Json[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj: unknown = JSON.parse(t);
        if (isRecord(obj)) out.push(obj);
      } catch {
        // partially-written tail line; skip, never fail
      }
    }
    return out;
  }

  /** Split a transcript into runs on idle gaps and /clear. */
  private segment(lines: Json[]): Json[][] {
    const segments: Json[][] = [];
    let cur: Json[] = [];
    let prevTs: string | null = null;
    for (const obj of lines) {
      const ts = parseTs(obj["timestamp"]);
      const gap = secondsBetween(prevTs, ts);
      const boundary = (gap !== null && gap > IDLE_GAP_SECONDS) || isClear(obj);
      if (boundary && cur.length) {
        segments.push(cur);
        cur = [];
      }
      cur.push(obj);
      if (ts) prevTs = ts;
    }
    if (cur.length) segments.push(cur);
    return segments;
  }

  private buildRun(seg: Json[], path: string, segmentIdx: number): Run | null {
    const sessionId = seg.map((o) => str(o["sessionId"])).find(Boolean) ?? basename(path, ".jsonl");

    const run: Run = {
      runId: makeRunId(this.name, sessionId, segmentIdx),
      source: this.name,
      sessionId,
      segment: segmentIdx,
      projectPath: null,
      gitBranch: null,
      agentVersion: null,
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

    const pending = new Map<string, TraceEvent>();
    const drift = new Set<string>();
    let idx = 0;

    for (const obj of seg) {
      const rtype = String(obj["type"] ?? "");
      const ts = parseTs(obj["timestamp"]);
      run.projectPath = str(obj["cwd"]) ?? run.projectPath;
      run.gitBranch = str(obj["gitBranch"]) ?? run.gitBranch;
      run.agentVersion = str(obj["version"]) ?? run.agentVersion;

      if (!KNOWN_LINE_TYPES.has(rtype)) {
        const v = str(obj["version"]);
        drift.add(`unrecognised entry type '${rtype}'${v ? ` (agent v${v})` : ""}`);
      }

      if (rtype === "assistant") {
        idx = this.handleAssistant(obj, run, ts, idx, pending);
      } else if (rtype === "user") {
        idx = this.handleUser(obj, run, ts, idx, pending);
      } else if (rtype === "system" || rtype === "summary" || rtype === "compact-boundary") {
        const compaction = looksLikeCompaction(obj, rtype);
        if (compaction) run.compactions++;
        run.events.push({
          idx: idx++,
          ts,
          kind: compaction ? "compaction" : "system",
          rawType: rtype,
          text: truncate(
            textOf((obj["message"] as Json | undefined)?.["content"]) ||
              obj["summary"] ||
              obj["content"],
            600,
          ),
        });
      } else if (!KNOWN_LINE_TYPES.has(rtype)) {
        run.events.push({
          idx: idx++,
          ts,
          kind: "other",
          rawType: rtype,
          text: truncate(JSON.stringify(obj).slice(0, 400), 400),
        });
      }
      // progress / attachment / snapshot: no analytic value yet
    }

    if (run.events.length === 0) return null;

    run.schemaDrift = [...drift].sort();
    const stamps = run.events.map((e) => e.ts).filter((t): t is string => Boolean(t));
    run.startedAt = stamps[0] ?? null;
    run.endedAt = stamps.at(-1) ?? null;
    run.durationS = secondsBetween(run.startedAt, run.endedAt);

    const firstPrompt = run.events.find((e) => e.kind === "user_message" && e.text?.trim());
    if (firstPrompt?.text) {
      const t = firstPrompt.text.replace(/\s+/g, " ").trim();
      run.goal = t.length > 400 ? `${t.slice(0, 400)}…` : t;
      run.goalIsKnown = true;
    }
    return run;
  }

  private handleAssistant(
    obj: Json,
    run: Run,
    ts: string | null,
    idx: number,
    pending: Map<string, TraceEvent>,
  ): number {
    const msg = isRecord(obj["message"]) ? obj["message"] : {};
    const model = str(msg["model"]);
    if (model && !run.models.includes(model)) run.models.push(model);
    accumulateUsage(run.usage, msg["usage"], model);

    for (const b of blocks(msg["content"])) {
      const btype = b["type"];
      if (btype === "text" && String(b["text"] ?? "").trim()) {
        run.events.push({
          idx: idx++,
          ts,
          kind: "assistant_message",
          role: "assistant",
          text: truncate(b["text"], 4000),
          model,
          rawType: "assistant",
        });
      } else if (btype === "thinking") {
        run.events.push({
          idx: idx++,
          ts,
          kind: "thinking",
          role: "assistant",
          text: truncate(b["thinking"] ?? b["text"], 2000),
          model,
          rawType: "assistant",
        });
      } else if (btype === "tool_use") {
        const ev: TraceEvent = {
          idx: idx++,
          ts,
          kind: "tool_call",
          role: "assistant",
          toolName: str(b["name"]) ?? "unknown",
          toolUseId: str(b["id"]),
          toolInput: redactDeep(isRecord(b["input"]) ? b["input"] : {}),
          model,
          rawType: "assistant",
        };
        run.events.push(ev);
        if (ev.toolUseId) pending.set(ev.toolUseId, ev);
      }
    }
    return idx;
  }

  private handleUser(
    obj: Json,
    run: Run,
    ts: string | null,
    idx: number,
    pending: Map<string, TraceEvent>,
  ): number {
    const msg = isRecord(obj["message"]) ? obj["message"] : {};
    const content = msg["content"];
    const toolResults = blocks(content).filter((b) => b["type"] === "tool_result");

    if (toolResults.length) {
      for (const b of toolResults) idx = this.handleToolResult(obj, b, run, ts, idx, pending);
      return idx;
    }

    const text = typeof content === "string" ? content : textOf(content);
    if (!text.trim()) return idx;
    const meta = Boolean(obj["isMeta"]) || isMetaText(text);
    run.events.push({
      idx: idx++,
      ts,
      kind: meta ? "system" : "user_message",
      role: "user",
      text: truncate(text, 4000),
      rawType: "user",
    });
    return idx;
  }

  private handleToolResult(
    obj: Json,
    block: Json,
    run: Run,
    ts: string | null,
    idx: number,
    pending: Map<string, TraceEvent>,
  ): number {
    const tuid = str(block["tool_use_id"]);
    const call = tuid ? pending.get(tuid) : undefined;
    const toolName = call?.toolName ?? "unknown";
    const isError = Boolean(block["is_error"]);
    const result = obj["toolUseResult"];

    const body = resultText(block, result);
    const denied = looksDenied(body);
    const resultIdx = idx;

    run.events.push({
      idx: idx++,
      ts,
      kind: "tool_result",
      role: "user",
      toolName,
      toolUseId: tuid,
      ok: denied ? false : !isError,
      error: isError || denied ? truncate(body, 1500) : null,
      text: truncate(redact(body), 3000),
      rawType: "user",
    });

    if (call) {
      if (EDIT_TOOLS.has(toolName)) {
        recordEdit(run, call, result, resultIdx, ts, !(isError || denied));
      } else if (SHELL_TOOLS.has(toolName)) {
        recordCommand(run, call, result, body, resultIdx, ts, isError, denied);
      }
    }
    return idx;
  }
}

// --- free functions used by the importer -------------------------------------

function isClear(obj: Json): boolean {
  if (obj["type"] !== "user") return false;
  const txt = textOf((obj["message"] as Json | undefined)?.["content"]);
  return txt.includes("<command-name>/clear</command-name>") || txt.trim() === "/clear";
}

function looksLikeCompaction(obj: Json, rtype: string): boolean {
  if (rtype === "compact-boundary" || obj["isCompactSummary"]) return true;
  const blob = JSON.stringify(obj).slice(0, 2000).toLowerCase();
  return blob.includes("compact") && (rtype === "system" || rtype === "summary");
}

function resultText(block: Json, result: unknown): string {
  const c = block["content"];
  if (typeof c === "string" && c.trim()) return c;
  if (Array.isArray(c)) {
    const t = blocks(c)
      .filter((b) => b["type"] === "text")
      .map((b) => String(b["text"] ?? ""))
      .join("\n");
    if (t.trim()) return t;
  }
  if (typeof result === "string") return result;
  if (isRecord(result)) {
    const parts = ["stdout", "stderr", "output", "error"]
      .map((k) => (result[k] === undefined ? "" : String(result[k])))
      .filter(Boolean);
    return parts.join("\n") || JSON.stringify(result).slice(0, 4000);
  }
  return "";
}

function looksDenied(body: string): boolean {
  const b = (body || "").toLowerCase();
  return [
    "permission to use",
    "user doesn't want to",
    "requested permissions",
    "blocked by",
    "operation not permitted by hook",
    "permissiondecision",
    "user rejected",
    "denied by",
  ].some((s) => b.includes(s));
}

function recordEdit(
  run: Run,
  call: TraceEvent,
  result: unknown,
  resultIdx: number,
  ts: string | null,
  ok: boolean,
): void {
  const inp = call.toolInput ?? {};
  const tool = call.toolName ?? "";
  const rd = isRecord(result) ? result : {};
  const path =
    str(rd["filePath"]) ??
    str(inp["file_path"]) ??
    str(inp["path"]) ??
    str(inp["notebook_path"]) ??
    "unknown";

  let op: EditOp = "edit";
  if (tool === "Write" || tool === "create_file" || rd["type"] === "create") op = "create";
  else if (tool === "MultiEdit") op = "multi_edit";
  else if (tool === "NotebookEdit") op = "notebook";

  const patch = countPatchLines(rd["structuredPatch"]);
  let added: number;
  let removed: number;
  let preview: string[] = [];

  if (patch) {
    ({ added, removed, preview } = patch);
  } else if (op === "create") {
    // Fall back to the tool input, which is always present even when the result
    // payload shape has changed under us.
    added = countLines(String(rd["content"] ?? inp["content"] ?? inp["file_text"] ?? ""));
    removed = 0;
  } else if (tool === "MultiEdit" && Array.isArray(inp["edits"])) {
    added = 0;
    removed = 0;
    for (const e of inp["edits"]) {
      if (!isRecord(e)) continue;
      const d = countStringDiff(e["old_string"], e["new_string"]);
      added += d.added;
      removed += d.removed;
    }
  } else {
    const d = countStringDiff(
      inp["old_string"] ?? inp["old_str"],
      inp["new_string"] ?? inp["new_str"],
    );
    added = d.added;
    removed = d.removed;
  }

  const edit: FileEdit = {
    eventIdx: resultIdx,
    ts,
    path,
    op,
    linesAdded: added,
    linesRemoved: removed,
    toolUseId: call.toolUseId ?? null,
    applied: ok,
    diffHunks: preview.map(redact),
  };
  run.fileEdits.push(edit);
}

function recordCommand(
  run: Run,
  call: TraceEvent,
  result: unknown,
  body: string,
  resultIdx: number,
  ts: string | null,
  isError: boolean,
  denied: boolean,
): void {
  const inp = call.toolInput ?? {};
  const cmd = String(inp["command"] ?? inp["cmd"] ?? "").trim();
  if (!cmd) return;

  const rd = isRecord(result) ? result : {};
  const stdout = String(rd["stdout"] ?? "");
  const stderr = String(rd["stderr"] ?? "");
  const interrupted = Boolean(rd["interrupted"]);
  const exitCode =
    typeof rd["exitCode"] === "number"
      ? rd["exitCode"]
      : typeof rd["returnCode"] === "number"
        ? rd["returnCode"]
        : null;

  // Claude Code does not record exit codes, so the parsed framework summary is
  // normally the strongest evidence available — ranked above the string
  // heuristic, below anything the harness stated outright.
  const check = parseCheckOutput(`${stdout}\n${stderr}\n${body}`);

  let ok: boolean | null;
  if (denied) ok = false;
  else if (exitCode !== null) ok = exitCode === 0;
  else if (isError || interrupted) ok = false;
  else if (check) ok = check.ok;
  else ok = inferOkFromOutput(stdout || body, stderr);

  const command: Command = {
    eventIdx: resultIdx,
    ts,
    command: cmd,
    category: classifyCommand(cmd),
    ok,
    exitCode,
    check,
    stdoutTail: truncate(redact(stdout || body), 1200),
    stderrTail: stderr ? truncate(redact(stderr), 800) : null,
    interrupted,
    denied,
    mutatesFiles: mutatesWorkingTree(cmd),
  };
  run.commands.push(command);
}

/**
 * Last resort when no exit code is recorded. Conservative: returns null (unknown)
 * unless the output says something unambiguous.
 */
function inferOkFromOutput(stdout: string, stderr: string): boolean | null {
  const blob = `${stdout}\n${stderr}`.toLowerCase();
  if (!blob.trim()) return null;
  const fail = [
    "traceback (most recent call last)",
    " failed,",
    "failed |",
    "test failed",
    "tests failed",
    "error ts",
    "npm err!",
    "assertionerror",
    "fatal:",
    "command not found",
    "compilation failed",
    "build failed",
    "✗",
    "failures:",
  ];
  const pass = ["passed", "all tests passed", "ok ", "✓", "build succeeded", "0 errors", "success"];
  if (fail.some((m) => blob.includes(m))) return false;
  if (pass.some((m) => blob.includes(m))) return true;
  return null;
}

function accumulateUsage(usage: Usage, u: unknown, model: string | null): void {
  if (!isRecord(u)) return;
  const i = num(u["input_tokens"]);
  const o = num(u["output_tokens"]);
  const cr = num(u["cache_read_input_tokens"]);
  let cc = num(u["cache_creation_input_tokens"]);
  if (cc === 0 && isRecord(u["cache_creation"])) {
    cc = Object.values(u["cache_creation"]).reduce<number>((n, v) => n + num(v), 0);
  }

  usage.inputTokens += i;
  usage.outputTokens += o;
  usage.cacheReadTokens += cr;
  usage.cacheCreationTokens += cc;

  const key = model ?? "unknown";
  const m = (usage.byModel[key] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  m.input += i;
  m.output += o;
  m.cacheRead += cr;
  m.cacheCreation += cc;
}
