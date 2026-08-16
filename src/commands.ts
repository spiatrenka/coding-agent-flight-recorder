/**
 * Shell command classification, shared by every importer.
 *
 * Two questions are asked of a command string:
 *
 * 1. What kind of command is it (test / build / lint / vcs / pkg / shell)?
 *    This drives the verification analysis — only test, build and lint count
 *    as evidence that the work was checked.
 *
 * 2. Does it write to the working tree? This one exists because a diff
 *    assembled purely from Edit/Write tool calls is blind to everything the
 *    agent does through the shell — `tar -xzf`, a heredoc, `sed -i`,
 *    `printf >> file`. Treating "no tool edits" as "no changes" inverts the
 *    verdict on shell-heavy runs, so the analyzers need to know the
 *    difference between *nothing happened* and *we cannot see what happened*.
 */

import type { CommandCategory } from "./model.js";

const TEST_RE =
  /\b(pytest|jest|vitest|mocha|go test|cargo test|rspec|phpunit|tox|nose2|gradlew? test|mvn (test|verify)|dotnet test|ctest|bats)\b|\b(npm|pnpm|yarn|bun|make)\s+(run\s+)?(test|tests|check|spec)\b|\bnode\s+--test\b|\bdeno\s+test\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\b(mix|rake|swift|zig|elixir)\s+test\b|\bbundle\s+exec\s+(rspec|rake\s+test)\b|\bnpm\s+run\s+test:/i;
const BUILD_RE =
  /\b(tsc|webpack|rollup|esbuild|vite build|next build|cargo build|go build|docker build|gradlew? build|mvn package|dotnet build|cmake)\b|\b(npm|pnpm|yarn|bun|make)\s+(run\s+)?(build|compile|dist)\b/i;
const LINT_RE =
  /\b(eslint|ruff|flake8|pylint|mypy|pyright|black|prettier|golangci-lint|clippy|rubocop|shellcheck)\b|tsc\s+--noemit|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|typecheck|format)\b/i;
const VCS_RE = /^\s*(git|gh|hg|jj)\b/i;
const PKG_RE =
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove)\b|\bpip3?\s+install\b|\bpoetry\s+(add|install)\b|\buv\s+(add|pip)\b|\bcargo\s+(add|install)\b|\bgo get\b|\bapt(-get)? install\b|\bbrew install\b/i;

export function classifyCommand(cmd: string): CommandCategory {
  if (TEST_RE.test(cmd)) return "test";
  if (LINT_RE.test(cmd)) return "lint";
  if (BUILD_RE.test(cmd)) return "build";
  if (PKG_RE.test(cmd)) return "pkg";
  if (VCS_RE.test(cmd)) return "vcs";
  return "shell";
}

// --- write-intent detection -------------------------------------------------

/**
 * Redirect targets that are not real writes. `> /dev/null` is the common one;
 * scratch space is deliberate and uninteresting for blast-radius purposes.
 */
const THROWAWAY_TARGET =
  /^\s*(\/dev\/(null|stderr|stdout)|\/tmp\/|\/var\/folders\/|\/private\/tmp\/)/;

/** `cmd > file` / `cmd >> file`, ignoring `2>&1`, `>&2` and throwaway targets. */
function hasRealRedirect(cmd: string): boolean {
  // Strip fd-duplication forms first so `2>&1` doesn't read as a redirect.
  const stripped = cmd.replace(/\d*>&\d*/g, " ");
  const re = /(?<!\d)>>?\s*([^\s;&|)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const target = m[1];
    if (!target) continue;
    if (THROWAWAY_TARGET.test(target)) continue;
    return true;
  }
  return false;
}

/**
 * Commands that create, modify or delete files in place. Package installs are
 * deliberately excluded: they do churn `node_modules`, but they are not
 * authored changes and counting them would fire the "unrecorded writes" signal
 * on almost every run.
 */
const MUTATING: ReadonlyArray<RegExp> = [
  /\btee\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\b(cp|mv|rsync)\s+/,
  /\brm\s+/,
  /\bsed\s+(-\w*i\w*|--in-place)/,
  /\bperl\s+-\w*i/,
  /\btar\s+(-?\w*x|--extract)/,
  /\b(unzip|gunzip|bunzip2)\b/,
  /\bpatch\s+/,
  /\bgit\s+(apply|checkout|restore|clean|reset|stash|revert|merge|rebase|cherry-pick|pull)\b/,
  /\bln\s+-s/,
  /\bdd\s+if=/,
  /\b(curl|wget)\b[^|]*\s(-o|-O|--output)\b/,
  /\binstall\s+-[Dm]/,
  /<<-?\s*['"]?\w+/, // heredoc
  /\bcat\s*>/, // cat > file
  /\bnpx?\s+\S*(codemod|jscodeshift)/,
];

/**
 * True when the command plausibly changed files on disk. Deliberately
 * inclusive: a false positive downgrades a "wasteful" verdict to
 * "questionable", which is the safe direction to be wrong in. A false
 * negative silently reinstates the bug this exists to fix.
 */
export function mutatesWorkingTree(cmd: string): boolean {
  if (!cmd.trim()) return false;
  if (classifyCommand(cmd) === "pkg") return false;
  if (MUTATING.some((re) => re.test(cmd))) return true;
  return hasRealRedirect(cmd);
}
