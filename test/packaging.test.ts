/**
 * Facts about this repository that are stated in more than one file.
 *
 * Every assertion here exists because the duplicate drifted in practice:
 *
 * - The Node floor is named in `package.json`, `.nvmrc` and the CI matrix. It
 *   was `>=24.0.0` in one and `24.x` in another, and `24.x` resolves to the
 *   newest 24 release — so the leg that existed to prove the floor honest had
 *   never once tested the floor.
 * - The verdict list is named in `src/model.ts` and in two issue-template
 *   dropdowns. `unchanged` was added to the code and not to the forms, so the
 *   most common verdict in a real store could not be reported as wrong.
 *
 * Neither is the kind of bug a unit test of behaviour would ever catch, and
 * both are the kind a first-time user hits before anything else.
 *
 * These read repository files rather than build output, so they are resolved
 * from the compiled test's location up two levels (`dist/test` -> repo root).
 * Zero runtime dependencies is a hard constraint, so there is no YAML parser
 * here: the template options are single-line inline arrays and a regex over
 * them is sufficient. If a template is ever reformatted to block style, these
 * tests fail loudly rather than silently passing on nothing — the extraction
 * asserts it found something.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { LABELS } from "../src/model.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), "utf8");

/** Pull every `options: [a, b, c]` inline array out of an issue template. */
function optionLists(yaml: string): string[][] {
  const lists: string[][] = [];
  for (const m of yaml.matchAll(/options:\s*\[([^\]]+)\]/g)) {
    lists.push((m[1] ?? "").split(",").map((s) => s.trim()));
  }
  return lists;
}

describe("the declared Node floor", () => {
  const engines = (JSON.parse(read("package.json")) as { engines: { node: string } }).engines.node;
  const floor = engines.replace(/^[^\d]*/, "");

  it("is the same version in package.json, .nvmrc and the CI matrix", () => {
    assert.match(engines, /^>=/, "engines.node should be a lower bound");
    assert.equal(read(".nvmrc").trim(), floor, ".nvmrc pins the floor, not the latest");

    const ci = read(".github", "workflows", "ci.yml");
    const matrix = /node:\s*\[([^\]]+)\]/.exec(ci);
    assert.ok(matrix, "could not find the node matrix in ci.yml");
    const legs = (matrix[1] ?? "").split(",").map((s) => s.trim().replace(/["']/g, ""));
    assert.ok(
      legs.includes(floor),
      `the CI matrix ${JSON.stringify(legs)} has no leg on the declared floor ${floor}`,
    );
  });

  it("is pinned exactly in CI, because an X.x spec cannot verify a lower bound", () => {
    // setup-node resolves "22.x" to the newest matching release. A floating leg
    // tests whatever shipped most recently and says nothing about the floor.
    assert.match(floor, /^\d+\.\d+\.\d+$/, "the floor must be an exact version");

    const ci = read(".github", "workflows", "ci.yml");
    const matrix = /node:\s*\[([^\]]+)\]/.exec(ci);
    const legs = (matrix?.[1] ?? "").split(",").map((s) => s.trim().replace(/["']/g, ""));
    assert.ok(
      legs.some((l) => l === floor),
      "the floor leg must be a literal version, not an X.x range",
    );
  });
});

describe("the issue templates track the code", () => {
  it("offers every verdict in the wrong-verdict dropdowns", () => {
    const yaml = read(".github", "ISSUE_TEMPLATE", "wrong_verdict.yml");
    const lists = optionLists(yaml);

    assert.equal(lists.length, 2, "expected exactly two verdict dropdowns (given, expected)");
    for (const list of lists) {
      assert.deepEqual(
        [...list].sort(),
        [...LABELS].sort(),
        `dropdown ${JSON.stringify(list)} does not offer every Label`,
      );
    }
  });

  it("does not claim detectors have never fired, which the changelog contradicts", () => {
    // The template used to say `loop.revert` and `loop.stall_tail` "have never
    // fired on a real corpus at all" long after the changelog recorded them
    // firing on 3 and 42 runs. A reporter who checks is told the project is stale.
    const yaml = read(".github", "ISSUE_TEMPLATE", "wrong_verdict.yml");
    assert.doesNotMatch(yaml, /never fired/i);
  });

  it("offers every command the CLI dispatches, and documents each one", () => {
    // The dispatch switch is the source of truth for what commands exist, so it
    // is read here rather than restated. `feedback` and `corpus` both shipped
    // without reaching the bug-report dropdown.
    const cli = read("src", "cli.ts");
    const dispatched = [...cli.matchAll(/^\s+case "([a-z]+)":/gm)].map((m) => m[1] as string);
    assert.ok(dispatched.length >= 8, `only found ${dispatched.length} dispatched commands`);

    const bug = read(".github", "ISSUE_TEMPLATE", "bug_report.yml");
    const dropdown = optionLists(bug).find((l) => l.includes("ingest"));
    assert.ok(dropdown, "no command dropdown found in bug_report.yml");
    for (const cmd of dispatched) {
      assert.ok(dropdown.includes(cmd), `bug_report.yml does not offer '${cmd}'`);
      assert.match(cli, new RegExp(`^\\s{2}${cmd}\\b`, "m"), `USAGE does not document '${cmd}'`);
    }
  });
});
