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
import {
  dbExists,
  dbPath,
  messageJson,
  OpenCodeDb,
  partJson,
  sessionJson,
  splitSyntheticPath,
  syntheticPath,
} from "./opencodeDb.js";
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

/** A message and the parts belonging to it, already ordered and parsed. */
export interface MessageWithParts {
  msg: Json;
  parts: Json[];
}

/** One session's whole object graph, however it was stored. */
interface SessionGraph {
  session: Json;
  messages: MessageWithParts[];
}

export class OpenCodeSource implements Source {
  readonly name = "opencode";

  /** Cached read-only handle, keyed on the resolved path. */
  private conn: { path: string; db: OpenCodeDb } | null = null;
  private readonly notices: string[] = [];

  /**
   * Open — or reuse — the database handle.
   *
   * Keyed on the resolved path because the registry hands out singletons while
   * `flightrec demo` and several tests move `OPENCODE_STORAGE_DIR` mid-process.
   * Without the key a source would happily serve the previous root's data.
   */
  private db(): OpenCodeDb | null {
    if (!dbExists()) return null;
    const path = dbPath();
    if (this.conn?.path === path) return this.conn.db;
    this.conn?.db.close();
    this.conn = null;
    try {
      this.conn = { path, db: new OpenCodeDb(path) };
      return this.conn.db;
    } catch (err) {
      // A WAL database whose -shm index is missing cannot be opened read-only,
      // and the fix is never to open it read-write: that would write into
      // someone's agent data directory. Say what would actually help instead.
      this.notices.push(
        `${path} could not be opened read-only (${String(err)}). If OpenCode has not ` +
          `run since this file was placed here, run it once — or copy opencode.db and ` +
          `opencode.db-wal aside and point OPENCODE_DB at the copy.`,
      );
      return null;
    }
  }

  private legacySessionFiles(): string[] {
    const root = join(storageDir(), "session");
    let projects: string[];
    try {
      projects = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(root, e.name));
    } catch {
      return [];
    }
    return projects.flatMap((dir) => listFiles(dir));
  }

  /**
   * Is there OpenCode data here — not merely an OpenCode-shaped directory?
   *
   * This used to be one `statSync` on `storage/session`. OpenCode migrated to
   * SQLite in February 2026 and left that directory behind, so the check kept
   * answering yes against six months of frozen files. Presence of a container
   * is not presence of data.
   */
  available(): boolean {
    const db = this.db();
    if (db?.hasSessions()) return true;
    return this.legacySessionFiles().length > 0;
  }

  /**
   * One "file" per session, from whichever backends have data.
   *
   * The database wins where both have a session, which on any migrated install
   * is everything: it is a strict superset, holding the legacy sessions plus
   * everything written since. Legacy-only sessions are still returned, because
   * an older OpenCode install has no database at all and a partially-migrated
   * one is not ours to assume away.
   *
   * Two backends rather than two registered sources on purpose: `makeRunId`
   * keys on the source *name*, so a second source called `opencode` would mint
   * identical run ids and the two would fight over one row.
   */
  discover(): DiscoveredFile[] {
    const out: DiscoveredFile[] = [];
    const fromDb = new Set<string>();

    const db = this.db();
    if (db) {
      for (const row of db.listSessions()) {
        fromDb.add(row.id);
        out.push({
          path: syntheticPath(db.path, row.id),
          sessionId: row.id,
          // `session.time_updated`, never anything derived from messages:
          // `message.time_updated` is corrupt for every migrated row.
          mtime: row.time_updated / 1000,
          // Message count as a second signal, so a same-millisecond update
          // still busts the ingest cache.
          size: row.n_messages,
        });
      }
      if (db.hasPopulatedSessionMessage()) {
        this.notices.push(
          "opencode.db has a populated `session_message` table — OpenCode may have moved " +
            "its message store again. flightrec still reads `message`/`part`; if run counts " +
            "have stopped growing, that is the first place to look.",
        );
      }
    }

    const legacy = this.legacySessionFiles();
    let legacyOnly = 0;
    for (const path of legacy) {
      const sessionId = basename(path, ".json");
      if (fromDb.has(sessionId)) continue;
      try {
        const st = statSync(path);
        if (st.size === 0) continue;
        legacyOnly++;
        out.push({
          path,
          sessionId,
          // The session record is rewritten on every update, so its mtime
          // tracks the whole session — which is what the ingest cache needs.
          mtime: st.mtimeMs / 1000,
          size: st.size,
        });
      } catch {
        /* skip */
      }
    }

    if (db && legacy.length && legacyOnly === 0) {
      this.notices.push(
        `legacy storage/ directory found with ${legacy.length} session file(s), all of them ` +
          `already in opencode.db. Reading the database; the directory is left over from the ` +
          `2026-02 SQLite migration and can be deleted.`,
      );
    }

    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  /** Anything this scan noticed that a user should know. Drained by `ingest`. */
  notes(): string[] {
    const out = [...this.notices];
    this.notices.length = 0;
    return out;
  }

  close(): void {
    this.conn?.db.close();
    this.conn = null;
  }

  load(path: string): Run[] {
    const graph = this.read(path);
    if (!graph || graph.messages.length === 0) return [];
    return this.segment(graph.messages)
      .map((seg, i) => this.buildRun(graph.session, seg, path, i))
      .filter((r): r is Run => r !== null && r.events.length >= MIN_EVENTS_PER_RUN);
  }

  /** Dispatch on the path shape: synthetic paths carry a database and a session id. */
  private read(path: string): SessionGraph | null {
    const split = splitSyntheticPath(path);
    return split ? this.readFromDb(split.db, split.sessionId) : this.readFromFiles(path);
  }

  private readFromDb(dbFile: string, sessionId: string): SessionGraph | null {
    const db = this.conn?.path === dbFile ? this.conn.db : this.db();
    if (!db) return null;
    const row = db.session(sessionId);
    if (!row) return null;

    const byMessage = new Map<string, Json[]>();
    for (const p of db.parts(sessionId)) {
      const part = partJson(p, sessionId);
      if (!part) continue;
      const list = byMessage.get(p.message_id);
      if (list) list.push(part);
      else byMessage.set(p.message_id, [part]);
    }

    const messages: MessageWithParts[] = [];
    for (const m of db.messages(sessionId)) {
      const msg = messageJson(m, sessionId);
      if (!msg) continue;
      messages.push({ msg, parts: byMessage.get(m.id) ?? [] });
    }
    return { session: sessionJson(row), messages };
  }

  private readFromFiles(path: string): SessionGraph | null {
    const session = readJson(path);
    if (!session) return null;
    const sessionId = str(session["id"]) ?? basename(path, ".json");

    const messages = listFiles(join(storageDir(), "message", sessionId))
      .map(readJson)
      .filter((m): m is Json => m !== null)
      .sort((a, b) => String(a["id"]).localeCompare(String(b["id"])))
      .map((msg) => {
        const messageId = str(msg["id"]);
        const parts = messageId
          ? listFiles(join(storageDir(), "part", messageId))
              .map(readJson)
              .filter((p): p is Json => p !== null)
              .sort((a, b) => String(a["id"]).localeCompare(String(b["id"])))
          : [];
        return { msg, parts };
      });

    return { session, messages };
  }

  /**
   * Same rule as the Claude Code importer: wall-clock silence ends a run.
   *
   * Splits on `message.time.created`, which is the one timestamp the SQLite
   * migration left intact — see the hazard note in `opencodeDb.ts`.
   */
  private segment(messages: MessageWithParts[]): MessageWithParts[][] {
    const segments: MessageWithParts[][] = [];
    let cur: MessageWithParts[] = [];
    let prevTs: string | null = null;
    for (const m of messages) {
      const ts = timeOf(m.msg, "created");
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

  private buildRun(
    session: Json,
    seg: MessageWithParts[],
    path: string,
    segmentIdx: number,
  ): Run | null {
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

    for (const { msg, parts } of seg) {
      const role = str(msg["role"]) ?? "unknown";
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
      run.goal = redact(title);
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
        text: truncate(redact(text), 4000),
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
        text: truncate(redactDeep(part["text"]), 2000),
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
      command: redact(cmd),
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
