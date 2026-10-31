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

// The unique indexes the money path leans on, read out of the migrations themselves (never retyped here). Each one is what turns a
// duplicate delivery, or two concurrent ones, into ONE row: the webhook checks for an existing row first, but only the index
// settles a race between two checks. A stand-in that did not enforce them would let a concurrent-duplicate test pass for the wrong
// reason. Only simple ones are modelled: plain columns, no predicate or `col is not null`.
const ENFORCED_UNIQUE = ["qualifications_token_idx", "deliverables_one_per_session", "deliverables_intake_token_idx", "watches_one_per_subscription", "api_accounts_one_per_subscription"];
const uniques = [];
for (const m of sql.matchAll(/create unique index (?:if not exists )?([a-z_]+)\s+on (?:public\.)?([a-z_]+)\s*\(([a-z_,\s]+)\)\s*(?:where\s*\(?\s*([a-z_]+) is not null\s*\)?)?\s*;/gi)) {
  if (ENFORCED_UNIQUE.includes(m[1])) uniques.push({ name: m[1], table: m[2], cols: m[3].split(",").map((c) => c.trim()), notNull: m[4] ?? null });
}
if (uniques.length !== ENFORCED_UNIQUE.length) {
  console.error(`[pgrest] could not read every enforced unique index from the migrations (found ${uniques.map((u) => u.name).join(", ")})`);
  process.exit(1);
}
// Column-level `unique` constraints on two tables whose idempotency the journeys exercise: the notification outbox (one obligation per
// dedupe_key: this is what makes a duplicate delivery send ONE email) and the deposit record (one per Stripe session).
for (const [table, col] of [["customer_notifications", "dedupe_key"], ["engagement_deposits", "stripe_session_id"]]) {
  const block = new RegExp(String.raw`create table (?:if not exists )?(?:public\.)?${table}\s*\(([\s\S]*?)\n\);`, "i").exec(sql)?.[1] ?? "";
  if (!new RegExp(String.raw`\b${col}\s+text[^\n,]*\bunique\b`, "i").test(block)) {
    console.error(`[pgrest] ${table}.${col} is not declared unique in the migrations; the stand-in would model a constraint that does not exist`);
    process.exit(1);
  }
  uniques.push({ name: `${table}_${col}_key`, table, cols: [col], notNull: null });
}
// Column defaults, for the one table whose behaviour DEPENDS on them: a notification row is only attempted while it is `pending` and
// due (`next_attempt_at <= now`), and both come from the column defaults, never from the code that inserts it. Parsed from the
// migration (string, number, boolean and now() defaults); other tables keep the stand-in's old behaviour of storing what was sent.
const DEFAULTED = ["customer_notifications"];
const defaultsOf = (table) => {
  const block = new RegExp(String.raw`create table (?:if not exists )?(?:public\.)?${table}\s*\(([\s\S]*?)\n\);`, "i").exec(sql)?.[1] ?? "";
  const out = {};
  for (const line of block.split("\n")) {
    const m = /^\s*([a-z_]+)\s+[a-z]+[^,]*?\bdefault\s+('(?:[^']*)'|-?\d+(?:\.\d+)?|true|false|now\(\))/i.exec(line);
    if (!m) continue;
    const v = m[2];
    out[m[1]] = v.startsWith("'") ? v.slice(1, -1) : v === "true" ? true : v === "false" ? false : v === "now()" ? "NOW" : Number(v);
  }
  return out;
};
const defaults = Object.fromEntries(DEFAULTED.map((t) => [t, defaultsOf(t)]));
for (const t of DEFAULTED) {
  if (!defaults[t].status || defaults[t].attempts === undefined) { console.error(`[pgrest] could not read the column defaults of ${t}`); process.exit(1); }
}
// `bigint generated always as identity` columns, read out of the migrations: a counter per column, assigned on insert (0044's `seq`
// orders a buyer's confirmations, so a stand-in without it would order them by accident).
const identities = new Map();
for (const t of tables.keys()) {
  const block = new RegExp(String.raw`create table (?:if not exists )?(?:public\.)?${t}\s*\(([\s\S]*?)\n\);`, "i").exec(sql)?.[1] ?? "";
  for (const line of block.split("\n")) {
    const m = /^\s*([a-z_]+)\s+bigint\s+generated always as identity/i.exec(line);
    if (m) identities.set(t, [...(identities.get(t) ?? []), { col: m[1], next: 1 }]);
  }
}
// The private object store the site writes evidence into (POST/DELETE /storage/v1/object/<bucket>/<path>), in memory.
const objects = new Map();
// Columns the migrations default to now() on the tables 0044 adds (the generic column-default reader above covers only DEFAULTED tables).
const NOW_COLUMNS = { intake_value_events: ["occurred_at"], intake_evidence_files: ["uploaded_at"] };
const withDefaults = (table, row) => {
  for (const c of NOW_COLUMNS[table] ?? []) if (row[c] === undefined) row = { ...row, [c]: new Date().toISOString() };
  for (const id of identities.get(table) ?? []) if (row[id.col] === undefined) row = { ...row, [id.col]: id.next++ };
  const d = defaults[table];
  if (!d) return row;
  const filled = {};
  for (const [k, v] of Object.entries(d)) if (row[k] === undefined) filled[k] = v === "NOW" ? new Date().toISOString() : v;
  return { ...filled, ...row };
};
const violates = (table, row, store) => uniques.find((u) => u.table === table
  && (!u.notNull || (row[u.notNull] ?? null) !== null)
  && u.cols.every((c) => (row[c] ?? null) !== null)
  && store.some((x) => u.cols.every((c) => x[c] === row[c])));

// Fault injection for the failure-path journeys: POST /__faults {table, method, status, remaining?} makes the next `remaining`
// (default: every) matching request answer `status` WITHOUT touching the table; DELETE /__faults clears them. A real outage of
// the store looks exactly like this to the site: a 5xx from PostgREST.
const faults = [];

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

// PostgREST addresses inside a json column as `col->key->>leaf`; the claim-stamp compare-and-set uses it.
const cell = (row, col) => {
  if (!col.includes("->")) return row[col];
  const [head, ...path] = col.split(/->>?/);
  let v = row[head];
  for (const k of path) v = v === null || v === undefined || typeof v !== "object" ? undefined : v[k];
  return v;
};
const match = (row, col, raw) => {
  const i = raw.indexOf(".");
  const op = raw.slice(0, i), val = raw.slice(i + 1);
  const cv = cell(row, col);
  const a = cv === null || cv === undefined ? "" : String(cv);
  if (op === "eq") return a === val;
  if (op === "neq") return a !== val;
  if (op === "in") return val.replace(/^\(|\)$/g, "").split(",").map(s => s.trim()).includes(a);
  if (op === "is") return val === "null" ? (cv ?? null) === null : false;
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
    const obj = u.pathname.match(/^\/storage\/v1\/object\/(.+)$/);
    if (obj) {
      if (req.method === "POST") { objects.set(obj[1], body.length); return send(res, 200, { Key: obj[1] }); }
      if (req.method === "DELETE") { objects.delete(obj[1]); return send(res, 200, {}); }
      return send(res, 404, { message: "object not found" });
    }
    if (u.pathname === "/__objects") return send(res, 200, [...objects.keys()]);
    if (u.pathname === "/__faults") {
      if (req.method === "DELETE") { faults.length = 0; return send(res, 200, { cleared: true }); }
      if (req.method === "POST") { faults.push({ remaining: Infinity, ...JSON.parse(body) }); return send(res, 200, { faults: faults.length }); }
      return send(res, 200, faults);
    }
    const m = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m) return send(res, 404, { message: "no route" });
    const name = m[1];
    const fault = faults.find((f) => f.table === name && f.method === req.method && f.remaining > 0);
    if (fault) {
      fault.remaining -= 1;
      console.log(`[pgrest] INJECTED ${fault.status} for ${req.method} ${name}`);
      return send(res, fault.status, { code: "XX000", message: "injected fault (tests/e2e/postgrest-stub.mjs /__faults)" });
    }
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
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).map(r => withDefaults(name, {
        id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r,
      }));
      // PostgREST's `?on_conflict=a,b` with `Prefer: resolution=ignore-duplicates` skips a row that collides on those columns (and does
      // not return it); `resolution=merge-duplicates` updates the existing row instead.
      const onConflict = (u.searchParams.get("on_conflict") || "").split(",").map((c) => c.trim()).filter(Boolean);
      const prefer = String(req.headers.prefer || "");
      const written = [];
      for (const r of rows) {
        if (onConflict.length) {
          const existing = store.find((x) => onConflict.every((c) => x[c] === r[c]));
          if (existing && prefer.includes("ignore-duplicates")) continue;
          if (existing && prefer.includes("merge-duplicates")) { Object.assign(existing, r, { id: existing.id }); written.push(existing); continue; }
        }
        if (name === "subscriptions" && r.status === "active" &&
            store.some(x => x.email === r.email && x.status === "active")) {
          return send(res, 409, { code: "23505", message: "subscriptions_one_active_per_email" });
        }
        const dup = violates(name, r, store);
        if (dup) return send(res, 409, { code: "23505", message: `duplicate key value violates unique constraint "${dup.name}"` });
        store.push(r);
        written.push(r);
      }
      console.log(`[pgrest] insert ${name} -> ${store.length} row(s)`);
      return send(res, 201, rep ? written : undefined);
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
