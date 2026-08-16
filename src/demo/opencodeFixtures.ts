/**
 * Generate a synthetic OpenCode storage tree.
 *
 * OpenCode does not use one file per session — it writes an object graph, so
 * the fixture has to build the same four directories the importer reads:
 *
 *   session/<projectID>/<sessionID>.json
 *   message/<sessionID>/<messageID>.json
 *   part/<messageID>/<partID>.json
 *   project/<projectID>.json
 *
 * Ids are zero-padded counters because the importer orders parts and messages
 * lexicographically by id — that ordering is load-bearing, so the fixtures have
 * to reproduce it rather than rely on directory order.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;

const PROJECT_ID = "proj0000000000000000000000000000000000001";
const CWD = "/Users/dev/code/ledger-svc";

export class OcBuilder {
  private readonly sid: string;
  private readonly root: string;
  private t: number;
  private msgN = 0;
  private partN = 0;
  private curMsg: string | null = null;
  private readonly messages: Json[] = [];
  private readonly parts = new Map<string, Json[]>();
  private readonly models = new Set<string>();
  private summary: Json | null = null;
  private title = "Synthetic OpenCode session";

  constructor(root: string, opts: { sessionId?: string; start?: number } = {}) {
    this.root = root;
    this.sid = opts.sessionId ?? "ses_00000000000000000000000001";
    this.t = opts.start ?? Date.parse("2026-08-14T09:00:00Z");
  }

  private tick(seconds = 6): number {
    this.t += seconds * 1000;
    return this.t;
  }

  /**
   * Ids must be unique across *every* builder, not just within one: parts live
   * at `part/<messageID>/`, a path that carries no session id, so two builders
   * numbering their messages from 1 would silently share a parts directory and
   * graft each other's tool calls onto the wrong run.
   */
  private newMessage(role: string, extra: Json = {}): string {
    const id = `msg_${this.sid.slice(4)}_${String(++this.msgN).padStart(6, "0")}`;
    this.curMsg = id;
    this.parts.set(id, []);
    this.messages.push({
      id,
      sessionID: this.sid,
      role,
      time: { created: this.tick() },
      ...extra,
    });
    return id;
  }

  private addPart(p: Json): void {
    const id = `prt_${this.sid.slice(4)}_${String(++this.partN).padStart(6, "0")}`;
    const msg = this.curMsg;
    if (!msg) throw new Error("addPart before any message");
    this.parts.get(msg)?.push({ id, sessionID: this.sid, messageID: msg, ...p });
  }

  /** Assistant messages carry the token counters and the agent's own cost. */
  private assistant(model = "claude-opus-4-6", cost = 0): void {
    this.models.add(model);
    this.newMessage("assistant", {
      modelID: model,
      providerID: "anthropic",
      cost,
      tokens: { input: 12, output: 240, reasoning: 0, cache: { read: 18000, write: 900 } },
      path: { cwd: CWD, root: CWD },
    });
  }

  user(text: string): this {
    this.newMessage("user");
    this.addPart({ type: "text", text, time: { start: this.t, end: this.t } });
    return this;
  }

  say(text: string, opts: { model?: string; cost?: number } = {}): this {
    this.assistant(opts.model, opts.cost);
    this.addPart({ type: "text", text, time: { start: this.t, end: this.t } });
    return this;
  }

  think(text: string): this {
    this.assistant();
    this.addPart({ type: "reasoning", text, time: { start: this.t, end: this.t } });
    return this;
  }

  edit(filePath: string, oldString: string, newString: string, ok = true): this {
    this.assistant();
    this.addPart({
      type: "tool",
      callID: `toolu_${this.partN}`,
      tool: "edit",
      state: ok
        ? {
            status: "completed",
            input: { filePath, oldString, newString },
            output: "Edit applied successfully.",
            metadata: { exists: true },
          }
        : {
            status: "error",
            input: { filePath, oldString, newString },
            error: "Error: file not found",
          },
    });
    return this;
  }

  write(filePath: string, content: string): this {
    this.assistant();
    this.addPart({
      type: "tool",
      callID: `toolu_${this.partN}`,
      tool: "write",
      state: {
        status: "completed",
        input: { filePath, content },
        output: "File written.",
        metadata: { exists: false },
      },
    });
    return this;
  }

  bash(command: string, output: string, opts: { error?: string } = {}): this {
    this.assistant();
    this.addPart({
      type: "tool",
      callID: `toolu_${this.partN}`,
      tool: "bash",
      state: opts.error
        ? { status: "error", input: { command }, error: opts.error }
        : { status: "completed", input: { command }, output },
    });
    return this;
  }

  compact(): this {
    this.assistant();
    this.addPart({ type: "compaction", auto: true });
    return this;
  }

  /** An unmapped part type — must be recorded as drift, never dropped. */
  weird(type: string): this {
    this.assistant();
    this.addPart({ type });
    return this;
  }

  idle(minutes: number): this {
    this.t += minutes * 60 * 1000;
    return this;
  }

  withSummary(files: number, additions: number, deletions: number): this {
    this.summary = { files, additions, deletions };
    return this;
  }

  withTitle(title: string): this {
    this.title = title;
    return this;
  }

  /** Writes the storage tree and returns the session record's path. */
  writeTo(): string {
    const st = this.root;
    mkdirSync(join(st, "project"), { recursive: true });
    writeFileSync(
      join(st, "project", `${PROJECT_ID}.json`),
      JSON.stringify({
        id: PROJECT_ID,
        worktree: CWD,
        vcs: "git",
        sandboxes: [],
        time: { created: this.t, updated: this.t },
      }),
    );

    const sessionDir = join(st, "session", PROJECT_ID);
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, `${this.sid}.json`);
    writeFileSync(
      sessionPath,
      JSON.stringify({
        id: this.sid,
        slug: "synthetic-run",
        version: "1.1.44",
        projectID: PROJECT_ID,
        directory: CWD,
        title: this.title,
        time: { created: Date.parse("2026-08-14T09:00:00Z"), updated: this.t },
        ...(this.summary ? { summary: this.summary } : {}),
      }),
    );

    const msgDir = join(st, "message", this.sid);
    mkdirSync(msgDir, { recursive: true });
    for (const m of this.messages) {
      writeFileSync(join(msgDir, `${String(m["id"])}.json`), JSON.stringify(m));
    }
    for (const [msgId, parts] of this.parts) {
      if (parts.length === 0) continue;
      const partDir = join(st, "part", msgId);
      mkdirSync(partDir, { recursive: true });
      for (const p of parts) {
        writeFileSync(join(partDir, `${String(p["id"])}.json`), JSON.stringify(p));
      }
    }
    return sessionPath;
  }
}
