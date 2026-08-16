/**
 * Local SQLite store (node:sqlite, no native dependency).
 *
 * Two reasons this exists rather than reading transcripts on demand:
 *
 * - Claude Code purges transcripts after 30 days by default. Derived analysis has to
 *   outlive its source or the "does this agent keep making the same mistake" question
 *   can never be asked.
 * - Re-analysing every session on every page load doesn't scale past a few hundred runs.
 *
 * Nothing leaves the machine. The file is a plain SQLite database you can delete.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Analysis } from "./analyze/index.js";
import {
  filesTouched,
  type Label,
  linesAdded,
  linesRemoved,
  type Run,
  totalTokens,
} from "./model.js";
import type { Postmortem } from "./postmortem.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    segment INTEGER NOT NULL DEFAULT 0,
    project_path TEXT,
    git_branch TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_s REAL,
    goal TEXT,
    label TEXT,
    label_reason TEXT,
    max_severity TEXT,
    verification_status TEXT,
    files_changed INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_removed INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost_usd REAL,
    cost_known INTEGER DEFAULT 0,
    n_findings INTEGER DEFAULT 0,
    n_events INTEGER DEFAULT 0,
    trivial INTEGER DEFAULT 0,
    source_file TEXT,
    content_hash TEXT,
    ingested_at TEXT,
    trace_json TEXT,
    analysis_json TEXT,
    postmortem_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_path);

CREATE TABLE IF NOT EXISTS findings (
    run_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    severity TEXT,
    category TEXT,
    title TEXT,
    PRIMARY KEY (run_id, finding_id)
);
CREATE INDEX IF NOT EXISTS idx_findings_cat ON findings(category, severity);

CREATE TABLE IF NOT EXISTS ingest_log (
    path TEXT PRIMARY KEY,
    mtime REAL,
    size INTEGER,
    runs_found INTEGER,
    ingested_at TEXT
);
`;

export interface RunSummary {
  run_id: string;
  source: string;
  session_id: string;
  segment: number;
  project_path: string | null;
  git_branch: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  goal: string | null;
  label: Label;
  label_reason: string;
  max_severity: string;
  verification_status: string;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  total_tokens: number;
  cost_usd: number | null;
  cost_known: number;
  n_findings: number;
  n_events: number;
  trivial: number;
}

export interface StoredRun extends RunSummary {
  trace: Run;
  analysis: Analysis;
  postmortem: Postmortem;
  source_file: string | null;
  content_hash: string;
  ingested_at: string;
}

export function defaultDbPath(): string {
  const root = process.env["FLIGHTREC_HOME"] || join(homedir(), ".flightrec");
  mkdirSync(root, { recursive: true });
  return join(root, "flightrec.db");
}

export class Store {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path?: string) {
    this.path = path ?? defaultDbPath();
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` never adds columns, so a database written by
   * an older build keeps its old shape. Add anything missing rather than
   * asking the user to delete and re-ingest — the store is an archive, and
   * transcripts it was built from may already have been purged.
   */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    const added: Array<[string, string]> = [["trivial", "INTEGER DEFAULT 0"]];
    for (const [name, decl] of added) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${decl}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // -- writes ------------------------------------------------------------
  upsert(run: Run, analysis: Analysis, pm: Postmortem): void {
    const trace = JSON.stringify(run);
    const hash = createHash("sha1").update(trace).digest("hex");
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    this.db
      .prepare(
        `INSERT INTO runs (run_id, source, session_id, segment, project_path, git_branch,
            started_at, ended_at, duration_s, goal, label, label_reason, max_severity,
            verification_status, files_changed, lines_added, lines_removed, total_tokens,
            cost_usd, cost_known, n_findings, n_events, trivial, source_file, content_hash,
            ingested_at, trace_json, analysis_json, postmortem_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id) DO UPDATE SET
            trivial=excluded.trivial,
            label=excluded.label, label_reason=excluded.label_reason,
            max_severity=excluded.max_severity,
            verification_status=excluded.verification_status,
            files_changed=excluded.files_changed, lines_added=excluded.lines_added,
            lines_removed=excluded.lines_removed, total_tokens=excluded.total_tokens,
            cost_usd=excluded.cost_usd, cost_known=excluded.cost_known,
            n_findings=excluded.n_findings, n_events=excluded.n_events,
            ended_at=excluded.ended_at, duration_s=excluded.duration_s,
            goal=excluded.goal, content_hash=excluded.content_hash,
            ingested_at=excluded.ingested_at, trace_json=excluded.trace_json,
            analysis_json=excluded.analysis_json, postmortem_json=excluded.postmortem_json`,
      )
      .run(
        run.runId,
        run.source,
        run.sessionId,
        run.segment,
        run.projectPath,
        run.gitBranch,
        run.startedAt,
        run.endedAt,
        run.durationS,
        run.goal,
        analysis.label,
        analysis.labelReason,
        analysis.maxSeverity,
        analysis.verification.status,
        filesTouched(run).length,
        linesAdded(run),
        linesRemoved(run),
        totalTokens(run.usage),
        run.usage.costUsd,
        run.usage.costUsd === null ? 0 : 1,
        analysis.findings.length,
        run.events.length,
        analysis.trivial ? 1 : 0,
        run.sourceFile,
        hash,
        now,
        trace,
        JSON.stringify(analysis),
        JSON.stringify(pm),
      );

    this.db.prepare("DELETE FROM findings WHERE run_id=?").run(run.runId);
    const insert = this.db.prepare("INSERT OR REPLACE INTO findings VALUES (?,?,?,?,?)");
    for (const f of analysis.findings) {
      insert.run(run.runId, f.id, f.severity, f.category, f.title);
    }
  }

  noteIngest(path: string, mtime: number, size: number, runsFound: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO ingest_log VALUES (?,?,?,?,?)")
      .run(path, mtime, size, runsFound, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  }

  isUnchanged(path: string, mtime: number, size: number): boolean {
    const row = this.db.prepare("SELECT mtime, size FROM ingest_log WHERE path=?").get(path) as
      | { mtime: number; size: number }
      | undefined;
    return Boolean(row && Math.abs(row.mtime - mtime) < 0.001 && row.size === size);
  }

  // -- reads -------------------------------------------------------------
  listRuns(
    opts: {
      limit?: number;
      project?: string | null;
      label?: string | null;
      source?: string | null;
      includeTrivial?: boolean;
    } = {},
  ): RunSummary[] {
    let q = `SELECT run_id, source, session_id, segment, project_path, git_branch, started_at,
              ended_at, duration_s, goal, label, label_reason, max_severity,
              verification_status, files_changed, lines_added, lines_removed, total_tokens,
              cost_usd, cost_known, n_findings, n_events, trivial FROM runs WHERE 1=1`;
    const args: Array<string | number> = [];
    if (!opts.includeTrivial) q += " AND COALESCE(trivial,0) = 0";
    if (opts.project) {
      q += " AND project_path = ?";
      args.push(opts.project);
    }
    if (opts.label) {
      q += " AND label = ?";
      args.push(opts.label);
    }
    if (opts.source) {
      q += " AND source = ?";
      args.push(opts.source);
    }
    q += " ORDER BY COALESCE(started_at,'') DESC LIMIT ?";
    args.push(opts.limit ?? 200);
    return this.db.prepare(q).all(...args) as unknown as RunSummary[];
  }

  getRun(runId: string): StoredRun | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as
      | (RunSummary & {
          trace_json: string;
          analysis_json: string;
          postmortem_json: string;
          source_file: string | null;
          content_hash: string;
          ingested_at: string;
        })
      | undefined;
    if (!row) return null;
    const { trace_json, analysis_json, postmortem_json, ...rest } = row;
    return {
      ...rest,
      trace: JSON.parse(trace_json) as Run,
      analysis: JSON.parse(analysis_json) as Analysis,
      postmortem: JSON.parse(postmortem_json) as Postmortem,
    };
  }

  projects(): Array<{ project_path: string; n: number; last: string }> {
    return this.db
      .prepare(
        `SELECT project_path, COUNT(*) n, MAX(started_at) last FROM runs
         WHERE project_path IS NOT NULL GROUP BY project_path ORDER BY last DESC`,
      )
      .all() as unknown as Array<{ project_path: string; n: number; last: string }>;
  }

  stats(): Record<string, unknown> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) runs, COUNT(DISTINCT session_id) sessions,
                SUM(COALESCE(cost_usd,0)) cost, SUM(cost_known) priced,
                SUM(COALESCE(duration_s,0)) seconds, SUM(files_changed) files,
                SUM(COALESCE(trivial,0)) trivial FROM runs`,
      )
      .get() as Record<string, unknown>;
    const labelRows = this.db
      .prepare("SELECT label, COUNT(*) n FROM runs GROUP BY label")
      .all() as unknown as Array<{ label: string; n: number }>;
    const topFindings = this.db
      .prepare(
        `SELECT category, severity, COUNT(*) n FROM findings
         GROUP BY category, severity ORDER BY n DESC LIMIT 12`,
      )
      .all();
    return {
      ...row,
      labels: Object.fromEntries(labelRows.map((r) => [r.label, r.n])),
      top_findings: topFindings,
    };
  }
}
