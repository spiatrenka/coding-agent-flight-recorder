/**
 * HTTP API tests.
 *
 * Driven over real sockets on port 0 rather than by calling `handle` directly:
 * the thing worth pinning is what a browser receives — status, content-type and
 * body shape — and half of that is produced by the response helpers, not by the
 * routing. An in-process call to `handle` would skip exactly the layer where the
 * camelCase/snake_case contract bugs have historically lived.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { seedDemo } from "../src/demo/index.js";
import { createApp } from "../src/server.js";
import { Store, type StoredRun } from "../src/store.js";

let tmp: string;
let store: Store;
let base: string;
let close: () => Promise<void>;
let priorClaude: string | undefined;
let priorOpenCode: string | undefined;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "flightrec-server-"));
  store = new Store(join(tmp, "test.db"));
  const demo = seedDemo(store, { root: join(tmp, "demo") });

  // `POST /api/ingest` scans whatever these point at. `seedDemo` deliberately
  // restores them, so without this the ingest test reads the developer's real
  // ~/.claude — slow, non-hermetic, and empty on CI. Point them at the synthetic
  // tree that was just built and put them back afterwards.
  priorClaude = process.env["CLAUDE_CONFIG_DIR"];
  priorOpenCode = process.env["OPENCODE_STORAGE_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = demo.root;
  process.env["OPENCODE_STORAGE_DIR"] = join(demo.root, "opencode", "storage");

  const server = createApp(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

after(async () => {
  await close();
  store.close();
  restoreEnv("CLAUDE_CONFIG_DIR", priorClaude);
  restoreEnv("OPENCODE_STORAGE_DIR", priorOpenCode);
  rmSync(tmp, { recursive: true, force: true });
});

function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
}

const get = (path: string) => fetch(`${base}${path}`);
const getJson = async (path: string) => (await get(path)).json();

/** A run id known to exist, picked once so tests do not depend on each other. */
function anyRunId(): string {
  const runs = store.listRuns({ limit: 1, includeTrivial: true });
  const first = runs[0];
  assert.ok(first, "fixture store should contain at least one run");
  return first.run_id;
}

describe("dashboard assets", () => {
  it("serves the dashboard at the root", async () => {
    const res = await get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /<html/i);
  });

  it("serves the same asset under /static/", async () => {
    const res = await get("/static/index.html");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  });

  it("returns a plain-text 404 for an unknown page", async () => {
    const res = await get("/nope");
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  });
});

describe("api", () => {
  it("reports health and the database path", async () => {
    const body = (await getJson("/api/health")) as { ok: boolean; db: string };
    assert.equal(body.ok, true);
    assert.equal(body.db, store.path);
  });

  it("returns aggregate stats", async () => {
    const body = (await getJson("/api/stats")) as Record<string, unknown>;
    assert.ok(Number(body["runs"]) > 0, "seeded store should report runs");
  });

  it("lists projects with run counts", async () => {
    const body = (await getJson("/api/projects")) as Array<{ project_path: string; n: number }>;
    assert.ok(body.length > 0);
    for (const p of body) {
      assert.equal(typeof p.project_path, "string");
      assert.ok(p.n > 0);
    }
  });
});

describe("api run listing", () => {
  it("hides trivial runs by default", async () => {
    const shown = (await getJson("/api/runs")) as Array<{ trivial: number }>;
    assert.ok(shown.length > 0);
    assert.ok(
      shown.every((r) => !r.trivial),
      "default listing must not include trivial runs",
    );
  });

  it("includes trivial runs when asked", async () => {
    const shown = (await getJson("/api/runs")) as unknown[];
    const all = (await getJson("/api/runs?all=1")) as unknown[];
    assert.ok(all.length >= shown.length);
  });

  it("caps the result with limit", async () => {
    const one = (await getJson("/api/runs?limit=1&all=1")) as unknown[];
    assert.equal(one.length, 1);
  });

  it("filters by source", async () => {
    const rows = (await getJson("/api/runs?source=opencode&all=1")) as Array<{ source: string }>;
    assert.ok(rows.length > 0, "demo data includes opencode runs");
    assert.ok(rows.every((r) => r.source === "opencode"));
  });

  it("filters by verdict label", async () => {
    const rows = (await getJson("/api/runs?label=risky&all=1")) as Array<{ label: string }>;
    assert.ok(rows.length > 0, "demo data includes a risky run");
    assert.ok(rows.every((r) => r.label === "risky"));
  });

  it("filters by project path", async () => {
    const all = (await getJson("/api/runs?all=1")) as Array<{ project_path: string | null }>;
    const target = all.find((r) => r.project_path)?.project_path;
    assert.ok(target, "demo data should carry a project path");
    const rows = (await getJson(`/api/runs?all=1&project=${encodeURIComponent(target)}`)) as Array<{
      project_path: string | null;
    }>;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.project_path === target));
  });
});

describe("api single run", () => {
  it("returns the full stored document", async () => {
    const run = (await getJson(`/api/runs/${anyRunId()}`)) as StoredRun;
    assert.ok(run.trace, "trace present");
    assert.ok(run.analysis, "analysis present");
    assert.ok(run.postmortem, "postmortem present");
  });

  it("renders the postmortem as markdown", async () => {
    const res = await get(`/api/runs/${anyRunId()}/markdown`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(await res.text(), /^#/m);
  });

  it("returns a JSON 404 for an unknown run id", async () => {
    const res = await get("/api/runs/does-not-exist");
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), { error: "not found" });
  });
});

describe("api ingest", () => {
  interface IngestBody {
    filesParsed: number;
    filesSkipped: number;
    runsStored: number;
    sourcesUsed: string[];
  }
  const postIngest = async (qs = ""): Promise<IngestBody> => {
    const res = await fetch(`${base}/api/ingest${qs}`, { method: "POST" });
    assert.equal(res.status, 200);
    return (await res.json()) as IngestBody;
  };

  // One test, three POSTs: the skip behaviour is only observable as a sequence,
  // and splitting it across cases would make each depend on the order the runner
  // happens to use. Note `seedDemo` drives the importers directly and never
  // records an ingest, so the first scan here legitimately parses everything.
  it("parses, then skips unchanged, then re-parses when forced", async () => {
    const first = await postIngest();
    assert.ok(first.filesParsed > 0, "first scan parses the synthetic tree");
    assert.deepEqual(first.sourcesUsed.slice().sort(), ["claude_code", "opencode"]);

    const second = await postIngest();
    assert.equal(second.filesParsed, 0, "second scan re-parses nothing");
    assert.equal(second.filesSkipped, first.filesParsed, "every file recognised as unchanged");
    assert.equal(second.runsStored, 0);

    const forced = await postIngest("?force=1");
    assert.equal(forced.filesSkipped, 0, "force ignores the ingest log");
    assert.equal(forced.filesParsed, first.filesParsed);
  });

  it("returns a JSON 404 for an unknown POST path", async () => {
    const res = await fetch(`${base}/api/nope`, { method: "POST" });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
  });
});

describe("handler failure", () => {
  it("answers 500 rather than taking the process down", async () => {
    // A store whose stats() throws stands in for any malformed stored run. The
    // point is that one bad row degrades one request, not the whole dashboard.
    const broken = {
      path: ":memory:",
      stats() {
        throw new Error("boom");
      },
    } as unknown as Store;

    const server = createApp(broken);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /boom/);
      // Still serving afterwards — the throw did not kill the listener.
      assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
