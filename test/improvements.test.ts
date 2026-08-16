/**
 * Regression tests for the OpenCode importer and the four analyzer defects
 * found by running the tool against real transcripts.
 *
 * Each suite pins a behaviour that was wrong before, so a future refactor that
 * reintroduces the bug fails here rather than in someone's postmortem.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { analyze } from "../src/analyze/index.js";
import { DEFAULT_PRICES, estimate, familyOf, priceFor } from "../src/analyze/cost.js";
import { classifyCommand, mutatesWorkingTree } from "../src/commands.js";
import {
  type Run,
  diffMayBeIncomplete,
  emptyUsage,
  isTrivialRun,
  netDiffLines,
  unrecordedWrites,
} from "../src/model.js";
import { generate } from "../src/postmortem.js";
import { OpenCodeSource } from "../src/sources/opencode.js";
import { Store } from "../src/store.js";
import { OcBuilder } from "../src/demo/opencodeFixtures.js";

let root: string;
let storage: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "flightrec-oc-"));
  storage = join(root, "storage");
  process.env["OPENCODE_STORAGE_DIR"] = storage;
});

after(() => {
  delete process.env["OPENCODE_STORAGE_DIR"];
  rmSync(root, { recursive: true, force: true });
});

function loadOnly(b: OcBuilder): Run {
  const path = b.writeTo();
  const runs = new OpenCodeSource().load(path);
  assert.equal(runs.length, 1, "expected exactly one run");
  return runs[0] as Run;
}

// --------------------------------------------------------------------------

describe("command classification", () => {
  it("classifies the categories that drive verification", () => {
    assert.equal(classifyCommand("pytest -q tests/"), "test");
    assert.equal(classifyCommand("npm run build"), "build");
    assert.equal(classifyCommand("eslint src/"), "lint");
    assert.equal(classifyCommand("git status"), "vcs");
    assert.equal(classifyCommand("npm install lodash"), "pkg");
    assert.equal(classifyCommand("echo hello"), "shell");
  });

  it("detects shell commands that write to the working tree", () => {
    for (const cmd of [
      "tar -xzf bundle.tar.gz -C ./out",
      "printf 'x\\n' >> ~/.zshrc",
      "sed -i '' 's/a/b/' src/app.ts",
      "mkdir -p build && touch build/.keep",
      "cat > config.yml <<'EOF'\nkey: v\nEOF",
      "cp -r src dist",
      "git checkout -- .",
      "curl -o vendor.js https://example.com/v.js",
    ]) {
      assert.equal(mutatesWorkingTree(cmd), true, `should be a write: ${cmd}`);
    }
  });

  it("does not treat reads, throwaway redirects or installs as writes", () => {
    for (const cmd of [
      "grep -rn TODO src/",
      "npm test 2>&1",
      "ls -la > /dev/null",
      "python -c 'print(1)' > /tmp/scratch.txt",
      "npm install",
      "cargo build --release",
    ]) {
      assert.equal(mutatesWorkingTree(cmd), false, `should not be a write: ${cmd}`);
    }
  });
});

// --------------------------------------------------------------------------

describe("cost model", () => {
  it("maps model ids onto price families across generations", () => {
    assert.equal(familyOf("claude-opus-4-6"), "opus");
    assert.equal(familyOf("claude-opus-5"), "opus");
    assert.equal(familyOf("claude-opus-4-1-20250805"), "opus-legacy");
    assert.equal(familyOf("claude-3-opus-20240229"), "opus-legacy");
    assert.equal(familyOf("claude-sonnet-5"), "sonnet");
    assert.equal(familyOf("claude-haiku-4-5"), "haiku");
    assert.equal(familyOf("claude-3-5-haiku-20241022"), "haiku-3-5");
    assert.equal(familyOf("claude-fable-5"), "frontier");
    assert.equal(familyOf("unknown"), null);
    assert.equal(familyOf(""), null);
  });

  it("prices current Opus at the current tier, not the legacy rate", () => {
    const p = priceFor("claude-opus-4-8");
    assert.ok(p, "opus 4.8 must be priced");
    assert.equal(p.input, 5.0);
    assert.equal(p.output, 25.0);
    // The legacy rate must still exist for the models it applies to.
    assert.equal(priceFor("claude-opus-4-1")?.input, 15.0);
  });

  it("keeps every family in the default table reachable", () => {
    for (const key of Object.keys(DEFAULT_PRICES)) {
      assert.ok(DEFAULT_PRICES[key], `${key} must have a price`);
    }
  });

  it("never overwrites a cost the agent reported itself", () => {
    const u = emptyUsage();
    u.byModel["claude-opus-4-6"] = { input: 0, output: 500_000, cacheRead: 0, cacheCreation: 0 };
    u.outputTokens = 500_000;
    u.costUsd = 0.42;
    u.costIsEstimate = false;
    estimate(u);
    assert.equal(u.costUsd, 0.42, "reported cost must survive estimation");
    assert.equal(u.costIsEstimate, false);
  });

  it("still models a cost when the source reported none", () => {
    const u = emptyUsage();
    u.byModel["claude-opus-4-6"] = { input: 0, output: 1_000_000, cacheRead: 0, cacheCreation: 0 };
    estimate(u);
    assert.equal(u.costUsd, 25.0);
    assert.equal(u.costIsEstimate, true);
  });
});

// --------------------------------------------------------------------------

describe("shell-mediated diffs", () => {
  it("flags a run whose only writes went through the shell", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_shellwrite000000000001" })
        .user("Unpack the vendor bundle into ./out")
        .bash("tar -xzf vendor.tar.gz -C ./out", "x out/a.js\nx out/b.js")
        .say("Unpacked."),
    );
    assert.equal(netDiffLines(run), 0, "no edit-tool changes recorded");
    assert.equal(diffMayBeIncomplete(run), true);
    assert.equal(unrecordedWrites(run).length, 1);
  });

  it("does not call such a run wasteful", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_shellwrite000000000002" })
        .user("Unpack the bundle")
        .bash("tar -xzf vendor.tar.gz -C ./out", "ok")
        .idle(20)
        .say("Done."),
    );
    const a = analyze(run);
    assert.notEqual(a.label, "wasteful", `got ${a.label}: ${a.labelReason}`);
    assert.match(a.labelReason, /shell command/);
  });

  it("still calls a genuinely empty run wasteful", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_emptyrun00000000000001" })
        .user("Why is the settlement job slow?")
        .bash("grep -rn settlement src/", "src/jobs/settle.ts:14")
        .think("Considering the query plan")
        .idle(25)
        .say("It is the N+1 in settle.ts."),
    );
    const a = analyze(run);
    assert.equal(diffMayBeIncomplete(run), false, "grep is not a write");
    assert.equal(a.label, "wasteful", a.labelReason);
  });

  it("names the opaque commands in the postmortem", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_shellwrite000000000003" })
        .user("Patch the config")
        .bash("sed -i '' 's/debug/info/' config.yml", "")
        .say("Patched."),
    );
    const pm = generate(run, analyze(run));
    assert.match(pm.sections.whatChanged, /diff is incomplete/);
    assert.match(pm.sections.whatChanged, /sed -i/);
  });
});

// --------------------------------------------------------------------------

describe("trivial runs", () => {
  it("marks a no-op session trivial", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_trivial0000000000000001" })
        .user(".")
        .say("I'm ready to help. What would you like me to work on?"),
    );
    assert.equal(isTrivialRun(run), true);
    assert.equal(analyze(run).trivial, true);
  });

  it("does not mark a run with real work trivial", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_trivial0000000000000002" })
        .user("Fix the off-by-one")
        .edit("/Users/dev/code/ledger-svc/src/refund.ts", "day > 30", "day >= 30")
        .say("Fixed."),
    );
    assert.equal(isTrivialRun(run), false);
    assert.equal(analyze(run).trivial, false);
  });

  it("hides trivial runs from the default listing but keeps them stored", () => {
    const dbPath = join(root, "trivial.db");
    const store = new Store(dbPath);
    for (const [sid, trivial] of [
      ["ses_store000000000000001", true],
      ["ses_store000000000000002", false],
    ] as const) {
      const b = new OcBuilder(storage, { sessionId: sid });
      const run = trivial
        ? loadOnly(b.user(".").say("Ready."))
        : loadOnly(
            b.user("Fix it")
              .edit("/Users/dev/code/ledger-svc/src/a.ts", "a", "b")
              .bash("pytest -q", "3 passed"),
          );
      const a = analyze(run);
      store.upsert(run, a, generate(run, a));
    }
    assert.equal(store.listRuns({}).length, 1, "trivial run hidden by default");
    assert.equal(store.listRuns({ includeTrivial: true }).length, 2, "still stored");
    store.close();
  });
});

// --------------------------------------------------------------------------

describe("opencode importer", () => {
  it("reads goal, project, model and version from the session graph", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_import00000000000001" })
        .user("Add pagination to the transactions endpoint")
        .edit("/Users/dev/code/ledger-svc/src/txn.ts", "list()", "list(page)")
        .say("Added."),
    );
    assert.equal(run.source, "opencode");
    assert.equal(run.goalIsKnown, true);
    assert.match(run.goal ?? "", /pagination/);
    assert.equal(run.projectPath, "/Users/dev/code/ledger-svc");
    assert.equal(run.agentVersion, "1.1.44");
    assert.deepEqual(run.models, ["claude-opus-4-6"]);
  });

  it("maps edits, commands and compaction", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_import00000000000002" })
        .user("Fix and verify")
        .edit("/Users/dev/code/ledger-svc/src/a.ts", "old", "new")
        .write("/Users/dev/code/ledger-svc/src/b.ts", "line1\nline2\nline3")
        .bash("pytest -q", "12 passed in 1.2s")
        .compact()
        .say("Done."),
    );
    assert.equal(run.fileEdits.length, 2);
    assert.equal(run.fileEdits[0]?.op, "edit");
    assert.equal(run.fileEdits[1]?.op, "create");
    assert.equal(run.fileEdits[1]?.linesAdded, 3);
    assert.equal(run.commands.length, 1);
    assert.equal(run.commands[0]?.category, "test");
    assert.equal(run.commands[0]?.ok, true);
    assert.equal(run.compactions, 1);
  });

  it("reports a blocked command as denied, not merely failed", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_import00000000000003" })
        .user("Clean up")
        .bash("rm -rf ./build", "", {
          error:
            "Error: The user has specified a rule which prevents you from using " +
            "this specific tool call.",
        })
        .say("Blocked."),
    );
    const cmd = run.commands[0];
    assert.ok(cmd);
    assert.equal(cmd.denied, true);
    assert.equal(cmd.ok, false);
    const a = analyze(run);
    assert.ok(
      a.findings.some((f) => f.id === "risk.destructive_attempt"),
      "a blocked rm -rf must surface as an attempt, not an execution",
    );
  });

  it("uses the agent's own cost when it reports one", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_import00000000000004" })
        .user("Do the thing")
        .say("Working.", { cost: 0.25 })
        .say("Done.", { cost: 0.75 }),
    );
    assert.equal(run.usage.costIsEstimate, false);
    assert.equal(run.usage.costUsd, 1.0);
    const a = analyze(run);
    assert.equal(a.metrics.costUsd, 1.0, "estimation must not overwrite it");
    const pm = generate(run, a);
    assert.match(pm.sections.cost, /reported by the agent/);
  });

  it("falls back to modelling when every reported cost is zero", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_import00000000000005" })
        .user("Do the thing")
        .say("Working.")
        .say("Done."),
    );
    assert.equal(run.usage.costIsEstimate, true, "subscription plans report 0");
    analyze(run);
    assert.ok((run.usage.costUsd ?? 0) > 0, "should still model a figure");
  });

  it("records an unmapped part type as drift without dropping the run", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_import00000000000006" })
        .user("Go")
        .weird("telemetry-v3")
        .say("Done."),
    );
    assert.ok(run.schemaDrift.some((d) => d.includes("telemetry-v3")), run.schemaDrift.join());
    assert.ok(run.events.length >= 2, "the rest of the run survives");
  });

  it("splits a session on a long idle gap", () => {
    const b = new OcBuilder(storage, { sessionId: "ses_import00000000000007" })
      .user("First task")
      .edit("/Users/dev/code/ledger-svc/src/a.ts", "x", "y")
      .say("Done.")
      .idle(90)
      .user("Second, unrelated task")
      .edit("/Users/dev/code/ledger-svc/src/b.ts", "p", "q")
      .say("Done.");
    const runs = new OpenCodeSource().load(b.writeTo());
    assert.equal(runs.length, 2);
    assert.equal(runs[0]?.segment, 0);
    assert.equal(runs[1]?.segment, 1);
    assert.notEqual(runs[0]?.runId, runs[1]?.runId);
  });

  it("uses the session diff summary when no edit tool ran", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_import00000000000008" })
        .withSummary(4, 120, 30)
        .user("Apply the migration script")
        .bash("./scripts/migrate.sh > out.log", "done")
        .say("Applied."),
    );
    assert.equal(netDiffLines(run), 150, "session summary fills the gap");
    assert.notEqual(analyze(run).label, "wasteful");
  });

  it("does not let the summary overwrite a diff the tool stream captured", () => {
    const run = loadOnly(
      new OcBuilder(storage, { sessionId: "ses_import00000000000009" })
        .withSummary(99, 9999, 9999)
        .user("Edit one line")
        .edit("/Users/dev/code/ledger-svc/src/a.ts", "one", "two")
        .say("Done."),
    );
    assert.equal(run.fileEdits.length, 1);
    assert.ok(netDiffLines(run) < 10, "recorded edits win over the summary");
  });

  it("produces a deterministic postmortem", () => {
    const build = () =>
      loadOnly(
        new OcBuilder(storage, { sessionId: "ses_import00000000000010" })
          .user("Fix the rounding bug")
          .edit("/Users/dev/code/ledger-svc/src/round.ts", "floor", "round")
          .bash("pytest -q", "8 passed")
          .say("Fixed and tested."),
      );
    const a = build();
    const bRun = build();
    const strip = (s: string) => s.replace(/Generated \S+ by/, "Generated <ts> by");
    assert.equal(
      strip(generate(a, analyze(a)).markdown),
      strip(generate(bRun, analyze(bRun)).markdown),
    );
  });
});
