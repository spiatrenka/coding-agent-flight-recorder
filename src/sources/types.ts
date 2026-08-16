import type { Run } from "../model.js";

export interface DiscoveredFile {
  path: string;
  sessionId: string;
  /** seconds since epoch */
  mtime: number;
  size: number;
}

/**
 * Adding a new agent (OpenCode, Codex, Aider, a homegrown harness) means writing
 * one class that implements this interface and registering it. Nothing downstream
 * changes: every analyzer, the postmortem generator, the store and the whole UI
 * consume only the normalized `Run`.
 */
export interface Source {
  readonly name: string;
  /** Is this agent's data present on this machine? */
  available(): boolean;
  /** Cheap listing of candidate transcripts. */
  discover(): DiscoveredFile[];
  /** Parse one transcript into one or more segmented Runs. */
  load(path: string): Run[];
}
