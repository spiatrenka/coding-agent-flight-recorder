/**
 * Dashboard smoke test.
 *
 * The dashboard is plain HTML with an inline script: no build step, no module
 * system, no type checking. Nothing else in this repository can catch a field
 * name that does not exist — and that is exactly what went wrong. The markup
 * was inherited from an implementation whose API served snake_case, while this
 * one serialises the model objects directly and therefore serves camelCase.
 * `/api/runs` returns SQL rows (still snake_case, so the run list worked) but
 * `/api/runs/:id` returns the nested documents, so every detail-pane render
 * threw and the panel stayed empty.
 *
 * This test extracts the inline script, runs each render function against a
 * real payload built by the real pipeline, and fails on a throw or on the
 * string "undefined" reaching the output. It is deliberately behavioural: it
 * asserts the page renders, not how it is written.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/postmortem.js";
import { ClaudeCodeSource } from "../src/sources/claudeCode.js";
import { OpenCodeSource } from "../src/sources/opencode.js";
import { Store } from "../src/store.js";
import { Builder } from "../src/demo/fixtures.js";
import { OcBuilder } from "../src/demo/opencodeFixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, "..", "..", "src", "web", "index.html");

interface Renderers {
  tape: (t: unknown, a: unknown) => string;
  stats: (t: unknown, a: unknown, m: unknown) => string;
  timeline: (d: unknown) => string;
  files: (d: unknown) => string;
  commands: (d: unknown) => string;
  findings: (d: unknown) => string;
  firewall: (d: unknown) => string;
  postmortem: (d: unknown) => string;
}

/**
 * Wrap a payload so that reading a snake_case key that does not exist throws.
 *
 * Searching the rendered markup for the string "undefined" looks like the
 * obvious check and is not usable: real runs legitimately contain that word in
 * file contents, commit messages and branch names, which produced 190 false
 * positives on the local corpus. This instead catches the defect at its cause.
 * The model contract is camelCase, so a snake_case read on one of these
 * documents is wrong by definition, whatever the output happens to look like.
 *
 * `toolInput` is deliberately left unwrapped: those keys are the agent's own
 * vocabulary (Claude Code writes `file_path`), not this project's schema.
 */
function guardSnakeCase(value: unknown, path: string): unknown {
  if (value === null || typeof value !== "object") return value;
  return new Proxy(value as object, {
    get(target, key, recv): unknown {
      if (typeof key === "string" && /[a-z]_[a-z]/.test(key) && !(key in target)) {
        throw new Error(`${path}.${key} — snake_case read; the model serialises camelCase`);
      }
      const v = Reflect.get(target, key, recv);
      if (key === "toolInput") return v;
      return guardSnakeCase(v, `${path}.${String(key)}`);
    },
  });
}

/** Enough of a DOM for the script's top-level statements to evaluate. */
function domStub(): unknown {
  const node = (): unknown => ({
    onclick: null, textContent: "", innerHTML: "", dataset: {}, classList: {},
    setAttribute: () => {}, after: () => {}, remove: () => {},
    querySelector: () => null, querySelectorAll: () => [],
  });
  return {
    querySelector: node,
    querySelectorAll: () => [],
    createElement: node,
    // The theme toggle reads and writes attributes on <html> at load time.
    documentElement: { getAttribute: () => null, setAttribute: () => {}, removeAttribute: () => {} },
  };
}

function loadRenderers(): Renderers {
  const html = readFileSync(INDEX_HTML, "utf8");
  // The page has a tiny theme-bootstrap script in <head> before the stylesheet,
  // so take the *last* block — the application script — not the first.
  const open = html.lastIndexOf("<script>");
  const script = html.slice(open + "<script>".length, html.indexOf("</script>", open));
  assert.ok(script.includes("function renderRun"), "extracted the wrong <script> block");
  const doc = domStub();
  (globalThis as Record<string, unknown>)["fetch"] = async () => ({
    json: async () => [], text: async () => "",
  });
  const factory = new Function(
    "document",
    `return (function(){${script}
      return {tape,stats,timeline,files,commands,findings,firewall,postmortem};})()`,
  ) as (d: unknown) => Renderers;
  return factory(doc);
}

let root: string;
let store: Store;

before(() => {
  root = mkdtempSync(join(tmpdir(), "flightrec-dash-"));
  store = new Store(join(root, "dash.db"));
  process.env["OPENCODE_STORAGE_DIR"] = join(root, "ocstorage");

  // A Claude Code run exercising every panel: edits, a check, a finding.
  const ccPath = new Builder({ sessionId: "dash-cc" })
    .user("Fix the refund window off-by-one")
    .edit("/Users/dev/code/payments-api/src/refund.ts", "day > 30", "day >= 30")
    .bash("npm test", { stdout: "ℹ tests 12\nℹ pass 12\nℹ fail 0" })
    .bash("rm -rf ./build", { stdout: "" })
    .say("Fixed and tested.")
    .writeTo(root);
  for (const run of new ClaudeCodeSource().load(ccPath)) {
    const a = analyze(run);
    store.upsert(run, a, generate(run, a));
  }

  // An OpenCode run — different importer, same contract.
  const ocPath = new OcBuilder(join(root, "ocstorage"), { sessionId: "ses_dash00000000000000001" })
    .user("Cache the FX lookup")
    .edit("/Users/dev/code/ledger-svc/src/fx.ts", "fetchRate(c)", "memo(c)")
    .bash("npm test", "ℹ tests 5\nℹ pass 5\nℹ fail 0")
    .say("Done.", { cost: 0.2 })
    .writeTo();
  for (const run of new OpenCodeSource().load(ocPath)) {
    const a = analyze(run);
    store.upsert(run, a, generate(run, a));
  }
});

after(() => {
  store.close();
  delete process.env["OPENCODE_STORAGE_DIR"];
  rmSync(root, { recursive: true, force: true });
});

describe("dashboard renders the API payload", () => {
  const PANELS = ["timeline", "files", "commands", "findings", "firewall", "postmortem"] as const;

  for (const source of ["claude_code", "opencode"] as const) {
    it(`renders every panel for a ${source} run`, () => {
      const R = loadRenderers();
      const summary = store.listRuns({ source, includeTrivial: true })[0];
      assert.ok(summary, `no ${source} run in the fixture store`);
      const raw = store.getRun(summary.run_id);
      assert.ok(raw, "run must load");
      const d = {
        ...raw,
        trace: guardSnakeCase(raw.trace, "trace"),
        analysis: guardSnakeCase(raw.analysis, "analysis"),
        postmortem: guardSnakeCase(raw.postmortem, "postmortem"),
      } as typeof raw;

      // Structural renders that renderRun() inlines — a throw here is what
      // blanked the whole detail pane.
      const tape = R.tape(d.trace, d.analysis);
      assert.ok(tape.length > 0, "tape must render");
      const stats = R.stats(d.trace, d.analysis, d.analysis.metrics);
      assert.ok(stats.length > 0, "stats must render");

      for (const panel of PANELS) {
        // Indexing a union of call signatures needs the cast; every panel
        // takes the whole StoredRun and returns markup.
        const render = R[panel] as (payload: unknown) => string;
        const out = render(d);
        assert.equal(typeof out, "string", `${panel} must return markup`);
        assert.ok(out.length > 0, `${panel} rendered nothing`);
        assert.ok(!out.includes("[object Object]"), `${panel} leaked a raw object`);
      }
    });
  }

  it("reads run-list rows with their SQL column names", () => {
    // /api/runs serves SQL rows (snake_case) while /api/runs/:id serves the
    // serialised documents (camelCase). Mixing the two is the bug this whole
    // suite exists for, so pin the row shape explicitly.
    const row = store.listRuns({ includeTrivial: true })[0];
    assert.ok(row);
    for (const key of ["run_id", "project_path", "git_branch", "started_at",
                       "duration_s", "files_changed", "cost_usd", "cost_known"]) {
      assert.ok(key in row, `run list row must expose ${key}`);
    }
  });

  it("serves the document fields under their model names", () => {
    const summary = store.listRuns({ includeTrivial: true })[0];
    assert.ok(summary);
    const d = store.getRun(summary.run_id);
    assert.ok(d);
    for (const key of ["projectPath", "gitBranch", "startedAt", "agentVersion",
                       "fileEdits", "schemaDrift"]) {
      assert.ok(key in d.trace, `trace must expose ${key}`);
    }
    for (const key of ["labelReason", "stopPoint", "metrics"]) {
      assert.ok(key in d.analysis, `analysis must expose ${key}`);
    }
    for (const key of ["filesChanged", "linesAdded", "toolCalls", "costUsd", "costKnown"]) {
      assert.ok(key in d.analysis.metrics, `metrics must expose ${key}`);
    }
    for (const key of ["whatHappened", "whatChanged", "whatFailed", "shouldHaveStopped"]) {
      assert.ok(key in d.postmortem.sections, `postmortem sections must expose ${key}`);
    }
  });
});
