/**
 * The importer registry is a documented extension seam — the README tells
 * people to implement `Source` and call `register`. That makes its behaviour a
 * public contract, so it gets a contract test rather than incidental coverage.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { buildAll } from "../src/demo/fixtures.js";
import { allSources, availableSources, get, register } from "../src/sources/index.js";
import type { Source } from "../src/sources/types.js";

let root: string;
const priorEnv: Record<string, string | undefined> = {};

before(() => {
  root = mkdtempSync(join(tmpdir(), "flightrec-sources-"));
  for (const k of ["CLAUDE_CONFIG_DIR", "OPENCODE_STORAGE_DIR", "CODEX_HOME"]) {
    priorEnv[k] = process.env[k];
  }
});

after(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("registry", () => {
  it("registers the built-in importers", () => {
    const names = allSources().map((s) => s.name);
    for (const expected of ["claude_code", "opencode", "codex"]) {
      assert.ok(names.includes(expected), `${expected} should be registered`);
    }
  });

  it("returns a registered source by name", () => {
    assert.equal(get("claude_code").name, "claude_code");
  });

  it("throws a named error for an unknown source", () => {
    assert.throws(() => get("nope"), /unknown source 'nope'/);
  });

  it("accepts a custom importer", () => {
    const custom: Source = {
      name: "test_custom_source",
      available: () => false,
      discover: () => [],
      load: () => [],
    };
    register(custom);
    assert.equal(get("test_custom_source"), custom);
    assert.ok(allSources().includes(custom));
  });
});

describe("availability reflects what is on disk", () => {
  it("reports nothing available against an empty root", () => {
    const empty = join(root, "empty");
    process.env["CLAUDE_CONFIG_DIR"] = empty;
    process.env["OPENCODE_STORAGE_DIR"] = empty;
    const names = availableSources().map((s) => s.name);
    assert.ok(!names.includes("claude_code"));
    assert.ok(!names.includes("opencode"));
  });

  it("reports claude_code available once transcripts exist", () => {
    const home = join(root, "claude");
    buildAll(join(home, "projects"));
    process.env["CLAUDE_CONFIG_DIR"] = home;
    assert.ok(availableSources().some((s) => s.name === "claude_code"));
  });
});

describe("the codex seam", () => {
  it("is registered but not yet available", () => {
    const codex = get("codex");
    assert.equal(codex.available(), false);
    assert.deepEqual(codex.discover(), []);
  });

  it("explains that it is not implemented rather than failing obscurely", () => {
    assert.throws(() => get("codex").load("/anything"), /not implemented/i);
  });
});
