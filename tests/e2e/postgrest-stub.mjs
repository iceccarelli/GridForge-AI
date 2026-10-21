// A local stand-in for Supabase's PostgREST, over real HTTP.
//
// It creates ONLY the tables that supabase/migrations/*.sql declare — parsed out
// of the SQL — so a table with no migration answers 404 here exactly as it would
// in production. That is the whole point: `subscriptions` and `scenarios` shipped
// with no migration for several releases and nothing noticed, because PostgREST
// answers a missing relation with 404 and `fetch` does not reject on one.
//
// Development and testing only. It has no auth, no types, no constraints beyond
// the one partial unique index the webhook depends on, and it keeps everything in
// memory. It is not a database and must never be pointed at by anything real.
//
//   node tests/e2e/postgrest-stub.mjs supabase/migrations 54321

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MIGRATIONS = process.argv[2];
const PORT = Number(process.argv[3] || 54321);

const sql = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort()
  .map(f => fs.readFileSync(path.join(MIGRATIONS, f), "utf8")).join("\n");
const tables = new Map();
for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_]+)/gi)) {
  tables.set(m[1], []);
}
// Views the site reads as if they were tables (0022 / 0018). Empty here: the stand-in does not derive them, and the real
// ones are exercised by the real-database suites.
for (const v of ["cost_evidence_state", "supplier_reality"]) if (!tables.has(v)) tables.set(v, []);
console.log("[pgrest] tables from migrations:", [...tables.keys()].join(", "));

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

const match = (row, col, raw) => {
  const i = raw.indexOf(".");
  const op = raw.slice(0, i), val = raw.slice(i + 1);
  const a = row[col] === null || row[col] === undefined ? "" : String(row[col]);
  if (op === "eq") return a === val;
  if (op === "neq") return a !== val;
  if (op === "in") return val.replace(/^\(|\)$/g, "").split(",").map(s => s.trim()).includes(a);
  if (op === "is") return val === "null" ? (row[col] ?? null) === null : false;
  if (op === "not") return !match(row, col, val);
  return true;
};

http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/auth/v1/user") {
      // Stand-in for GoTrue: a bearer of the form `tok:<email>` verifies as that email, anything else is a 401.
      // `unconfirmed:<email>` is a session whose address was never confirmed: GoTrue omits email_confirmed_at for it.
      const t = /^Bearer tok:(.+)$/.exec(req.headers.authorization || "");
      const u2 = /^Bearer unconfirmed:(.+)$/.exec(req.headers.authorization || "");
      if (u2) return send(res, 200, { email: u2[1] });
      return t ? send(res, 200, { email: t[1], email_confirmed_at: "2026-01-01T00:00:00Z" }) : send(res, 401, {});
    }
    // The few server-side functions the verified journeys call. These restate what the SQL does (supabase/migrations/0024 and
    // 0025) just far enough to drive the site; that the SQL itself is atomic and race-free is proven against PostgreSQL by
    // tests/test_buyer_page_migration.py and tests/site/buyer-page.realdb.test.ts, not here.
    const rpc = u.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpc) {
      const a = body ? JSON.parse(body) : {};
      const t = (n) => tables.get(n);
      const row = (n, r) => { const x = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }; t(n).push(x); return x; };
      const event = (project_id, e, extra = {}) => row("project_events", { project_id, event_type: e.event_type, actor: e.actor, occurred_at: e.occurred_at, payload: { ...(e.payload || {}), ...extra } });
      if (rpc[1] === "gf_rate_limit_hit") {
        const ws = Math.floor(Date.now() / 1000 / a.p_window_seconds) * a.p_window_seconds;
        let w = t("rate_limit_windows").find((r) => r.bucket === a.p_bucket && r.subject === a.p_subject && r.window_start === ws);
        if (!w) w = row("rate_limit_windows", { bucket: a.p_bucket, subject: a.p_subject, window_start: ws, hits: 0 });
        w.hits += 1;
        return send(res, 200, { allowed: w.hits <= a.p_limit, hits: w.hits, limit: a.p_limit, retry_after_seconds: Math.max(1, Math.ceil(ws + a.p_window_seconds - Date.now() / 1000)) });
      }
      if (rpc[1] === "gf_save_comparison") {
        let pid = a.p?.project_id;
        if (a.p_new_project) { const p = row("projects", { ...a.p_new_project }); event(p.id, a.p_new_event); pid = p.id; }
        const c = row("project_comparisons", { ...a.p, project_id: pid });
        event(pid, a.p_event, { comparison_id: c.id });
        return send(res, 200, { created: true, project_id: pid, comparison_id: c.id });
      }
      if (rpc[1] === "gf_issue_share") {
        const old = t("project_shares").filter((r) => r.project_id === a.p_project && !r.revoked_at);
        old.forEach((r) => { r.revoked_at = new Date().toISOString(); });
        const r = row("project_shares", { project_id: a.p_project, token_hash: a.p_token_hash, revoked_at: null });
        event(a.p_project, a.p_event, { share_id: r.id });
        return send(res, 200, { share_id: r.id, created_at: r.created_at, replaced_previous: old.length > 0 });
      }
      if (rpc[1] === "gf_revoke_share") {
        const r = t("project_shares").find((x) => x.project_id === a.p_project && !x.revoked_at);
        if (r) { r.revoked_at = new Date().toISOString(); event(a.p_project, a.p_event, { share_id: r.id }); }
        return send(res, 200, { revoked: !!r });
      }
      console.log(`[pgrest] 404 rpc ${rpc[1]} — not restated in this stand-in`);
      return send(res, 404, { code: "PGRST202", message: `Could not find the function public.${rpc[1]}` });
    }
    const m = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m) return send(res, 404, { message: "no route" });
    const name = m[1];
    if (!tables.has(name)) {
      console.log(`[pgrest] 404 ${req.method} ${name} — no migration creates it`);
      return send(res, 404, { code: "42P01", message: `relation "public.${name}" does not exist` });
    }
    const store = tables.get(name);
    const filters = [...u.searchParams.entries()]
      .filter(([k]) => !["select", "order", "limit", "offset"].includes(k));
    const hit = store.filter(r => filters.every(([k, v]) => match(r, k, v)));
    const rep = String(req.headers.prefer || "").includes("return=representation");
    const parsed = body ? JSON.parse(body) : undefined;

    if (req.method === "GET") {
      let out = [...hit];
      const order = u.searchParams.get("order");
      if (order) {
        const keys = order.split(",").map((k) => k.split("."));
        out.sort((a, b) => {
          for (const [col, dir] of keys) {
            const c = String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (dir === "desc" ? -1 : 1);
            if (c) return c;
          }
          return 0;
        });
      }
      const lim = Number(u.searchParams.get("limit"));
      if (lim > 0) out = out.slice(0, lim);
      return send(res, 200, out);
    }
    if (req.method === "POST") {
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).map(r => ({
        id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r,
      }));
      for (const r of rows) {
        if (name === "subscriptions" && r.status === "active" &&
            store.some(x => x.email === r.email && x.status === "active")) {
          return send(res, 409, { code: "23505", message: "subscriptions_one_active_per_email" });
        }
        store.push(r);
      }
      console.log(`[pgrest] insert ${name} -> ${store.length} row(s)`);
      return send(res, 201, rep ? rows : undefined);
    }
    if (req.method === "PATCH") {
      hit.forEach(r => Object.assign(r, parsed));
      console.log(`[pgrest] patch ${name} x${hit.length}`);
      return send(res, 200, rep ? hit : undefined);
    }
    if (req.method === "DELETE") {
      hit.forEach(r => store.splice(store.indexOf(r), 1));
      console.log(`[pgrest] delete ${name} x${hit.length}`);
      return send(res, 200, rep ? hit : undefined);
    }
    return send(res, 405, { message: req.method });
  });
}).listen(PORT, () => console.log(`[pgrest] listening on ${PORT}`));
