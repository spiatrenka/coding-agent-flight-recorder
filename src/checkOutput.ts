/**
 * Resolve the outcome of a test / build / lint command from what it printed.
 *
 * Why this exists: the design of this tool rests on "exit codes are evidence,
 * prose is not". Claude Code transcripts do not record exit codes — measured
 * across a real corpus, 0 of 108 Bash results carried `exitCode`, and none set
 * `is_error` — so 84% of commands resolved to `unknown`, which made
 * verification status unknowable and the `productive` verdict unreachable.
 * OpenCode has the same hole for a different reason.
 *
 * The honest fix is not to guess harder. It is to read the *other* machine
 * evidence that is actually present: test runners and compilers print
 * structured summaries in well-known formats. Parsing `ℹ fail 0` or
 * `test result: ok. 12 passed; 0 failed` is reading a result, not inferring
 * one — and it yields counts a bare exit code never could.
 *
 * The invariant is preserved at the edges: a matcher that does not recognise
 * the output returns null, and null still means unknown. Nothing here upgrades
 * an ambiguous run to "passed".
 */

export interface CheckOutcome {
  /** Which format matched — recorded so a wrong parse is traceable. */
  framework: string;
  ok: boolean;
  passed: number | null;
  failed: number | null;
}

/**
 * Matchers receive the output twice: whole, and pre-split into lines. Anything
 * that looks for a summary *line* must use `lines`. Regexes that scan the whole
 * document for a line-shaped pattern backtrack badly on the long `=====` and
 * `-----` rules test runners like to print.
 */
type Matcher = (out: string, lines: string[]) => CheckOutcome | null;

const int = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Order matters only where formats overlap; each matcher is anchored tightly
 * enough that a non-match is cheap and unambiguous.
 */
const MATCHERS: ReadonlyArray<[string, Matcher]> = [
  // node:test — `ℹ pass 66` / `ℹ fail 0`
  ["node:test", (o) => {
    const pass = /^[ \t]*(?:ℹ|#)[ \t]*pass[ \t]+(\d+)[ \t]*$/m.exec(o);
    const fail = /^[ \t]*(?:ℹ|#)[ \t]*fail[ \t]+(\d+)[ \t]*$/m.exec(o);
    if (!pass || !fail) return null;
    const f = int(fail[1]) ?? 0;
    return { framework: "node:test", ok: f === 0, passed: int(pass[1]), failed: f };
  }],

  // pytest — `===== 3 failed, 12 passed in 1.2s =====`
  //
  // Matched against the summary *line*, not the document. An earlier version
  // used `\s` inside the scan, and because `\s` matches newlines that turned a
  // long `====` rule into a whole-document backtracking scan — 85ms on a
  // single output, which dominated ingest.
  ["pytest", (_o, lines) => {
    const seg = lines.find(
      (l) => l.startsWith("=") && /\b(?:passed|failed|errors?|no tests ran)\b/i.test(l),
    );
    if (!seg) return null;
    const passed = int(/(\d+)[ \t]+passed/i.exec(seg)?.[1]);
    const failed = int(/(\d+)[ \t]+failed/i.exec(seg)?.[1]);
    const errors = int(/(\d+)[ \t]+errors?\b/i.exec(seg)?.[1]);
    if (passed === null && failed === null && errors === null) return null;
    return {
      framework: "pytest",
      ok: (failed ?? 0) === 0 && (errors ?? 0) === 0,
      passed, failed: (failed ?? 0) + (errors ?? 0),
    };
  }],

  // jest — `Tests:  1 failed, 13 passed, 14 total`
  ["jest", (o) => {
    const line = /^[ \t]*Tests:[ \t]+([^\n]+)$/m.exec(o);
    if (!line?.[1]) return null;
    const seg = line[1];
    const failed = int(/(\d+)[ \t]+failed/i.exec(seg)?.[1]) ?? 0;
    const passed = int(/(\d+)[ \t]+passed/i.exec(seg)?.[1]);
    return { framework: "jest", ok: failed === 0, passed, failed };
  }],

  // vitest — `Tests  2 failed | 5 passed (7)`
  ["vitest", (o) => {
    const line = /^[ \t]*Tests[ \t]+(\d+[ \t]+\w+(?:[ \t]*\|[ \t]*\d+[ \t]+\w+)*)/m.exec(o);
    if (!line?.[1]) return null;
    const seg = line[1];
    const failed = int(/(\d+)[ \t]+failed/i.exec(seg)?.[1]) ?? 0;
    const passed = int(/(\d+)[ \t]+passed/i.exec(seg)?.[1]);
    if (passed === null && failed === 0) return null;
    return { framework: "vitest", ok: failed === 0, passed, failed };
  }],

  // mocha — `12 passing` / `2 failing`
  ["mocha", (o) => {
    const passing = int(/^[ \t]*(\d+)[ \t]+passing\b/m.exec(o)?.[1]);
    if (passing === null) return null;
    const failing = int(/^[ \t]*(\d+)[ \t]+failing\b/m.exec(o)?.[1]) ?? 0;
    return { framework: "mocha", ok: failing === 0, passed: passing, failed: failing };
  }],

  // cargo test — `test result: ok. 12 passed; 0 failed;`
  ["cargo", (o) => {
    const m = /test result:[ \t]*(ok|FAILED)\.[ \t]*(\d+)[ \t]+passed;[ \t]*(\d+)[ \t]+failed/i.exec(o);
    if (!m) return null;
    return {
      framework: "cargo test",
      ok: (m[1] ?? "").toLowerCase() === "ok",
      passed: int(m[2]), failed: int(m[3]),
    };
  }],

  // go test — `--- FAIL:` / `FAIL\tpkg` / `ok  \tpkg`
  ["go", (o) => {
    const fail = /^(FAIL|---\s*FAIL)\b/m.test(o);
    const ok = /^ok\s+\S+/m.test(o);
    if (!fail && !ok) return null;
    const failed = (o.match(/^---\s*FAIL:/gm) ?? []).length;
    const passed = (o.match(/^---\s*PASS:/gm) ?? []).length;
    return {
      framework: "go test",
      ok: !fail,
      passed: passed || null,
      failed: failed || (fail ? 1 : 0),
    };
  }],

  // TypeScript — `Found 3 errors.` / `error TS2345:`
  ["tsc", (o) => {
    const found = /Found (\d+) errors?/i.exec(o);
    if (found) {
      const n = int(found[1]) ?? 0;
      return { framework: "tsc", ok: n === 0, passed: null, failed: n };
    }
    const errs = (o.match(/\berror TS\d+:/g) ?? []).length;
    if (errs > 0) return { framework: "tsc", ok: false, passed: null, failed: errs };
    return null;
  }],

  // mypy — `Success: no issues found in 12 source files` / `Found 3 errors in`
  ["mypy", (o) => {
    if (/^Success: no issues found/m.test(o)) {
      return { framework: "mypy", ok: true, passed: null, failed: 0 };
    }
    const m = /^Found (\d+) errors? in/m.exec(o);
    if (!m) return null;
    return { framework: "mypy", ok: false, passed: null, failed: int(m[1]) };
  }],

  // ruff — `All checks passed!` / `Found 5 errors.`
  ["ruff", (o) => {
    if (/^All checks passed!/m.test(o)) {
      return { framework: "ruff", ok: true, passed: null, failed: 0 };
    }
    return null;
  }],

  // eslint — `✖ 7 problems (3 errors, 4 warnings)`
  ["eslint", (o) => {
    const m = /[✖x][ \t]*(\d+)[ \t]+problems?[ \t]*\((\d+)[ \t]+errors?/i.exec(o);
    if (!m) return null;
    const errs = int(m[2]) ?? 0;
    return { framework: "eslint", ok: errs === 0, passed: null, failed: errs };
  }],

  // make — `make: *** [target] Error 2`
  ["make", (o) => {
    if (!/^\s*make(\[\d+\])?:\s+\*\*\*/m.test(o)) return null;
    return { framework: "make", ok: false, passed: null, failed: 1 };
  }],

  // npm lifecycle failure — `npm ERR! code ELIFECYCLE`.
  // No \b after `ERR!`: `!` and the following space are both non-word, so a
  // word boundary never exists there and the match would silently never fire.
  ["npm", (o) => {
    if (!/^npm (ERR!|error\b)/m.test(o)) return null;
    return { framework: "npm", ok: false, passed: null, failed: 1 };
  }],
];

/**
 * Parse a check command's combined output. Returns null when no known format
 * is recognised — which is the common case for arbitrary shell, and must stay
 * `unknown` rather than becoming a guess.
 */
export function parseCheckOutput(output: string): CheckOutcome | null {
  if (!output.trim()) return null;
  // Strip ANSI so colourised runners still match.
  const clean = output.replace(/\[[0-9;]*[A-Za-z]/g, "");
  const lines = clean.split("\n");
  for (const [, match] of MATCHERS) {
    const hit = match(clean, lines);
    if (hit) return hit;
  }
  return null;
}

/** Human-readable evidence line for the postmortem. */
export function describeCheck(c: CheckOutcome): string {
  const bits: string[] = [];
  if (c.passed !== null) bits.push(`${c.passed} passed`);
  if (c.failed !== null && c.failed > 0) bits.push(`${c.failed} failed`);
  const detail = bits.length ? ` (${bits.join(", ")})` : "";
  return `${c.framework}: ${c.ok ? "pass" : "fail"}${detail}`;
}
