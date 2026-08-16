/**
 * Synthetic OpenCode sessions for `flightrec demo`.
 *
 * Deliberately covers what the Claude Code fixtures cannot: a run whose only
 * changes went through the shell, a blocked destructive command, and a session
 * where the agent reported its own cost. Those three are the paths that only
 * exist because OpenCode records more than a transcript does.
 */

import { OcBuilder } from "./opencodeFixtures.js";

export function buildOpenCodeDemo(storage: string): string[] {
  const out: string[] = [];

  // Productive: real diff, tests green, cost reported by the agent.
  out.push(
    new OcBuilder(storage, { sessionId: "ses_demo00000000000000001" })
      .withTitle("Cache the FX rate lookup")
      .user("The FX rate lookup hits the API on every row. Cache it per request.")
      .think("The lookup is called inside the row loop; hoist it into a memo.")
      .edit(
        "/Users/dev/code/ledger-svc/src/fx.ts",
        "export function rate(cur: string) {\n  return fetchRate(cur);\n}",
        "const memo = new Map<string, number>();\nexport function rate(cur: string) {\n  if (!memo.has(cur)) memo.set(cur, fetchRate(cur));\n  return memo.get(cur)!;\n}",
      )
      .bash("npm test -- fx", "PASS src/fx.test.ts\n\nTests: 14 passed, 14 total")
      .say("Memoised per request. All 14 fx tests pass.", { cost: 0.31 })
      .writeTo(),
  );

  // Shell-only work: no edit tool ran, but the tree changed anyway.
  out.push(
    new OcBuilder(storage, {
      sessionId: "ses_demo00000000000000002",
      start: Date.parse("2026-08-14T11:00:00Z"),
    })
      .withTitle("Regenerate the protobuf stubs")
      .withSummary(6, 412, 88)
      .user("Regenerate the protobuf stubs from the updated schema.")
      .bash("protoc --ts_out=./src/gen -I proto proto/*.proto", "")
      .bash("prettier --write 'src/gen/**/*.ts' > /dev/null", "")
      .say("Regenerated six stub files from the updated schema.")
      .writeTo(),
  );

  // Risky: a blocked destructive command plus a credential file read.
  out.push(
    new OcBuilder(storage, {
      sessionId: "ses_demo00000000000000003",
      start: Date.parse("2026-08-14T13:30:00Z"),
    })
      .withTitle("Reset the local environment")
      .user("My local env is broken, reset it and start clean.")
      .bash("cat .env", "DATABASE_URL=postgres://user:hunter2@localhost/ledger")
      .bash("rm -rf ~/Projects/ledger-svc", "", {
        error:
          "Error: The user has specified a rule which prevents you from using this " +
          "specific tool call. Rule: bash 'rm -rf*' → ask",
      })
      .edit("/Users/dev/code/ledger-svc/.env", "DEBUG=false", "DEBUG=true")
      .say("I stopped short of deleting the tree. I did flip DEBUG in .env.")
      .writeTo(),
  );

  // Wasteful: repeated identical failure, nothing fixed.
  const loop = new OcBuilder(storage, {
    sessionId: "ses_demo00000000000000004",
    start: Date.parse("2026-08-14T15:00:00Z"),
  })
    .withTitle("Fix the flaky settlement test")
    .user("The settlement test is flaky, make it pass.");
  for (let i = 0; i < 4; i++) {
    loop
      .edit(
        "/Users/dev/code/ledger-svc/test/settle.test.ts",
        `await sleep(${100 + i * 100})`,
        `await sleep(${200 + i * 100})`,
      )
      .bash(
        "npm test -- settle",
        "FAIL test/settle.test.ts\n  ● settlement › batches\n\n    AssertionError: expected 3 to equal 4",
      );
  }
  loop.say("Still failing. The timing assumption may not be the real problem.");
  out.push(loop.writeTo());

  return out;
}
