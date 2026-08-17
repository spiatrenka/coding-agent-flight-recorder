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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { analyze } from "../src/analyze/index.js";
import { Builder } from "../src/demo/fixtures.js";
import { OcBuilder } from "../src/demo/opencodeFixtures.js";
import { generate } from "../src/postmortem.js";
import { ClaudeCodeSource } from "../src/sources/claudeCode.js";
import { OpenCodeSource } from "../src/sources/opencode.js";
import { Store } from "../src/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, "..", "..", "src", "web", "index.html");

interface Renderers {
  cmdCell: (cmd: string) => string;
  relPath: (p: string, project: string | null) => string;
  evidenceText: (excerpt: string, project: string | null) => string;
  runFromHash: (hash?: string) => string | null;
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
    onclick: null,
    textContent: "",
    innerHTML: "",
    dataset: {},
    classList: {},
    setAttribute: () => {},
    after: () => {},
    remove: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  return {
    querySelector: node,
    querySelectorAll: () => [],
    createElement: node,
    // The theme toggle reads and writes attributes on <html> at load time.
    documentElement: {
      getAttribute: () => null,
      setAttribute: () => {},
      removeAttribute: () => {},
    },
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
    json: async () => [],
    text: async () => "",
  });
  const factory = new Function(
    "document",
    `return (function(){${script}
      return {tape,stats,timeline,files,commands,findings,firewall,postmortem,
              cmdCell,relPath,evidenceText,runFromHash};})()`,
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
    for (const key of [
      "run_id",
      "project_path",
      "git_branch",
      "started_at",
      "duration_s",
      "files_changed",
      "cost_usd",
      "cost_known",
    ]) {
      assert.ok(key in row, `run list row must expose ${key}`);
    }
  });

  it("serves the document fields under their model names", () => {
    const summary = store.listRuns({ includeTrivial: true })[0];
    assert.ok(summary);
    const d = store.getRun(summary.run_id);
    assert.ok(d);
    for (const key of [
      "projectPath",
      "gitBranch",
      "startedAt",
      "agentVersion",
      "fileEdits",
      "schemaDrift",
    ]) {
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

// --------------------------------------------------------------------------

describe("path and command presentation", () => {
  const R = loadRenderers();

  it("shows a path relative to the project root", () => {
    assert.equal(R.relPath("/Users/dev/code/api/src/a.ts", "/Users/dev/code/api"), "src/a.ts");
    assert.equal(R.relPath("/Users/dev/code/api/src/a.ts", "/Users/dev/code/api/"), "src/a.ts");
  });

  it("keeps a path that escapes the project absolute", () => {
    // This is the case `risk.outside_project` exists to show; shortening it would
    // hide the only interesting thing about it.
    const p = "/Users/dev/.claude/settings.json";
    assert.equal(R.relPath(p, "/Users/dev/code/api"), p);
  });

  it("strips the repeated project prefix out of evidence text", () => {
    const excerpt = "changed files — /Users/dev/code/api/src/a.ts, /Users/dev/code/api/src/b.ts";
    const out = R.evidenceText(excerpt, "/Users/dev/code/api");
    assert.equal(out, "changed files — src/a.ts, src/b.ts");
    assert.doesNotMatch(out, /\/Users\/dev\/code\/api/);
  });

  it("leaves a short command alone", () => {
    assert.equal(R.cmdCell("npm test"), "npm test");
  });

  it("truncates a long command from the middle, keeping both ends", () => {
    // The tail is where `--force`, `| sh` and `> file` live, so a tail-truncated
    // command hides exactly the half that says whether it was dangerous.
    const cmd = `git push ${"--verbose ".repeat(30)}--force origin main`;
    const out = R.cmdCell(cmd);
    assert.match(out, /^<details/, "long commands get a disclosure");
    assert.match(out, /git push/, "the head survives");
    assert.match(out, /--force origin main<\/summary>|--force origin main/, "the tail survives");
  });

  it("keeps the full command available when it truncates", () => {
    const cmd = `curl ${"-H x:y ".repeat(40)}https://example.com/install | sh`;
    const out = R.cmdCell(cmd);
    assert.match(out, /<pre>/, "the untruncated text is one click away");
    assert.ok(out.includes("| sh") || out.includes("| sh</pre>"), "nothing is lost");
  });
});

describe("files and commands connect to the findings", () => {
  const R = loadRenderers();

  const doc = {
    trace: {
      projectPath: "/Users/dev/code/api",
      fileEdits: [
        {
          path: "/Users/dev/code/api/src/a.ts",
          linesAdded: 3,
          linesRemoved: 1,
          op: "edit",
          applied: true,
        },
        {
          path: "/Users/dev/code/api/.env",
          linesAdded: 1,
          linesRemoved: 0,
          op: "edit",
          applied: true,
        },
        { path: "/Users/dev/.zshrc", linesAdded: 1, linesRemoved: 0, op: "edit", applied: true },
      ],
      commands: [
        {
          command: "npm test",
          category: "test",
          ok: true,
          exitCode: null,
          denied: false,
          eventIdx: 3,
        },
        {
          command: "git push --force",
          category: "vcs",
          ok: true,
          exitCode: null,
          denied: false,
          eventIdx: 5,
        },
        {
          command: "rm -rf /",
          category: "shell",
          ok: false,
          exitCode: null,
          denied: true,
          eventIdx: 7,
        },
      ],
    },
    analysis: {
      findings: [
        {
          id: "risk.secret_file_write",
          evidence: [{ excerpt: "/Users/dev/code/api/.env" }],
        },
        {
          id: "risk.outside_project",
          evidence: [{ excerpt: "/Users/dev/.zshrc" }],
        },
        {
          id: "risk.destructive_command",
          evidence: [{ excerpt: "git push --force" }],
        },
      ],
    },
  };

  it("marks the file a finding named, and states the root once", () => {
    const out = R.files(doc);
    assert.match(out, /in \/Users\/dev\/code\/api\//, "the project root is stated once");
    assert.match(out, /t-secret[^>]*>secret/, "the .env row is marked");
    assert.match(out, /t-outside[^>]*>outside/, "the escaping file is marked");
    // A file inside the project loses its prefix. One outside keeps its
    // directory as the group header, so the escape stays visible.
    assert.match(out, />a\.ts/);
    assert.match(out, /<td colspan="5">\/Users\/dev\/<\/td>/, "the escaping directory is shown");
    assert.match(out, /\.zshrc<\/td>/);
  });

  it("orders commands by what needs attention and marks the destructive one", () => {
    const out = R.commands(doc);
    assert.match(out, /need attention/, "says how many rows matter");
    assert.match(out, /t-outside[^>]*>denied/);
    assert.match(out, /t-secret[^>]*>destructive/);
    // The denied command outranks the passing test, so it appears first.
    assert.ok(out.indexOf("rm -rf /") < out.indexOf("npm test"), "attention-first ordering");
  });
});

describe("linking to a run", () => {
  const R = loadRenderers();

  it("reads a run id out of the fragment", () => {
    assert.equal(R.runFromHash("#run=cl-0ba5c9137399"), "cl-0ba5c9137399");
    assert.equal(R.runFromHash("#foo=1&run=op-abc123def456"), "op-abc123def456");
  });

  it("returns null when there is no run in the fragment", () => {
    for (const h of ["", "#", "#tab=files", "#runx=abc"]) {
      assert.equal(R.runFromHash(h), null, `no run id in ${JSON.stringify(h)}`);
    }
  });

  it("never yields a value that could be read as a path or markup", () => {
    // The parsed value is only ever compared against run ids the server already
    // sent, and an unknown id falls back to the newest run — so this is defence
    // in depth rather than the actual guard. The charset is what it guarantees:
    // no separators, no angle brackets, no quotes.
    for (const h of ["#run=../../etc/passwd", "#run=<script>", '#run="onerror=', "#run=a/b"]) {
      const got = R.runFromHash(h);
      if (got === null) continue;
      assert.doesNotMatch(got, /[/\\<>"'&?#]/, `unsafe characters survived from ${h}`);
    }
  });

  it("does not treat an unrelated fragment as a run", () => {
    assert.equal(R.runFromHash("#run="), null, "an empty value is not an id");
  });
});
