/** Importer registry. */

import { ClaudeCodeSource } from "./claudeCode.js";
import { OpenCodeSource } from "./opencode.js";
import { CodexSource } from "./stubs.js";
import type { Source } from "./types.js";

export { ClaudeCodeSource } from "./claudeCode.js";
export { OpenCodeSource } from "./opencode.js";
export type { DiscoveredFile, Source } from "./types.js";

const REGISTRY = new Map<string, Source>();

export function register(source: Source): void {
  REGISTRY.set(source.name, source);
}

export function get(name: string): Source {
  const s = REGISTRY.get(name);
  if (!s) throw new Error(`unknown source '${name}'`);
  return s;
}

export function allSources(): Source[] {
  return [...REGISTRY.values()];
}

export function availableSources(): Source[] {
  return allSources().filter((s) => s.available());
}

register(new ClaudeCodeSource());
register(new OpenCodeSource());
register(new CodexSource());
