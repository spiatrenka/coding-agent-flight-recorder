/**
 * Ingest orchestration: discovery, skip-unchanged, force, limits, and the
 * error containment that keeps one bad transcript from aborting a scan.
 *
 * Both source root variables are set for every test. Without that, ingest reads
 * the developer's real ~/.claude — slow and non-deterministic locally, empty on
 * CI — so the same assertion would pass for two different wrong reasons.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { buildAll } from "../src/demo/fixtures.js";
import { buildOpenCodeDemo } from "../src/demo/opencodeDemo.js";
import { ingest } from "../src/ingest.js";
import { register } from "../src/sources/index.js";
import type { DiscoveredFile, Source } from "../src/sources/types.js";
import { Store } from "../src/store.js";

let root: string;
let claudeFiles: string[];
let store: Store;
let dbSeq = 0;

const priorEnv: Record<string, string | undefined> = {};

before(() => {
  root = mkdtempSync(join(tmpdir(), "flightrec-ingest-"));
  for (const k of ["CLAUDE_CONFIG_DIR", "OPENCODE_STORAGE_DIR"]) priorEnv[k] = process.env[k];

  claudeFiles = Object.values(buildAll(join(root, "projects")));
  process.env["CLAUDE_CONFIG_DIR"] = root;

  const ocStorage = join(root, "opencode", "storage");
  buildOpenCodeDemo(ocStorage);
  process.env["OPENCODE_STORAGE_DIR"] = ocStorage;
});

after(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // A fresh database per test: the skip-unchanged behaviour is stateful, so a
  // shared store would make these order-dependent.
  store?.close();
  store = new Store(join(root, `db-${dbSeq++}.db`));
});

describe("ingest", () => {
  it("parses every discovered transcript and stores its runs", () => {
    const res = ingest(store);
    assert.ok(res.filesParsed > 0, "found transcripts");
    assert.ok(res.runsStored >= res.filesParsed, "each file yields at least one run");
    assert.deepEqual(res.sourcesUsed.slice().sort(), ["claude_code", "opencode"]);
    assert.deepEqual(res.errors, []);
  });

  it("skips unchanged files on a second pass", () => {
    const first = ingest(store);
    const second = ingest(store);
    assert.equal(second.filesSkipped, first.filesParsed);
    assert.equal(second.filesParsed, 0);
    assert.equal(second.runsStored, 0);
  });

  it("re-parses unchanged files when forced", () => {
    const first = ingest(store);
    const forced = ingest(store, { force: true });
    assert.equal(forced.filesSkipped, 0);
    assert.equal(forced.filesParsed, first.filesParsed);
  });

  it("honours limit per source", () => {
    const res = ingest(store, { limit: 1 });
    // One file per source, and both sources are available here.
    assert.equal(res.filesSeen, 2);
  });

  it("honours sinceDays", () => {
    const stale = claudeFiles[0];
    assert.ok(stale, "fixture produced at least one Claude Code transcript");
    const longAgo = Date.now() / 1000 - 40 * 86400;
    utimesSync(stale, longAgo, longAgo);

    const all = ingest(new Store(join(root, "since-all.db")));
    const recent = ingest(new Store(join(root, "since-recent.db")), { sinceDays: 7 });
    assert.equal(recent.filesSeen, all.filesSeen - 1, "the backdated file is excluded");
  });

  it("restricts the scan to named sources", () => {
    const res = ingest(store, { sourceNames: ["claude_code"] });
    assert.deepEqual(res.sourcesUsed, ["claude_code"]);
    assert.ok(res.filesParsed > 0);
  });

  it("reports progress once per parsed file", () => {
    const lines: string[] = [];
    const res = ingest(store, { onProgress: (l) => lines.push(l) });
    assert.equal(lines.length, res.filesParsed);
  });

  it("finds nothing when no agent data is present", () => {
    const empty = join(root, "empty");
    const prior = [process.env["CLAUDE_CONFIG_DIR"], process.env["OPENCODE_STORAGE_DIR"]];
    process.env["CLAUDE_CONFIG_DIR"] = empty;
    process.env["OPENCODE_STORAGE_DIR"] = empty;
    try {
      const res = ingest(store);
      assert.deepEqual(res.sourcesUsed, []);
      assert.equal(res.filesSeen, 0);
    } finally {
      process.env["CLAUDE_CONFIG_DIR"] = prior[0] as string;
      process.env["OPENCODE_STORAGE_DIR"] = prior[1] as string;
    }
  });
});

describe("ingest error containment", () => {
  // A detector that throws must cost one file, not the whole scan. These
  // register throwaway sources; node:test gives each file its own process, so
  // the global registry mutation stays contained to this suite.

  it("records a load failure and keeps scanning", () => {
    const broken: Source = {
      name: "broken_load",
      available: () => true,
      discover: (): DiscoveredFile[] => [
        { path: "/nowhere/x.jsonl", sessionId: "broken", mtime: Date.now() / 1000, size: 1 },
      ],
      load: () => {
        throw new Error("unreadable");
      },
    };
    register(broken);

    const res = ingest(store);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0] as string, /unreadable/);
    assert.ok(res.runsStored > 0, "the healthy sources still stored their runs");
  });

  it("records a discovery failure and keeps scanning", () => {
    const broken: Source = {
      name: "broken_discover",
      available: () => true,
      discover: () => {
        throw new Error("permission denied");
      },
      load: () => [],
    };
    register(broken);

    const res = ingest(store);
    assert.ok(
      res.errors.some((e) => /broken_discover: discovery failed/.test(e)),
      "discovery failure is attributed to its source",
    );
    assert.ok(res.runsStored > 0, "the healthy sources still stored their runs");
  });
});
