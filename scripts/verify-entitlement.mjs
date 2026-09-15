#!/usr/bin/env node
/**
 * Does money actually become entitlement, on the deployment that takes the money?
 *
 *   node scripts/verify-entitlement.mjs --schema
 *   node scripts/verify-entitlement.mjs --full --yes-write-to-this-database
 *
 * Why this exists rather than a paragraph in a runbook.
 *
 * `subscriptions` and `scenarios` were read and written by shipping code for
 * several releases and neither table had ever been created. Nothing caught it,
 * because PostgREST answers a missing relation with HTTP 404, `fetch` does not
 * reject on 404, and every call site caught only a throw. A customer paid a real
 * monthly subscription, nothing was recorded, and /account showed them the upgrade
 * prompt. There was no log line anywhere.
 *
 * A green CI run cannot see any of that: CI has no database, no Stripe and no
 * deployment. The only place the question can be answered is against the real
 * hosted stack, so this asks it there, and answers PASS or FAIL per criterion.
 *
 * --schema is READ ONLY and is the one that must pass before a deploy.
 * --full drives the whole purchase -> cancellation cycle through the live webhook
 *   with a correctly signed event, then deletes everything it created. It writes
 *   to the database you point it at, which is why it demands a second flag.
 *
 * Environment:
 *   SITE_URL                    https://timetopower.ai
 *   SUPABASE_URL                https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   service role / sb_secret_…
 *   STRIPE_WEBHOOK_SECRET       whsec_…              (--full only)
 */

import crypto from "node:crypto";

const args = new Set(process.argv.slice(2));
const MODE = args.has("--full") ? "full" : "schema";
const CONFIRMED = args.has("--yes-write-to-this-database");

const SITE = (process.env.SITE_URL || "").replace(/\/$/, "");
const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const WH = process.env.STRIPE_WEBHOOK_SECRET || "";

let failures = 0;
let checks = 0;
const ok = (label, cond, detail = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  return cond;
};
const head = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

function auth() {
  return KEY.startsWith("sb_secret_")
    ? { apikey: KEY }
    : { apikey: KEY, Authorization: `Bearer ${KEY}` };
}

async function rest(path, init = {}) {
  const res = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { ...auth(), "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

if (!SB || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(2);
}

// --- schema ------------------------------------------------------------------
// Every table the site reads or writes. tests/test_stack_consistency.py keeps this
// list honest against the code; this checks the database actually has them.
const TABLES = [
  "leads",
  "qualifications",
  "deliverables",
  "watches",
  "watch_notes",
  "api_accounts",
  "subscriptions",
  "scenarios",
];

// Columns that exist for a specific reason, where absence is silent.
const COLUMNS = {
  subscriptions: [
    // Without this, customer.subscription.deleted has nothing to resolve against
    // and a cancelled plan stays active forever.
    "stripe_subscription_id",
    "email",
    "plan",
    "status",
    "stripe_session_id",
  ],
  scenarios: ["email", "name", "mw", "region_id", "avoided_eur"],
  qualifications: ["token"], // the shareable read resolves on it
};

head(`Schema — ${SB}`);
for (const t of TABLES) {
  const r = await rest(`${t}?select=*&limit=1`);
  ok(
    `table ${t}`,
    r.ok,
    r.ok ? "" : `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`
  );
}
for (const [t, cols] of Object.entries(COLUMNS)) {
  const r = await rest(`${t}?select=${cols.join(",")}&limit=1`);
  ok(`${t} columns: ${cols.join(", ")}`, r.ok, r.ok ? "" : `HTTP ${r.status}`);
}

if (MODE === "schema") {
  head("Result");
  console.log(`  ${checks - failures}/${checks} passed`);
  if (failures) {
    console.log(
      "\n  Apply the migrations in supabase/migrations/ in order, then re-run.\n" +
        "  They are additive and idempotent (`create table if not exists`), so running\n" +
        "  them against a database that already has some of them is safe."
    );
  }
  process.exit(failures ? 1 : 0);
}

// --- full cycle ---------------------------------------------------------------
if (!CONFIRMED) {
  console.error(
    "\n--full writes test rows to the database above and then deletes them.\n" +
      "Re-run with --yes-write-to-this-database once you have checked that URL."
  );
  process.exit(2);
}
if (!SITE || !WH) {
  console.error("\n--full needs SITE_URL and STRIPE_WEBHOOK_SECRET.");
  process.exit(2);
}

// A marked, disposable identity. Every row this script creates carries it, and
// cleanup deletes on exactly this value and nothing else.
const RUN = crypto.randomBytes(4).toString("hex");
const EMAIL = `gf-verify+${RUN}@timetopower.ai`;
const SUB_ID = `sub_verify_${RUN}`;
const SESSION = `cs_verify_${RUN}`;

/** Stripe's scheme: the signed payload is `${timestamp}.${body}`. */
function stripeSignature(payload) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", WH).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function hook(event) {
  const payload = JSON.stringify(event);
  const res = await fetch(`${SITE}/api/stripe/webhook`, {
    method: "POST",
    headers: { "stripe-signature": stripeSignature(payload), "content-type": "application/json" },
    body: payload,
  });
  return { status: res.status, body: await res.text() };
}

async function status() {
  const res = await fetch(`${SITE}/api/subscription-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function cleanup() {
  head("Cleanup");
  for (const t of ["scenarios", "subscriptions"]) {
    const r = await rest(`${t}?email=eq.${encodeURIComponent(EMAIL)}`, {
      method: "DELETE",
      headers: { Prefer: "return=representation" },
    });
    ok(`removed ${t} rows for ${EMAIL}`, r.ok, r.ok ? `${(r.body || []).length} row(s)` : `HTTP ${r.status}`);
  }
}

try {
  head(`Purchase → entitlement → cancellation — ${SITE}`);
  console.log(`  using ${EMAIL}\n`);

  ok("not a subscriber before paying", (await status()).body.active === false);

  const forged = await fetch(`${SITE}/api/stripe/webhook`, {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=forged", "content-type": "application/json" },
    body: JSON.stringify({ id: "evt_forged", type: "checkout.session.completed", data: { object: {} } }),
  });
  ok("a forged webhook is refused", forged.status === 400, `HTTP ${forged.status}`);

  const paid = await hook({
    id: `evt_verify_${RUN}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: SESSION,
        object: "checkout_session",
        customer_email: EMAIL,
        customer: `cus_verify_${RUN}`,
        subscription: SUB_ID,
        amount_total: 199900,
        metadata: { kind: "intelligence_subscription", plan: "team" },
      },
    },
  });
  if (
    !ok("the webhook recorded the subscription", paid.status === 200, `HTTP ${paid.status} ${paid.body.slice(0, 160)}`)
  ) {
    console.log(
      "\n  A 500 here means the write failed and Stripe will retry — which is the\n" +
        "  correct behaviour and almost always means the migrations are not applied.\n" +
        "  Run with --schema."
    );
  }

  const live = await status();
  ok("the entitlement is live", live.body.active === true, JSON.stringify(live.body));
  ok("on the plan that was bought", live.body.plan === "team", String(live.body.plan));

  const replay = await hook({
    id: `evt_verify_${RUN}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: SESSION,
        object: "checkout_session",
        customer_email: EMAIL,
        customer: `cus_verify_${RUN}`,
        subscription: SUB_ID,
        amount_total: 199900,
        metadata: { kind: "intelligence_subscription", plan: "team" },
      },
    },
  });
  ok("a redelivered event does not double-issue", replay.status === 200);
  const rows = await rest(
    `subscriptions?email=eq.${encodeURIComponent(EMAIL)}&status=eq.active&select=id`
  );
  ok("exactly one active row", Array.isArray(rows.body) && rows.body.length === 1,
     `${(rows.body || []).length} row(s)`);

  const stored = await rest(
    `subscriptions?email=eq.${encodeURIComponent(EMAIL)}&select=stripe_subscription_id&limit=1`
  );
  ok(
    "the subscription id cancellation needs was stored",
    stored.body?.[0]?.stripe_subscription_id === SUB_ID,
    String(stored.body?.[0]?.stripe_subscription_id)
  );

  const save = await fetch(`${SITE}/api/scenarios`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: EMAIL, name: `verify ${RUN}`, mw: 40, regionId: "verify",
      valuePerMwMonth: 1, monthsSaved: 1, avoidedEur: 1,
    }),
  });
  ok("the paid surface accepts a write", save.status === 200, `HTTP ${save.status}`);

  const list = await fetch(`${SITE}/api/scenarios?email=${encodeURIComponent(EMAIL)}`);
  const listed = await list.json().catch(() => ({}));
  ok("and reads it back", (listed.scenarios || []).length === 1, JSON.stringify(listed).slice(0, 160));

  await hook({
    id: `evt_verify_fail_${RUN}`,
    type: "invoice.payment_failed",
    data: { object: { id: `in_${RUN}`, object: "invoice", subscription: SUB_ID } },
  });
  ok("a failed payment does not lock out a customer Stripe is still retrying",
     (await status()).body.active === true);

  await hook({
    id: `evt_verify_del_${RUN}`,
    type: "customer.subscription.deleted",
    data: { object: { id: SUB_ID, object: "subscription" } },
  });
  ok("cancellation withdraws the entitlement", (await status()).body.active === false);

  const closed = await fetch(`${SITE}/api/scenarios?email=${encodeURIComponent(EMAIL)}`);
  ok("and the paid surface closes with it", closed.status === 402, `HTTP ${closed.status}`);
} finally {
  await cleanup();
}

head("Result");
console.log(`  ${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
