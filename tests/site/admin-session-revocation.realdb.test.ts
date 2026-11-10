/**
 * Admin-session revocation (migration 0055) against REAL PostgreSQL through REAL PostgREST, with the REAL lib/admin.ts and the REAL login/logout
 * route: log in, verify, log out, and the same cookie is refused; the table is closed to the API roles, the functions are service-role-only, the
 * stored value is a keyed hash, and retention prunes only what no cookie can still need. What is NOT real: Supabase itself (no gateway beyond a
 * path-mapping proxy, no Auth), and the site's cookie jar (a stand-in for next/headers).
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set (scripts/realdb-up.sh) -- a skip is a gap in what was checked; GF_REQUIRE_REALDB=1 turns it
 * into a failure.
 */
import http from "node:http";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => jar.find((c) => c.name === n),
    set: (n: string, v: string) => { jar.length = 0; jar.push({ name: n, value: v }); },
    delete: (n: string) => { const i = jar.findIndex((c) => c.name === n); if (i >= 0) jar.splice(i, 1); },
  }),
}));

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("psql", ["--version"]).status === 0;
const required = process.env.GF_REQUIRE_REALDB === "1";
const PASSWORD = "a-long-random-admin-password";
const STRONG = "realdb-admin-session-secret-0123456789abcdef";
const realFetch = globalThis.fetch;
let gateway: http.Server | null = null;

describe("real-database prerequisites (admin session revocation)", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST).not.toBe("");
    expect(JWT).not.toBe("");
    expect(enabled).toBe(true);
  });
  it.runIf(required && enabled)("migration 0055 is applied", async () => {
    const r = await realFetch(`${PGRST}/admin_session_revocations?limit=1`, { headers: { Authorization: `Bearer ${JWT}` } });
    expect(r.status, "migration 0055 must be applied").toBe(200);
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
const api = (path: string, init: RequestInit = {}, token: string | null = JWT) =>
  realFetch(PGRST + path, { ...init, headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
const hex = (n: number, c = "a") => c.repeat(n);

beforeAll(async () => {
  if (!enabled) return;
  process.env.SUPABASE_URL = await startGateway();
  process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
  process.env.ADMIN_PASSWORD = PASSWORD;
  process.env.ADMIN_SESSION_SECRET = STRONG;
  vi.stubEnv("NODE_ENV", "production"); // the fail-closed rules apply here
  vi.stubEnv("VERCEL", "1");
});
afterAll(() => { gateway?.close(); vi.unstubAllEnvs(); });
beforeEach(() => { jar.length = 0; });

describe.skipIf(!enabled)("admin session revocation on real PostgreSQL", () => {
  it("log in -> verify -> log out -> the SAME cookie is refused (production rules, real store)", async () => {
    const { POST, DELETE } = await import("@/app/api/admin/login/route");
    const { verifyAdminCookie, resetLoginThrottle } = await import("@/lib/admin");
    resetLoginThrottle();
    const ip = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:${Math.floor(Math.random() * 0xffff).toString(16)}::1`;
    const login = await POST(new Request(siteUrl("/api/admin/login"), { method: "POST", headers: { "x-forwarded-for": ip, "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) }));
    expect(login.status).toBe(200);
    const cookie = jar[0].value;
    expect(await verifyAdminCookie(cookie)).toBe(true);

    const out = await DELETE(new Request(siteUrl("/api/admin/login"), { method: "DELETE", headers: { "x-forwarded-for": ip } }));
    expect(await out.json()).toMatchObject({ ok: true, revoked: true });
    expect(await verifyAdminCookie(cookie)).toBe(false);

    // the table holds one row: a keyed hash, not the nonce, with an expiry no later than the cookie's
    const [exp, nonce, mac] = cookie.split(".");
    const rows = (await (await api("/admin_session_revocations?select=*")).json()) as { nonce_hash: string; expires_at: string }[];
    const mine = rows.filter((r) => Math.abs(new Date(r.expires_at).getTime() - Number(exp)) < 1000);
    expect(mine).toHaveLength(1);
    expect(mine[0].nonce_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(nonce);
    expect(JSON.stringify(rows)).not.toContain(mac);
  });

  it("production FAILS CLOSED when the function is missing (simulated by pointing the check at a store that answers 404)", async () => {
    const { adminToken, verifyAdminCookie } = await import("@/lib/admin");
    const t = adminToken()!;
    expect(await verifyAdminCookie(t)).toBe(true);
    const saved = process.env.SUPABASE_URL;
    const dead = http.createServer((_q, r) => { r.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ code: "PGRST202" })); });
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    process.env.SUPABASE_URL = `http://127.0.0.1:${(dead.address() as { port: number }).port}`;
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await verifyAdminCookie(t)).toBe(false);
    } finally {
      process.env.SUPABASE_URL = saved;
      dead.close();
      vi.restoreAllMocks();
    }
    expect(await verifyAdminCookie(t)).toBe(true);
  });

  it("revoke is idempotent, validates its arguments and clamps the expiry to a day", async () => {
    const h = hex(64, "b");
    const call = (body: unknown) => api("/rpc/gf_admin_session_revoke", { method: "POST", body: JSON.stringify(body) });
    const far = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect((await call({ p_nonce_hash: h, p_expires_at: far })).status).toBeLessThan(300);
    expect((await call({ p_nonce_hash: h, p_expires_at: far })).status).toBeLessThan(300); // twice: still one row
    expect(sql(`select count(*) from public.admin_session_revocations where nonce_hash = '${h}'`)).toBe("1");
    expect(sql(`select (expires_at <= now() + interval '1 day 1 minute')::text from public.admin_session_revocations where nonce_hash = '${h}'`)).toBe("true");
    for (const bad of [{ p_nonce_hash: "NOT-HEX", p_expires_at: far }, { p_nonce_hash: hex(63), p_expires_at: far }, { p_nonce_hash: hex(64, "A"), p_expires_at: far }, { p_nonce_hash: h, p_expires_at: null }]) {
      const r = await call(bad);
      expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    }
    expect((await api("/rpc/gf_admin_session_revoked", { method: "POST", body: JSON.stringify({ p_nonce_hash: h }) })).status).toBe(200);
    expect(await (await api("/rpc/gf_admin_session_revoked", { method: "POST", body: JSON.stringify({ p_nonce_hash: h }) })).json()).toBe(true);
    expect(await (await api("/rpc/gf_admin_session_revoked", { method: "POST", body: JSON.stringify({ p_nonce_hash: hex(64, "c") }) })).json()).toBe(false);
    expect((await api("/rpc/gf_admin_session_revoked", { method: "POST", body: JSON.stringify({ p_nonce_hash: "short" }) })).status).toBeGreaterThanOrEqual(400);
  });

  it("retention: a revoke prunes rows that expired more than an hour ago and keeps the rest", async () => {
    const old = hex(64, "d");
    const recent = hex(64, "e");
    sql(`insert into public.admin_session_revocations (nonce_hash, expires_at) values ('${old}', now() - interval '2 hours'), ('${recent}', now() - interval '10 minutes') on conflict do nothing`);
    const r = await api("/rpc/gf_admin_session_revoke", { method: "POST", body: JSON.stringify({ p_nonce_hash: hex(64, "f"), p_expires_at: new Date(Date.now() + 3_600_000).toISOString() }) });
    expect(r.status).toBeLessThan(300);
    expect(sql(`select count(*) from public.admin_session_revocations where nonce_hash = '${old}'`)).toBe("0");
    expect(sql(`select count(*) from public.admin_session_revocations where nonce_hash = '${recent}'`)).toBe("1"); // within the margin
  });

  it("RLS is on with no policy, and the API roles hold nothing: anon (no token) is refused at the table and at both functions", async () => {
    expect(sql("select relrowsecurity::text from pg_class where oid = 'public.admin_session_revocations'::regclass")).toBe("true");
    expect(sql("select count(*) from pg_policies where tablename = 'admin_session_revocations'")).toBe("0");
    const t = await api("/admin_session_revocations?select=*", {}, null);
    expect([401, 403]).toContain(t.status);
    const w = await api("/admin_session_revocations", { method: "POST", body: JSON.stringify({ nonce_hash: hex(64, "1"), expires_at: new Date().toISOString() }) }, null);
    expect([401, 403]).toContain(w.status);
    const args: Record<string, object> = {
      gf_admin_session_revoke: { p_nonce_hash: hex(64, "2"), p_expires_at: new Date().toISOString() },
      gf_admin_session_revoked: { p_nonce_hash: hex(64, "2") },
    };
    for (const [fn, body] of Object.entries(args)) {
      const r = await api(`/rpc/${fn}`, { method: "POST", body: JSON.stringify(body) }, null);
      expect([401, 403], fn).toContain(r.status);
    }
    expect(sql(`select count(*) from public.admin_session_revocations where nonce_hash = '${hex(64, "2")}'`)).toBe("0");
  });

  it("a replay of the migration changes no row and is harmless (idempotent); it is also what re-establishes the table's own privileges, which the rig widens after the migrations", async () => {
    sql("insert into public.admin_session_revocations (nonce_hash, expires_at) values ('" + hex(64, "9") + "', now() + interval '1 hour') on conflict do nothing");
    const before = sql("select count(*) from public.admin_session_revocations");
    const file = (await import("node:fs")).readFileSync("supabase/migrations/0055_admin_session_revocation_and_free_domain_cap.sql", "utf8");
    const r = spawnSync("psql", ["-X", "-q", "-d", process.env.GF_PG_DB ?? "gf", "-v", "ON_ERROR_STOP=1"], { input: file, encoding: "utf8" });
    expect(r.status, String(r.stderr)).toBe(0);
    expect(sql("select count(*) from public.admin_session_revocations")).toBe(before);
  });

  it("privileges in the catalogue: functions executable by service_role only; the table is service_role select/insert/delete, never update or truncate", async () => {
    // scripts/realdb-up.sh runs `grant all on all tables in schema public to service_role` AFTER the migrations (it imitates a Supabase project's defaults),
    // so the table's own ACL is read after the replay above, which is the migration's `revoke all ... from service_role; grant select, insert, delete`.
    for (const sig of ["gf_admin_session_revoke(text, timestamptz)", "gf_admin_session_revoked(text)"]) {
      expect(sql(`select has_function_privilege('anon', 'public.${sig}', 'EXECUTE')::text`), sig).toBe("false");
      expect(sql(`select (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))::text from pg_proc p where p.oid = 'public.${sig}'::regprocedure`), `${sig} PUBLIC`).toBe("false");
      expect(sql(`select has_function_privilege('service_role', 'public.${sig}', 'EXECUTE')::text`), sig).toBe("true");
    }
    const t = "public.admin_session_revocations";
    expect(sql(`select has_table_privilege('anon', '${t}', 'select,insert,update,delete')::text`)).toBe("false");
    expect(sql(`select has_table_privilege('service_role', '${t}', 'select')::text || has_table_privilege('service_role', '${t}', 'insert')::text || has_table_privilege('service_role', '${t}', 'delete')::text`)).toBe("truetruetrue");
    expect(sql(`select has_table_privilege('service_role', '${t}', 'update')::text || has_table_privilege('service_role', '${t}', 'truncate')::text`)).toBe("falsefalse");
  });
});
