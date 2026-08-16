/**
 * Store behaviour: filtering, aggregation, idempotent writes, and the schema
 * migration that keeps an old database readable.
 *
 * The migration case matters more than its size suggests. The store is an
 * archive — Claude Code purges transcripts after thirty days, so a database
 * this tool wrote may be the only remaining record of a run. A build that
 * cannot open last month's file loses data that cannot be regenerated.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

import { analyze } from "../src/analyze/index.js";
import { fixtureProductive } from "../src/demo/fixtures.js";
import { seedDemo } from "../src/demo/index.js";
import { generate } from "../src/postmortem.js";
import { ClaudeCodeSource } from "../src/sources/claudeCode.js";
import { defaultDbPath, Store } from "../src/store.js";

let root: string;
let store: Store;
let seq = 0;

const priorHome = process.env["FLIGHTREC_HOME"];

before(() => {
  root = mkdtempSync(join(tmpdir(), "flightrec-store-"));
  store = new Store(join(root, "seeded.db"));
  seedDemo(store, { root: join(root, "demo") });
});

after(() => {
  store.close();
  if (priorHome === undefined) delete process.env["FLIGHTREC_HOME"];
  else process.env["FLIGHTREC_HOME"] = priorHome;
  rmSync(root, { recursive: true, force: true });
});

const fresh = (): Store => new Store(join(root, `s-${seq++}.db`));

describe("listRuns", () => {
  it("filters by source", () => {
    const rows = store.listRuns({ source: "opencode", includeTrivial: true });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.source === "opencode"));
  });

  it("filters by label", () => {
    const rows = store.listRuns({ label: "risky", includeTrivial: true });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.label === "risky"));
  });

  it("filters by project path", () => {
    const target = store
      .listRuns({ includeTrivial: true })
      .find((r) => r.project_path)?.project_path;
    assert.ok(target);
    const rows = store.listRuns({ project: target, includeTrivial: true });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.project_path === target));
  });

  it("respects limit", () => {
    assert.equal(store.listRuns({ limit: 2, includeTrivial: true }).length, 2);
  });

  it("orders newest first", () => {
    const starts = store.listRuns({ includeTrivial: true }).map((r) => r.started_at ?? "");
    const sorted = [...starts].sort().reverse();
    assert.deepEqual(starts, sorted);
  });

  it("hides trivial runs unless asked", () => {
    const shown = store.listRuns({});
    assert.ok(shown.every((r) => !r.trivial));
  });
});

describe("aggregates", () => {
  it("groups projects with counts and a last-seen timestamp", () => {
    const rows = store.projects();
    assert.ok(rows.length > 0);
    for (const p of rows) {
      assert.equal(typeof p.project_path, "string");
      assert.ok(p.n > 0);
      assert.ok(p.last);
    }
  });

  it("aggregates stats over stored runs", () => {
    const s = store.stats();
    assert.ok(Number(s["runs"]) > 0);
  });

  it("returns zeroes for an empty store rather than throwing", () => {
    const empty = fresh();
    try {
      assert.equal(Number(empty.stats()["runs"]), 0);
      assert.deepEqual(empty.projects(), []);
      assert.deepEqual(empty.listRuns({}), []);
    } finally {
      empty.close();
    }
  });
});

describe("getRun", () => {
  it("returns null for an unknown id", () => {
    assert.equal(store.getRun("no-such-run"), null);
  });

  it("round-trips the stored document", () => {
    const id = store.listRuns({ limit: 1, includeTrivial: true })[0]?.run_id;
    assert.ok(id);
    const run = store.getRun(id);
    assert.ok(run);
    assert.equal(run.run_id, id);
    assert.ok(run.trace.events.length > 0);
    assert.ok(run.postmortem.markdown.length > 0);
  });
});

describe("ingest bookkeeping", () => {
  it("tracks a file as changed until it is noted, and again when it grows", () => {
    const s = fresh();
    try {
      assert.equal(s.isUnchanged("/x/a.jsonl", 100, 10), false);
      s.noteIngest("/x/a.jsonl", 100, 10, 1);
      assert.equal(s.isUnchanged("/x/a.jsonl", 100, 10), true);
      assert.equal(s.isUnchanged("/x/a.jsonl", 100, 11), false, "a size change invalidates");
      assert.equal(s.isUnchanged("/x/a.jsonl", 101, 10), false, "an mtime change invalidates");
    } finally {
      s.close();
    }
  });
});

describe("upsert", () => {
  it("replaces a run's findings rather than accumulating them", () => {
    const s = fresh();
    try {
      const path = fixtureProductive().writeTo(join(root, "upsert"));
      const run = new ClaudeCodeSource().load(path)[0];
      assert.ok(run);
      const a = analyze(run);

      s.upsert(run, a, generate(run, a));
      const firstCount = s.listRuns({ includeTrivial: true })[0]?.n_findings;

      // Same run, stored twice: one row, and the finding count must not double.
      s.upsert(run, a, generate(run, a));
      const rows = s.listRuns({ includeTrivial: true });
      assert.equal(rows.length, 1, "upsert must not duplicate the run");
      assert.equal(rows[0]?.n_findings, firstCount);
    } finally {
      s.close();
    }
  });
});

describe("schema migration", () => {
  it("adds a column missing from an older database", () => {
    // Hand-build a `runs` table without the `trivial` column, the way a build
    // from before that column existed would have left it.
    const path = join(root, "legacy.db");
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, source TEXT, session_id TEXT, segment INTEGER,
      project_path TEXT, git_branch TEXT, started_at TEXT, ended_at TEXT,
      duration_s REAL, goal TEXT, label TEXT, label_reason TEXT, max_severity TEXT,
      verification_status TEXT, files_changed INTEGER, lines_added INTEGER,
      lines_removed INTEGER, total_tokens INTEGER, cost_usd REAL, cost_known INTEGER,
      n_findings INTEGER, n_events INTEGER, trace_json TEXT, analysis_json TEXT,
      postmortem_json TEXT, source_file TEXT, content_hash TEXT, ingested_at TEXT
    )`);
    raw.close();

    const migrated = new Store(path);
    try {
      const cols = new Set(
        (
          new DatabaseSync(path).prepare("PRAGMA table_info(runs)").all() as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      );
      assert.ok(cols.has("trivial"), "the missing column should have been added");
      assert.deepEqual(migrated.listRuns({}), [], "and the store should still be usable");
    } finally {
      migrated.close();
    }
  });
});

describe("defaultDbPath", () => {
  it("honours FLIGHTREC_HOME and creates the directory", () => {
    const home = join(root, "custom-home");
    process.env["FLIGHTREC_HOME"] = home;
    assert.equal(defaultDbPath(), join(home, "flightrec.db"));
    // Opening it must work, which proves the directory was created.
    const s = new Store(defaultDbPath());
    s.close();
  });
});
