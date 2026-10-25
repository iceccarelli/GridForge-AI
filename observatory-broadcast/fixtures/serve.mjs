#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tiny static server for the stand-in stage (localhost only). `node fixtures/serve.mjs [port]`.
 * Used by the tests and by manual runs; it can be told to misbehave (`setMode("down")`) to exercise the scene probe.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));

export function serveFixtures({ port = 0 } = {}) {
  let mode = "ok";
  const server = http.createServer((req, res) => {
    if (mode === "down") { res.writeHead(503); res.end("down"); return; }
    const u = new URL(req.url ?? "/", "http://localhost");
    const name = u.pathname === "/" || u.pathname === "/stage" ? "stage.html" : path.basename(u.pathname);
    const file = path.join(dir, name);
    if (!/^[\w.-]+$/.test(name) || !fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    const type = name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".json") ? "application/json" : "text/plain";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({
        url: `http://127.0.0.1:${addr.port}/stage`,
        port: addr.port,
        /** @param {"ok"|"down"} m */ setMode(m) { mode = m; },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r(undefined)); }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await serveFixtures({ port: Number(process.argv[2] ?? 0) });
  console.log(`serving fixtures at ${s.url}`);
}
