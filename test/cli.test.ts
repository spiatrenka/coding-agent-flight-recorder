/**
 * Command line tests.
 *
 * Driven in-process by calling `main(argv)` with `--db <tmp>` and capturing
 * console output. Two cases spawn the real binary instead, because the entry
 * guard and `process.exitCode` plumbing cannot be reached any other way.
 *
 * `serve` is never invoked here — it blocks. Its behaviour lives in
 * server.test.ts and security.test.ts.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ANALYZER_VERSION, analyze } from "../src/analyze/index.js";
import { type Args, main, parseArgs } from "../src/cli.js";
import { seedDemo } from "../src/demo/index.js";
import { OcBuilder } from "../src/demo/opencodeFixtures.js";
import { generate } from "../src/postmortem.js";
import { OpenCodeSource } from "../src/sources/opencode.js";
import { Store } from "../src/store.js";

const CLI_JS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

let tmp: string;
let db: string;
let demoRoot: string;
let out: string[];
let err: string[];
const realLog = console.log;
const realError = console.error;
const priorEnv: Record<string, string | undefined> = {};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "flightrec-cli-"));
  db = join(tmp, "cli.db");

  // Never let a test touch ~/.flightrec, and never let `ingest` read the real
  // ~/.claude — on a developer machine that is slow and non-deterministic, and
  // on CI it is empty, so a test written against it would pass for the wrong
  // reason in both places.
  for (const k of ["FLIGHTREC_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_STORAGE_DIR"]) {
    priorEnv[k] = process.env[k];
  }
  process.env["FLIGHTREC_HOME"] = join(tmp, "home");

  const store = new Store(db);
  const demo = seedDemo(store, { root: join(tmp, "demo") });
  store.close();
  demoRoot = demo.root;
});

after(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  out = [];
  err = [];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
});

const stdout = () => out.join("\n");
const stderr = () => err.join("\n");
const run = (...argv: string[]) => main([...argv, "--db", db]);

describe("argument parsing", () => {
  const parse = (...argv: string[]): Args => parseArgs(argv);

  it("reads --flag=value", () => {
    assert.equal(parse("list", "--limit=5").flags.get("limit"), "5");
  });

  it("reads --flag value", () => {
    assert.equal(parse("list", "--limit", "5").flags.get("limit"), "5");
  });

  it("treats a trailing flag as boolean true", () => {
    assert.equal(parse("ingest", "--force").flags.get("force"), true);
  });

  it("does not swallow a following flag as a value", () => {
    const a = parse("ingest", "--force", "--limit", "3");
    assert.equal(a.flags.get("force"), true);
    assert.equal(a.flags.get("limit"), "3");
  });

  it("maps -v to verbose", () => {
    assert.equal(parse("ingest", "-v").flags.get("verbose"), true);
  });

  it("takes the first bare word as the command and the rest as positionals", () => {
    const a = parse("report", "run-1", "extra");
    assert.equal(a.cmd, "report");
    assert.deepEqual(a.positional, ["run-1", "extra"]);
  });

  it("honours --db", () => {
    assert.equal(parse("list", "--db", "/tmp/x.db").db, "/tmp/x.db");
  });

  it("falls back to the default database path", () => {
    // FLIGHTREC_HOME is redirected in before(), so this asserts the override is
    // respected without writing anywhere near the real home directory.
    assert.equal(parse("list").db, join(tmp, "home", "flightrec.db"));
  });
});

describe("usage", () => {
  it("prints usage and succeeds when given no command", async () => {
    assert.equal(await main([]), 0);
    assert.match(stdout(), /Usage: flightrec/);
  });

  it("prints usage and fails on an unknown command", async () => {
    assert.equal(await main(["wat"]), 1);
    assert.match(stdout(), /Usage: flightrec/);
  });
});

describe("list", () => {
  it("prints one row per stored run", async () => {
    assert.equal(await run("list"), 0);
    assert.match(stdout(), /run\s+when\s+dur/);
    assert.match(stdout(), /run\(s\)\./);
  });

  it("marks verdicts with their symbols and explains the legend", async () => {
    await run("list", "--all");
    assert.match(stdout(), /\+ productive\s+\. unchanged\s+\? questionable\s+~ wasteful\s+! risky/);
  });

  it("filters by label", async () => {
    assert.equal(await run("list", "--label", "risky"), 0);
    const rows = out.filter((l) => l.startsWith("!"));
    assert.ok(rows.length > 0, "demo data contains a risky run");
  });

  it("filters by source", async () => {
    assert.equal(await run("list", "--source", "opencode"), 0);
    assert.match(stdout(), /run\(s\)\./);
  });

  it("hides a trivial-only store behind --all", async () => {
    // The demo fixtures are all substantive, so a trivial run has to be built
    // here to reach the branch at all — which is the branch a user hits after
    // ingesting a day of one-word sessions.
    const storage = join(tmp, "trivial-storage");
    const path = new OcBuilder(storage, { sessionId: "ses_trivial0000000000000009" })
      .user(".")
      .say("I'm ready to help. What would you like me to work on?")
      .writeTo();

    const trivialDb = join(tmp, "trivial.db");
    const store = new Store(trivialDb);
    // The importer resolves message/ and part/ from the configured storage root,
    // not relative to the session file, so this has to be set even when loading
    // a single known path.
    process.env["OPENCODE_STORAGE_DIR"] = storage;
    try {
      for (const r of new OpenCodeSource().load(path)) {
        const a = analyze(r);
        store.upsert(r, a, generate(r, a));
      }
    } finally {
      delete process.env["OPENCODE_STORAGE_DIR"];
      store.close();
    }

    assert.equal(await main(["list", "--db", trivialDb]), 1);
    assert.match(stdout(), /1 trivial run\(s\) hidden, use --all to show them/);

    out = [];
    assert.equal(await main(["list", "--all", "--db", trivialDb]), 0);
    assert.match(stdout(), /1 run\(s\)\./);
  });

  it("explains an empty store and reports failure", async () => {
    assert.equal(await main(["list", "--db", join(tmp, "empty.db")]), 1);
    assert.match(stdout(), /no runs — try `flightrec ingest` first/);
  });
});

describe("report", () => {
  const someRunId = (): string => {
    const store = new Store(db);
    const id = store.listRuns({ limit: 1, includeTrivial: true })[0]?.run_id;
    store.close();
    assert.ok(id);
    return id;
  };

  it("prints the markdown postmortem", async () => {
    assert.equal(await run("report", someRunId()), 0);
    assert.match(stdout(), /^#/m);
  });

  it("prints the full document with --json", async () => {
    assert.equal(await run("report", someRunId(), "--json"), 0);
    const doc = JSON.parse(stdout()) as Record<string, unknown>;
    assert.ok(doc["trace"]);
    assert.ok(doc["analysis"]);
    assert.ok(doc["postmortem"]);
  });

  it("fails on an unknown run id", async () => {
    assert.equal(await run("report", "nope"), 1);
    assert.match(stderr(), /no run 'nope'/);
  });
});

describe("stats", () => {
  it("prints parseable JSON", async () => {
    assert.equal(await run("stats"), 0);
    const s = JSON.parse(stdout()) as Record<string, unknown>;
    assert.ok(Number(s["runs"]) > 0);
  });
});

describe("regrade", () => {
  /** A store whose runs claim an analyzer that no longer exists. */
  const staleDb = (): string => {
    const path = join(tmp, `stale-${Math.random().toString(36).slice(2)}.db`);
    const store = new Store(path);
    seedDemo(store, { root: join(tmp, "regrade-seed") });
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE runs SET analyzer_version='0.9.0'");
    raw.close();
    return path;
  };

  it("regrades runs the current analyzer did not grade", async () => {
    const path = staleDb();
    assert.equal(await main(["regrade", "--db", path]), 0);
    assert.match(stdout(), /regraded \d+ run\(s\) with analyzer/);

    const store = new Store(path);
    const versions = store.stats()["analyzer_versions"] as Record<string, number>;
    store.close();
    assert.deepEqual(Object.keys(versions), [ANALYZER_VERSION], "no stale rows may remain");
  });

  it("does nothing when the store is already current", async () => {
    const path = join(tmp, "current.db");
    const store = new Store(path);
    seedDemo(store, { root: join(tmp, "current-seed") });
    store.close();

    assert.equal(await main(["regrade", "--db", path]), 0);
    assert.match(stdout(), /nothing to regrade/);
  });

  it("works from the stored trace, so it needs no transcript on disk", async () => {
    // The reason this command exists: Claude Code purges transcripts after about
    // thirty days, and `ingest` cannot regrade a file that is gone.
    const path = staleDb();
    rmSync(join(tmp, "regrade-seed"), { recursive: true, force: true });
    assert.equal(await main(["regrade", "--db", path]), 0);
    assert.doesNotMatch(stdout(), /nothing to regrade/);
  });
});

describe("ingest", () => {
  it("reports what it parsed and stored", async () => {
    process.env["CLAUDE_CONFIG_DIR"] = demoRoot;
    process.env["OPENCODE_STORAGE_DIR"] = join(demoRoot, "opencode", "storage");
    try {
      assert.equal(await main(["ingest", "--db", join(tmp, "ingest.db")]), 0);
      assert.match(stdout(), /file\(s\) parsed/);
      assert.match(stdout(), /run\(s\) stored/);
    } finally {
      delete process.env["CLAUDE_CONFIG_DIR"];
      delete process.env["OPENCODE_STORAGE_DIR"];
    }
  });

  it("explains itself when there is no agent data to find", async () => {
    const empty = join(tmp, "nothing");
    process.env["CLAUDE_CONFIG_DIR"] = empty;
    process.env["OPENCODE_STORAGE_DIR"] = empty;
    try {
      assert.equal(await main(["ingest", "--db", join(tmp, "empty2.db")]), 0);
      assert.match(stdout(), /No agent data found/);
    } finally {
      delete process.env["CLAUDE_CONFIG_DIR"];
      delete process.env["OPENCODE_STORAGE_DIR"];
    }
  });
});

describe("demo", () => {
  it("loads synthetic runs into the given database", async () => {
    const target = join(tmp, "demo.db");
    assert.equal(await main(["demo", "--db", target]), 0);
    assert.match(stdout(), /loaded \d+ synthetic run\(s\)/);

    const store = new Store(target);
    const runs = store.listRuns({ limit: 100, includeTrivial: true });
    store.close();
    assert.ok(runs.length > 0);
  });

  it("leaves the source environment variables as it found them", async () => {
    // seedDemo redirects CLAUDE_CONFIG_DIR while it builds. If it failed to put
    // it back, every later ingest in this process would silently read fixture
    // data instead of the user's real history.
    const before = process.env["CLAUDE_CONFIG_DIR"];
    await main(["demo", "--db", join(tmp, "demo2.db")]);
    assert.equal(process.env["CLAUDE_CONFIG_DIR"], before);
  });
});

describe("the installed binary", () => {
  const exec = (args: string[]): { status: number; stdout: string } => {
    try {
      const stdout = execFileSync(process.execPath, [CLI_JS, ...args], { encoding: "utf8" });
      return { status: 0, stdout };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { status: err.status ?? -1, stdout: err.stdout ?? "" };
    }
  };

  it("prints usage and exits 0", () => {
    const r = exec([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: flightrec/);
  });

  it("exits 1 when a command fails", () => {
    assert.equal(exec(["report", "nope", "--db", db]).status, 1);
  });

  // npm installs `bin` entries as symlinks, so this is how every globally
  // installed copy is invoked — and it is the one path the guard used to get
  // wrong. `import.meta.url` is the real file; `process.argv[1]` is the symlink.
  // Comparing them without resolving made the installed CLI print nothing and
  // exit 0, which looks exactly like success.
  it("runs when invoked through a bin symlink", () => {
    const link = join(tmp, "flightrec-link");
    rmSync(link, { force: true });
    symlinkSync(CLI_JS, link);

    const out = execFileSync(process.execPath, [link], { encoding: "utf8" });
    assert.match(out, /Usage: flightrec/, "a symlinked bin must still run main()");
  });
});
