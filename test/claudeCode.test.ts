/**
 * Claude Code path validation.
 *
 * Every case here came from auditing the detectors against a real Claude Code
 * corpus rather than from imagination: each detector's firing was compared
 * against ground truth computed independently from the traces. The two that
 * disagreed with reality are pinned first.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { analyze } from "../src/analyze/index.js";
import { detectFileChurn } from "../src/analyze/loops.js";
import { analyzeVerification, unverifiedClaimFindings } from "../src/analyze/verify.js";
import type { Run } from "../src/model.js";
import { ClaudeCodeSource } from "../src/sources/claudeCode.js";
import { Builder } from "../src/demo/fixtures.js";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "flightrec-cc-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

function loadOne(b: Builder): Run {
  const path = b.writeTo(root);
  const runs = new ClaudeCodeSource().load(path);
  assert.ok(runs.length >= 1, "expected at least one run");
  return runs[0] as Run;
}

// --------------------------------------------------------------------------

describe("success-claim detection", () => {
  /**
   * These six phrasings were found in a real corpus and matched by *none* of
   * the original patterns — the detector was silent on every claim the agent
   * actually made.
   */
  const REAL_CLAIMS = [
    "41/41 tests pass, typecheck clean. Now the real test.",
    "66/66 passing. Let me commit this.",
    "All 41 existing tests still pass.",
    "Builds clean. Now running the test suite.",
    "Typecheck clean. Now the CLI needs the flag.",
    "It builds clean, typechecks clean, 41/41 tests pass.",
  ];

  for (const text of REAL_CLAIMS) {
    it(`recognises: ${text.slice(0, 42)}…`, () => {
      const run = loadOne(
        new Builder({ sessionId: `claim-${Buffer.from(text).toString("hex").slice(0, 8)}` })
          .user("Fix the rounding bug")
          .edit("/Users/dev/code/payments-api/src/round.ts", "floor", "round")
          .say(text),
      );
      const v = analyzeVerification(run);
      assert.equal(v.status, "not_run", "fixture runs no checks");
      const findings = unverifiedClaimFindings(run, v);
      assert.equal(findings.length, 1, `claim not detected in: ${text}`);
      assert.equal(findings[0]?.severity, "high");
    });
  }

  it("stays silent when the claim is actually backed by a passing check", () => {
    const run = loadOne(
      new Builder({ sessionId: "claim-backed" })
        .user("Fix the rounding bug")
        .edit("/Users/dev/code/payments-api/src/round.ts", "floor", "round")
        .bash("npm test", { stdout: "ℹ tests 41\nℹ pass 41\nℹ fail 0" })
        .say("41/41 tests pass, typecheck clean."),
    );
    const v = analyzeVerification(run);
    assert.equal(v.status, "passed", "the check must resolve as passing");
    assert.equal(unverifiedClaimFindings(run, v).length, 0);
  });

  it("does not fire on ordinary prose that merely mentions tests", () => {
    const run = loadOne(
      new Builder({ sessionId: "claim-none" })
        .user("What does this module do?")
        .say("This module parses tests and reports coverage. I have not run anything."),
    );
    const v = analyzeVerification(run);
    assert.equal(unverifiedClaimFindings(run, v).length, 0);
  });
});

// --------------------------------------------------------------------------

describe("file churn precision", () => {
  const FILE = "/Users/dev/code/payments-api/src/settle.ts";

  it("calls churn with no feedback in between guesswork", () => {
    const b = new Builder({ sessionId: "churn-blind" }).user("Fix the settlement bug");
    for (let i = 0; i < 5; i++) b.edit(FILE, `v${i}`, `v${i + 1}`);
    b.say("Done.");
    const findings = detectFileChurn(loadOne(b));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "medium");
    assert.match(findings[0]?.detail ?? "", /nothing was run to check it/);
    assert.doesNotMatch(findings[0]?.title ?? "", /checked in between/);
  });

  it("downgrades churn when checks ran between the edits", () => {
    const b = new Builder({ sessionId: "churn-checked" }).user("Fix the settlement bug");
    for (let i = 0; i < 5; i++) {
      b.edit(FILE, `v${i}`, `v${i + 1}`);
      b.bash("npm test", { stdout: "ℹ tests 3\nℹ pass 3\nℹ fail 0" });
    }
    b.say("Done.");
    const findings = detectFileChurn(loadOne(b));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "low", "iteration against feedback is not high severity");
    assert.match(findings[0]?.title ?? "", /checked in between/);
    assert.match(findings[0]?.detail ?? "", /iteration against feedback/);
  });

  it("still escalates heavy churn that was never checked", () => {
    const b = new Builder({ sessionId: "churn-heavy" }).user("Fix it");
    for (let i = 0; i < 9; i++) b.edit(FILE, `v${i}`, `v${i + 1}`);
    b.say("Done.");
    assert.equal(detectFileChurn(loadOne(b))[0]?.severity, "high");
  });

  it("does not fire below the threshold", () => {
    const b = new Builder({ sessionId: "churn-under" }).user("Small fix");
    for (let i = 0; i < 3; i++) b.edit(FILE, `v${i}`, `v${i + 1}`);
    b.say("Done.");
    assert.equal(detectFileChurn(loadOne(b)).length, 0);
  });
});

// --------------------------------------------------------------------------

describe("claude code command outcomes without exit codes", () => {
  it("resolves a check from runner output when no exit code exists", () => {
    const run = loadOne(
      new Builder({ sessionId: "cc-nocode" })
        .user("Run the suite")
        .edit("/Users/dev/code/payments-api/src/a.ts", "x", "y")
        .bash("node --test dist/test/*.test.js", { stdout: "ℹ tests 78\nℹ pass 78\nℹ fail 0" }),
    );
    const cmd = run.commands[0];
    assert.ok(cmd);
    assert.equal(cmd.exitCode, null, "Claude Code records no exit code");
    assert.equal(cmd.category, "test", "node --test must classify as a test");
    assert.equal(cmd.ok, true);
    assert.equal(cmd.check?.framework, "node:test");
    assert.equal(cmd.check?.passed, 78);
    assert.equal(analyzeVerification(run).status, "passed");
  });

  it("marks a failing typecheck as failed, not passed", () => {
    const run = loadOne(
      new Builder({ sessionId: "cc-tscfail" })
        .user("Typecheck it")
        .edit("/Users/dev/code/payments-api/src/a.ts", "x", "y")
        .bash("npm run typecheck", { stdout: "src/a.ts(4,1): error TS2345: bad\nFound 1 error." }),
    );
    assert.equal(run.commands[0]?.ok, false);
    assert.equal(analyzeVerification(run).status, "failed");
    assert.notEqual(analyze(run).label, "productive");
  });

  it("leaves an unrecognised command inconclusive rather than passing", () => {
    const run = loadOne(
      new Builder({ sessionId: "cc-ambiguous" })
        .user("Look around")
        .bash("find . -name '*.ts' -maxdepth 2", { stdout: "./src/a.ts\n./src/b.ts" }),
    );
    const cmd = run.commands[0];
    assert.ok(cmd);
    assert.equal(cmd.check, null, "no known framework format here");
    assert.equal(cmd.category, "shell", "not a check command at all");
  });

  it("reports the six routine entry types as known, not drift", () => {
    const run = loadOne(
      new Builder({ sessionId: "cc-drift" })
        .user("Go")
        .raw("last-prompt", { lastPrompt: "Go" })
        .raw("queue-operation", { operation: "enqueue" })
        .raw("permission-mode", { mode: "default" })
        .raw("mode", { mode: "plan" })
        .raw("ai-title", { title: "A session" })
        .raw("bridge-session", {})
        .say("Done."),
    );
    assert.deepEqual(run.schemaDrift, [], `unexpected drift: ${run.schemaDrift.join(", ")}`);
  });
});
