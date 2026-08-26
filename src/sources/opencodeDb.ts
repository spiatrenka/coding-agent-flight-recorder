/**
 * OpenCode's SQLite store — the read layer.
 *
 * OpenCode kept sessions as a JSON object graph under `storage/` until it
 * migrated to SQLite in February 2026 (its own migration
 * `20260213144116_wakeful_the_professor`). It left the old directory in place,
 * which is why this took six months to notice: `storage/session` still existed,
 * so the importer reported itself healthy while serving frozen data.
 *
 * The migration moved the data without redesigning it. `message.data` and
 * `part.data` hold the *same JSON objects* as the old files, minus the three
 * identity fields that became columns — `id`, `sessionID`, `messageID`. So this
 * module is only a reader plus a shim that puts those fields back; every
 * mapping decision still lives in `opencode.ts` and is shared by both backends.
 *
 * Two hazards are baked into the schema and are not obvious:
 *
 * 1. **`part.time_created` and `message.time_updated` are corrupt for every
 *    migrated row** — both carry the migration instant, 2026-02-15T08:42:11Z
 *    (10,739 messages across 1,140 of 1,416 sessions on the store this was
 *    written against). Only `message.time_created` survived. Nothing here may
 *    order by, or compute freshness from, the corrupt columns. Ordering is by
 *    `id`, which was validated against time order across every session with
 *    zero inversions — and is what the file importer already did, for the same
 *    reason: ids are monotonic within a session.
 *
 * 2. **The next migration is already staged in the same database.** A
 *    `session_message` table exists with its indexes built and no rows, and
 *    `event` is already accumulating. When OpenCode flips writes over, `message`
 *    freezes and this importer goes quiet again — with no leftover directory to
 *    blame. `hasPopulatedSessionMessage()` is the tripwire for that day.
 *
 * The connection is read-only and stays read-only. This is someone's live agent
 * data, frequently with the agent running: we never take a write lock, never
 * checkpoint the WAL, and never create a file in their data directory.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Separator between the database path and the session id in a synthetic path. */
export const DB_PATH_SEP = "#";

type Json = Record<string, unknown>;

/**
 * Local rather than imported from `opencode.ts`: this module is the lower
 * layer, and importing upward would make the two files a cycle.
 */
function asRecord(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

/**
 * Where OpenCode keeps its data directory.
 *
 * `OPENCODE_STORAGE_DIR` is consulted — via its parent — even though it names
 * the *legacy* directory, and that is load-bearing rather than incidental:
 * every existing test sets it to a temp tree, and without this clause those
 * tests would resolve the database from `$HOME` and start reading the
 * developer's real session history. `storage/` is a sibling of `opencode.db`
 * in the real layout, so the parent is also simply correct.
 */
export function dataDir(): string {
  const db = process.env["OPENCODE_DB"];
  if (db) return dirname(db);
  const storage = process.env["OPENCODE_STORAGE_DIR"];
  if (storage) return dirname(storage);
  return process.env["OPENCODE_DATA_DIR"] || join(homedir(), ".local", "share", "opencode");
}

export function dbPath(): string {
  return process.env["OPENCODE_DB"] || join(dataDir(), "opencode.db");
}

export function dbExists(): boolean {
  try {
    return existsSync(dbPath());
  } catch {
    return false;
  }
}

export interface OcDbSession {
  id: string;
  directory: string | null;
  title: string | null;
  version: string | null;
  time_created: number | null;
  time_updated: number | null;
  summary_files: number | null;
  summary_additions: number | null;
  summary_deletions: number | null;
}

export interface OcDbListing {
  id: string;
  time_updated: number;
  n_messages: number;
}

/**
 * A read-only handle on `opencode.db`.
 *
 * Throws from the constructor when the database cannot be opened read-only.
 * The caller is expected to catch: an unreadable agent database is a reason to
 * contribute nothing, never a reason to fail someone's whole scan.
 */
export class OpenCodeDb {
  private readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path, { readOnly: true });
    // Belt and braces: `readOnly` already prevents writes, and `query_only`
    // makes an accidental write a clear error rather than a silent no-op.
    this.db.exec("PRAGMA query_only = 1");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  hasSessions(): boolean {
    try {
      return this.db.prepare("SELECT 1 FROM session LIMIT 1").get() !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Every session, newest first.
   *
   * `time_updated` is the freshness key rather than anything derived from
   * messages, because `message.time_updated` is one of the columns the
   * migration corrupted. It is a sound high-water mark: on the store this was
   * measured against, 47 of 1,416 sessions have a later `message.time_created`
   * and the largest drift is 24.7 seconds.
   */
  listSessions(): OcDbListing[] {
    const rows = this.db
      .prepare(
        `SELECT s.id AS id,
                s.time_updated AS time_updated,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS n_messages
           FROM session s
          ORDER BY s.time_updated DESC`,
      )
      .all() as unknown as OcDbListing[];
    return rows;
  }

  session(id: string): OcDbSession | null {
    const row = this.db
      .prepare(
        `SELECT id, directory, title, version, time_created, time_updated,
                summary_files, summary_additions, summary_deletions
           FROM session WHERE id = ?`,
      )
      .get(id) as unknown as OcDbSession | undefined;
    return row ?? null;
  }

  /** Ordered by id — see the hazard note at the top of this file. */
  messages(sessionId: string): { id: string; data: string }[] {
    return this.db
      .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY id")
      .all(sessionId) as unknown as { id: string; data: string }[];
  }

  /** Ordered by id, never `time_created` — that column is corrupt for migrated rows. */
  parts(sessionId: string): { id: string; message_id: string; data: string }[] {
    return this.db
      .prepare("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id")
      .all(sessionId) as unknown as { id: string; message_id: string; data: string }[];
  }

  /**
   * Has OpenCode started writing messages somewhere new?
   *
   * The table may not exist on older databases, which is not an error — it just
   * means the migration this guards against has not been staged yet.
   */
  hasPopulatedSessionMessage(): boolean {
    try {
      return this.db.prepare("SELECT 1 FROM session_message LIMIT 1").get() !== undefined;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

// --- the shim ----------------------------------------------------------------
// Puts back exactly what the migration hoisted out, so that every mapping
// function in `opencode.ts` runs against the shape it was written for.

export function messageJson(row: { id: string; data: string }, sessionId: string): Json | null {
  const parsed = asRecord(safeParse(row.data));
  if (!parsed) return null;
  parsed["id"] = row.id;
  parsed["sessionID"] = sessionId;
  return parsed;
}

export function partJson(
  row: { id: string; message_id: string; data: string },
  sessionId: string,
): Json | null {
  const parsed = asRecord(safeParse(row.data));
  if (!parsed) return null;
  parsed["id"] = row.id;
  parsed["messageID"] = row.message_id;
  parsed["sessionID"] = sessionId;
  return parsed;
}

/**
 * Rebuild the legacy session-record shape from the columns.
 *
 * `summary` is reassembled only when it carries a non-zero number, matching
 * what the old records looked like — the column is non-NULL on nearly every row
 * but non-zero on about one in eight, and `applySessionSummary` already treats
 * an all-zero summary as absent.
 */
export function sessionJson(row: OcDbSession): Json {
  const out: Json = {
    id: row.id,
    directory: row.directory,
    title: row.title,
    version: row.version,
    time: { created: row.time_created, updated: row.time_updated },
  };
  const files = row.summary_files ?? 0;
  const additions = row.summary_additions ?? 0;
  const deletions = row.summary_deletions ?? 0;
  if (files || additions || deletions) {
    out["summary"] = { files, additions, deletions };
  }
  return out;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null; // half-written or truncated: skip, never fail the scan
  }
}

/** `<db path>#<session id>` — the synthetic path a database session discovers as. */
export function syntheticPath(db: string, sessionId: string): string {
  return `${db}${DB_PATH_SEP}${sessionId}`;
}

/** Split a synthetic path back apart, or null when it is an ordinary file path. */
export function splitSyntheticPath(path: string): { db: string; sessionId: string } | null {
  const i = path.lastIndexOf(DB_PATH_SEP);
  if (i <= 0) return null;
  const sessionId = path.slice(i + 1);
  if (!sessionId) return null;
  return { db: path.slice(0, i), sessionId };
}
