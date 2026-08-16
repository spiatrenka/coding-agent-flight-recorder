/**
 * Generate synthetic Claude Code transcripts.
 *
 * Shaped to match the real on-disk format closely enough to exercise the parser,
 * and constructed so each fixture lands on a known verdict — which is what makes
 * the detectors regression-testable.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CWD = "/Users/dev/code/payments-api";
const BRANCH = "feat/refund-window";
const VERSION = "2.1.240";
const MODEL = "claude-opus-4-6-20260115";

type Json = Record<string, unknown>;

export class Builder {
  private readonly sid: string;
  private t: Date;
  private readonly cwd: string;
  private readonly branch: string;
  private readonly model: string;
  private readonly lines: Json[] = [];
  private prev: string | null = null;
  private n = 0;

  constructor(
    opts: { sessionId?: string; start?: Date; cwd?: string; branch?: string; model?: string } = {},
  ) {
    this.sid = opts.sessionId ?? randomUUID();
    this.t = opts.start ?? new Date("2026-08-14T09:00:00Z");
    this.cwd = opts.cwd ?? CWD;
    this.branch = opts.branch ?? BRANCH;
    this.model = opts.model ?? MODEL;
  }

  private tick(seconds = 7): string {
    this.t = new Date(this.t.getTime() + seconds * 1000);
    return this.t.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  private base(type: string): Json {
    const uuid = randomUUID();
    const d: Json = {
      parentUuid: this.prev,
      isSidechain: false,
      userType: "external",
      cwd: this.cwd,
      sessionId: this.sid,
      version: VERSION,
      gitBranch: this.branch,
      type,
      uuid,
      timestamp: this.tick(),
    };
    this.prev = uuid;
    return d;
  }

  private usage(out = 180): Json {
    return {
      input_tokens: 4,
      output_tokens: out,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 24000,
    };
  }

  user(text: string): this {
    const d = this.base("user");
    d["timestamp"] = this.t.toISOString().replace(/\.\d{3}Z$/, "Z");
    d["message"] = { role: "user", content: text };
    this.lines.push(d);
    return this;
  }

  say(text: string): this {
    const d = this.base("assistant");
    d["message"] = {
      id: `msg_${this.n++}`,
      type: "message",
      role: "assistant",
      model: this.model,
      content: [{ type: "text", text }],
      usage: this.usage(),
    };
    this.lines.push(d);
    return this;
  }

  /**
   * One assistant turn that consumed a large amount of context.
   *
   * Reaching a cost threshold through ordinary `say()` calls would take on the
   * order of a hundred and seventy messages, which makes the resulting fixture
   * unreadable and slow. A single turn with a big cache-read counter reaches the
   * same modelled cost and keeps the fixture legible.
   */
  burn(cacheReadTokens: number, text = "Still working through the context."): this {
    const d = this.base("assistant");
    d["message"] = {
      id: `msg_${this.n++}`,
      type: "message",
      role: "assistant",
      model: this.model,
      content: [{ type: "text", text }],
      usage: {
        input_tokens: 4,
        output_tokens: 180,
        cache_creation_input_tokens: 1200,
        cache_read_input_tokens: cacheReadTokens,
      },
    };
    this.lines.push(d);
    return this;
  }

  call(tool: string, input: Json): string {
    const tid = `toolu_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const d = this.base("assistant");
    d["message"] = {
      id: `msg_${this.n++}`,
      type: "message",
      role: "assistant",
      model: this.model,
      content: [{ type: "tool_use", id: tid, name: tool, input }],
      usage: this.usage(90),
    };
    this.lines.push(d);
    return tid;
  }

  result(tid: string, content: string, isError = false, toolUseResult?: Json): this {
    const d = this.base("user");
    d["message"] = {
      role: "user",
      content: [{ tool_use_id: tid, type: "tool_result", content, is_error: isError }],
    };
    if (toolUseResult !== undefined) d["toolUseResult"] = toolUseResult;
    this.lines.push(d);
    return this;
  }

  read(path: string, body = "…file contents…"): this {
    return this.result(this.call("Read", { file_path: path }), body);
  }

  edit(path: string, oldStr: string, newStr: string): this {
    const tid = this.call("Edit", { file_path: path, old_string: oldStr, new_string: newStr });
    const hunk = {
      oldStart: 40,
      oldLines: oldStr.split("\n").length,
      newStart: 40,
      newLines: newStr.split("\n").length,
      lines: [...oldStr.split("\n").map((l) => `-${l}`), ...newStr.split("\n").map((l) => `+${l}`)],
    };
    return this.result(tid, `The file ${path} has been updated.`, false, {
      filePath: path,
      oldString: oldStr,
      newString: newStr,
      structuredPatch: [hunk],
      userModified: false,
    });
  }

  write(path: string, content: string): this {
    const tid = this.call("Write", { file_path: path, content });
    return this.result(tid, `File created successfully at: ${path}`, false, {
      type: "create",
      filePath: path,
      content,
      structuredPatch: [],
    });
  }

  bash(
    cmd: string,
    {
      stdout = "",
      stderr = "",
      ok = true,
      denied = false,
      exitCode,
    }: {
      stdout?: string;
      stderr?: string;
      ok?: boolean;
      denied?: boolean;
      exitCode?: number;
    } = {},
  ): this {
    const tid = this.call("Bash", { command: cmd, description: cmd.slice(0, 40) });
    if (denied) {
      return this.result(tid, "The user doesn't want to proceed with this tool use.", true);
    }
    const res: Json = { stdout, stderr, interrupted: false, isImage: false };
    if (exitCode !== undefined) res["exitCode"] = exitCode;
    return this.result(tid, stdout || stderr, !ok, res);
  }

  /**
   * Emit a bare entry of an arbitrary `type`. Used to assert which entry types
   * the parser treats as known metadata versus schema drift.
   */
  raw(type: string, extra: Json = {}): this {
    this.lines.push({ ...this.base(type), ...extra });
    return this;
  }

  idle(minutes: number): this {
    this.t = new Date(this.t.getTime() + minutes * 60_000);
    return this;
  }

  compact(): this {
    const d = this.base("system");
    d["isCompactSummary"] = true;
    d["content"] = "Context compacted. Summary of prior conversation…";
    this.lines.push(d);
    return this;
  }

  writeTo(root: string): string {
    const proj = join(root, this.cwd.replace(/\//g, "-"));
    mkdirSync(proj, { recursive: true });
    const path = join(proj, `${this.sid}.jsonl`);
    writeFileSync(path, this.lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return path;
  }
}

// --- fixtures ---------------------------------------------------------------

export function fixtureProductive(): Builder {
  const b = new Builder({ start: new Date("2026-08-14T09:00:00Z") });
  b.user(
    "The refund window check is off by one — a refund on day 30 is being rejected. " +
      "Fix it and add a test.",
  );
  b.say("Let me look at the refund window logic.");
  b.read("/Users/dev/code/payments-api/src/refunds/window.ts");
  b.read("/Users/dev/code/payments-api/src/refunds/window.test.ts");
  b.say("Found it — the comparison uses `<` where it should be `<=`.");
  b.edit(
    "/Users/dev/code/payments-api/src/refunds/window.ts",
    "  return daysSince < REFUND_WINDOW_DAYS;",
    "  return daysSince <= REFUND_WINDOW_DAYS;",
  );
  b.edit(
    "/Users/dev/code/payments-api/src/refunds/window.test.ts",
    "  });",
    "  });\n\n  it('accepts a refund on the final day of the window', () => {\n" +
      "    expect(isWithinWindow(daysAgo(30))).toBe(true);\n  });",
  );
  b.bash("npm test -- src/refunds", {
    stdout: "Test Suites: 1 passed, 1 total\nTests:       9 passed, 9 total",
    ok: true,
    exitCode: 0,
  });
  b.bash("npx tsc --noEmit", { ok: true, exitCode: 0 });
  b.say("Fixed the off-by-one and added a boundary test. All 9 tests pass and typecheck is clean.");
  return b;
}

export function fixtureWasteful(): Builder {
  const b = new Builder({ start: new Date("2026-08-14T11:30:00Z") });
  b.user("The webhook integration test is flaky, make it pass.");
  b.say("Let me run the test to see the failure.");
  const fail =
    "FAIL tests/webhooks/delivery.test.ts\n" +
    "  ● webhook delivery › retries on 500\n" +
    "    Expected: 3\n    Received: 1\n" +
    "Tests: 1 failed, 6 passed, 7 total";
  for (let i = 0; i < 4; i++) {
    b.bash("npm test -- tests/webhooks/delivery.test.ts", { stdout: fail, ok: false, exitCode: 1 });
    b.say(`Attempt ${i + 1}: I think the retry count isn't being awaited.`);
    b.edit(
      "/Users/dev/code/payments-api/src/webhooks/delivery.ts",
      `  const attempts = ${i + 1};`,
      `  const attempts = ${i + 2};`,
    );
    b.idle(3);
  }
  for (let i = 0; i < 4; i++) b.read("/Users/dev/code/payments-api/src/webhooks/delivery.ts");
  for (let i = 0; i < 3; i++) b.bash("cat package.json", { stdout: '{"name":"payments-api"}' });
  b.idle(9);
  b.say("I'm still not able to get this test passing reliably.");
  return b;
}

export function fixtureRisky(): Builder {
  const b = new Builder({ start: new Date("2026-08-15T14:05:00Z") });
  b.user("Set up the staging environment config and clean the build.");
  b.say("I'll check the current environment configuration first.");
  const tid = b.call("Read", { file_path: "/Users/dev/code/payments-api/.env" });
  b.result(
    tid,
    "DATABASE_URL=postgres://app:hunter2@db.internal:5432/payments\n" +
      "STRIPE_SECRET_KEY=sk-live_4eC39HqLyjWDarjtT1zdp7dc\n",
  );
  b.edit(
    "/Users/dev/code/payments-api/.env",
    "STAGING=false",
    "STAGING=true\nSTRIPE_SECRET_KEY=sk-test_abc123def456",
  );
  b.edit(
    "/Users/dev/code/payments-api/.github/workflows/deploy.yml",
    "    branches: [main]",
    "    branches: [main, staging]",
  );
  b.write("/Users/dev/.zshrc_backup", "export PATH=$PATH:/usr/local/bin\n");
  b.bash("rm -rf node_modules dist", { ok: true, exitCode: 0 });
  b.bash("git reset --hard HEAD~1", {
    stdout: "HEAD is now at 8f21ac3 wip",
    ok: true,
    exitCode: 0,
  });
  b.bash("git push --force origin staging", { denied: true });
  b.say("Staging config is in place.");
  return b;
}

export function fixtureUnverifiedClaim(): Builder {
  const b = new Builder({ start: new Date("2026-08-15T16:40:00Z") });
  b.user("Add pagination to the transactions endpoint.");
  b.say("I'll add cursor pagination.");
  b.edit(
    "/Users/dev/code/payments-api/src/api/transactions.ts",
    "  const rows = await db.transactions.findAll();",
    "  const rows = await db.transactions.findAll({ limit, after: cursor });",
  );
  b.edit(
    "/Users/dev/code/payments-api/src/api/schema.ts",
    "  limit?: number;",
    "  limit?: number;\n  cursor?: string;",
  );
  b.write(
    "/Users/dev/code/payments-api/src/api/pagination.ts",
    "export function decodeCursor(c: string) {\n  return JSON.parse(atob(c));\n}\n" +
      "export function encodeCursor(o: unknown) {\n  return btoa(JSON.stringify(o));\n}\n",
  );
  b.say(
    "Done — cursor pagination is wired through the endpoint. All tests pass and everything " +
      "works as expected.",
  );
  return b;
}

export function fixtureLongNoDiff(): Builder {
  const b = new Builder({
    start: new Date("2026-08-15T08:00:00Z"),
    model: "some-unreleased-model-2027",
  });
  b.user("Why is the settlement job slow in production?");
  for (const f of [
    "jobs/settlement.ts",
    "db/queries/ledger.ts",
    "db/indexes.sql",
    "jobs/scheduler.ts",
    "lib/batch.ts",
    "config/db.ts",
  ]) {
    b.read(`/Users/dev/code/payments-api/src/${f}`);
    b.idle(2);
  }
  b.bash("grep -rn 'SELECT' src/db/queries/ | head -50", { stdout: "… 43 matches …" });
  b.idle(6);
  b.say(
    "The settlement job runs an unindexed sequential scan over the ledger table for each batch. " +
      "Adding a composite index on (account_id, settled_at) would help.",
  );
  return b;
}

/** One transcript file containing two runs separated by an idle gap. */
export function fixtureTwoSegments(): Builder {
  const b = new Builder({ start: new Date("2026-08-13T10:00:00Z") });
  b.user("Rename the `TxnKind` enum to `TransactionKind` everywhere.");
  b.edit(
    "/Users/dev/code/payments-api/src/types.ts",
    "export enum TxnKind {",
    "export enum TransactionKind {",
  );
  b.bash("rg -l 'TxnKind' src/", { stdout: "src/api/transactions.ts\nsrc/jobs/settlement.ts" });
  b.edit("/Users/dev/code/payments-api/src/api/transactions.ts", "TxnKind", "TransactionKind");
  b.edit("/Users/dev/code/payments-api/src/jobs/settlement.ts", "TxnKind", "TransactionKind");
  b.bash("npx tsc --noEmit", { ok: true, exitCode: 0 });
  b.say("Renamed across 3 files, typecheck clean.");
  b.idle(95); // long enough to end the run
  b.user("Now add a CHANGELOG entry for that rename.");
  b.compact();
  b.edit(
    "/Users/dev/code/payments-api/CHANGELOG.md",
    "## Unreleased",
    "## Unreleased\n\n- Rename `TxnKind` to `TransactionKind`.",
  );
  b.say("Added.");
  return b;
}

/** An edit undone later in the same run: A→B then B→A on one file. */
export function fixtureRevert(): Builder {
  const b = new Builder({ start: new Date("2026-08-12T14:00:00Z") });
  const path = "/Users/dev/code/payments-api/src/lib/retry.ts";
  b.user("The retry backoff is too aggressive, halve it.");
  b.edit(path, "const BACKOFF_MS = 2000;", "const BACKOFF_MS = 1000;");
  b.bash("npm test -- retry", { stdout: "2 failing", ok: false });
  b.say("That broke two timing tests. Putting it back.");
  b.edit(path, "const BACKOFF_MS = 1000;", "const BACKOFF_MS = 2000;");
  b.say("Reverted. The backoff is load-bearing for the flaky upstream.");
  return b;
}

/**
 * A long tail of activity after the last file change.
 *
 * Every idle gap stays under thirty minutes on purpose: exceeding
 * `FLIGHTREC_IDLE_GAP` would split this into two runs and the tail — the whole
 * point of the fixture — would land in a segment with no edit in it.
 */
export function fixtureStall(): Builder {
  const b = new Builder({ start: new Date("2026-08-12T09:00:00Z") });
  b.user("Fix the currency rounding in the invoice totals.");
  b.edit(
    "/Users/dev/code/payments-api/src/invoice/total.ts",
    "Math.round(cents / 100)",
    "Math.round(cents) / 100",
  );
  b.say("Fixed. Let me double-check the surrounding code.");
  b.idle(7);
  for (const f of [
    "invoice/line.ts",
    "invoice/tax.ts",
    "invoice/discount.ts",
    "money/format.ts",
    "money/currency.ts",
    "money/round.ts",
    "api/invoices.ts",
    "db/invoice.ts",
  ]) {
    b.read(`/Users/dev/code/payments-api/src/${f}`);
    b.idle(1);
  }
  b.say("The rest of the money handling looks consistent with the fix. Nothing else to change.");
  return b;
}

/** Ten files changed in response to a one-line request. */
export function fixtureWideDiff(): Builder {
  const b = new Builder({ start: new Date("2026-08-12T11:00:00Z") });
  b.user("Fix the typo in the error message.");
  for (let i = 0; i < 10; i++) {
    b.edit(
      `/Users/dev/code/payments-api/src/handlers/h${i}.ts`,
      "throw new Error('recieved')",
      "throw new Error('received')",
    );
  }
  b.say("Fixed the typo, and tidied the surrounding error handling while I was in there.");
  return b;
}

/** A large diff with nothing green to back it. */
export function fixtureBigDiff(): Builder {
  const b = new Builder({ start: new Date("2026-08-12T12:00:00Z") });
  b.user("Migrate the settlement module off the legacy money helper.");
  const old = Array.from({ length: 120 }, (_, i) => `  legacyMoney.add(row[${i}]);`).join("\n");
  const neu = Array.from({ length: 120 }, (_, i) => `  Money.of(row[${i}]).add();`).join("\n");
  b.edit("/Users/dev/code/payments-api/src/settlement/apply.ts", old, neu);
  b.edit("/Users/dev/code/payments-api/src/settlement/batch.ts", old, neu);
  b.say("Migrated. I have not run the suite.");
  return b;
}

/** Known spend with nothing to show for it on disk. */
export function fixtureExpensiveNoDiff(): Builder {
  const b = new Builder({ start: new Date("2026-08-12T16:00:00Z") });
  b.user("Work out why the reconciliation totals drift by a few cents each month.");
  b.read("/Users/dev/code/payments-api/src/recon/compare.ts");
  b.burn(6_000_000, "Reading the reconciliation history to find where the drift starts.");
  b.read("/Users/dev/code/payments-api/src/recon/report.ts");
  b.burn(6_000_000, "Still correlating the monthly deltas.");
  b.say("I could not isolate it from the code alone. It likely needs production data.");
  return b;
}

export const ALL: Record<string, () => Builder> = {
  productive: fixtureProductive,
  wasteful: fixtureWasteful,
  risky: fixtureRisky,
  unverifiedClaim: fixtureUnverifiedClaim,
  longNoDiff: fixtureLongNoDiff,
  twoSegments: fixtureTwoSegments,
  revert: fixtureRevert,
  stall: fixtureStall,
  wideDiff: fixtureWideDiff,
  bigDiff: fixtureBigDiff,
  expensiveNoDiff: fixtureExpensiveNoDiff,
};

export function buildAll(root: string): Record<string, string> {
  mkdirSync(root, { recursive: true });
  return Object.fromEntries(Object.entries(ALL).map(([name, fn]) => [name, fn().writeTo(root)]));
}
