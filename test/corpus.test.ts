/**
 * Corpus audit tests.
 *
 * The audit is the tool that makes the corpus check in CONTRIBUTING a single
 * command, so its own counting has to be trustworthy. Seeded from `seedDemo` so
 * it stays hermetic like the rest of the suite.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { analyze } from "../src/analyze/index.js";
import { auditCorpus, formatCorpusReport } from "../src/corpus.js";
import { Builder } from "../src/demo/fixtures.js";
import { seedDemo } from "../src/demo/index.js";
import { detectorOf } from "../src/model.js";
import { generate } from "../src/postmortem.js";
import { redactDeep, survivingSecretKinds } from "../src/redact.js";
import { ClaudeCodeSource } from "../src/sources/claudeCode.js";
import { Store } from "../src/store.js";

let root: string;
let store: Store;

before(() => {
  root = mkdtempSync(join(tmpdir(), "flightrec-corpus-"));
  store = new Store(join(root, "corpus.db"));
  seedDemo(store, { root: join(root, "demo") });
});

after(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("detectorOf", () => {
  it("collapses the three instance-scoped ids onto their detector", () => {
    assert.equal(detectorOf("loop.churn.440bffc744fc"), "loop.churn");
    assert.equal(detectorOf("loop.identical_call.cae2c60cde765060"), "loop.identical_call");
    assert.equal(detectorOf("loop.repeat_failure.eada857045f7"), "loop.repeat_failure");
  });

  it("leaves every stable id untouched", () => {
    for (const id of [
      "loop.revert",
      "loop.stall_tail",
      "risk.blast_radius",
      "risk.config_file_write",
      "risk.cost_no_diff",
      "risk.destructive_attempt",
      "risk.destructive_command",
      "risk.duration_no_diff",
      "risk.outside_project",
      "risk.secret_file_read",
      "risk.secret_file_write",
      "verify.never_ran",
      "verify.unbacked_claim",
    ]) {
      assert.equal(detectorOf(id), id, `${id} has no instance segment`);
    }
  });
});

describe("audit counting", () => {
  it("agrees with the store on run and verdict counts", () => {
    const r = auditCorpus(store);
    const stats = store.stats() as { runs: number; labels: Record<string, number> };
    assert.equal(r.coverage.runs, stats.runs);
    for (const v of r.verdicts) {
      assert.equal(v.n, stats.labels[v.key], `${v.key} count must match stats()`);
    }
    assert.equal(
      r.verdicts.reduce((n, v) => n + v.n, 0),
      r.coverage.runs,
      "verdicts must partition the corpus",
    );
  });

  it("counts a detector once per run, not once per instance", () => {
    // The wasteful fixture churns the same file repeatedly, producing several
    // `loop.churn.<hash>` findings in one run. Grouping is the entire point of
    // detectorOf, so assert the row appears once and never exceeds the run count.
    const r = auditCorpus(store);
    const churn = r.detectors.filter((d) => d.detector === "loop.churn");
    assert.equal(churn.length, 1, "one row per detector");
    for (const d of r.detectors) {
      assert.ok(d.runs <= r.coverage.runs, `${d.detector} cannot affect more runs than exist`);
      assert.ok(d.pct <= 100);
    }
  });

  it("reports command outcomes per source, keeping unknown separate", () => {
    const r = auditCorpus(store);
    assert.ok(r.commandOutcomes.length >= 2, "demo data covers both importers");
    const cc = r.commandOutcomes.find((o) => o.source === "claude_code");
    assert.ok(cc);
    // Claude Code records no exit codes, so some outcomes are genuinely unknown.
    // That must not be folded into "failed".
    assert.ok(cc.unknown > 0, "claude_code leaves some outcomes unknown");
    assert.ok(cc.failed <= cc.known, "failed is a subset of known");
  });

  it("explains an empty store rather than dividing by zero", () => {
    const empty = new Store(join(root, "empty.db"));
    try {
      const r = auditCorpus(empty);
      assert.equal(r.coverage.runs, 0);
      assert.deepEqual(r.verdicts, []);
      assert.equal(r.redaction.masksApplied, 0);
    } finally {
      empty.close();
    }
  });

  it("renders without throwing, including the empty case", () => {
    assert.match(formatCorpusReport(auditCorpus(store)), /COVERAGE/);
    const empty = new Store(join(root, "empty2.db"));
    try {
      assert.match(formatCorpusReport(auditCorpus(empty)), /\(none\)/);
    } finally {
      empty.close();
    }
  });
});

describe("redaction self-check", () => {
  it("finds nothing surviving in the demo corpus", () => {
    const r = auditCorpus(store);
    assert.ok(r.redaction.masksApplied > 0, "the demo data contains scrubbed credentials");
    assert.equal(r.redaction.runsWithSurvivors, 0, "nothing credential-shaped should survive");
    assert.deepEqual(r.redaction.survivingKinds, []);
  });

  it("does not mistake an applied mask for a survivor", () => {
    // `[redacted]` is a run of non-whitespace characters, so a naive re-scan of
    // `TOKEN=[redacted]` reports the very redaction that succeeded.
    assert.deepEqual(survivingSecretKinds("GITHUB_TOKEN=[redacted]"), []);
    assert.deepEqual(survivingSecretKinds("Authorization: Bearer [redacted]"), []);
  });

  it("still reports a genuine survivor", () => {
    const kinds = survivingSecretKinds("STRIPE_SECRET_KEY=sk-live_4eC39HqLyjWDarjtT1zdp7dc");
    assert.ok(kinds.length > 0, "an unmasked key must be reported");
    assert.ok(kinds.includes("sk- key"));
  });
});

describe("tool input is redacted, not just tool output", () => {
  // Found by running the audit against its own demo data. Redaction was applied
  // to command output and tool results but never to tool *input* — so an Edit
  // that wrote a credential into a file stored that credential verbatim in
  // `toolInput.new_string`. That is precisely the case
  // `risk.secret_file_write` exists to flag.

  it("scrubs a credential the agent wrote into a file", () => {
    const b = new Builder({ start: new Date("2026-08-12T20:00:00Z") });
    b.user("Add the Stripe key to the env file.");
    b.edit(
      "/Users/dev/code/payments-api/.env",
      "STAGING=true",
      "STAGING=true\nSTRIPE_SECRET_KEY=sk-live_4eC39HqLyjWDarjtT1zdp7dc",
    );
    b.say("Added.");

    const path = b.writeTo(join(root, "toolinput"));
    const run = new ClaudeCodeSource().load(path)[0];
    assert.ok(run);

    const blob = JSON.stringify(run);
    assert.doesNotMatch(blob, /sk-live_4eC39/, "the key must not be stored anywhere in the run");
    assert.deepEqual(survivingSecretKinds(blob), []);

    // And the surrounding structure has to survive, because the analyzers and
    // the dashboard read known keys out of toolInput.
    const call = run.events.find((e) => e.kind === "tool_call" && e.toolName === "Edit");
    assert.ok(call?.toolInput);
    assert.equal(call.toolInput["file_path"], "/Users/dev/code/payments-api/.env");
  });

  it("preserves shape and non-secret values when redacting deeply", () => {
    const input = {
      file_path: "/x/y.ts",
      nested: { list: ["plain", "TOKEN=abcdef123456", 7, null], flag: true },
    };
    const out = redactDeep(input);
    assert.equal(out.file_path, "/x/y.ts");
    assert.equal(out.nested.flag, true);
    assert.equal(out.nested.list[0], "plain");
    assert.equal(out.nested.list[2], 7);
    assert.equal(out.nested.list[3], null);
    assert.match(String(out.nested.list[1]), /\[redacted\]/);
  });

  it("still flags the write itself — redaction does not hide the finding", () => {
    // Scrubbing the value must not scrub the evidence that a secret file was
    // written, or the detector would be defeated by its own mitigation.
    const b = new Builder({ start: new Date("2026-08-12T21:00:00Z") });
    b.user("Write the key.");
    b.edit("/Users/dev/code/payments-api/.env", "A=1", "A=1\nAPI_TOKEN=sk-live_abcdefghijklmnop");
    b.say("Done.");
    const run = new ClaudeCodeSource().load(b.writeTo(join(root, "stillflags")))[0];
    assert.ok(run);
    const a = analyze(run);
    generate(run, a); // must not throw on redacted content
    assert.ok(
      a.findings.some((f) => f.id === "risk.secret_file_write"),
      "the write is still reported",
    );
  });
});
