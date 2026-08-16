/**
 * The check-output resolver is the only machine evidence about whether a check
 * passed, because neither supported agent records exit codes. Two properties
 * matter and both are pinned here: recognised formats must resolve correctly,
 * and unrecognised output must stay `unknown` rather than becoming a guess.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCheckOutput } from "../src/checkOutput.js";
import { classifyCommand } from "../src/commands.js";

describe("check output parsing", () => {
  it("reads node:test summaries", () => {
    const r = parseCheckOutput(
      "✔ tolerance to schema drift (0.3ms)\nℹ tests 66\nℹ suites 16\nℹ pass 66\nℹ fail 0\nℹ duration_ms 133",
    );
    assert.deepEqual(r, { framework: "node:test", ok: true, passed: 66, failed: 0 });
  });

  it("reads a failing node:test summary", () => {
    const r = parseCheckOutput("ℹ tests 12\nℹ pass 10\nℹ fail 2\n");
    assert.equal(r?.ok, false);
    assert.equal(r?.failed, 2);
  });

  it("reads pytest summaries in both directions", () => {
    const pass = parseCheckOutput("===== 12 passed in 1.20s =====");
    assert.equal(pass?.framework, "pytest");
    assert.equal(pass?.ok, true);
    assert.equal(pass?.passed, 12);

    const fail = parseCheckOutput("===== 3 failed, 9 passed in 2.10s =====");
    assert.equal(fail?.ok, false);
    assert.equal(fail?.failed, 3);
  });

  it("counts pytest errors as failures", () => {
    const r = parseCheckOutput("===== 1 error in 0.10s =====");
    assert.equal(r?.ok, false);
    assert.equal(r?.failed, 1);
  });

  it("reads jest and vitest", () => {
    const jest = parseCheckOutput("Tests:       1 failed, 13 passed, 14 total");
    assert.equal(jest?.framework, "jest");
    assert.equal(jest?.ok, false);
    assert.equal(jest?.passed, 13);

    const vitest = parseCheckOutput(" Tests  2 failed | 5 passed (7)");
    assert.equal(vitest?.ok, false);
    assert.equal(vitest?.failed, 2);
  });

  it("reads mocha, cargo and go", () => {
    assert.equal(parseCheckOutput("  12 passing (34ms)\n  0 failing")?.ok, true);
    assert.equal(parseCheckOutput("  9 passing (2s)\n  3 failing")?.ok, false);
    assert.equal(
      parseCheckOutput("test result: ok. 12 passed; 0 failed; 0 ignored")?.ok,
      true,
    );
    assert.equal(
      parseCheckOutput("test result: FAILED. 1 passed; 2 failed; 0 ignored")?.ok,
      false,
    );
    assert.equal(parseCheckOutput("ok  \tgithub.com/x/y\t0.42s")?.ok, true);
    assert.equal(parseCheckOutput("--- FAIL: TestThing (0.00s)\nFAIL\tpkg\t0.1s")?.ok, false);
  });

  it("reads compiler and linter output", () => {
    assert.equal(parseCheckOutput("Found 3 errors in 2 files.")?.ok, false);
    assert.equal(parseCheckOutput("src/a.ts(4,1): error TS2345: bad")?.ok, false);
    assert.equal(parseCheckOutput("Success: no issues found in 12 source files")?.ok, true);
    assert.equal(parseCheckOutput("All checks passed!")?.ok, true);
    assert.equal(parseCheckOutput("✖ 7 problems (3 errors, 4 warnings)")?.ok, false);
    assert.equal(parseCheckOutput("✖ 2 problems (0 errors, 2 warnings)")?.ok, true);
  });

  it("reads build-system failures", () => {
    assert.equal(parseCheckOutput("make: *** [build] Error 2")?.ok, false);
    assert.equal(parseCheckOutput("npm ERR! code ELIFECYCLE")?.ok, false);
  });

  it("sees through ANSI colour codes", () => {
    const r = parseCheckOutput("[32mℹ pass 5[0m\n[31mℹ fail 0[0m");
    assert.equal(r?.ok, true);
    assert.equal(r?.passed, 5);
  });

  it("returns unknown for output it does not recognise", () => {
    for (const out of [
      "",
      "   \n  ",
      "Cloning into 'repo'...\ndone.",
      "total 48\ndrwxr-xr-x  6 me staff 192 Aug 16 14:01 .",
      "This is not the tsc command you are looking for",
      "added 3 packages, and audited 4 packages in 30s",
    ]) {
      assert.equal(parseCheckOutput(out), null, `should stay unknown: ${out.slice(0, 40)}`);
    }
  });
});

describe("test-runner classification", () => {
  it("recognises runners that are not npm scripts", () => {
    for (const cmd of [
      "node --test dist/test/*.test.js",
      "python -m pytest tests/",
      "python3 -m unittest discover",
      "deno test --allow-read",
      "mix test",
      "rake test",
      "swift test",
      "bundle exec rspec spec/",
      "npm run test:unit",
    ]) {
      assert.equal(classifyCommand(cmd), "test", `should be a test: ${cmd}`);
    }
  });

  it("does not over-claim on lookalikes", () => {
    assert.equal(classifyCommand("node server.js"), "shell");
    assert.equal(classifyCommand("git log --oneline"), "vcs");
    assert.equal(classifyCommand("cat test.txt"), "shell");
  });
});
