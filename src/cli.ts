#!/usr/bin/env node
/** flightrec command line. */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ANALYZER_VERSION, analyze } from "./analyze/index.js";
import { auditCorpus, formatCorpusReport } from "./corpus.js";
import { buildFeedback, formatFeedback } from "./feedback.js";
import { ingest, staleSources } from "./ingest.js";
import type { Label } from "./model.js";
import { generate } from "./postmortem.js";
import { serve } from "./server.js";
import { availableSources } from "./sources/index.js";
import { defaultDbPath, Store } from "./store.js";

const LABEL_MARK: Record<Label, string> = {
  productive: "+",
  unchanged: ".",
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
  if (res.filesRegraded) {
    console.log(
      `${res.filesRegraded} of those were unchanged on disk and re-read because this ` +
        `build grades differently (analyzer ${ANALYZER_VERSION}). Their verdicts may have ` +
        `moved; \`flightrec regrade\` does the same for runs whose transcripts are gone.`,
    );
  }
  if (res.errors.length) {
    console.log(`${res.errors.length} error(s):`);
    for (const e of res.errors.slice(0, 10)) console.log(`  ${e}`);
  }
  for (const report of res.sourceReports) {
    for (const note of report.notes) console.log(`\n${report.source}: ${note}`);
  }

  // A source that has gone quiet is the failure this exists to catch: the
  // OpenCode importer served the same frozen files for six months and every
  // ingest reported success, because "0 new" and "broken" look identical.
  const stale = staleSources(res, (s) => store.listRuns({ source: s, limit: 1 }).length > 0);
  for (const r of stale) {
    const days = Math.floor(r.staleDays ?? 0);
    console.log(
      `\nWARNING: the newest ${r.source} data on this machine is ${days} days old ` +
        `(${(r.newestItem ?? "").slice(0, 10)}), but this store already has ${r.source} runs. ` +
        `Either you have not used it since, or it has moved where it keeps its data and ` +
        `flightrec is reading the wrong place.`,
    );
  }

  if (!res.sourcesUsed.length) {
    console.log(
      "\nNo agent data found. Looked for Claude Code transcripts under ~/.claude/projects " +
        "(CLAUDE_CONFIG_DIR to relocate), and OpenCode sessions under " +
        "~/.local/share/opencode (OPENCODE_DATA_DIR, or OPENCODE_DB for the database itself).",
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
  staleNotice(store);
  console.log(
    `\n${runs.length} run(s).${note}  + productive  . unchanged  ? questionable  ~ wasteful  ! risky`,
  );
  store.close();
  return 0;
}

/**
 * Say when stored runs were graded by a different analyzer.
 *
 * Grading changed in 1.1.0 (the `unchanged` label), and nothing regrades a store
 * automatically — so without this a user sees a mix of old and new labels with no
 * explanation.
 */
function staleNotice(store: Store): void {
  const versions = (store.stats()["analyzer_versions"] ?? {}) as Record<string, number>;
  const stale = Object.entries(versions).filter(([v]) => v !== ANALYZER_VERSION);
  if (!stale.length) return;
  const n = stale.reduce((sum, [, count]) => sum + count, 0);
  const which = stale.map(([v, count]) => `${count} by ${v}`).join(", ");
  console.log(
    `\n${n} run(s) were graded by an older analyzer (${which}); this build is ` +
      `${ANALYZER_VERSION}. Run \`flightrec regrade\` to bring them up to date — it ` +
      `works from the stored traces, so it does not need the original transcripts.`,
  );
}

/**
 * Re-grade stored runs from their stored traces, without re-reading transcripts.
 *
 * `ingest` regrades on an analyzer change, but only for files still on disk, and
 * Claude Code purges transcripts after about thirty days. For an archive older than
 * that the stored trace is the only copy — so without this a store keeps verdicts
 * from an analyzer that no longer exists and nothing can move them.
 *
 * Grading is deterministic, so this rewrites the analysis and the postmortem while
 * leaving the trace exactly as ingested.
 */
function cmdRegrade(args: Args): number {
  const store = new Store(args.db);
  const ids = store.runsToRegrade(args.flags.has("all") ? null : ANALYZER_VERSION);

  if (!ids.length) {
    console.log(`nothing to regrade — every stored run is already at ${ANALYZER_VERSION}`);
    store.close();
    return 0;
  }

  const moves = new Map<string, number>();
  let done = 0;
  const errors: string[] = [];
  for (const id of ids) {
    const stored = store.getRun(id);
    if (!stored) continue;
    try {
      const a = analyze(stored.trace);
      store.upsert(stored.trace, a, generate(stored.trace, a));
      done++;
      if (stored.label !== a.label) {
        const key = `${stored.label} → ${a.label}`;
        moves.set(key, (moves.get(key) ?? 0) + 1);
      }
    } catch (err) {
      errors.push(`${id}: ${String(err)}`);
    }
  }

  console.log(`regraded ${done} run(s) with analyzer ${ANALYZER_VERSION}`);
  if (moves.size) {
    console.log("\nverdict changes:");
    for (const [k, n] of [...moves].sort((x, y) => y[1] - x[1])) {
      console.log(`  ${String(n).padStart(5)}  ${k}`);
    }
  } else {
    console.log("no verdict changed");
  }
  for (const e of errors.slice(0, 10)) console.error(`  ! ${e}`);
  if (errors.length > 10) console.error(`  ! …and ${errors.length - 10} more`);
  store.close();
  return errors.length ? 1 : 0;
}

/**
 * Delete stored runs. The only destructive command in the tool.
 *
 * It exists because the alternative was worse: before this, the documented way to
 * remove anything was deleting the whole database — see SECURITY.md, which also
 * says redaction is a mitigation rather than a guarantee. That made "a credential
 * survived into one run" cost an entire archive, and Claude Code has usually purged
 * the transcripts needed to rebuild it.
 *
 * Deleting more than one run requires `--yes`. That is a flag rather than a prompt
 * so the guard is reachable from a test and behaves the same when piped.
 */
function cmdRemove(args: Args): number {
  const store = new Store(args.db);
  const opts = {
    ids: args.positional,
    project: (args.flags.get("project") as string) ?? null,
    before: (args.flags.get("before") as string) ?? null,
    synthetic: args.flags.has("synthetic"),
  };

  if (!opts.ids.length && !opts.project && !opts.before && !opts.synthetic) {
    console.error(
      "nothing selected. Give one or more run ids, or --project <path>, " +
        "--before <date>, or --synthetic.",
    );
    store.close();
    return 1;
  }

  const matches = store.findForDeletion(opts);
  if (!matches.length) {
    console.log("no runs matched — nothing deleted");
    store.close();
    return 1;
  }

  for (const m of matches) {
    console.log(
      `  ${m.run_id}  ${(m.started_at ?? "").slice(0, 16).padEnd(17)} ` +
        `${m.label.padEnd(13)} ${(m.goal ?? "(no prompt)").slice(0, 48)}`,
    );
  }

  const dryRun = args.flags.has("dry-run");
  if (dryRun) {
    console.log(`\n${matches.length} run(s) would be deleted. Nothing was changed.`);
    store.close();
    return 0;
  }

  if (matches.length > 1 && !args.flags.has("yes")) {
    console.error(
      `\n${matches.length} run(s) matched. Re-run with --yes to delete them, ` +
        `or --dry-run to review first.`,
    );
    store.close();
    return 1;
  }

  const n = store.deleteRuns(matches.map((m) => m.run_id));
  console.log(`\ndeleted ${n} run(s)`);
  console.log(
    "The original transcripts were not touched. `ingest --force` will restore any " +
      "run whose transcript still exists.",
  );
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

/**
 * The installed version, for the provenance line in `feedback`.
 *
 * Read at call time rather than baked in at build: a wrong version number in a
 * bug report is worse than an absent one, and this is the only consumer.
 */
function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(resolve(here, "..", "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Print a summary of one run that is safe to paste into a chat window.
 *
 * With no id it takes the most recent run and says which one it picked, because
 * the moment this is wanted is right after seeing a wrong verdict in `list`, and
 * copying an id out of a terminal is exactly the friction that stops a report
 * from being sent.
 */
function cmdFeedback(args: Args): number {
  const store = new Store(args.db);
  let runId = args.positional[0];

  if (!runId) {
    const recent = store.listRuns({ limit: 1, includeTrivial: true });
    const latest = recent[0];
    if (!latest) {
      console.log("no runs — try `flightrec demo` or `flightrec ingest` first");
      store.close();
      return 1;
    }
    runId = latest.run_id;
    console.log(`(newest run: ${runId} — pass a run id to pick a different one)\n`);
  }

  const feedback = buildFeedback(store, runId, packageVersion());
  if (!feedback) {
    console.error(`no run '${runId}'`);
    store.close();
    return 1;
  }
  console.log(
    args.flags.has("json") ? JSON.stringify(feedback, null, 2) : formatFeedback(feedback),
  );
  store.close();
  return 0;
}

function cmdCorpus(args: Args): number {
  const store = new Store(args.db);
  const report = auditCorpus(store, { includeSynthetic: args.flags.has("include-synthetic") });
  if (report.coverage.runs === 0) {
    console.log("no runs — try `flightrec ingest` first");
    store.close();
    return 1;
  }
  console.log(
    args.flags.has("json") ? JSON.stringify(report, null, 2) : formatCorpusReport(report),
  );
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
    --label <productive|unchanged|questionable|wasteful|risky>
    --all               include trivial runs (no tool calls, no diff, seconds long)
  report <run-id>       print a run's postmortem
    --json              full trace + analysis instead of markdown
  regrade               re-grade stored runs from their stored traces, so an
                        analyzer upgrade reaches runs whose transcripts are gone
    --all               regrade every run, not only the out-of-date ones
  rm <run-id>...        delete stored runs (the originals are never touched)
    --project <path>    every run for one project
    --before <date>     runs started before an ISO date
    --synthetic         every run seeded by the demo command
    --dry-run           list what would go, change nothing
    --yes               required to delete more than one run
  serve                 open the local dashboard
    --port <n>          default 8787
    --ingest            ingest before serving
  demo                  load synthetic runs to try the dashboard
  stats                 aggregate stats across stored runs
  corpus                audit what the detectors did across the whole store
  feedback [run-id]     a short summary of one run, safe to paste to someone
                        else — no prompts, paths, file contents or commands.
                        Defaults to the newest run.
    --json              machine-readable instead of a table
    --include-synthetic  count runs seeded by the demo command too

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
    case "regrade":
      return cmdRegrade(args);
    case "rm":
      return cmdRemove(args);
    case "report":
      return cmdReport(args);
    case "serve":
      return cmdServe(args);
    case "stats":
      return cmdStats(args);
    case "corpus":
      return cmdCorpus(args);
    case "feedback":
      return cmdFeedback(args);
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
