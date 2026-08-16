/**
 * Local dashboard server. Node stdlib only, loopback only.
 *
 * The bind address is not configurable to a public interface on purpose: this
 * process serves your source code, your branch names and your shell history back
 * as JSON.
 */

import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ingest } from "./ingest.js";
import type { Store } from "./store.js";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res: ServerResponse, obj: unknown, code = 200): void {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(
  res: ServerResponse,
  s: string,
  code = 200,
  ctype = "text/plain; charset=utf-8",
): void {
  const body = Buffer.from(s, "utf8");
  res.writeHead(code, { "Content-Type": ctype, "Content-Length": body.length });
  res.end(body);
}

/**
 * Resolve a `/static/` request to a real file path, or `null` if it escapes.
 *
 * Separate from the response so the traversal guard can be tested directly
 * rather than inferred from a 404 — a 404 is also what a missing file returns,
 * so asserting on the status code alone cannot tell a working guard from a
 * lucky `statSync` failure.
 */
export function resolveStatic(name: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return null; // malformed percent-escape
  }
  if (decoded.includes("\0")) return null;
  if (isAbsolute(decoded)) return null;
  // Reject `..` as a path segment. This has to happen after decoding: `%2e%2e`
  // survives URL parsing untouched, so a check on the raw request would miss it.
  if (decoded.split(/[\\/]/).includes("..")) return null;

  const path = resolve(join(WEB_DIR, decoded));
  // Belt and braces. The separator is load-bearing: a bare `startsWith(WEB_DIR)`
  // also accepts a sibling directory whose name merely begins with the same
  // characters, e.g. `/…/webevil` against `/…/web`.
  if (path !== WEB_DIR && !path.startsWith(WEB_DIR + sep)) return null;
  return path;
}

function sendStatic(res: ServerResponse, name: string): void {
  const path = resolveStatic(name);
  if (path === null) return sendText(res, "Not found", 404);
  try {
    if (!statSync(path).isFile()) return sendText(res, "Not found", 404);
  } catch {
    return sendText(res, "Not found", 404);
  }
  const data = readFileSync(path);
  res.writeHead(200, {
    "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function handle(store: Store, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const p = url.pathname;
  const q = url.searchParams;

  if (req.method === "POST") {
    if (p === "/api/ingest") {
      const result = ingest(store, {
        sinceDays: q.has("since_days") ? Number(q.get("since_days")) : null,
        force: q.get("force") === "1" || q.get("force") === "true",
      });
      return sendJson(res, result);
    }
    return sendJson(res, { error: "not found" }, 404);
  }

  if (p === "/" || p === "/index.html") return sendStatic(res, "index.html");
  if (p.startsWith("/static/")) return sendStatic(res, p.slice("/static/".length));

  if (p === "/api/health") return sendJson(res, { ok: true, db: store.path });
  if (p === "/api/stats") return sendJson(res, store.stats());
  if (p === "/api/projects") return sendJson(res, store.projects());

  if (p === "/api/runs") {
    return sendJson(
      res,
      store.listRuns({
        limit: Number(q.get("limit") ?? 300),
        project: q.get("project"),
        label: q.get("label"),
        source: q.get("source"),
        includeTrivial: q.get("all") === "1" || q.get("all") === "true",
      }),
    );
  }

  if (p.startsWith("/api/runs/")) {
    const rest = p.slice("/api/runs/".length);
    const [runId, sub] = rest.split("/", 2);
    const run = runId ? store.getRun(runId) : null;
    if (!run) return sendJson(res, { error: "not found" }, 404);
    if (sub === "markdown") {
      return sendText(res, run.postmortem.markdown, 200, "text/markdown; charset=utf-8");
    }
    return sendJson(res, run);
  }

  return sendText(res, "Not found", 404);
}

/**
 * Build the HTTP server without binding it.
 *
 * Split out from `serve` so tests can listen on port 0 and close cleanly. A
 * handler that throws must not take the process down with it — the catch is the
 * only thing standing between one malformed stored run and a dead dashboard.
 */
export function createApp(store: Store): Server {
  return createServer((req, res) => {
    try {
      handle(store, req, res);
    } catch (err) {
      sendJson(res, { error: String(err) }, 500);
    }
  });
}

export function serve(
  store: Store,
  { host = "127.0.0.1", port = 8787 }: { host?: string; port?: number } = {},
): Server {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("flightrec binds loopback only — it serves your source code as JSON.");
  }
  const server = createApp(store);
  server.listen(port, host, () => {
    console.log(`Agent Flight Recorder → http://${host}:${port}/`);
    console.log(`  database: ${store.path}`);
    console.log("  ctrl-c to stop");
  });
  process.on("SIGINT", () => {
    console.log("\nstopped");
    server.close();
    process.exit(0);
  });
  return server;
}
