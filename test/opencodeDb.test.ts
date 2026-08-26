/**
 * The OpenCode SQLite backend.
 *
 * OpenCode migrated from a JSON directory to SQLite in February 2026 and left
 * the old directory behind. Because `available()` only asked whether that
 * directory existed, the importer reported itself healthy and served six months
 * of frozen data — 1,072 missing sessions on the machine this was written
 * against, with nothing anywhere reporting a problem.
 *
 * These tests exist in that order of importance:
 *
 *  1. the two backends produce identical runs, so they cannot drift;
 *  2. `available()` answers "is there data", not "is there a directory";
 *  3. ordering comes from the id, because two timestamp columns are corrupt for
 *     every migrated row;
 *  4. the shim restores the identity fields the migration hoisted into columns;
 *  5. reading never writes, because this is someone's live agent database.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { OcBuilder } from "../src/demo/opencodeFixtures.js";
import type { Run } from "../src/model.js";
import { OpenCodeSource } from "../src/sources/opencode.js";
import { splitSyntheticPath } from "../src/sources/opencodeDb.js";

let tmp: string;

/** Point the source at an isolated root and run something against it. */
function withRoot<T>(root: string, fn: () => T): T {
  const prevStorage = process.env["OPENCODE_STORAGE_DIR"];
  const prevDb = process.env["OPENCODE_DB"];
  process.env["OPENCODE_STORAGE_DIR"] = join(root, "storage");
  process.env["OPENCODE_DB"] = join(root, "opencode.db");
  try {
    return fn();
  } finally {
    if (prevStorage === undefined) delete process.env["OPENCODE_STORAGE_DIR"];
    else process.env["OPENCODE_STORAGE_DIR"] = prevStorage;
    if (prevDb === undefined) delete process.env["OPENCODE_DB"];
    else process.env["OPENCODE_DB"] = prevDb;
  }
}

/**
 * A script exercising every part type the importer maps.
 *
 * The middle turn is deliberately one message of four parts. A fixture of one
 * part per message cannot distinguish correct intra-message ordering from
 * broken ordering — there is never a second part to misplace — and an earlier
 * version of these tests passed happily against a backend that sorted parts by
 * the corrupt `time_created` column.
 */
function script(b: OcBuilder): OcBuilder {
  return b
    .user("add pagination to the transactions endpoint")
    .think("I will look at the handler first")
    .same()
    .edit("/Users/dev/code/ledger-svc/src/api.ts", "const a = 1;", "const a = 2;\nconst b = 3;")
    .same()
    .write("/Users/dev/code/ledger-svc/src/page.ts", "export const page = 1;\n")
    .same()
    .bash("npm test", "Tests: 12 passed, 12 total")
    .say("Done — pagination added and the suite is green.", { cost: 0.42 });
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "flightrec-ocdb-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("the two OpenCode backends agree", () => {
  it("produces identical runs from files and from the database", () => {
    // Separate roots so neither backend can see the other's data, and the same
    // session id in both so the run ids must match.
    const fileRoot = join(tmp, "eq-files");
    const dbRoot = join(tmp, "eq-db");
    const sid = "ses_equivalence00000000001";

    const filePath = script(new OcBuilder(join(fileRoot, "storage"), { sessionId: sid })).writeTo();
    const dbPath = script(new OcBuilder(join(dbRoot, "storage"), { sessionId: sid })).writeDbTo(
      join(dbRoot, "opencode.db"),
    );

    const fromFiles = withRoot(fileRoot, () => {
      const s = new OpenCodeSource();
      const r = s.load(filePath);
      s.close();
      return r;
    });
    const fromDb = withRoot(dbRoot, () => {
      const s = new OpenCodeSource();
      const r = s.load(dbPath);
      s.close();
      return r;
    });

    assert.equal(fromFiles.length, 1, "the file backend should produce one run");
    assert.equal(fromDb.length, 1, "the db backend should produce one run");

    // `sourceFile` is the one field that legitimately differs — it records
    // where the run was read from.
    const strip = (r: Run): Omit<Run, "sourceFile"> => {
      const { sourceFile, ...rest } = r;
      void sourceFile;
      return rest;
    };
    assert.deepEqual(strip(fromDb[0] as Run), strip(fromFiles[0] as Run));
    assert.equal((fromDb[0] as Run).runId, (fromFiles[0] as Run).runId);
  });
});

describe("available() tests for data, not for a directory", () => {
  it("is false for an empty storage directory and an empty database", () => {
    // This is the regression test for the actual bug: in February the directory
    // existed, so the old check said yes and kept saying yes for six months.
    const root = join(tmp, "empty");
    mkdirSync(join(root, "storage", "session"), { recursive: true });
    const present = withRoot(root, () => {
      const s = new OpenCodeSource();
      const a = s.available();
      s.close();
      return a;
    });
    assert.equal(present, false, "an empty session directory is not available data");
  });

  it("is true when the database has sessions", () => {
    const root = join(tmp, "has-db");
    script(
      new OcBuilder(join(root, "storage"), { sessionId: "ses_hasdb0000000000000001" }),
    ).writeDbTo(join(root, "opencode.db"));
    const present = withRoot(root, () => {
      const s = new OpenCodeSource();
      const a = s.available();
      s.close();
      return a;
    });
    assert.equal(present, true);
  });

  it("is true when only the legacy directory has files", () => {
    const root = join(tmp, "has-legacy");
    script(
      new OcBuilder(join(root, "storage"), { sessionId: "ses_legacy000000000000001" }),
    ).writeTo();
    const present = withRoot(root, () => {
      const s = new OpenCodeSource();
      const a = s.available();
      s.close();
      return a;
    });
    assert.equal(present, true);
  });
});

describe("discover() unions the backends, database first", () => {
  it("prefers the database and keeps sessions only the directory has", () => {
    const root = join(tmp, "union");
    const shared = "ses_shared00000000000001";
    const legacyOnly = "ses_legacyonly0000000001";

    // The shared session exists in both; the database copy must win.
    script(new OcBuilder(join(root, "storage"), { sessionId: shared })).writeTo();
    script(new OcBuilder(join(root, "storage"), { sessionId: legacyOnly })).writeTo();
    script(new OcBuilder(join(root, "storage"), { sessionId: shared })).writeDbTo(
      join(root, "opencode.db"),
    );

    const found = withRoot(root, () => {
      const s = new OpenCodeSource();
      const d = s.discover();
      s.close();
      return d;
    });

    const ids = found.map((f) => f.sessionId).sort();
    assert.deepEqual(ids, [legacyOnly, shared].sort(), "one entry per session, no duplicates");

    const sharedEntry = found.find((f) => f.sessionId === shared);
    assert.ok(
      splitSyntheticPath(sharedEntry?.path ?? ""),
      "the shared session should come from the db",
    );
    const legacyEntry = found.find((f) => f.sessionId === legacyOnly);
    assert.equal(
      splitSyntheticPath(legacyEntry?.path ?? ""),
      null,
      "the legacy-only session should keep its file path",
    );
  });
});

describe("ordering survives the migration's corrupt timestamps", () => {
  it("orders by id when every part carries the same time_created", () => {
    // Reproduces a migrated session: rows inserted in reverse order, and every
    // part.time_created collapsed onto the migration instant. Anything that
    // sorts on that column scrambles six months of timelines.
    const root = join(tmp, "ordering");
    const sid = "ses_ordering000000000001";
    const dbPath = script(new OcBuilder(join(root, "storage"), { sessionId: sid })).writeDbTo(
      join(root, "opencode.db"),
      { reversed: true },
    );

    const runs = withRoot(root, () => {
      const s = new OpenCodeSource();
      const r = s.load(dbPath);
      s.close();
      return r;
    });

    assert.equal(runs.length, 1);
    const run = runs[0] as Run;
    assert.equal(run.events[0]?.kind, "user_message");
    assert.match(run.events[0]?.text ?? "", /add pagination/);
    assert.match(run.events.at(-1)?.text ?? "", /pagination added/);

    // The load-bearing assertion: within the single four-part assistant turn,
    // reasoning precedes the edit, which precedes the write, which precedes the
    // test run. Sorting on `time_created` — identical across all of them —
    // leaves that order to chance.
    const toolOrder = run.events.filter((e) => e.kind === "tool_call").map((e) => e.toolName);
    assert.deepEqual(toolOrder, ["edit", "write", "bash"]);
    const thinkIdx = run.events.findIndex((e) => e.kind === "thinking");
    const firstToolIdx = run.events.findIndex((e) => e.kind === "tool_call");
    assert.ok(thinkIdx >= 0 && thinkIdx < firstToolIdx, "reasoning must precede the tool calls");

    assert.equal(run.fileEdits.length, 2);
    assert.equal(run.commands.length, 1);
  });
});

describe("the shim restores what the migration hoisted into columns", () => {
  it("recovers tool ids and file edits from a database row", () => {
    const root = join(tmp, "shim");
    const sid = "ses_shim00000000000000001";
    const dbPath = script(new OcBuilder(join(root, "storage"), { sessionId: sid })).writeDbTo(
      join(root, "opencode.db"),
    );

    const run = withRoot(root, () => {
      const s = new OpenCodeSource();
      const r = s.load(dbPath);
      s.close();
      return r[0] as Run;
    });

    assert.equal(run.sessionId, sid, "sessionID comes from the column, not the blob");
    const edit = run.fileEdits[0];
    assert.ok(edit?.toolUseId, "callID survives into toolUseId");
    assert.equal(edit?.path, "/Users/dev/code/ledger-svc/src/api.ts");
    assert.ok(run.usage.costUsd && run.usage.costUsd > 0);
    assert.equal(run.usage.costIsEstimate, false, "the agent's own cost is still preferred");
  });
});

describe("reading never writes", () => {
  it("leaves the database and its directory untouched", () => {
    const root = join(tmp, "readonly");
    const sid = "ses_readonly000000000001";
    const db = join(root, "opencode.db");
    const dbPath = script(new OcBuilder(join(root, "storage"), { sessionId: sid })).writeDbTo(db);

    const before = statSync(db);
    const listedBefore = readdirSync(root).sort();

    withRoot(root, () => {
      const s = new OpenCodeSource();
      s.discover();
      s.load(dbPath);
      s.close();
    });

    const after = statSync(db);
    assert.equal(after.size, before.size, "the database file must not change size");
    assert.equal(after.mtimeMs, before.mtimeMs, "the database file must not be rewritten");
    assert.deepEqual(
      readdirSync(root).sort(),
      listedBefore,
      "no -wal or -shm may be created by us",
    );
    assert.equal(existsSync(`${db}-wal`), false);
    assert.equal(existsSync(`${db}-shm`), false);
  });
});
