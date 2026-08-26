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
  /**
   * Anything about this scan the user should be told, drained after discovery.
   *
   * For facts about the *source* — "the directory I read has been frozen since
   * February" — not about a run. Run-level surprises belong in
   * `Run.schemaDrift`, which is per-run and ends up in that run's postmortem.
   */
  notes?(): string[];
  /**
   * Release any OS handle held across a scan.
   *
   * A source backed by a file needs nothing here. One backed by a database does:
   * the registry hands out singletons and `serve` is long-lived, so without this
   * a connection outlives every scan that opened it.
   */
  close?(): void;
}
