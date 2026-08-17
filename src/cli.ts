#!/usr/bin/env node
/** flightrec command line. */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { ingest } from "./ingest.js";
import type { Label } from "./model.js";
import { serve } from "./server.js";
import { availableSources } from "./sources/index.js";
import { defaultDbPath, Store } from "./store.js";

const LABEL_MARK: Record<Label, string> = {
  productive: "+",
  questionable: "?",
  wasteful: "~",
  risky: "!",
};

/**
 * node:sqlite is stable enough for a local single-writer store, but Node emits an
 * experimental warning per process. Silence just that one; keep every other warning.
 *
 * Called from the entry guard rather than at import time: as a module side effect
 * it stripped warning listeners from any process that merely imported this file,
 * which is not a CLI's business to do to its callers.
 */
function silenceSqliteWarning(): void {
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (!(w.name === "ExperimentalWarning" && w.message.includes("SQLite"))) console.warn(w);
  });
}

export interface Args {
  cmd: string;
  db: string;
  flags: Map<string, string | true>;
  positional: string[];
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  let cmd = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      const next = argv[i + 1];
      if (inline !== undefined) flags.set(k as string, inline);
      else if (next && !next.startsWith("-")) {
        flags.set(k as string, next);
        i++;
      } else flags.set(k as string, true);
    } else if (a === "-v") {
      flags.set("verbose", true);
    } else if (!cmd) {
      cmd = a;
    } else {
      positional.push(a);
    }
  }
  const db = flags.get("db");
  return { cmd, db: typeof db === "string" ? db : defaultDbPath(), flags, positional };
}

function fmtDur(s: number | null): string {
  if (s === null) return "    ?";
  const n = Math.round(s);
  return n >= 60
    ? `${String(Math.floor(n / 60)).padStart(3)}m${String(n % 60).padStart(2, "0")}s`
    : `${String(n).padStart(5)}s`;
}

function num(v: string | true | undefined, fallback: number | null = null): number | null {
  return typeof v === "string" && v !== "" ? Number(v) : fallback;
}

// --- commands ----------------------------------------------------------------

function cmdIngest(args: Args): number {
  const store = new Store(args.db);
  const names = availableSources().map((s) => s.name);
  console.log(`scanning… (sources: ${names.join(", ") || "none found"})`);
  const res = ingest(store, {
    sinceDays: num(args.flags.get("since-days")),
    force: args.flags.has("force"),
    limit: num(args.flags.get("limit")),
    ...(args.flags.has("verbose") ? { onProgress: (l: string) => console.log(l) } : {}),
  });
  console.log(
    `\n${res.filesParsed} file(s) parsed, ${res.filesSkipped} unchanged, ` +
      `${res.runsStored} run(s) stored in ${res.elapsedS}s`,
  );
  if (res.errors.length) {
    console.log(`${res.errors.length} error(s):`);
    for (const e of res.errors.slice(0, 10)) console.log(`  ${e}`);
  }
  if (!res.sourcesUsed.length) {
    console.log(
      "\nNo agent data found. Looked for Claude Code transcripts under ~/.claude/projects " +
        "(override with CLAUDE_CONFIG_DIR).",
    );
  }
  store.close();
  return 0;
}

function cmdList(args: Args): number {
  const store = new Store(args.db);
  const includeTrivial = args.flags.has("all");
  const opts = {
    limit: num(args.flags.get("limit"), 40) ?? 40,
    project: (args.flags.get("project") as string) ?? null,
    label: (args.flags.get("label") as string) ?? null,
    source: (args.flags.get("source") as string) ?? null,
  };
  const runs = store.listRuns({ ...opts, includeTrivial });
  if (!runs.length) {
    const anyTrivial = includeTrivial
      ? 0
      : store.listRuns({ ...opts, includeTrivial: true }).length;
    console.log(
      anyTrivial
        ? `no substantive runs — ${anyTrivial} trivial run(s) hidden, use --all to show them`
        : "no runs — try `flightrec ingest` first",
    );
    store.close();
    return 1;
  }
  console.log(
    `${"".padEnd(2)} ${"run".padEnd(14)} ${"when".padEnd(17)} ${"dur".padStart(7)} ` +
      `${"files".padStart(5)} ${"±lines".padStart(9)} ${"$".padStart(7)}  ${"verify".padEnd(9)} goal`,
  );
  for (const r of runs) {
    const cost = r.cost_known ? (r.cost_usd ?? 0).toFixed(2) : "?";
    console.log(
      `${LABEL_MARK[r.label] ?? " "}  ${r.run_id.padEnd(14)} ` +
        `${(r.started_at ?? "").slice(0, 16).padEnd(17)} ${fmtDur(r.duration_s).padStart(7)} ` +
        `${String(r.files_changed).padStart(5)} ` +
        `${`+${r.lines_added}/-${r.lines_removed}`.padStart(9)} ${cost.padStart(7)}  ` +
        `${(r.verification_status ?? "?").padEnd(9)} ` +
        `${(r.goal ?? "(no prompt in segment)").slice(0, 56)}`,
    );
  }
  const hidden = includeTrivial
    ? 0
    : store.listRuns({ ...opts, limit: 100000, includeTrivial: true }).length -
      store.listRuns({ ...opts, limit: 100000 }).length;
  const note = hidden > 0 ? `  (${hidden} trivial hidden — --all to show)` : "";
  console.log(`\n${runs.length} run(s).${note}  + productive  ? questionable  ~ wasteful  ! risky`);
  store.close();
  return 0;
}

function cmdReport(args: Args): number {
  const store = new Store(args.db);
  const runId = args.positional[0];
  const run = runId ? store.getRun(runId) : null;
  if (!run) {
    console.error(`no run '${runId}'`);
    store.close();
    return 1;
  }
  console.log(args.flags.has("json") ? JSON.stringify(run, null, 2) : run.postmortem.markdown);
  store.close();
  return 0;
}

function cmdServe(args: Args): number {
  const store = new Store(args.db);
  if (args.flags.has("ingest")) {
    const res = ingest(store, { sinceDays: num(args.flags.get("since-days")) });
    console.log(`ingested ${res.runsStored} run(s) from ${res.filesParsed} file(s)`);
  }
  serve(store, { port: num(args.flags.get("port"), 8787) ?? 8787 });
  return 0;
}

function cmdStats(args: Args): number {
  const store = new Store(args.db);
  console.log(JSON.stringify(store.stats(), null, 2));
  store.close();
  return 0;
}

/** Ingest synthetic runs so the dashboard can be evaluated without real data. */
async function cmdDemo(args: Args): Promise<number> {
  // Loaded on demand: the fixture builders are only needed by this one command,
  // and every other command pays their parse cost otherwise.
  const { seedDemo } = await import("./demo/index.js");

  const store = new Store(args.db);
  const { runs } = seedDemo(store);
  console.log(`loaded ${runs} synthetic run(s) into ${args.db}`);
  console.log("now run:  flightrec serve");
  store.close();
  return 0;
}

const USAGE = `flightrec — record coding-agent runs and explain what happened.

Usage: flightrec <command> [options]

Commands:
  ingest                scan agent transcripts and analyse them
    --since-days <n>    only files modified in the last n days
    --limit <n>         max transcripts to read
    --force             re-analyse unchanged files
    -v                  print each file as it is parsed
  list                  list analysed runs
    --limit <n>         default 40
    --project <path>
    --source <claude_code|opencode>
    --label <productive|questionable|wasteful|risky>
    --all               include trivial runs (no tool calls, no diff, seconds long)
  report <run-id>       print a run's postmortem
    --json              full trace + analysis instead of markdown
  serve                 open the local dashboard
    --port <n>          default 8787
    --ingest            ingest before serving
  demo                  load synthetic runs to try the dashboard
  stats                 aggregate stats across stored runs

Global:
  --db <path>           SQLite database (default ~/.flightrec/flightrec.db)
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  switch (args.cmd) {
    case "ingest":
      return cmdIngest(args);
    case "list":
      return cmdList(args);
    case "report":
      return cmdReport(args);
    case "serve":
      return cmdServe(args);
    case "stats":
      return cmdStats(args);
    case "demo":
      return cmdDemo(args);
    default:
      console.log(USAGE);
      return args.cmd ? 1 : 0;
  }
}

/**
 * Was this module run directly, rather than imported?
 *
 * `import.meta.url` is always the real path, but `process.argv[1]` is whatever
 * the caller typed — and npm installs `bin` entries as symlinks, so for a
 * globally installed CLI the two never match. Comparing them naively makes the
 * installed binary exit 0 having done nothing at all. Resolve the invoked path
 * before comparing.
 */
function invokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false; // argv[1] is not a real path (a REPL, an eval, a bundler)
  }
}

if (invokedDirectly()) {
  silenceSqliteWarning();
  void main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
