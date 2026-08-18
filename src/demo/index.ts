/**
 * Seed a store with synthetic runs so the dashboard can be evaluated without
 * real data.
 *
 * This is product code, not test scaffolding: `flightrec demo` is the first
 * command a new user runs, so the builders it depends on ship in the package.
 * The test suite reuses the same builders, which keeps what the demo shows and
 * what the detectors are pinned against from drifting apart.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyze } from "../analyze/index.js";
import { generate } from "../postmortem.js";
import { ClaudeCodeSource } from "../sources/claudeCode.js";
import { OpenCodeSource } from "../sources/opencode.js";
import type { Store } from "../store.js";
import { buildAll } from "./fixtures.js";
import { buildOpenCodeDemo } from "./opencodeDemo.js";

export interface DemoResult {
  /** Number of synthetic runs stored. */
  runs: number;
  /** Directory the synthetic transcripts were written to. */
  root: string;
}

/**
 * Build synthetic Claude Code and OpenCode trees, ingest them into `store`, and
 * return what was written.
 *
 * The source importers read their roots from the environment, so this has to
 * point `CLAUDE_CONFIG_DIR` and `OPENCODE_STORAGE_DIR` at the synthetic tree —
 * and put both back afterwards. Leaving them set would silently redirect every
 * later ingest in the same process at throwaway fixture data.
 */
export function seedDemo(store: Store, opts: { root?: string } = {}): DemoResult {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "flightrec-demo-"));
  const priorClaude = process.env["CLAUDE_CONFIG_DIR"];
  const priorOpenCode = process.env["OPENCODE_STORAGE_DIR"];

  try {
    buildAll(join(root, "projects"));
    process.env["CLAUDE_CONFIG_DIR"] = root;

    const ocStorage = join(root, "opencode", "storage");
    buildOpenCodeDemo(ocStorage);
    process.env["OPENCODE_STORAGE_DIR"] = ocStorage;

    const ids: string[] = [];
    for (const src of [new ClaudeCodeSource(), new OpenCodeSource()]) {
      for (const item of src.discover()) {
        for (const run of src.load(item.path)) {
          const a = analyze(run);
          store.upsert(run, a, generate(run, a));
          ids.push(run.runId);
        }
      }
    }
    // Mark them, rather than leaving them to be recognised by their temp-dir source
    // path. `demo` seeds into whatever store is configured — usually the real one —
    // and these runs then sit in `flightrec corpus` output alongside real ones.
    store.markSynthetic(ids);
    return { runs: ids.length, root };
  } finally {
    restore("CLAUDE_CONFIG_DIR", priorClaude);
    restore("OPENCODE_STORAGE_DIR", priorOpenCode);
  }
}

function restore(key: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
}
