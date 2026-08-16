/**
 * Token → USD estimation.
 *
 * Three things make this genuinely hard, and all three are handled by admitting
 * uncertainty rather than papering over it:
 *
 * 1. Transcripts record token counters, not money. Any USD figure is modelled.
 * 2. On subscription plans there is no per-run price at all. The honest answer for
 *    those runs is "unknown", not "$0.00".
 * 3. Prices change. The table lives in data (and can be overridden by a JSON file
 *    at $FLIGHTREC_PRICES) so it can be corrected without touching code.
 *
 * Cache accounting matters: cache reads are roughly a tenth of input price while
 * cache writes are more expensive than input. A long agentic run is mostly cache
 * reads, so collapsing all input tokens into one rate overstates cost badly.
 */

import { readFileSync } from "node:fs";

import { type Usage, totalTokens } from "../model.js";

export interface Price {
  input: number;
  output: number;
}

/**
 * The date the built-in table below was last checked against published pricing.
 * Surfaced in every postmortem: a price table that goes stale silently is worse
 * than one that admits its age, because the cost thresholds in the risk
 * detectors are calibrated in dollars.
 */
export const PRICES_UPDATED = "2026-08-16";

/**
 * USD per million tokens, keyed by model family. Verify against the current
 * pricing page before trusting absolute numbers; the relative shape
 * (cache read ≈ 0.1×, cache write ≈ 1.25×) is what the analysis depends on.
 *
 * Keys are resolved by `familyOf()` below, not by substring order, so a new
 * model generation is a one-line addition here rather than a code change.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  frontier: { input: 10.0, output: 50.0 }, // fable / mythos tier
  opus: { input: 5.0, output: 25.0 }, // opus 4.6 → 5
  "opus-legacy": { input: 15.0, output: 75.0 }, // opus 3, 4.0, 4.1
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 1.0, output: 5.0 }, // haiku 4.5
  "haiku-3-5": { input: 0.8, output: 4.0 },
  "haiku-3": { input: 0.25, output: 1.25 },
};

/** Model families that predate the current pricing tier for their line. */
const OPUS_LEGACY = /opus-(3|4-0|4-1)\b|claude-3-opus/;

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

let priceTableSource = "built-in defaults";
export function priceTableSourceName(): string {
  return priceTableSource;
}

function loadPrices(): Record<string, Price> {
  const path = process.env["FLIGHTREC_PRICES"];
  if (path) {
    try {
      const data: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (data && typeof data === "object" && Object.keys(data).length > 0) {
        priceTableSource = path;
        return data as Record<string, Price>;
      }
    } catch {
      // fall through to defaults; a broken override should never break ingest
    }
  }
  return DEFAULT_PRICES;
}

/**
 * Map a model id onto a price-table key. Separated from the lookup so the
 * mapping is testable on its own and so an override file only has to supply
 * family prices, not enumerate every model id.
 */
export function familyOf(model: string): string | null {
  const m = (model || "").toLowerCase();
  if (!m || m === "unknown") return null;

  if (m.includes("fable") || m.includes("mythos")) return "frontier";
  if (m.includes("haiku")) {
    if (m.includes("3-5") || m.includes("3.5")) return "haiku-3-5";
    if (m.includes("claude-3-haiku") || /haiku-3\b/.test(m)) return "haiku-3";
    return "haiku";
  }
  if (m.includes("opus")) return OPUS_LEGACY.test(m) ? "opus-legacy" : "opus";
  if (m.includes("sonnet")) return "sonnet";
  return null;
}

export function priceFor(model: string): Price | null {
  const family = familyOf(model);
  if (!family) return null;
  const prices = loadPrices();
  // Fall back to the base family when an override omits a specialised key.
  const base = family.replace(/-(legacy|3|3-5)$/, "");
  return prices[family] ?? prices[base] ?? null;
}

/**
 * Fills usage.costUsd in place. Leaves it null when nothing can be priced.
 *
 * Skipped entirely when the source already reported an exact cost — some
 * agents record what they were actually charged, and a modelled number must
 * never overwrite a real one.
 */
export function estimate(usage: Usage): Usage {
  if (!usage.costIsEstimate && usage.costUsd !== null) return usage;
  let total = 0;
  let pricedAny = false;
  const unpriced: string[] = [];

  for (const [model, counts] of Object.entries(usage.byModel)) {
    const p = priceFor(model);
    const tokens = counts.input + counts.output + counts.cacheRead + counts.cacheCreation;
    if (!p) {
      if (tokens > 0) unpriced.push(model);
      continue;
    }
    pricedAny = true;
    total +=
      (counts.input * p.input +
        counts.output * p.output +
        counts.cacheCreation * p.input * CACHE_WRITE_MULTIPLIER +
        counts.cacheRead * p.input * CACHE_READ_MULTIPLIER) /
      1_000_000;
  }

  usage.unpricedModels = [...new Set(unpriced)].sort();
  usage.costIsEstimate = true;
  usage.costUsd = pricedAny ? Math.round(total * 10_000) / 10_000 : null;
  return usage;
}

export function describeCost(usage: Usage): string {
  if (usage.costUsd === null) {
    if (totalTokens(usage) > 0) {
      return `unknown (no price for ${usage.unpricedModels.join(", ") || "this model"})`;
    }
    return "unknown (no token counters in transcript)";
  }
  const tail = usage.unpricedModels.length
    ? ` + unpriced usage on ${usage.unpricedModels.join(", ")}`
    : "";
  if (!usage.costIsEstimate) return `$${usage.costUsd.toFixed(2)} as reported by the agent${tail}`;
  return `~$${usage.costUsd.toFixed(2)} estimated${tail}`;
}
