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
        const [col, dir] = order.split(".");
        out.sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (dir === "desc" ? -1 : 1));
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
