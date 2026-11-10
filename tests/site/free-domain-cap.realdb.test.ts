/**
 * Migration 0055 part B, gf_free_account_verify_capped, against REAL PostgreSQL through REAL PostgREST, driven by the REAL client code
 * (lib/payg-accounts.ts verifyFreeAccount): the per-domain cap and the site-wide ceiling are enforced in ONE serialised call, so a burst of CONCURRENT first
 * mints from a catch-all domain cannot overshoot either limit. (tests/site/free-domain-cap.test.ts covers the route, the policy and the messages against an
 * in-memory mirror of this function; this file proves the SQL itself.)
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set (scripts/realdb-up.sh) -- a skip is a gap in what was checked; GF_REQUIRE_REALDB=1 turns it into a failure.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("psql", ["--version"]).status === 0;
const required = process.env.GF_REQUIRE_REALDB === "1";
const realFetch = globalThis.fetch;
let gateway: http.Server | null = null;

describe("real-database prerequisites (free domain cap)", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST).not.toBe("");
    expect(JWT).not.toBe("");
    expect(enabled).toBe(true);
  });
  it.runIf(required && enabled)("migration 0055 (gf_free_account_verify_capped) is applied", async () => {
    const r = await realFetch(`${PGRST}/rpc/gf_free_account_verify_capped`, {
      method: "POST", headers: { Authorization: `Bearer ${JWT}`, "content-type": "application/json" },
      body: JSON.stringify({ p_token: "nobody", p_max: 1, p_domain_key: null, p_domain_max: null }),
    });
    expect(r.status, "migration 0055 must be applied").toBe(200);
    expect(await r.json()).toEqual({ ok: false, reason: "unknown" });
  });
});

async function startGateway(): Promise<string> {
  gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";
    if (!url.startsWith("/rest/v1/")) { res.writeHead(404).end("{}"); return; }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const r = await realFetch(PGRST + url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : Buffer.concat(chunks) });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gateway!.address() as { port: number }).port}`;
}
const sql = (statement: string) => {
  const r = spawnSync("psql", ["-X", "-q", "-At", "-d", process.env.GF_PG_DB ?? "gf", "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${String(r.stderr).split("\n")[0]}`);
  return r.stdout.trim();
};
const call = async (fn: string, body: unknown) => {
  const r = await realFetch(`${PGRST}/rpc/${fn}`, { method: "POST", headers: { Authorization: `Bearer ${JWT}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
/** A free account exactly as gf_free_account_create makes it (0033), returning its portal token. */
async function account(emailNorm: string): Promise<string> {
  const token = `gft_${crypto.randomBytes(12).toString("hex")}`;
  const r = await call("gf_free_account_create", { p_email_norm: emailNorm, p_email: emailNorm, p_company: null, p_token: token, p_account: `a-${crypto.randomBytes(5).toString("hex")}`, p_units: 100 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return token;
}
const verifiedIn = (domainLike: string) => Number(sql(`select count(*) from public.api_accounts where free_verified_at is not null and free_email_norm like '%${domainLike}'`));

beforeAll(async () => {
  if (!enabled) return;
  process.env.SUPABASE_URL = await startGateway();
  process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
});
afterAll(() => { gateway?.close(); });

describe.skipIf(!enabled)("gf_free_account_verify_capped on real PostgreSQL", () => {
  it("a burst of 24 CONCURRENT first mints from one catch-all domain (and its sub-domains) verifies exactly the cap, never more", async () => {
    const { verifyFreeAccount } = await import("@/lib/payg-accounts");
    const hosts = ["evil.example", "a.evil.example", "b.c.evil.example"];
    const tokens = await Promise.all(Array.from({ length: 24 }, (_, i) => account(`u${i}@${hosts[i % 3]}`)));
    const out = await Promise.all(tokens.map((t) => verifyFreeAccount(t, 200, { key: "evil.example", max: 5 })));
    expect(out.filter((o) => o === "ok")).toHaveLength(5);
    expect(out.filter((o) => o === "domain_capacity")).toHaveLength(19);
    expect(verifiedIn("evil.example")).toBe(5);
    // a refused account is left untouched, and a verified one is never turned away
    const refused = tokens[out.findIndex((o) => o === "domain_capacity")];
    expect(sql(`select free_verified_at is null from public.api_accounts where token = '${refused}'`)).toBe("t");
    const ok = tokens[out.findIndex((o) => o === "ok")];
    expect(await verifyFreeAccount(ok, 200, { key: "evil.example", max: 5 })).toBe("ok");
    expect(verifiedIn("evil.example")).toBe(5);
  });

  it("a look-alike domain is a different domain; free-mail (null cap) and another domain are unaffected", async () => {
    const { verifyFreeAccount } = await import("@/lib/payg-accounts");
    const look = await account("x@notevil.example"); // ends with 'evil.example' but is not a sub-domain of it
    expect(await verifyFreeAccount(look, 200, { key: "notevil.example", max: 5 })).toBe("ok");
    const other = await account("p@acme.example");
    expect(await verifyFreeAccount(other, 200, { key: "acme.example", max: 5 })).toBe("ok");
    const gmail = await Promise.all(Array.from({ length: 8 }, (_, i) => account(`g${i}@gmail.com`)));
    const out = await Promise.all(gmail.map((t) => verifyFreeAccount(t, 200, null)));
    expect(out.every((o) => o === "ok")).toBe(true);
  });

  it("the site-wide ceiling is checked first and still counts everyone; an already-verified account is never refused", async () => {
    const total = Number(sql("select count(*) from public.api_accounts where free_verified_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'"));
    const t = await account("late@site-wide.example");
    const r = await call("gf_free_account_verify_capped", { p_token: t, p_max: total, p_domain_key: "site-wide.example", p_domain_max: 100 });
    expect(r.body).toEqual({ ok: false, reason: "capacity" });
    const evilVerified = sql("select token from public.api_accounts where free_verified_at is not null and free_email_norm like '%@evil.example' limit 1");
    expect((await call("gf_free_account_verify_capped", { p_token: evilVerified, p_max: 0, p_domain_key: "evil.example", p_domain_max: 1 })).body).toEqual({ ok: true, already: true });
  });

  it("reports the domain's count including this account, only when a cap was given", async () => {
    const a = await account("n1@counted.example");
    const b = await account("n2@counted.example");
    expect((await call("gf_free_account_verify_capped", { p_token: a, p_max: 1000, p_domain_key: "counted.example", p_domain_max: 10 })).body).toEqual({ ok: true, already: false, domain_count: 1 });
    expect((await call("gf_free_account_verify_capped", { p_token: b, p_max: 1000, p_domain_key: null, p_domain_max: null })).body).toEqual({ ok: true, already: false });
    const c = await account("n3@counted.example");
    expect((await call("gf_free_account_verify_capped", { p_token: c, p_max: 1000, p_domain_key: "counted.example", p_domain_max: 10 })).body).toEqual({ ok: true, already: false, domain_count: 3 });
  });

  it("refuses malformed arguments without writing anything: a half-given cap, a key with a wildcard or capital, a cap below 1, a negative ceiling", async () => {
    const t = await account("bad@args.example");
    for (const bad of [
      { p_domain_key: "args.example", p_domain_max: null }, { p_domain_key: null, p_domain_max: 3 }, { p_domain_key: "%.example", p_domain_max: 3 },
      { p_domain_key: "ARGS.example", p_domain_max: 3 }, { p_domain_key: "args_example", p_domain_max: 3 }, { p_domain_key: "args.example", p_domain_max: 0 },
      { p_domain_key: "-args.example", p_domain_max: 3 },
    ]) {
      const r = await call("gf_free_account_verify_capped", { p_token: t, p_max: 100, ...bad });
      expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    }
    expect((await call("gf_free_account_verify_capped", { p_token: t, p_max: -1, p_domain_key: null, p_domain_max: null })).status).toBeGreaterThanOrEqual(400);
    expect(sql(`select free_verified_at is null from public.api_accounts where token = '${t}'`)).toBe("t");
  });

  it("the function is service-role only, and 0033's gf_free_account_verify is untouched", async () => {
    const sig = "public.gf_free_account_verify_capped(text, integer, text, integer)";
    expect(sql(`select has_function_privilege('anon', '${sig}', 'EXECUTE')::text`)).toBe("false");
    expect(sql(`select (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))::text from pg_proc p where p.oid = '${sig}'::regprocedure`)).toBe("false");
    expect(sql(`select has_function_privilege('service_role', '${sig}', 'EXECUTE')::text`)).toBe("true");
    const anon = await realFetch(`${PGRST}/rpc/gf_free_account_verify_capped`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ p_token: "x", p_max: 1, p_domain_key: null, p_domain_max: null }) });
    expect([401, 403]).toContain(anon.status);
    expect(sql("select pg_get_functiondef('public.gf_free_account_verify(text, integer)'::regprocedure) like '%domain%'")).toBe("f");
  });

  it("the 80% line is written exactly once, by the real client, with the domain and no address", async () => {
    const { verifyFreeAccount } = await import("@/lib/payg-accounts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tokens = await Promise.all(Array.from({ length: 5 }, (_, i) => account(`w${i}.private@eighty.example`)));
      for (const t of tokens) expect(await verifyFreeAccount(t, 1000, { key: "eighty.example", max: 5 })).toBe("ok"); // sequential: 4 of 5 is 80%
      const lines = warn.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("eighty.example"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/4 of 5/);
      expect(lines[0]).not.toMatch(/@|private/);
    } finally {
      warn.mockRestore();
    }
  });
});
