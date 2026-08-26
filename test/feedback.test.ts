/**
 * The one property `flightrec feedback` has to have: a colleague can paste its
 * output without reading it first.
 *
 * Two tests carry that claim, and they fail differently on purpose.
 *
 * The canary test catches a leak through a *derived* value — a count formatted
 * into a sentence that happens to include the string, a title copied into a
 * detail. The Proxy test catches the field being *read at all*, which is the
 * stronger and more durable statement: it fails the moment someone adds
 * `f.title` to the summary, whether or not that particular fixture's title
 * happens to contain anything private.
 *
 * The Proxy technique is the one `test/dashboard.test.ts` already uses, for the
 * reason recorded in `docs/DECISIONS.md`: string-searching a payload for private
 * data produces false positives by the hundred, while a read that is wrong by
 * definition is exact. Here it is exact in both directions, because the summary
 * reduces `schemaDrift` to a count and so needs no exemption at all.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { analyze } from "../src/analyze/index.js";
import { seedDemo } from "../src/demo/index.js";
import { OcBuilder } from "../src/demo/opencodeFixtures.js";
import { buildFeedback, formatFeedback } from "../src/feedback.js";
import { generate } from "../src/postmortem.js";
import { survivingSecretKinds } from "../src/redact.js";
import { OpenCodeSource } from "../src/sources/opencode.js";
import { Store } from "../src/store.js";

/** Every one of these must be absent from the summary. */
const CANARIES = {
  goal: "ZZGOALZZ",
  branch: "ZZBRANCHZZ",
  file: "ZZFILEZZ",
  command: "ZZCMDZZ",
  output: "ZZOUTZZ",
  said: "ZZSAYZZ",
  mcpServer: "ZZSERVERZZ",
  drift: "ZZDRIFTZZ",
};

let tmp: string;
let store: Store;
let canaryRunId: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "flightrec-feedback-"));
  store = new Store(join(tmp, "test.db"));

  const storage = join(tmp, "storage");
  const path = new OcBuilder(storage, { sessionId: "ses_feedback00000000000001" })
    .user(`please fix ${CANARIES.goal} in the ledger`)
    .think(`I will look at ${CANARIES.file}`)
    .bash(`echo ${CANARIES.command}`, CANARIES.output)
    .edit(`/Users/jane/${CANARIES.branch}/${CANARIES.file}.ts`, "const a = 1;", "const a = 2;")
    .write(`/Users/jane/${CANARIES.branch}/new-${CANARIES.file}.ts`, "export const x = 1;\n")
    .weird(CANARIES.drift)
    .say(CANARIES.said)
    .writeTo();

  process.env["OPENCODE_STORAGE_DIR"] = storage;
  try {
    for (const r of new OpenCodeSource().load(path)) {
      const a = analyze(r);
      store.upsert(r, a, generate(r, a));
      canaryRunId = r.runId;
    }
  } finally {
    delete process.env["OPENCODE_STORAGE_DIR"];
  }

  seedDemo(store);
});

after(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("flightrec feedback", () => {
  it("lets no free text out of the trace", () => {
    const f = buildFeedback(store, canaryRunId, "0.0.0-test");
    assert.ok(f, "the canary run should be present");

    const rendered = formatFeedback(f);
    const serialised = JSON.stringify(f);

    for (const [what, canary] of Object.entries(CANARIES)) {
      assert.ok(!rendered.includes(canary), `${what} (${canary}) leaked into the rendered summary`);
      assert.ok(!serialised.includes(canary), `${what} (${canary}) leaked into --json`);
    }
  });

  it("buckets an MCP tool name rather than naming the server", () => {
    const f = buildFeedback(store, canaryRunId, "0.0.0-test");
    assert.ok(f);
    // The server segment of `mcp__<server>__<tool>` is routinely an internal
    // system name, so the whole class is collapsed to one bucket.
    assert.ok(f.tools.every((t) => !t.name.includes("__")));
  });

  it("reads no field it is not allowed to read", () => {
    // Wrong by definition rather than wrong for this fixture: adding
    // `finding.title` to the summary fails this even when the title is benign.
    const forbidden = new Set([
      "goal",
      "projectPath",
      "gitBranch",
      "sessionId",
      "sourceFile",
      "startedAt",
      "endedAt",
      "text",
      "error",
      "command",
      "stdoutTail",
      "stderrTail",
      "diffHunks",
      "toolInput",
      "excerpt",
      "title",
      "detail",
      "markdown",
      "reason",
      "labelReason",
      "trigger",
      "stopTrigger",
    ]);

    const guard = (value: unknown, path: string): unknown => {
      if (value === null || typeof value !== "object") return value;
      return new Proxy(value as object, {
        get(target, key, recv): unknown {
          if (typeof key === "string" && forbidden.has(key)) {
            throw new Error(`${path}.${key} — read a field the summary must not carry`);
          }
          return guard(Reflect.get(target, key, recv), `${path}.${String(key)}`);
        },
      });
    };

    const real = store.getRun(canaryRunId);
    assert.ok(real);
    const guardedStore = {
      getRun: (): unknown => guard(real, "run"),
    } as unknown as Store;

    // Must not throw.
    const f = buildFeedback(guardedStore, canaryRunId, "0.0.0-test");
    assert.ok(f);
    assert.doesNotThrow(() => formatFeedback(f));
  });

  it("leaves no credential shape in the summary", () => {
    // The allowlist is the boundary; this is the same secondary audit
    // `flightrec corpus` runs over stored text, applied to the paste.
    for (const r of store.listRuns({ limit: 200, includeTrivial: true })) {
      const f = buildFeedback(store, r.run_id, "0.0.0-test");
      assert.ok(f);
      assert.deepEqual(survivingSecretKinds(formatFeedback(f)), [], `run ${r.run_id}`);
    }
  });

  it("stays short enough to paste", () => {
    // A summary that grows into a report stops being pasted at all.
    for (const r of store.listRuns({ limit: 200, includeTrivial: true })) {
      const f = buildFeedback(store, r.run_id, "0.0.0-test");
      assert.ok(f);
      const text = formatFeedback(f);
      const lines = text.split("\n").length;
      assert.ok(lines <= 32, `run ${r.run_id} rendered ${lines} lines`);
      assert.ok(text.length <= 2200, `run ${r.run_id} rendered ${text.length} chars`);
    }
  });

  it("returns null for a run that does not exist", () => {
    assert.equal(buildFeedback(store, "cl-nosuchrun", "0.0.0-test"), null);
  });
});
