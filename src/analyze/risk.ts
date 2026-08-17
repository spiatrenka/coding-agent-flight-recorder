/**
 * Risk detectors: what the run touched that it probably shouldn't have.
 *
 * Two principles here:
 *
 * - Attempted counts. A destructive command that a permission prompt or hook blocked
 *   still tells you what the agent was willing to do. Blocked attempts are reported
 *   separately, at reduced severity, never ignored.
 * - Severity is about blast radius, not about how scary the string looks. Deleting a
 *   build directory is not the same event as deleting a working tree.
 */

import { homedir } from "node:os";
import { posix } from "node:path";

import {
  type Command,
  diffMayBeIncomplete,
  type Evidence,
  type Finding,
  filesTouched,
  netDiffLines,
  type Run,
  type Severity,
  toolCalls,
  totalTokens,
} from "../model.js";
import type { Verification } from "./verify.js";

// --- sensitive path classification ------------------------------------------

/**
 * Env files that are conventionally *committed templates*: placeholder values,
 * no secrets. `.env.example` was the single most-flagged path when the detectors
 * were measured against a real corpus — 17 hits, all false — because
 * `\.env(\.|$)` matches it just as readily as `.env.production`.
 */
const ENV_TEMPLATE_RE = /(^|\/)\.env\.(example|sample|template|dist|defaults?)$/i;

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(^|\/)\.env(\.|$)/, "environment file"],
  [/\.(pem|key|p12|pfx|keystore)$/, "private key material"],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, "SSH private key"],
  [/(^|\/)\.ssh\//, "SSH configuration"],
  [/(^|\/)\.aws\/|(^|\/)\.gcloud\/|(^|\/)\.kube\/config/, "cloud credentials"],
  [/(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/, "package/registry credentials"],
  // No `/` in the character class on purpose. With it, a *directory* named
  // `secrets/` matched, so `scripts/secrets/create-intake-secrets.sh` and
  // `src/secrets/index.ts` were reported as credential files — 19 false hits on
  // a real corpus. Managing secrets is not the same as holding one.
  [/(^|\/)(secrets?|credentials?)[._-]/, "credentials file"],
  [/(^|\/)service[-_]?account.*\.json$/, "service account key"],
];

const CONFIG_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(^|\/)\.github\/workflows\//, "CI workflow"],
  [/\.(tf|tfvars)$/, "Terraform"],
  [/(^|\/)(Dockerfile|docker-compose\.ya?ml)$/, "container config"],
  [/(^|\/)(k8s|kubernetes|helm|charts)\//, "Kubernetes manifest"],
  [/(^|\/)(package|package-lock|pnpm-lock|yarn)\.(json|lock|ya?ml)$/, "dependency manifest"],
  [/(^|\/)(pyproject\.toml|requirements.*\.txt|poetry\.lock|Cargo\.lock)$/, "dependency manifest"],
  [/(^|\/)\.git\//, "git internals"],
  [/(^|\/)migrations?\//, "database migration"],
];

export type PathTier = "secret" | "config" | null;

export function classifyPath(path: string): { tier: PathTier; why: string | null } {
  const p = path.replace(/\\/g, "/");
  // Checked before the secret patterns: a template is not a secret, and this is
  // the one case where a more specific rule has to beat a more general one.
  if (ENV_TEMPLATE_RE.test(p)) return { tier: null, why: null };
  for (const [re, why] of SECRET_PATTERNS) if (re.test(p)) return { tier: "secret", why };
  for (const [re, why] of CONFIG_PATTERNS) if (re.test(p)) return { tier: "config", why };
  return { tier: null, why: null };
}

function absolute(path: string, project: string | null): string {
  let p = path.replace(/\\/g, "/");
  if (p.startsWith("~"))
    p = posix.join(homedir().replace(/\\/g, "/"), p.slice(1).replace(/^\/+/, ""));
  if (!p.startsWith("/") && project) p = posix.join(project.replace(/\\/g, "/"), p);
  return posix.normalize(p);
}

export function outsideProject(path: string, project: string | null): boolean {
  if (!project) return false;
  const ap = absolute(path, project);
  const root = posix.normalize(project.replace(/\\/g, "/"));
  if (ap === root || ap.startsWith(`${root.replace(/\/$/, "")}/`)) return false;
  // Scratch space is expected and uninteresting.
  return !["/tmp/", "/var/folders/", "/private/tmp/"].some((pre) => ap.startsWith(pre));
}

// --- destructive command classification -------------------------------------

const DESTRUCTIVE: ReadonlyArray<[RegExp, Severity, string]> = [
  [/\brm\s+(-\w*[rf]\w*\s+)+/, "high", "recursive/forced delete"],
  [/\bgit\s+reset\s+--hard\b/, "high", "discards uncommitted work"],
  [/\bgit\s+clean\s+-\w*[fdx]/, "high", "deletes untracked files"],
  [/\bgit\s+checkout\s+(--\s+)?\.\s*$/, "high", "discards working tree changes"],
  [/\bgit\s+push\s+.*(--force\b|-f\b)/, "high", "force push rewrites remote history"],
  [/\bgit\s+branch\s+-D\b/, "medium", "force-deletes a branch"],
  [/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, "high", "destructive SQL"],
  [/\bterraform\s+(destroy|apply\s+-auto-approve)\b/, "high", "infrastructure mutation"],
  [/\bkubectl\s+delete\b/, "high", "deletes cluster resources"],
  [/\bdd\s+if=/, "high", "raw disk write"],
  [/\bmkfs(\.\w+)?\b/, "high", "formats a filesystem"],
  [/\bchmod\s+(-R\s+)?777\b/, "medium", "world-writable permissions"],
  [
    /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/,
    "high",
    "pipes a download straight into a shell",
  ],
  [/\b(npm\s+publish|cargo\s+publish|twine\s+upload)\b/, "high", "publishes a package"],
  [/\bsudo\b/, "medium", "elevated privileges"],
  [/\b(shutdown|reboot|killall)\b/, "medium", "host-level action"],
  [/>\s*\/dev\/sd[a-z]/, "high", "writes to a raw device"],
];

/** rm on these is routine and shouldn't be graded as a destructive incident. */
const BENIGN_RM =
  /\brm\s+-\w+\s+[^;&|]*?(node_modules|\/tmp\/|dist\/|build\/|\.next|target\/|__pycache__|\.pytest_cache|coverage|\.venv)/;

export function classifyCommandRisk(cmd: string): { severity: Severity; why: string } | null {
  for (const [re, severity, why] of DESTRUCTIVE) {
    if (re.test(cmd)) {
      if (why === "recursive/forced delete" && BENIGN_RM.test(cmd)) {
        return { severity: "low", why: "deletes build artefacts or dependencies" };
      }
      return { severity, why };
    }
  }
  return null;
}

// --- detectors ---------------------------------------------------------------

export function detectSensitiveFiles(run: Run): Finding[] {
  const secretEdits: Array<{ edit: Run["fileEdits"][number]; why: string }> = [];
  const configEdits: Array<{ edit: Run["fileEdits"][number]; why: string }> = [];

  for (const e of run.fileEdits) {
    const { tier, why } = classifyPath(e.path);
    if (tier === "secret") secretEdits.push({ edit: e, why: why ?? "sensitive" });
    else if (tier === "config") configEdits.push({ edit: e, why: why ?? "config" });
  }

  // Reads of secrets matter too — that's how a token ends up in the context window.
  const readHits: Array<{ idx: number; ts: string | null; path: string; why: string }> = [];
  for (const ev of toolCalls(run)) {
    if (!["Read", "view", "Grep", "cat"].includes(ev.toolName ?? "")) continue;
    const p = String(ev.toolInput?.["file_path"] ?? ev.toolInput?.["path"] ?? "");
    if (!p) continue;
    const { tier, why } = classifyPath(p);
    if (tier === "secret") readHits.push({ idx: ev.idx, ts: ev.ts, path: p, why: why ?? "secret" });
  }

  const findings: Finding[] = [];

  if (secretEdits.length) {
    findings.push({
      id: "risk.secret_file_write",
      title: `Modified ${secretEdits.length} secret-bearing file(s)`,
      severity: "high",
      category: "secrets",
      detail:
        "The run wrote to files that normally hold credentials. Even a correct change here is " +
        "worth a human read: these files are usually gitignored, environment-specific, and not " +
        "reconstructible from the repo.",
      evidence: secretEdits.slice(0, 6).map<Evidence>(({ edit, why }) => ({
        eventIdx: edit.eventIdx,
        ts: edit.ts,
        label: why,
        excerpt: edit.path,
      })),
      firstEventIdx: Math.min(...secretEdits.map((s) => s.edit.eventIdx)),
      stopTrigger: "the first write to a credential file",
      suggestedRules: [
        {
          kind: "deny_path",
          rule: "Deny Edit/Write on .env, key material and credential files",
          settingsJson: {
            permissions: {
              deny: [
                "Edit(**/.env*)",
                "Write(**/.env*)",
                "Edit(**/*.pem)",
                "Write(**/*.pem)",
                "Edit(**/.ssh/**)",
                "Write(**/.ssh/**)",
              ],
            },
          },
        },
      ],
    });
  }

  if (readHits.length) {
    findings.push({
      id: "risk.secret_file_read",
      title: `Read ${readHits.length} secret-bearing file(s) into context`,
      severity: "medium",
      category: "secrets",
      detail:
        "Reading a credential file pulls its contents into the model context and into this " +
        "transcript on disk. Values shown in the timeline here are redacted, but the original " +
        "transcript is not.",
      evidence: readHits.slice(0, 6).map<Evidence>((h) => ({
        eventIdx: h.idx,
        ts: h.ts,
        label: h.why,
        excerpt: h.path,
      })),
      firstEventIdx: Math.min(...readHits.map((h) => h.idx)),
      stopTrigger: "the first read of a credential file",
      suggestedRules: [
        {
          kind: "deny_path",
          rule: "Deny Read on credential files, and block `cat`/`grep` reaching them",
          settingsJson: {
            permissions: { deny: ["Read(**/.env*)", "Read(**/*.pem)", "Read(**/.ssh/**)"] },
          },
          implementation:
            "A deny rule covers the file tools; a PreToolUse hook on Bash is needed as well, " +
            "since the shell can read anything.",
        },
      ],
    });
  }

  if (configEdits.length) {
    findings.push({
      id: "risk.config_file_write",
      title: `Modified ${configEdits.length} infrastructure/config file(s)`,
      severity: "medium",
      category: "scope",
      detail:
        "CI workflows, container and infra definitions, dependency manifests and migrations " +
        "change behaviour outside this repository's test suite, so a green test run does not " +
        "confirm they're safe.",
      evidence: configEdits.slice(0, 8).map<Evidence>(({ edit, why }) => ({
        eventIdx: edit.eventIdx,
        ts: edit.ts,
        label: why,
        excerpt: edit.path,
      })),
      firstEventIdx: Math.min(...configEdits.map((c) => c.edit.eventIdx)),
      suggestedRules: [
        {
          kind: "ask_path",
          rule: "Require confirmation for .github/workflows, terraform and migrations",
          settingsJson: {
            permissions: {
              ask: ["Edit(**/.github/workflows/**)", "Edit(**/*.tf)", "Edit(**/migrations/**)"],
            },
          },
        },
      ],
    });
  }

  return findings;
}

export function detectScopeEscape(run: Run): Finding[] {
  const outside = run.fileEdits.filter((e) => outsideProject(e.path, run.projectPath));
  if (outside.length === 0) return [];
  return [
    {
      id: "risk.outside_project",
      title: `Edited ${outside.length} file(s) outside the project directory`,
      severity: "high",
      category: "scope",
      detail:
        `Files were changed outside \`${run.projectPath}\`. Those edits are invisible to this ` +
        `repository's git status and its review process — nobody will see them in a diff, and ` +
        `they persist after the branch is thrown away.`,
      evidence: outside.slice(0, 8).map<Evidence>((e) => ({
        eventIdx: e.eventIdx,
        ts: e.ts,
        label: e.op,
        excerpt: e.path,
      })),
      firstEventIdx: Math.min(...outside.map((e) => e.eventIdx)),
      suggestedRules: [
        {
          kind: "confine",
          rule: "Confine Edit/Write to the project root",
          implementation:
            "PreToolUse hook on Edit|Write|MultiEdit resolving file_path and denying anything " +
            "that escapes $CLAUDE_PROJECT_DIR",
        },
      ],
    },
  ];
}

export function detectDestructiveCommands(run: Run): Finding[] {
  const executed: Array<{ c: Command; severity: Severity; why: string }> = [];
  const blocked: Array<{ c: Command; severity: Severity; why: string }> = [];

  for (const c of run.commands) {
    const r = classifyCommandRisk(c.command);
    if (!r) continue;
    (c.denied || c.ok === false ? blocked : executed).push({ c, ...r });
  }

  const findings: Finding[] = [];

  if (executed.length) {
    const worst: Severity = executed.some((e) => e.severity === "high")
      ? "high"
      : executed.every((e) => e.severity === "low")
        ? "low"
        : "medium";
    findings.push({
      id: "risk.destructive_command",
      title: `Ran ${executed.length} destructive command(s)`,
      severity: worst,
      category: "destructive",
      detail:
        "Commands were executed that delete, overwrite or publish state. These are not " +
        "recoverable from the transcript — check the affected targets directly.",
      evidence: executed.slice(0, 8).map<Evidence>(({ c, why }) => ({
        eventIdx: c.eventIdx,
        ts: c.ts,
        label: why,
        excerpt: c.command,
      })),
      firstEventIdx: Math.min(...executed.map((e) => e.c.eventIdx)),
      stopTrigger: "the first destructive command",
      suggestedRules: [
        {
          kind: "deny_command",
          rule: "Deny force-push, hard reset, git clean and recursive delete outside build dirs",
          settingsJson: {
            permissions: {
              deny: [
                "Bash(git push --force:*)",
                "Bash(git reset --hard:*)",
                "Bash(git clean:*)",
                "Bash(rm -rf /*)",
              ],
            },
          },
          implementation:
            "Pattern rules cover the common shapes; a PreToolUse hook on Bash is what actually " +
            "holds, since it sees the full command string and its deny survives bypassPermissions mode.",
        },
      ],
    });
  }

  if (blocked.length) {
    findings.push({
      id: "risk.destructive_attempt",
      title: `Attempted ${blocked.length} destructive command(s) that did not succeed`,
      severity: "medium",
      category: "destructive",
      detail:
        "These were blocked, denied or failed. Nothing broke, but they show what the agent was " +
        "prepared to do unsupervised — relevant if you are considering running this workload " +
        "with permissions relaxed.",
      evidence: blocked.slice(0, 8).map<Evidence>(({ c, why }) => ({
        eventIdx: c.eventIdx,
        ts: c.ts,
        label: `${why} (${c.denied ? "denied" : "failed"})`,
        excerpt: c.command,
      })),
      firstEventIdx: Math.min(...blocked.map((b) => b.c.eventIdx)),
      suggestedRules: [
        {
          kind: "keep",
          rule: "Keep the existing guard that stopped this",
          implementation: "No change needed — this is the control working.",
        },
      ],
    });
  }

  return findings;
}

export function detectBlastRadius(run: Run, verification: Verification): Finding[] {
  const files = filesTouched(run);
  const lines = netDiffLines(run);
  const smallAsk = run.goalIsKnown && (run.goal ?? "").length < 200;

  const reasons: string[] = [];
  if (smallAsk && files.length >= 10)
    reasons.push(`${files.length} files changed for a one-line request`);
  if (lines >= 400 && verification.status !== "passed") {
    reasons.push(`${lines} lines changed with no passing verification`);
  }
  if (reasons.length === 0) return [];

  return [
    {
      id: "risk.blast_radius",
      title: `Large change surface: ${files.length} files, ${lines} lines`,
      severity: "medium",
      category: "scope",
      detail:
        `${reasons.join("; ")}. Wide diffs from narrow asks are where unrelated 'improvements' ` +
        `hide — reformatting, renamed variables, deleted comments — and they are the hardest ` +
        `kind of agent output to review honestly.`,
      evidence: [{ eventIdx: 0, label: "files changed", excerpt: files.slice(0, 12).join(", ") }],
      firstEventIdx: null,
      suggestedRules: [
        {
          kind: "budget",
          rule: "Warn above 10 changed files or 400 changed lines in a single run",
          implementation: "PostToolUse hook accumulating per-run edit counts",
        },
      ],
    },
  ];
}

export function detectWastedSpend(run: Run): Finding[] {
  const findings: Finding[] = [];
  const dur = run.durationS ?? 0;
  const cost = run.usage.costUsd;
  // Both detectors below are "spent X, changed nothing" claims. Neither can be
  // made honestly when the run wrote through the shell, because then the trace
  // does not know whether anything changed.
  const changed = netDiffLines(run) > 0 || diffMayBeIncomplete(run);

  if (dur >= 600 && !changed) {
    findings.push({
      id: "risk.duration_no_diff",
      title: `${Math.floor(dur / 60)} minutes elapsed, nothing changed on disk`,
      severity: "medium",
      category: "efficiency",
      detail:
        "The run occupied real wall-clock time and produced no file changes. That is sometimes " +
        "correct — investigation, code reading, a question answered — but it means the " +
        "repository is exactly where it started.",
      evidence: [
        {
          eventIdx: 0,
          label: "duration",
          excerpt: `${Math.floor(dur / 60)}m ${Math.floor(dur % 60)}s, ${toolCalls(run).length} tool calls, 0 edits`,
        },
      ],
      firstEventIdx: null,
      suggestedRules: [
        {
          kind: "time_budget",
          rule: "Check in after 10 minutes with no file change",
          implementation: "Stop hook or a wall-clock budget on the run",
        },
      ],
    });
  }

  if (cost !== null && cost >= 2.0 && !changed) {
    findings.push({
      id: "risk.cost_no_diff",
      title: `~$${cost.toFixed(2)} estimated with no file changes`,
      severity: cost < 8 ? "medium" : "high",
      category: "efficiency",
      detail:
        `Roughly $${cost.toFixed(2)} of estimated model spend produced no diff. Cost figures ` +
        `here are modelled from token counters, not billed amounts.`,
      evidence: [
        {
          eventIdx: 0,
          label: "tokens",
          excerpt: `${totalTokens(run.usage).toLocaleString()} tokens across ${Object.keys(run.usage.byModel).length} model(s)`,
        },
      ],
      firstEventIdx: null,
      suggestedRules: [
        {
          kind: "cost_budget",
          rule: "Set a per-run token budget and stop at it",
          implementation:
            "Track cumulative usage in a PostToolUse hook; stop the run when the budget is hit",
        },
      ],
    });
  }

  return findings;
}

export function allRiskFindings(run: Run, verification: Verification): Finding[] {
  return [
    ...detectSensitiveFiles(run),
    ...detectScopeEscape(run),
    ...detectDestructiveCommands(run),
    ...detectBlastRadius(run, verification),
    ...detectWastedSpend(run),
  ];
}
