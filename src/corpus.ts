/**
 * Corpus audit: what the detectors actually did across a whole store.
 *
 * This exists because fixtures cannot establish precision. A detector and its
 * fixture are written by the same person from the same assumption, so a green
 * suite says only that the code does what its author meant — not that what they
 * meant is right. Every defect found in this project's detectors was found by
 * measuring against real data, and each time the fixtures were passing.
 *
 * `docs/DECISIONS.md` makes that check a requirement for detector changes;
 * this is the tool that makes it a single command rather than ad-hoc SQL.
 *
 * Nothing here writes: it reads a store and returns counts.
 */

import { classifyPath } from "./analyze/risk.js";
import { detectorOf } from "./model.js";
import { MASK, survivingSecretKinds } from "./redact.js";
import type { Store } from "./store.js";

export interface Counted {
  key: string;
  n: number;
  pct: number;
}

export interface DetectorRow {
  detector: string;
  runs: number;
  pct: number;
  /** Highest severity this detector reached anywhere in the corpus. */
  worstSeverity: string;
}

export interface SensitivePathRow {
  path: string;
  hits: number;
  tier: string;
  why: string;
}

export interface OutcomeRow {
  source: string;
  known: number;
  unknown: number;
  failed: number;
  pctKnown: number;
}

export interface CorpusReport {
  coverage: {
    runs: number;
    sessions: number;
    projects: number;
    trivial: number;
    withDiff: number;
  };
  verdicts: Counted[];
  detectors: DetectorRow[];
  verification: Counted[];
  commandOutcomes: OutcomeRow[];
  sensitivePaths: SensitivePathRow[];
  redaction: {
    masksApplied: number;
    runsWithSurvivors: number;
    survivingKinds: Counted[];
  };
}

const pct = (n: number, total: number): number =>
  total === 0 ? 0 : Math.round((n / total) * 1000) / 10;

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function rankedSeverity(a: string, b: string): string {
  return (SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a;
}

function counted(map: Map<string, number>, total: number): Counted[] {
  return [...map.entries()]
    .map(([key, n]) => ({ key, n, pct: pct(n, total) }))
    .sort((x, y) => y.n - x.n || x.key.localeCompare(y.key));
}

/**
 * Build the audit. Runs are read one at a time and discarded: a real corpus is
 * hundreds of traces and holding them all would cost more memory than the
 * report is worth.
 */
export function auditCorpus(store: Store): CorpusReport {
  const summaries = store.listRuns({ limit: 1_000_000, includeTrivial: true });
  const total = summaries.length;

  const sessions = new Set<string>();
  const projects = new Set<string>();
  let trivial = 0;
  let withDiff = 0;

  const verdicts = new Map<string, number>();
  const verification = new Map<string, number>();
  const detectorRuns = new Map<string, number>();
  const detectorSeverity = new Map<string, string>();
  const paths = new Map<string, number>();
  const outcomes = new Map<string, { known: number; unknown: number; failed: number }>();

  let masksApplied = 0;
  let runsWithSurvivors = 0;
  const survivingKinds = new Map<string, number>();

  for (const s of summaries) {
    sessions.add(s.session_id);
    if (s.project_path) projects.add(s.project_path);
    if (s.trivial) trivial++;
    if (s.files_changed > 0) withDiff++;
    verdicts.set(s.label, (verdicts.get(s.label) ?? 0) + 1);
    verification.set(s.verification_status, (verification.get(s.verification_status) ?? 0) + 1);

    const run = store.getRun(s.run_id);
    if (!run) continue;

    // One increment per detector per run: a run that churned four files should
    // count once for `loop.churn`, not four times.
    const seen = new Set<string>();
    for (const f of run.analysis.findings) {
      const d = detectorOf(f.id);
      if (!seen.has(d)) {
        seen.add(d);
        detectorRuns.set(d, (detectorRuns.get(d) ?? 0) + 1);
      }
      detectorSeverity.set(d, rankedSeverity(detectorSeverity.get(d) ?? "low", f.severity));

      if (f.id.startsWith("risk.secret_file") || f.id === "risk.config_file_write") {
        for (const e of f.evidence) {
          const p = (e.excerpt ?? "").trim();
          if (p) paths.set(p, (paths.get(p) ?? 0) + 1);
        }
      }
    }

    const bucket = outcomes.get(run.source) ?? { known: 0, unknown: 0, failed: 0 };
    for (const c of run.trace.commands) {
      if (c.ok === null) bucket.unknown++;
      else {
        bucket.known++;
        if (c.ok === false) bucket.failed++;
      }
    }
    outcomes.set(run.source, bucket);

    // Redaction audit against the stored document, which is what actually
    // persists — not against the transcript it came from.
    const blob = JSON.stringify(run.trace);
    masksApplied += blob.split(MASK).length - 1;
    const kinds = survivingSecretKinds(blob);
    if (kinds.length) {
      runsWithSurvivors++;
      for (const k of kinds) survivingKinds.set(k, (survivingKinds.get(k) ?? 0) + 1);
    }
  }

  const detectors: DetectorRow[] = [...detectorRuns.entries()]
    .map(([detector, runs]) => ({
      detector,
      runs,
      pct: pct(runs, total),
      worstSeverity: detectorSeverity.get(detector) ?? "low",
    }))
    .sort((a, b) => b.runs - a.runs || a.detector.localeCompare(b.detector));

  const sensitivePaths: SensitivePathRow[] = [...paths.entries()]
    .map(([path, hits]) => {
      const c = classifyPath(path);
      return { path, hits, tier: c.tier ?? "none", why: c.why ?? "" };
    })
    .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));

  return {
    coverage: { runs: total, sessions: sessions.size, projects: projects.size, trivial, withDiff },
    verdicts: counted(verdicts, total),
    detectors,
    verification: counted(verification, total),
    commandOutcomes: [...outcomes.entries()]
      .map(([source, o]) => ({
        source,
        ...o,
        pctKnown: pct(o.known, o.known + o.unknown),
      }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    sensitivePaths,
    redaction: {
      masksApplied,
      runsWithSurvivors,
      survivingKinds: counted(survivingKinds, total),
    },
  };
}

// --- rendering ---------------------------------------------------------------

function table(rows: string[][], indent = "  "): string {
  if (rows.length === 0) return `${indent}(none)`;
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map(
      (r) =>
        indent +
        r
          .map((c, i) => (c ?? "").padEnd(widths[i] ?? 0))
          .join("  ")
          .trimEnd(),
    )
    .join("\n");
}

/** Human-readable rendering. `--json` prints the object instead. */
export function formatCorpusReport(r: CorpusReport): string {
  const out: string[] = [];
  const c = r.coverage;

  out.push("COVERAGE");
  out.push(
    `  ${c.runs} run(s) across ${c.sessions} session(s) and ${c.projects} project(s); ` +
      `${c.trivial} trivial, ${c.withDiff} changed files`,
  );

  out.push("\nVERDICTS");
  out.push(table(r.verdicts.map((v) => [v.key, String(v.n), `${v.pct}%`])));

  out.push("\nVERIFICATION STATUS");
  out.push(table(r.verification.map((v) => [v.key, String(v.n), `${v.pct}%`])));

  out.push("\nDETECTORS  (runs affected — grouped by detector, not by instance)");
  out.push(
    table(
      r.detectors.map((d) => [d.detector, String(d.runs), `${d.pct}%`, `[${d.worstSeverity}]`]),
    ),
  );

  out.push("\nCOMMAND OUTCOMES  (unknown is honest, not a failure)");
  out.push(
    table(
      r.commandOutcomes.map((o) => [
        o.source,
        `${o.known} known`,
        `${o.unknown} unknown`,
        `${o.failed} failed`,
        `${o.pctKnown}% known`,
      ]),
    ),
  );

  out.push("\nSENSITIVE PATHS FLAGGED  (read these — precision is only visible here)");
  out.push(table(r.sensitivePaths.map((p) => [String(p.hits), p.tier, p.path, p.why])));

  out.push("\nREDACTION SELF-CHECK");
  out.push(`  ${r.redaction.masksApplied} mask(s) applied across the store`);
  if (r.redaction.runsWithSurvivors === 0) {
    out.push("  no credential shapes survived into the store");
  } else {
    out.push(`  ${r.redaction.runsWithSurvivors} run(s) still contain a credential shape:`);
    out.push(
      table(
        r.redaction.survivingKinds.map((k) => [k.key, `${k.n} run(s)`]),
        "    ",
      ),
    );
  }

  return out.join("\n");
}
