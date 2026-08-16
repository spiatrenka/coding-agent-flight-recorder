/**
 * The two security properties this project advertises.
 *
 * Kept in their own file on purpose: both are claims made in the README and
 * SECURITY.md, and someone auditing the repo should be able to find the tests
 * that back them without reading the whole suite.
 *
 * The traversal cases are asserted against `resolveStatic` rather than only
 * through HTTP, because a 404 is also what a merely-missing file produces — an
 * end-to-end 404 cannot distinguish a working guard from a lucky `statSync`
 * failure. Both layers are covered: the unit tests pin the decision, the HTTP
 * tests pin that the decision is actually wired up.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createApp, resolveStatic, serve } from "../src/server.js";
import { Store } from "../src/store.js";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web");

let tmp: string;
let store: Store;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "flightrec-security-"));
  store = new Store(join(tmp, "test.db"));
});

after(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("the server binds loopback only", () => {
  // The guard throws before any socket is created, so these cost nothing and
  // never actually expose a port.
  for (const host of ["0.0.0.0", "192.168.1.10", "::", "10.0.0.5"]) {
    it(`refuses to bind ${host}`, () => {
      assert.throws(() => serve(store, { host, port: 0 }), /loopback only/);
    });
  }

  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    it(`accepts ${host}`, async () => {
      const server = serve(store, { host, port: 0 });
      try {
        await new Promise<void>((res) => server.once("listening", () => res()));
        assert.ok((server.address() as AddressInfo).port > 0);
      } finally {
        await new Promise<void>((res) => server.close(() => res()));
      }
    });
  }
});

describe("static assets cannot escape the web directory", () => {
  it("accepts a real asset", () => {
    const path = resolveStatic("index.html");
    assert.ok(path, "index.html should resolve");
    assert.ok(path.startsWith(WEB_DIR + sep));
  });

  it("rejects a parent-directory escape", () => {
    assert.equal(resolveStatic("../../package.json"), null);
  });

  it("rejects a percent-encoded escape", () => {
    // `%2e%2e` survives URL parsing untouched, unlike a literal `..`, so this is
    // the form that actually reaches the resolver from a real request.
    assert.equal(resolveStatic("%2e%2e%2f%2e%2e%2fpackage.json"), null);
  });

  it("rejects a sibling directory sharing the prefix", () => {
    // A bare `startsWith(WEB_DIR)` accepts this: "/…/webevil" does begin with
    // "/…/web". The separator in the guard is what rejects it.
    assert.equal(resolveStatic("../webevil/secrets.txt"), null);
  });

  it("rejects an absolute path", () => {
    assert.equal(resolveStatic("/etc/passwd"), null);
  });

  it("rejects a NUL byte", () => {
    assert.equal(resolveStatic("index.html\0.png"), null);
  });

  it("rejects a malformed percent-escape", () => {
    assert.equal(resolveStatic("%"), null);
  });
});

describe("traversal attempts over HTTP", () => {
  let base: string;
  let close: () => Promise<void>;

  before(async () => {
    const server = createApp(store);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((res) => server.close(() => res()));
  });

  after(async () => {
    await close();
  });

  for (const path of [
    "/static/../../package.json",
    "/static/%2e%2e%2f%2e%2e%2fpackage.json",
    "/static/....//....//package.json",
  ]) {
    it(`404s on ${path}`, async () => {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404);
      // Not just the status: prove no manifest content came back.
      assert.doesNotMatch(await res.text(), /agent-flight-recorder/);
    });
  }
});
