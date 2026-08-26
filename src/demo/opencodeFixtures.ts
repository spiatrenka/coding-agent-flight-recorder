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
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  private reuse = false;
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

  /**
   * Make the next step attach to the current message instead of opening a new
   * one.
   *
   * Real assistant turns are routinely several parts — reasoning, then a tool
   * call, then the reply — and a fixture of one part per message cannot tell a
   * correct part ordering from a broken one, because there is never more than
   * one part to order.
   */
  same(): this {
    this.reuse = true;
    return this;
  }

  /** Assistant messages carry the token counters and the agent's own cost. */
  private assistant(model = "claude-opus-4-6", cost = 0): void {
    if (this.reuse && this.curMsg) {
      this.reuse = false;
      return;
    }
    this.reuse = false;
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

  /**
   * Write the same session into a SQLite database, the way OpenCode does now.
   *
   * The identity fields are **stripped out of the JSON and put into columns**,
   * which is precisely what the real 2026-02 migration did — so a fixture built
   * this way exercises the shim that puts them back rather than quietly handing
   * the importer a shape it never sees in the wild.
   *
   * `reversed` inserts messages and parts in descending id order and stamps
   * every part with one identical `time_created`, reproducing a migrated row:
   * the migration collapsed every pre-existing `part.time_created` onto the
   * migration instant, so anything that orders by that column scrambles the
   * timeline. Ordering must come from the id.
   */
  writeDbTo(dbPath: string, opts: { reversed?: boolean } = {}): string {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(OC_DB_SCHEMA);

    const created = Date.parse("2026-08-14T09:00:00Z");
    db.prepare(
      `INSERT OR REPLACE INTO session
         (id, project_id, directory, title, version, time_created, time_updated,
          summary_files, summary_additions, summary_deletions)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      this.sid,
      PROJECT_ID,
      CWD,
      this.title,
      "1.1.44",
      created,
      this.t,
      (this.summary?.["files"] as number) ?? null,
      (this.summary?.["additions"] as number) ?? null,
      (this.summary?.["deletions"] as number) ?? null,
    );

    const order = <T>(xs: T[]): T[] => (opts.reversed ? [...xs].reverse() : xs);
    // One constant, as a migrated row would carry.
    const migratedAt = Date.parse("2026-02-15T08:42:11.799Z");

    const insMsg = db.prepare(
      "INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
    );
    for (const m of order(this.messages)) {
      const { id, sessionID, ...data } = m as { id: string; sessionID: string } & Json;
      void sessionID;
      const t = ((data["time"] as Json | undefined)?.["created"] as number) ?? created;
      insMsg.run(id, this.sid, t, opts.reversed ? migratedAt : t, JSON.stringify(data));
    }

    const insPart = db.prepare(
      "INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
    );
    for (const [msgId, parts] of this.parts) {
      for (const p of order(parts)) {
        const { id, messageID, sessionID, ...data } = p as {
          id: string;
          messageID: string;
          sessionID: string;
        } & Json;
        void messageID;
        void sessionID;
        insPart.run(id, msgId, this.sid, migratedAt, migratedAt, JSON.stringify(data));
      }
    }

    db.close();
    return `${dbPath}#${this.sid}`;
  }
}

/**
 * Enough of OpenCode's schema to exercise the importer.
 *
 * Column names and types mirror the real database. `session_message` is here
 * with no rows because it is in the real one too, staged for a migration that
 * has not happened yet — the importer watches it as a tripwire, and a fixture
 * without it could not test that.
 */
export const OC_DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT,
  time_created INTEGER NOT NULL DEFAULT 0, time_updated INTEGER NOT NULL DEFAULT 0,
  sandboxes TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
  slug TEXT, directory TEXT, title TEXT, version TEXT,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
  summary_diffs TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  agent TEXT, model TEXT, cost REAL DEFAULT 0 NOT NULL,
  tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
  tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
  tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS part_session_idx ON part (session_id);
CREATE INDEX IF NOT EXISTS message_session_idx ON message (session_id, time_created, id);
`;
