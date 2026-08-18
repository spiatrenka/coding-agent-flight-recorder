/** Discover transcripts → parse → analyse → postmortem → store. */

import { ANALYZER_VERSION, analyze } from "./analyze/index.js";
import type { Run } from "./model.js";
import { generate } from "./postmortem.js";
import { availableSources, get as getSource } from "./sources/index.js";
import type { DiscoveredFile } from "./sources/types.js";
import type { Store } from "./store.js";

export interface IngestResult {
  filesSeen: number;
  filesParsed: number;
  filesSkipped: number;
  runsStored: number;
  errors: string[];
  elapsedS: number;
  sourcesUsed: string[];
}

export interface IngestOptions {
  sourceNames?: string[];
  sinceDays?: number | null;
  force?: boolean;
  limit?: number | null;
  onProgress?: (line: string) => void;
}

export function ingest(store: Store, opts: IngestOptions = {}): IngestResult {
  const started = Date.now();
  const res: IngestResult = {
    filesSeen: 0,
    filesParsed: 0,
    filesSkipped: 0,
    runsStored: 0,
    errors: [],
    elapsedS: 0,
    sourcesUsed: [],
  };
  const cutoff = opts.sinceDays ? Date.now() / 1000 - opts.sinceDays * 86400 : null;
  const active = opts.sourceNames?.length ? opts.sourceNames.map(getSource) : availableSources();
  res.sourcesUsed = active.map((s) => s.name);

  for (const src of active) {
    let found: DiscoveredFile[];
    try {
      found = src.discover();
    } catch (err) {
      res.errors.push(`${src.name}: discovery failed: ${String(err)}`);
      continue;
    }
    if (opts.limit) found = found.slice(0, opts.limit);

    for (const item of found) {
      if (cutoff !== null && item.mtime < cutoff) continue;
      res.filesSeen++;
      if (!opts.force && store.isUnchanged(item.path, item.mtime, item.size, ANALYZER_VERSION)) {
        res.filesSkipped++;
        continue;
      }

      let runs: Run[];
      try {
        runs = src.load(item.path);
      } catch (err) {
        res.errors.push(`${item.path}: ${String(err)}`);
        continue;
      }

      res.filesParsed++;
      for (const run of runs) {
        try {
          const a = analyze(run);
          store.upsert(run, a, generate(run, a));
          res.runsStored++;
        } catch (err) {
          res.errors.push(`${run.runId}: analysis failed: ${String(err)}`);
        }
      }
      store.noteIngest(item.path, item.mtime, item.size, runs.length);
      opts.onProgress?.(`  ${item.path} → ${runs.length} run(s)`);
    }
  }

  res.elapsedS = Math.round((Date.now() - started) / 10) / 100;
  return res;
}
