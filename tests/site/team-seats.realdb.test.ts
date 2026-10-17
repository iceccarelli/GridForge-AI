/**
 * The seat invariants against REAL PostgreSQL through REAL PostgREST: the row lock that makes the last seat go to exactly one
 * person, the single-use and immutability triggers, the unique indexes, and the outbox constraint. Nothing about the database is
 * simulated; the only stand-ins are Supabase Auth, Resend and Anthropic (see team-scenarios.ts).
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set (scripts/realdb-up.sh) -- a skip is a gap in what was checked, and
 * GF_REQUIRE_REALDB=1 turns the skip into a failure.
 */
import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { defineTeamScenarios } from "./team-scenarios";

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT;
const required = process.env.GF_REQUIRE_REALDB === "1";

describe("real-database prerequisites (team seats)", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST).not.toBe("");
    expect(JWT).not.toBe("");
  });
  it.runIf(required && enabled)("migration 0027 is applied", async () => {
    const r = await fetch(`${PGRST}/rpc/gf_plan_seats`, {
      method: "POST", headers: { Authorization: `Bearer ${JWT}`, "content-type": "application/json" }, body: JSON.stringify({ p_plan: "team" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toBe(5);
  });
});

const realFetch = globalThis.fetch;
let gateway: http.Server | null = null;

/** The site talks to SUPABASE_URL/rest/v1/...; PostgREST serves /... — a tiny path-mapping proxy, as in provider-spend.realdb.test.ts. */
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

describe.skipIf(!enabled)("team seats — real PostgreSQL via PostgREST", () => {
  defineTeamScenarios({
    async install() {
      process.env.SUPABASE_URL = gateway ? `http://127.0.0.1:${(gateway.address() as { port: number }).port}` : await startGateway();
      process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
      return () => { /* the gateway outlives the test; the harness restores globalThis.fetch */ };
    },
  });
});
