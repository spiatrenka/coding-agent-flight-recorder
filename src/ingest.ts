/** Discover transcripts → parse → analyse → postmortem → store. */

import { ANALYZER_VERSION, analyze } from "./analyze/index.js";
import type { Run } from "./model.js";
import { generate } from "./postmortem.js";
import { availableSources, get as getSource } from "./sources/index.js";
import type { DiscoveredFile } from "./sources/types.js";
import type { Store } from "./store.js";

/**
 * What one source contributed to a scan, and how fresh it looks.
 *
 * Added because the OpenCode importer went silent for six months without
 * anything being wrong: the source was available, discovery succeeded, and it
 * returned the same frozen files every time. A scan that reports only
 * "0 new run(s)" cannot distinguish "you have been idle" from "this importer
 * stopped working in February".
 */
export interface SourceReport {
  source: string;
  itemsSeen: number;
  /** ISO date of the newest item discovered, not of the newest item stored. */
  newestItem: string | null;
  /** Days between the newest discovered item and now. */
  staleDays: number | null;
  notes: string[];
}

export interface IngestResult {
  filesSeen: number;
  filesParsed: number;
  filesSkipped: number;
  runsStored: number;
  /**
   * Files re-read only because the analyzer changed, not because they changed.
   *
   * Reported so an upgrade's first `ingest` cannot rewrite a whole archive in
   * silence. It is the intended behaviour, but "scan for new transcripts" and
   * "re-grade everything I have ever stored" deserve different sentences.
   */
  filesRegraded: number;
  errors: string[];
  elapsedS: number;
  sourcesUsed: string[];
  sourceReports: SourceReport[];
}

/** A source whose newest data is older than this is worth remarking on. */
const STALE_SOURCE_DAYS = 30;

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
    filesRegraded: 0,
    filesParsed: 0,
    filesSkipped: 0,
    runsStored: 0,
    errors: [],
    elapsedS: 0,
    sourcesUsed: [],
    sourceReports: [],
  };
  const cutoff = opts.sinceDays ? Date.now() / 1000 - opts.sinceDays * 86400 : null;
  const active = opts.sourceNames?.length ? opts.sourceNames.map(getSource) : availableSources();
  res.sourcesUsed = active.map((s) => s.name);

  for (const src of active) {
    try {
      scanSource(src, store, opts, cutoff, res);
    } finally {
      src.close?.();
    }
  }

  res.elapsedS = Math.round((Date.now() - started) / 10) / 100;
  return res;
}

function scanSource(
  src: ReturnType<typeof getSource>,
  store: Store,
  opts: IngestOptions,
  cutoff: number | null,
  res: IngestResult,
): void {
  {
    let found: DiscoveredFile[];
    try {
      found = src.discover();
    } catch (err) {
      res.errors.push(`${src.name}: discovery failed: ${String(err)}`);
      return;
    }

    // Freshness is measured over everything discovered, before --limit and
    // --since-days narrow it: the question is "is this source still alive",
    // and answering it from a filtered view would be circular.
    const newestMtime = found.reduce((max, f) => Math.max(max, f.mtime), 0);
    const newestItem = newestMtime > 0 ? new Date(newestMtime * 1000).toISOString() : null;
    res.sourceReports.push({
      source: src.name,
      itemsSeen: found.length,
      newestItem,
      staleDays: newestMtime > 0 ? Math.floor(Date.now() / 1000 - newestMtime) / 86400 : null,
      notes: src.notes?.() ?? [],
    });

    if (opts.limit) found = found.slice(0, opts.limit);

    for (const item of found) {
      if (cutoff !== null && item.mtime < cutoff) continue;
      res.filesSeen++;
      if (!opts.force && store.isUnchanged(item.path, item.mtime, item.size, ANALYZER_VERSION)) {
        res.filesSkipped++;
        continue;
      }
      // Unchanged on disk, so the only reason to be here is a grading change.
      if (!opts.force && store.isUnchanged(item.path, item.mtime, item.size, null)) {
        res.filesRegraded++;
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
}

/**
 * Sources that look like they have stopped producing data.
 *
 * Deliberately generic rather than a check for the 2026-02 OpenCode migration:
 * the failure is "a source went quiet and nothing said so", and the next one
 * will have a different cause. Only reported for sources the store already has
 * runs from, so a machine that simply does not use an agent stays silent.
 */
export function staleSources(
  res: IngestResult,
  hasStoredRuns: (source: string) => boolean,
): SourceReport[] {
  return res.sourceReports.filter(
    (r) => r.staleDays !== null && r.staleDays > STALE_SOURCE_DAYS && hasStoredRuns(r.source),
  );
}
