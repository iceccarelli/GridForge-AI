/**
 * The site and hall registry's route scenarios against REAL PostgreSQL through REAL PostgREST: the migrations 0049-0051 are applied to a fresh
 * database by scripts/realdb-up.sh, and every route runs its functions for real (role checks, CHECK constraints, triggers, unique indexes, the
 * views). Nothing about the database is simulated; the only stand-in is Supabase Auth.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set (scripts/realdb-up.sh) - a skip is a gap in what was checked, and GF_REQUIRE_REALDB=1
 * turns the skip into a failure.
 */
import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { defineRegistryScenarios } from "./site-registry-scenarios";
import { defineEngineDiffScenarios } from "./site-registry-engine-diff-scenarios";

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT;
const required = process.env.GF_REQUIRE_REALDB === "1";

describe("real-database prerequisites (site registry)", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST).not.toBe("");
    expect(JWT).not.toBe("");
  });
  it.runIf(required && enabled)("migrations 0049-0051 are applied", async () => {
    // PostgREST publishes the functions it can call at its root; a function a migration did not create is simply not listed.
    const root = await fetch(`${PGRST}/`, { headers: { Authorization: `Bearer ${JWT}` } });
    expect(root.status).toBe(200);
    const paths = Object.keys(((await root.json()) as { paths: Record<string, unknown> }).paths);
    for (const fn of ["gf_create_org", "gf_record_hall_input", "gf_hall_timeline", "gf_attach_project_to_hall"]) expect(paths, fn).toContain(`/rpc/${fn}`);
  });
});

const realFetch = globalThis.fetch;
let gateway: http.Server | null = null;

/** The site talks to SUPABASE_URL/rest/v1/...; PostgREST serves /... - a tiny path-mapping proxy, as in team-seats.realdb.test.ts. */
async function startGateway(): Promise<string> {
  gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";
    if (!url.startsWith("/rest/v1/")) { res.writeHead(404).end("{}"); return; }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const r = await realFetch(PGRST + url.slice("/rest/v1".length), {
      method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gateway!.address() as { port: number }).port}`;
}
afterAll(() => { gateway?.close(); });

describe.skipIf(!enabled)("site registry - real PostgreSQL via PostgREST", () => {
  defineRegistryScenarios({
    async install() {
      process.env.SUPABASE_URL = gateway ? `http://127.0.0.1:${(gateway.address() as { port: number }).port}` : await startGateway();
      process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
      return () => { /* the gateway outlives the test; the harness restores globalThis.fetch */ };
    },
  });
});

describe.skipIf(!enabled)("site registry engine-backed capacity diff - real PostgreSQL via PostgREST", () => {
  defineEngineDiffScenarios({
    async install() {
      process.env.SUPABASE_URL = gateway ? `http://127.0.0.1:${(gateway.address() as { port: number }).port}` : await startGateway();
      process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
      return () => { /* the gateway outlives the test; the harness restores globalThis.fetch */ };
    },
  });
});
