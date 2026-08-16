/**
 * Placeholder importers.
 *
 * These exist so the seam is exercised rather than theoretical: the registry,
 * the UI source filter and the store all handle multiple sources today.
 * Implementing one means filling in `discover()` and `load()` to return
 * normalized `Run`s — see `opencode.ts` for a worked example.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { Run } from "../model.js";
import type { DiscoveredFile, Source } from "./types.js";

abstract class NotYetImplemented implements Source {
  abstract readonly name: string;
  protected abstract readonly rootEnv: string;
  protected abstract readonly defaultRoot: string;

  protected root(): string {
    return process.env[this.rootEnv] || join(homedir(), this.defaultRoot);
  }

  available(): boolean {
    return false; // flip to a stat() on root() once load() is real
  }

  discover(): DiscoveredFile[] {
    return [];
  }

  load(_path: string): Run[] {
    throw new Error(
      `${this.name} importer not implemented. Map its session log into the Run type ` +
        `from src/model.ts and everything downstream works unchanged.`,
    );
  }
}

export class CodexSource extends NotYetImplemented {
  readonly name = "codex";
  protected readonly rootEnv = "CODEX_HOME";
  protected readonly defaultRoot = ".codex";
}
