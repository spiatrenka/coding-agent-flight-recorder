/**
 * Deterministic postmortem generation.
 *
 * No model call. The narrative is assembled from the Analysis by templates chosen
 * on the evidence, which buys three things an LLM summary can't: it is identical
 * on every run over the same data, it costs nothing, and it never invents a fact
 * that isn't in the trace.
 *
 * The firewall section is not prose. It compiles the same Findings into concrete
 * `settings.json` permission rules and hook descriptions, so arming them later is
 * a config change rather than a rewrite.
 */

import { describeCost, PRICES_UPDATED, priceTableSourceName } from "./analyze/cost.js";
import type { Analysis } from "./analyze/index.js";
import {
  filesTouched,
  type Label,
  type Run,
  SEVERITY_ORDER,
  type Severity,
  toolCalls,
  totalTokens,
  unrecordedWrites,
} from "./model.js";

export const GENERATOR = "flightrec.postmortem/1.0 (deterministic, no LLM)";

export type Confidence = "high" | "medium" | "low";

export interface FirewallRule {
  rule: string;
  kind: string;
  priority: Severity;
  because: string;
  fromFinding: string;
  implementation: string | null;
  settingsJson: { permissions?: Record<string, string[]> } | null;
  /** This release only proposes. Nothing is armed. */
  enforced: false;
}

export interface Postmortem {
  runId: string;
  generatedAt: string;
  generator: string;
  label: Label;
  labelReason: string;
  confidence: Confidence;
  confidenceNotes: string[];
  headline: string;
  sections: {
    goal: string;
    whatHappened: string;
    whatChanged: string;
    whatFailed: string;
    cost: string;
    risks: string;
    shouldHaveStopped: string;
  };
  firewall: FirewallRule[];
  settingsSnippet: { permissions: Record<string, string[]> } | null;
  markdown: string;
}

// --- formatting helpers ------------------------------------------------------

function dur(seconds: number | null): string {
  if (seconds === null) return "unknown duration";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

function confidenceOf(run: Run, a: Analysis): { confidence: Confidence; notes: string[] } {
  const notes: string[] = [];
  let score = 3;

  if (!run.goalIsKnown) {
    score--;
    notes.push("no user prompt found in this segment, so the stated goal is inferred");
  }
  if (a.verification.status === "unknown") {
    score--;
    notes.push("check commands ran but their exit status wasn't recorded");
  }
  if (run.usage.costUsd === null) {
    notes.push("cost could not be priced, so spend-based judgements are omitted");
  }
  if (run.schemaDrift.length) {
    score--;
    notes.push(
      `transcript contained ${plural(run.schemaDrift.length, "unrecognised entry shape")} — ` +
        `parts of the run may not be represented`,
    );
  }
  if (run.compactions) {
    notes.push(
      `${plural(run.compactions, "context compaction")} occurred; earlier detail was discarded ` +
        `by the agent before this record was written`,
    );
  }

  const confidence: Confidence = score >= 3 ? "high" : score === 2 ? "medium" : "low";
  return { confidence, notes };
}

// --- section writers ---------------------------------------------------------

function goalSection(run: Run): string {
  if (run.goalIsKnown && run.goal) return run.goal;
  return (
    "Unknown — this segment contains no user prompt. It is most likely a resumed or automated " +
    "continuation; check the preceding segment of the same session."
  );
}

function whatHappened(run: Run, a: Analysis): string {
  const tools = new Map<string, number>();
  for (const e of toolCalls(run)) {
    const n = e.toolName ?? "unknown";
    tools.set(n, (tools.get(n) ?? 0) + 1);
  }
  const top = [...tools.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([n, c]) => `${n}×${c}`)
    .join(", ");

  const parts = [
    `The run lasted ${dur(a.metrics.durationS)} and made ${plural(a.metrics.toolCalls, "tool call")} ` +
      `(${top || "no tool calls"}).`,
  ];

  if (a.metrics.commands) {
    parts.push(
      `${plural(a.metrics.commands, "shell command")} ran` +
        (a.metrics.failedCommands
          ? `, ${a.metrics.failedCommands} of which failed.`
          : ", all of which succeeded or returned no failure signal."),
    );
  } else {
    parts.push("No shell commands were run.");
  }

  if (run.compactions) {
    parts.push(
      `The context window was compacted ${plural(run.compactions, "time")} mid-run, which ` +
        `discards earlier detail and is a common cause of the agent repeating work it had ` +
        `already done.`,
    );
  }
  if (run.models.length) parts.push(`Models used: ${run.models.join(", ")}.`);
  return parts.join(" ");
}

function whatChanged(run: Run, a: Analysis): string {
  const files = filesTouched(run);
  const opaqueWrites = unrecordedWrites(run);
  const shellNote = opaqueWrites.length
    ? `\n\n${plural(opaqueWrites.length, "shell command")} may also have changed files ` +
      `without going through an edit tool, so this diff is incomplete:\n` +
      opaqueWrites
        .slice(0, 6)
        .map((c) => `  ${c.command.split("\n")[0]?.slice(0, 90) ?? ""}`)
        .join("\n") +
      (opaqueWrites.length > 6 ? `\n  … and ${opaqueWrites.length - 6} more` : "")
    : "";

  if (files.length === 0) {
    const head = opaqueWrites.length
      ? "No edit-tool changes were recorded."
      : "Nothing. No file was modified in this run, so the repository is byte-for-byte where it started.";
    return `${head}${shellNote}`;
  }
  const head = `${plural(files.length, "file")} changed, +${a.metrics.linesAdded}/−${a.metrics.linesRemoved} lines.`;
  const perFile = files.slice(0, 20).map((p) => {
    const edits = run.fileEdits.filter((e) => e.path === p && e.applied);
    const add = edits.reduce((n, e) => n + (e.linesAdded ?? 0), 0);
    const del = edits.reduce((n, e) => n + (e.linesRemoved ?? 0), 0);
    return `  ${p}  (+${add}/−${del}, ${plural(edits.length, "edit")})`;
  });
  if (files.length > 20) perFile.push(`  … and ${files.length - 20} more`);

  const rejected = run.fileEdits.filter((e) => !e.applied);
  const tail = rejected.length
    ? `\n${plural(rejected.length, "edit")} was blocked or errored and did not apply.`
    : "";
  return `${head}\n${perFile.join("\n")}${tail}${shellNote}`;
}

function whatFailed(run: Run, a: Analysis): string {
  const v = a.verification;
  const lines: string[] = [];

  if (v.status === "not_run") {
    lines.push(
      "No test, build or lint command was executed, so nothing in this run confirms or refutes " +
        "the change.",
    );
  } else {
    lines.push(`Verification: ${v.status} — ${v.summary}.`);
    if (v.lastCheck) lines.push(`Last check run: \`${v.lastCheck.command}\`.`);
    // Neither source records exit codes, so say where the verdict came from.
    if (v.frameworks.length) {
      lines.push(
        `Outcome read from ${v.frameworks.join(", ")} output — no exit code is recorded ` +
          `by this agent, so the runner's own summary is the evidence.`,
      );
    } else if (v.status === "unknown") {
      lines.push(
        "No recognised test-runner summary was found and no exit code was recorded, " +
          "so these checks are inconclusive rather than passing.",
      );
    }
  }

  const failures = run.commands.filter((c) => c.ok === false);
  if (failures.length) {
    lines.push(`\n${plural(failures.length, "command")} failed:`);
    const counts = new Map<string, number>();
    for (const c of failures) {
      const k = c.command.split(/\s+/).join(" ").trim();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [cmd, n] of [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)) {
      lines.push(`  ${cmd}${n > 1 ? `   (${n}×)` : ""}`);
    }
  } else if (v.status !== "not_run") {
    lines.push("No command failed.");
  }
  return lines.join("\n");
}

function costSection(run: Run): string {
  const u = run.usage;
  if (totalTokens(u) === 0) {
    return (
      "Unknown — this transcript carries no token counters. That happens on some agent versions " +
      "and on segments made entirely of tool results."
    );
  }
  const breakdown =
    `${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out / ` +
    `${u.cacheReadTokens.toLocaleString()} cache read / ${u.cacheCreationTokens.toLocaleString()} ` +
    `cache write = ${totalTokens(u).toLocaleString()} tokens`;

  const note =
    u.costUsd === null
      ? "\nNo price entry matched the model(s) in this run, so no dollar figure is given. Set " +
        "FLIGHTREC_PRICES to a JSON price table to enable estimation."
      : !u.costIsEstimate
        ? "\nThis figure was reported by the agent itself, not modelled from token counters."
        : `\nCost is modelled from token counters using ${priceTableSourceName()} ` +
          `(last checked ${PRICES_UPDATED}), not read from a bill. Treat it as an order of magnitude.`;

  return `${breakdown}\n${describeCost(u)}.${note}`;
}

function riskSection(a: Analysis): string {
  if (a.findings.length === 0) return "No risk flags raised.";
  const lines: string[] = [];
  for (const f of [...a.findings].sort(
    (x, y) => SEVERITY_ORDER[y.severity] - SEVERITY_ORDER[x.severity],
  )) {
    lines.push(`[${f.severity.toUpperCase().padEnd(6)}] ${f.title}`);
    lines.push(`         ${f.detail}`);
    const ev = f.evidence[0];
    if (ev) lines.push(`         → event ${ev.eventIdx}: ${ev.excerpt.slice(0, 120)}`);
  }
  return lines.join("\n");
}

function stopSection(a: Analysis): string {
  const sp = a.stopPoint;
  if (!sp) {
    return a.label === "productive"
      ? "No. The run stopped at a reasonable point."
      : "No single point stands out. The run's problems are distributed across it rather than " +
          "starting at one identifiable moment.";
  }
  const when = sp.ts ? ` at ${sp.ts}` : "";
  const tail = [plural(sp.eventsAfter, "event")];
  if (sp.minutesAfter !== null) tail.push(`${sp.minutesAfter} minutes`);
  if (sp.editsAfter) tail.push(plural(sp.editsAfter, "further file edit"));
  if (sp.checksAfter) tail.push(plural(sp.checksAfter, "further check"));

  const verdict = sp.editsAfter
    ? "Those later edits may well be the useful ones — read them before discarding the tail."
    : "Nothing was changed on disk after that point, so the tail was pure overhead.";

  return (
    `Yes — around event ${sp.eventIdx}${when}, at ${sp.trigger}.\n` +
    `After that point the run continued for ${tail.join(", ")}.\n${verdict}`
  );
}

function headline(run: Run, a: Analysis): string {
  const bits = [dur(a.metrics.durationS)];
  bits.push(
    a.metrics.filesChanged
      ? `${plural(a.metrics.filesChanged, "file")} changed`
      : "no files changed",
  );
  if (run.usage.costUsd !== null) bits.push(`~$${run.usage.costUsd.toFixed(2)}`);
  const phrases: Record<string, string> = {
    passed: "checks passed",
    failed: "checks failing",
    mixed: "checks mixed",
    not_run: "nothing verified",
    unknown: "check results unclear",
  };
  bits.push(phrases[a.verification.status] ?? "verification unclear");
  return bits.join(" · ");
}

// --- firewall ----------------------------------------------------------------

/** Compile findings into concrete guardrail proposals. Nothing is armed. */
function compileFirewall(a: Analysis): {
  rules: FirewallRule[];
  snippet: { permissions: Record<string, string[]> } | null;
} {
  const rules: FirewallRule[] = [];
  const seen = new Set<string>();
  const permissions: Record<string, string[]> = {};

  const ordered = [...a.findings].sort(
    (x, y) => SEVERITY_ORDER[y.severity] - SEVERITY_ORDER[x.severity],
  );

  for (const f of ordered) {
    for (const r of f.suggestedRules) {
      if (r.kind === "keep" || !r.rule || seen.has(r.rule)) continue;
      seen.add(r.rule);
      rules.push({
        rule: r.rule,
        kind: r.kind,
        priority: f.severity,
        because: f.title,
        fromFinding: f.id,
        implementation: r.implementation ?? null,
        settingsJson: r.settingsJson ?? null,
        enforced: false,
      });
      for (const [bucket, patterns] of Object.entries(r.settingsJson?.permissions ?? {})) {
        const list = (permissions[bucket] ??= []);
        for (const p of patterns) if (!list.includes(p)) list.push(p);
      }
    }
  }

  return {
    rules,
    snippet: Object.keys(permissions).length ? { permissions } : null,
  };
}

// --- entry point -------------------------------------------------------------

export function generate(run: Run, a: Analysis): Postmortem {
  const { confidence, notes } = confidenceOf(run, a);
  const { rules, snippet } = compileFirewall(a);

  const pm: Postmortem = {
    runId: run.runId,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    generator: GENERATOR,
    label: a.label,
    labelReason: a.labelReason,
    confidence,
    confidenceNotes: notes,
    headline: headline(run, a),
    sections: {
      goal: goalSection(run),
      whatHappened: whatHappened(run, a),
      whatChanged: whatChanged(run, a),
      whatFailed: whatFailed(run, a),
      cost: costSection(run),
      risks: riskSection(a),
      shouldHaveStopped: stopSection(a),
    },
    firewall: rules,
    settingsSnippet: snippet,
    markdown: "",
  };
  pm.markdown = renderMarkdown(run, a, pm);
  return pm;
}

export function renderMarkdown(run: Run, a: Analysis, pm: Postmortem): string {
  const L: string[] = [];
  L.push(`# Postmortem — ${run.runId}`, "");
  L.push(`**${pm.label.toUpperCase()}** — ${pm.labelReason}`, "");
  L.push(`\`${pm.headline}\``, "");
  L.push("| | |", "|---|---|");
  L.push(`| Project | \`${run.projectPath ?? "unknown"}\` |`);
  L.push(`| Branch | \`${run.gitBranch ?? "unknown"}\` |`);
  L.push(`| Session | \`${run.sessionId}\` (segment ${run.segment}) |`);
  L.push(`| Started | ${run.startedAt ?? "unknown"} |`);
  L.push(`| Agent | ${run.source} ${run.agentVersion ?? ""} |`);
  L.push(`| Confidence | ${pm.confidence} |`, "");

  const sections: Array<[keyof Postmortem["sections"], string, boolean]> = [
    ["goal", "Goal", false],
    ["whatHappened", "What happened", false],
    ["whatChanged", "What changed", true],
    ["whatFailed", "What failed", true],
    ["cost", "Cost and usage", true],
    ["risks", "Risk flags", true],
    ["shouldHaveStopped", "Should this have been stopped earlier?", false],
  ];
  for (const [key, title, fenced] of sections) {
    L.push(`## ${title}`, "");
    L.push(fenced ? `\`\`\`\n${pm.sections[key]}\n\`\`\`` : pm.sections[key]);
    L.push("");
  }

  L.push("## Firewall recommendations", "");
  if (pm.firewall.length === 0) {
    L.push("Nothing to propose — this run raised no findings that map to a guardrail.");
  } else {
    L.push("_Proposed only. Nothing here is enforced by this tool._", "");
    for (const r of pm.firewall) {
      L.push(`- **${r.rule}** (${r.priority}) — because ${r.because.toLowerCase()}`);
      if (r.implementation) L.push(`  - ${r.implementation}`);
    }
    if (pm.settingsSnippet) {
      L.push("", "Merged `settings.json` fragment:", "", "```json");
      L.push(JSON.stringify(pm.settingsSnippet, null, 2));
      L.push("```");
    }
  }
  L.push("");

  if (pm.confidenceNotes.length) {
    L.push("## Confidence notes", "");
    for (const n of pm.confidenceNotes) L.push(`- ${n}`);
    L.push("");
  }
  if (run.schemaDrift.length) {
    L.push("## Parser warnings", "");
    for (const d of run.schemaDrift) L.push(`- ${d}`);
    L.push("");
  }

  L.push("---");
  L.push(
    `Generated ${pm.generatedAt} by ${pm.generator}. Analyzer ${a.analyzerVersion}. ` +
      `Source: \`${run.sourceFile ?? "n/a"}\`.`,
  );
  return L.join("\n");
}
