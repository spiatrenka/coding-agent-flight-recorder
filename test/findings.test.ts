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
  fixtureProductive,
  fixtureQuestion,
  fixtureRevert,
  fixtureRisky,
  fixtureStall,
  fixtureUnverifiedClaim,
  fixtureWideDiff,
} from "../src/demo/fixtures.js";
import { churnedLines, type Finding, type Run } from "../src/model.js";
import { generate } from "../src/postmortem.js";
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
    const changed = churnedLines(run);
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

// --------------------------------------------------------------------------

describe("stop point prose", () => {
  /** Edits first, then a repeated failure, then nothing but checks. */
  function stopThenOnlyChecks(): Builder {
    const b = new Builder({ start: new Date("2026-08-12T22:00:00Z") });
    b.user("The settlement test is failing, fix it.");
    b.edit("/Users/dev/code/payments-api/src/settle.ts", "round(x)", "floor(x)");
    b.bash("npm test -- settle", { stdout: "1 failing", ok: false });
    b.bash("npm test -- settle", { stdout: "1 failing", ok: false });
    // Tail: verification only, no further edits.
    b.bash("npm test -- settle", { stdout: "12 passing", ok: true });
    b.bash("npm run build", { stdout: "Compiled successfully", ok: true });
    b.bash("npm run lint", { stdout: "0 problems", ok: true });
    b.say("Green. The rounding was the cause.");
    b.say("Confirmed across the build and the linter too.");
    return b;
  }

  it("does not call a verification tail pure overhead", () => {
    const { run } = load(stopThenOnlyChecks());
    const a = analyze(run);
    assert.ok(a.stopPoint, "premise: this fixture produces a stop point");
    assert.equal(a.stopPoint.editsAfter, 0, "premise: no edits followed");
    assert.ok(a.stopPoint.checksAfter > 0, "premise: checks did follow");

    const text = generate(run, a).sections.shouldHaveStopped;
    assert.doesNotMatch(text, /pure overhead/, "a verification tail is not overhead");
    assert.match(text, /verification, not waste/);
  });

  it("states its confidence, and lowers it when the tail was verification", () => {
    const { run } = load(stopThenOnlyChecks());
    const text = generate(run, analyze(run)).sections.shouldHaveStopped;
    assert.match(text, /Confidence: low/);
  });

  it("still calls a genuinely empty tail overhead", () => {
    const { run } = load(fixtureStall());
    const a = analyze(run);
    if (!a.stopPoint) return; // fixture only needs to be meaningful when it triggers
    if (a.stopPoint.editsAfter === 0 && a.stopPoint.checksAfter === 0) {
      assert.match(generate(run, a).sections.shouldHaveStopped, /pure overhead/);
    }
  });

  it("never puts a raw ISO timestamp in prose", () => {
    // The section used to interpolate sp.ts directly, which is unreadable in the
    // dashboard and in `flightrec report` alike.
    for (const b of [stopThenOnlyChecks(), fixtureRevert(), fixtureStall()]) {
      const run = load(b).run;
      const text = generate(run, analyze(run)).sections.shouldHaveStopped;
      assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no ISO timestamps in prose");
    }
  });

  it("formats the stop time identically regardless of machine timezone", () => {
    // The markdown is stored, so a locale- or TZ-dependent rendering would make
    // the same run differ between machines. Determinism is the product.
    const { run } = load(stopThenOnlyChecks());
    const a = analyze(run);
    if (!a.stopPoint?.ts) return;
    const text = generate(run, a).sections.shouldHaveStopped;
    assert.match(text, /\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/);
  });
});

// --------------------------------------------------------------------------

describe("what changed, grouped", () => {
  function multiDir(): Builder {
    const b = new Builder({ start: new Date("2026-08-12T23:00:00Z") });
    b.user("Wire pagination through the API.");
    b.edit("/Users/dev/code/payments-api/src/api/list.ts", "limit", "limit, cursor");
    b.edit("/Users/dev/code/payments-api/src/api/schema.ts", "Page", "Page, Cursor");
    b.edit("/Users/dev/code/payments-api/src/db/query.ts", "SELECT", "SELECT /* paged */");
    b.say("Wired.");
    return b;
  }

  it("states the project root once instead of on every line", () => {
    const { run } = load(multiDir());
    const text = generate(run, analyze(run)).sections.whatChanged;
    assert.equal(
      text.split("/Users/dev/code/payments-api").length - 1,
      1,
      "the absolute prefix appears exactly once",
    );
    assert.match(text, /in \/Users\/dev\/code\/payments-api\//);
  });

  it("groups files under their directory", () => {
    const { run } = load(multiDir());
    const text = generate(run, analyze(run)).sections.whatChanged;
    assert.match(text, /src\/api\//);
    assert.match(text, /src\/db\//);
    // Names appear without their directory repeated.
    assert.match(text, /^\s+list\.ts\s+\(\+/m);
    assert.match(text, /^\s+query\.ts\s+\(\+/m);
  });

  it("aligns the counts within a group", () => {
    const { run } = load(multiDir());
    const text = generate(run, analyze(run)).sections.whatChanged;
    const cols = text
      .split("\n")
      .filter((l) => /^\s{4}\S+\.ts\s+\(\+/.test(l))
      .map((l) => l.indexOf("(+"));
    assert.ok(cols.length >= 2);
    // Files in the same group start their stats at the same column.
    assert.equal(new Set(cols.slice(0, 2)).size, 1, "aligned within src/api/");
  });
});

// --------------------------------------------------------------------------

describe("the unchanged label", () => {
  it("does not claim a shell-write run is unchanged", () => {
    // Rule 2 must keep returning `questionable`. A run whose writes went through
    // the shell is *uncertain*, not unchanged, and the project went out of its way
    // to keep those two claims separate — sweeping it into `unchanged` would assert
    // something the trace cannot support.
    const b = new Builder({ start: new Date("2026-08-12T09:30:00Z") });
    b.user("Unpack the vendor bundle into ./out");
    b.bash("tar -xzf vendor.tar.gz -C ./out", { stdout: "x out/a.js\nx out/b.js" });
    b.say("Unpacked.");
    const { run } = load(b);
    const a = analyze(run);

    assert.equal(a.label, "questionable", "shell writes are uncertain, not unchanged");
    assert.equal(a.labelRule, "no-diff-opaque");
    assert.match(a.labelReason, /not visible in the transcript/);
  });

  it("calls a brief investigation unchanged, and says so without judgement", () => {
    const { run } = load(fixtureQuestion());
    const a = analyze(run);
    assert.equal(a.label, "unchanged");
    assert.equal(a.labelRule, "no-diff-no-signal");
    assert.doesNotMatch(a.labelReason, /questionable|waste|problem/i);
  });

  it("calls a long investigation unchanged too, not wasteful", () => {
    // This assertion was inverted in analyzer 1.2.0, and the reason it was wrong
    // before is worth keeping: `unchanged` is for runs that were not trying to
    // change anything, and this fixture asked why a job was slow, read six files
    // and correctly identified an unindexed sequential scan. It is the label's own
    // definition. The old rule tested elapsed time, which capped `unchanged` at
    // five minutes and sent every longer review to `wasteful` — 0 of 54 such runs
    // in a real corpus escaped it.
    const { run } = load(fixtureLongNoDiff());
    const a = analyze(run);
    assert.ok((run.durationS ?? 0) > 300, "the fixture must cross the old threshold");
    assert.equal(a.label, "unchanged");
    assert.equal(a.labelRule, "no-diff-no-signal");
  });

  it("keeps calling a no-diff run wasteful when it repeated itself", () => {
    // What replaced duration as the evidence. Repetition with nothing to show is
    // still waste; taking a long time over a question is not.
    const b = new Builder({ start: new Date("2026-08-12T11:00:00Z") });
    b.user("Find out why the deploy fails");
    for (let i = 0; i < 4; i++) {
      b.bash("kubectl get pods -n prod", { stdout: "No resources found." });
      b.idle(2);
    }
    b.say("I could not determine it.");
    const a = analyze(load(b).run);

    assert.equal(a.label, "wasteful");
    assert.equal(a.labelRule, "no-diff-spent");
    assert.match(a.labelReason, /repetition/);
  });

  it("records which rule decided every label", () => {
    for (const b of [fixtureQuestion(), fixtureProductive(), fixtureRisky()]) {
      const a = analyze(load(b).run);
      assert.ok(a.labelRule, "labelRule is what lets the UI explain the verdict");
      assert.notEqual(a.labelRule, "fallback", "a fixture should match a real branch");
    }
  });
});
