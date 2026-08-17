/**
 * Coverage for the finding ids that production code emits but nothing asserted.
 *
 * A detector that no test exercises is a detector whose thresholds are a guess.
 * These pin the shape of each finding, and — for cost — the invariant that an
 * unknown cost never turns into a "$0 spent" accusation.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { analyze } from "../src/analyze/index.js";
import { classifyPath } from "../src/analyze/risk.js";
import {
  Builder,
  fixtureBigDiff,
  fixtureExpensiveNoDiff,
  fixtureLongNoDiff,
  fixtureRevert,
  fixtureStall,
  fixtureUnverifiedClaim,
  fixtureWideDiff,
} from "../src/demo/fixtures.js";
import { type Finding, netDiffLines, type Run } from "../src/model.js";
import { ClaudeCodeSource } from "../src/sources/claudeCode.js";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "flightrec-findings-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Build, parse and analyse one fixture, asserting it produced a single run. */
function load(b: Builder): { run: Run; findings: Finding[] } {
  const path = b.writeTo(root);
  const runs = new ClaudeCodeSource().load(path);
  assert.equal(runs.length, 1, "fixture should segment into exactly one run");
  const run = runs[0] as Run;
  return { run, findings: analyze(run).findings };
}

const ids = (findings: Finding[]): string[] => findings.map((f) => f.id);
const find = (findings: Finding[], id: string): Finding => {
  const f = findings.find((x) => x.id === id);
  assert.ok(f, `expected a ${id} finding, got: ${ids(findings).join(", ") || "none"}`);
  return f;
};

describe("loop.revert", () => {
  it("flags an edit undone later in the same run", () => {
    const { findings } = load(fixtureRevert());
    const f = find(findings, "loop.revert");
    assert.match(f.title, /undone later/);
    assert.ok(f.evidence.length > 0, "a revert must point at the edits it means");
  });

  it("names the reverted file in its evidence", () => {
    const { findings } = load(fixtureRevert());
    const f = find(findings, "loop.revert");
    assert.ok(
      f.evidence.some((e) => (e.excerpt ?? "").includes("retry.ts")),
      "evidence should name the file that was put back",
    );
  });
});

describe("loop.stall_tail", () => {
  it("flags a long tail of activity after the last file change", () => {
    const { findings } = load(fixtureStall());
    const f = find(findings, "loop.stall_tail");
    assert.match(f.title, /after the last file change/);
  });

  it("reports the tail length in minutes", () => {
    const { findings } = load(fixtureStall());
    assert.match(find(findings, "loop.stall_tail").title, /^\d+ min/);
  });
});

describe("risk.blast_radius", () => {
  // Two independent arms, so both get their own case.
  it("flags a wide change surface from a narrow request", () => {
    const { run, findings } = load(fixtureWideDiff());
    assert.ok((run.goal ?? "").length < 200, "premise: the ask really is short");
    const f = find(findings, "risk.blast_radius");
    assert.match(f.detail, /files changed for a one-line request/);
  });

  it("flags a large diff with no passing verification", () => {
    const { run, findings } = load(fixtureBigDiff());
    const changed = netDiffLines(run);
    assert.ok(changed >= 400, `premise: the diff really is large (was ${changed})`);
    const f = find(findings, "risk.blast_radius");
    assert.match(f.detail, /lines changed with no passing verification/);
  });
});

describe("verify.never_ran", () => {
  it("flags a run that changed files without running anything", () => {
    const { run, findings } = load(fixtureUnverifiedClaim());
    assert.ok(
      run.fileEdits.some((e) => e.applied),
      "premise: files really were changed",
    );
    find(findings, "verify.never_ran");
  });
});

describe("wasted spend", () => {
  it("flags a long run that changed nothing on disk", () => {
    const { findings } = load(fixtureLongNoDiff());
    const f = find(findings, "risk.duration_no_diff");
    assert.match(f.title, /nothing changed on disk/);
  });

  it("does not accuse a run whose cost is unknown", () => {
    // fixtureLongNoDiff runs on an unpriced model, so its cost is null rather
    // than zero. Unknown must stay unknown: reporting "$0.00 spent, nothing
    // changed" would be a confident claim built on missing data.
    const { run, findings } = load(fixtureLongNoDiff());
    assert.equal(run.usage.costUsd, null, "premise: this model has no price entry");
    assert.ok(
      !ids(findings).includes("risk.cost_no_diff"),
      "an unknown cost must not become a spend accusation",
    );
  });

  it("flags known spend that produced no diff", () => {
    const { run, findings } = load(fixtureExpensiveNoDiff());
    assert.ok(run.usage.costUsd !== null, "premise: this run has a modelled cost");
    assert.ok(
      run.usage.costUsd >= 2.0,
      `premise: cost clears the threshold (was ${run.usage.costUsd})`,
    );
    const f = find(findings, "risk.cost_no_diff");
    assert.match(f.title, /with no file changes/);
    assert.equal(f.severity, run.usage.costUsd < 8 ? "medium" : "high");
  });
});

// --------------------------------------------------------------------------

describe("path classification precision", () => {
  // Every case below is a real path from a 484-run corpus that the detectors
  // were measured against. The false ones accounted for 36 of 41 secret-file
  // hits and were the sole cause of 7 `risky` verdicts.

  it("does not treat a committed env template as a secret", () => {
    for (const p of [
      "/x/.env.example",
      "/x/.env.sample",
      "/x/.env.template",
      "/x/.env.dist",
      "/x/.env.default",
      "/x/.env.defaults",
    ]) {
      assert.equal(classifyPath(p).tier, null, `${p} is a template, not a secret`);
    }
  });

  it("still treats real environment files as secrets", () => {
    for (const p of ["/x/.env", "/x/.env.local", "/x/.env.production", "/x/services/.env"]) {
      assert.equal(classifyPath(p).tier, "secret", `${p} holds real values`);
    }
  });

  it("does not treat a directory named secrets as a credentials file", () => {
    // Managing secrets is not holding one.
    for (const p of [
      "/x/scripts/secrets/create-intake-secrets.sh",
      "/x/scripts/secrets/read-intake-secrets.sh",
      "/x/packages/shared/src/secrets/index.ts",
      "/x/src/credentials/loader.ts",
    ]) {
      assert.equal(classifyPath(p).tier, null, `${p} is code about secrets`);
    }
  });

  it("still treats credential-bearing filenames as secrets", () => {
    for (const p of [
      "/x/secrets.yaml",
      "/x/secrets.json",
      "/x/credentials.json",
      "/x/secret-key.txt",
      "/x/secrets_prod.env",
    ]) {
      assert.equal(classifyPath(p).tier, "secret", `${p} names a credential`);
    }
  });
});

describe("unbacked claim evidence", () => {
  it("quotes the claim rather than the head of a long message", () => {
    const preamble = "## Goal\n\n" + "Convert the Jest configuration to TypeScript. ".repeat(12);
    const b = new Builder({ start: new Date("2026-08-12T18:00:00Z") });
    b.user("Convert the jest configs.");
    b.edit("/Users/dev/code/payments-api/jest.config.ts", "module.exports", "export default");
    b.say(`${preamble}\n\nAll tests pass, so this is done.`);
    const { findings } = load(b);

    const f = find(findings, "verify.unbacked_claim");
    const excerpt = f.evidence[0]?.excerpt ?? "";
    assert.match(excerpt, /all tests pass/i, "the excerpt must contain the matched claim");
    assert.ok(excerpt.startsWith("…"), "a trimmed excerpt is marked as trimmed");
  });

  it("quotes from the start when the claim is already near it", () => {
    const b = new Builder({ start: new Date("2026-08-12T19:00:00Z") });
    b.user("Fix the rounding.");
    b.edit("/Users/dev/code/payments-api/src/round.ts", "floor", "round");
    b.say("All tests pass. Nothing else to do.");
    const { findings } = load(b);
    const excerpt = find(findings, "verify.unbacked_claim").evidence[0]?.excerpt ?? "";
    assert.ok(!excerpt.startsWith("…"), "no ellipsis when nothing was trimmed");
    assert.match(excerpt, /^All tests pass/);
  });
});
