/**
 * Regression tests for the detectors and the verdict.
 *
 * The point of a deterministic postmortem is that it can be tested. Each fixture is
 * built to land on exactly one verdict; if a change to a detector moves one of these,
 * that is a behaviour change and should be a deliberate one.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { type Analysis, analyze } from "../src/analyze/index.js";
import { ALL } from "../src/demo/fixtures.js";
import { filesTouched, linesAdded, linesRemoved, type Run, totalTokens } from "../src/model.js";
import { generate } from "../src/postmortem.js";
import { containsSecret, redact } from "../src/redact.js";
import { ClaudeCodeSource } from "../src/sources/claudeCode.js";
import { Store } from "../src/store.js";

const TMP = mkdtempSync(join(tmpdir(), "flightrec-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const source = new ClaudeCodeSource();

function load(name: keyof typeof ALL): Run[] {
  const factory = ALL[name];
  assert.ok(factory, `unknown fixture ${name}`);
  return source.load(factory().writeTo(TMP));
}

function loadOne(name: keyof typeof ALL): Run {
  const runs = load(name);
  assert.ok(runs[0], `fixture ${name} produced no run`);
  return runs[0];
}

function analyzed(name: keyof typeof ALL): { run: Run; a: Analysis } {
  const run = loadOne(name);
  return { run, a: analyze(run) };
}

describe("parser", () => {
  const runs = load("productive");

  it("yields one run for a transcript with no idle gap", () => {
    assert.equal(runs.length, 1);
  });

  it("reads cwd and branch from the entries", () => {
    assert.equal(runs[0]?.projectPath, "/Users/dev/code/payments-api");
    assert.equal(runs[0]?.gitBranch, "feat/refund-window");
  });

  it("takes the goal from the first user prompt", () => {
    assert.equal(runs[0]?.goalIsKnown, true);
    assert.match(runs[0]?.goal ?? "", /off by one/);
  });

  it("counts lines from structuredPatch", () => {
    const run = runs[0] as Run;
    assert.equal(filesTouched(run).length, 2);
    assert.ok(linesAdded(run) > 0);
    assert.ok(linesRemoved(run) > 0);
  });

  it("accumulates token counters", () => {
    assert.ok(totalTokens((runs[0] as Run).usage) > 0);
  });
});

describe("segmentation", () => {
  const segs = load("twoSegments");

  it("splits one file into two runs on a 95-minute idle gap", () => {
    assert.equal(segs.length, 2);
  });

  it("gives segments distinct run ids", () => {
    assert.notEqual(segs[0]?.runId, segs[1]?.runId);
  });

  it("counts compaction inline rather than splitting on it", () => {
    assert.equal(segs[1]?.compactions, 1);
  });
});

describe("verdicts", () => {
  const expected: Array<[keyof typeof ALL, string]> = [
    ["productive", "productive"],
    ["wasteful", "wasteful"],
    ["risky", "risky"],
    ["unverifiedClaim", "questionable"],
    ["longNoDiff", "wasteful"],
    // The no-change case. Before `unchanged` existed this shared `questionable`
    // with unverifiedClaim above — two opposite situations under one label.
    ["question", "unchanged"],
  ];
  for (const [fixture, want] of expected) {
    it(`labels the ${fixture} fixture '${want}'`, () => {
      assert.equal(analyzed(fixture).a.label, want);
    });
  }
});

describe("loop detection", () => {
  const { run, a } = analyzed("wasteful");
  const kinds = new Set(a.findings.map((f) => f.id.split(".")[1]));

  it("flags the same failing test command", () => assert.ok(kinds.has("repeat_failure")));
  it("flags identical repeated tool calls", () => assert.ok(kinds.has("identical_call")));
  it("flags repeated edits to one file", () => assert.ok(kinds.has("churn")));

  it("identifies a stop point early in the run", () => {
    assert.ok(a.stopPoint);
    assert.ok((a.stopPoint?.eventIdx ?? Infinity) < run.events.length / 2);
  });

  it("quantifies the wasted tail", () => {
    assert.ok((a.stopPoint?.eventsAfter ?? 0) > 10);
  });
});

describe("risk detection", () => {
  const { a } = analyzed("risky");
  const ids = new Set(a.findings.map((f) => f.id));

  it("flags editing .env", () => assert.ok(ids.has("risk.secret_file_write")));
  it("flags reading .env", () => assert.ok(ids.has("risk.secret_file_read")));
  it("flags an edit outside the project root", () => assert.ok(ids.has("risk.outside_project")));
  it("flags git reset --hard as destructive", () => assert.ok(ids.has("risk.destructive_command")));
  it("reports a denied force-push separately", () =>
    assert.ok(ids.has("risk.destructive_attempt")));
  it("flags a CI workflow edit", () => assert.ok(ids.has("risk.config_file_write")));
  it("raises at least one high-severity finding", () => {
    assert.ok(a.findings.some((f) => f.severity === "high"));
  });
});

describe("verification", () => {
  it("detects that no checks ran", () => {
    assert.equal(analyzed("unverifiedClaim").a.verification.status, "not_run");
  });

  it("flags 'all tests pass' with no test run", () => {
    const { a } = analyzed("unverifiedClaim");
    assert.ok(a.findings.some((f) => f.id === "verify.unbacked_claim"));
  });

  it("reads a passing test plus typecheck as passed", () => {
    assert.equal(analyzed("productive").a.verification.status, "passed");
  });

  it("raises no high-severity findings on a clean run", () => {
    assert.ok(!analyzed("productive").a.findings.some((f) => f.severity === "high"));
  });
});

describe("cost", () => {
  it("estimates cost for a known model", () => {
    assert.notEqual(analyzed("productive").run.usage.costUsd, null);
  });

  it("returns unknown rather than $0.00 for an unpriced model", () => {
    const { run } = analyzed("longNoDiff");
    assert.equal(run.usage.costUsd, null);
    assert.ok(run.usage.unpricedModels.length > 0);
  });

  it("prices cache reads far below input tokens", () => {
    const { run } = analyzed("productive");
    // ~504k cache-read tokens on Opus would exceed $7 at full input price;
    // at the cache-read rate it should stay well under a dollar per 100k.
    assert.ok((run.usage.costUsd ?? 0) < 2, `unexpectedly high: ${run.usage.costUsd}`);
  });
});

describe("redaction", () => {
  it("masks api keys", () => {
    assert.ok(!redact("STRIPE_SECRET_KEY=sk-live_4eC39HqLyjWDarjtT1zdp7dc").includes("4eC39Hq"));
  });

  it("masks inline connection-string passwords", () => {
    assert.ok(!redact("postgres://app:hunter2@db:5432/x").includes("hunter2"));
  });

  it("leaves ordinary text alone", () => {
    assert.equal(containsSecret("just some normal log output"), false);
  });

  it("redacts before anything reaches the store", () => {
    const { run } = analyzed("risky");
    const blob = run.events.map((e) => e.text ?? "").join("\n");
    assert.ok(!blob.includes("sk-live_4eC39HqLyjWDarjtT1zdp7dc"));
    assert.ok(!blob.includes("hunter2"));
  });
});

describe("determinism", () => {
  it("produces a byte-identical postmortem for the same run", () => {
    const run = loadOne("wasteful");
    const first = generate(run, analyze(run)).markdown.split("Generated")[0];
    const second = generate(run, analyze(run)).markdown.split("Generated")[0];
    assert.equal(first, second);
  });
});

describe("store", () => {
  it("round-trips and upserts idempotently", () => {
    const store = new Store(join(TMP, "t.db"));
    const run = loadOne("risky");
    const a = analyze(run);
    store.upsert(run, a, generate(run, a));
    store.upsert(run, a, generate(run, a));

    assert.equal(store.listRuns().length, 1);
    const got = store.getRun(run.runId);
    assert.equal(got?.postmortem.label, "risky");
    assert.equal(got?.trace.source, "claude_code");
    store.close();
  });
});

describe("tolerance to schema drift", () => {
  const weird = join(TMP, "weird.jsonl");
  writeFileSync(
    weird,
    [
      '{"type":"user","sessionId":"x","timestamp":"2026-08-01T10:00:00Z",' +
        '"cwd":"/tmp/p","message":{"role":"user","content":"do a thing"}}',
      '{"type":"quantum-entry","sessionId":"x","version":"9.9.9",' +
        '"timestamp":"2026-08-01T10:00:05Z","payload":{"nested":[1,2,3]}}',
      "not json at all",
      '{"type":"assistant","sessionId":"x","timestamp":"2026-08-01T10:00:09Z",' +
        '"message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
    ].join("\n"),
    "utf8",
  );
  const runs = source.load(weird);

  it("does not abort on an unknown entry type or a malformed line", () => {
    assert.equal(runs.length, 1);
  });

  it("records the unknown entry type as drift", () => {
    assert.ok((runs[0]?.schemaDrift.length ?? 0) > 0);
  });

  it("surfaces drift in the postmortem", () => {
    const run = runs[0] as Run;
    assert.match(generate(run, analyze(run)).markdown, /Parser warnings/);
  });
});
