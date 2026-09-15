#!/usr/bin/env node
/**
 * The whole commercial stack, running, driven the way a customer drives it.
 *
 *   npm run build && npm run verify:local
 *
 * Why this exists alongside `npm test`.
 *
 * The vitest suite calls the real route handlers, but it stubs the engine and the
 * database — so it can only assert behaviour somebody already knew about. This
 * runs the REAL capacity engine, the REAL production build over HTTP, and a
 * PostgREST stand-in built from the actual migration files.
 *
 * That difference is not theoretical. The follow-on offer read the hall's binding
 * constraint out of `scenarios.csv`, and a Density Screen never produces one:
 * `/v1/screen` has no csv format at all. Every Density Screen ever sold therefore
 * offered a generic constraint instead of the customer's own. No stub would have
 * shown that, because a stub returns what its author believed — the defect was
 * found by asking the real engine and getting an empty bundle back.
 *
 * Nothing here touches production. It spawns its own engine, its own in-memory
 * database and its own server on local ports, and kills them on the way out. For
 * the hosted stack use scripts/verify-entitlement.mjs, which is a different job.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PG_PORT = Number(process.env.E2E_PG_PORT || 54329);
const ENGINE_PORT = Number(process.env.E2E_ENGINE_PORT || 8089);
const SITE_PORT = Number(process.env.E2E_SITE_PORT || 3009);

const SITE = `http://127.0.0.1:${SITE_PORT}`;
const PG = `http://127.0.0.1:${PG_PORT}`;
const ENGINE = `http://127.0.0.1:${ENGINE_PORT}`;

const WH_SECRET = "whsec_local_verify_secret";
const ADMIN_PASSWORD = "local-verify-admin-password";
const CRON_SECRET = "local-verify-cron-secret";
const ENGINE_KEY = "local-verify-engine-key";

const PYTHON = process.env.E2E_PYTHON || "python3";

let failures = 0;
let checks = 0;
const ok = (label, cond, detail = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  return cond;
};
const head = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

const children = [];
/** The last lines each child said, kept so a failure can show them. */
const logs = new Map();

function start(name, cmd, args, env = {}) {
  const c = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(c);

  // Drain both pipes. A piped child whose buffer fills BLOCKS, and a server that
  // blocks mid-boot looks exactly like a server that is slow to start — the run
  // would hang instead of failing, which in CI is the worst of both.
  const tail = [];
  logs.set(name, tail);
  const keep = (buf) => {
    for (const line of String(buf).split("\n")) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 40) tail.shift();
    }
  };
  c.stdout.on("data", keep);
  c.stderr.on("data", keep);
  c.on("error", (err) => keep(`spawn failed: ${err.message}`));
  return c;
}

/** What a service said, for when it did not come up. */
function say(name) {
  const tail = logs.get(name) ?? [];
  if (!tail.length) return "(said nothing)";
  return "\n      " + tail.slice(-12).join("\n      ");
}
function stopAll() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Poll until `probe` resolves truthy, or give up. */
async function waitFor(label, probe, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await probe()) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not come up. It said:${say(label)}`);
}

const sb = (q, init = {}) =>
  fetch(`${PG}/rest/v1/${q}`, {
    ...init,
    headers: { apikey: "local-verify", "Content-Type": "application/json", ...(init.headers || {}) },
  });

/** Stripe's scheme: the signed payload is `${timestamp}.${body}`. */
function signature(payload) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", WH_SECRET).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}
async function hook(event) {
  const payload = JSON.stringify(event);
  const res = await fetch(`${SITE}/api/stripe/webhook`, {
    method: "POST",
    headers: { "stripe-signature": signature(payload), "content-type": "application/json" },
    body: payload,
  });
  return { status: res.status, body: await res.text() };
}
function checkout(kind, over = {}) {
  return {
    id: `evt_${kind}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${kind}`,
        object: "checkout_session",
        customer_email: "buyer@northhall.example",
        customer: `cus_${kind}`,
        subscription: `sub_${kind}`,
        amount_total: 450000,
        metadata: { kind, company: "North Hall" },
        ...over,
      },
    },
  };
}

/** A hall that binds on its tap-offs — the reference shape. */
const HALL = {
  siteName: "North Hall",
  hallId: "H1",
  metro: "Dublin",
  firmCapacityMVA: 15,
  contractedMW: 12,
  currentPeakMW: 7.4,
  currentItLoadMW: 4.9,
  buswayAmpacityA: 400,
  buswayRuns: 6,
  tapoffMaxA: 63,
  voltageV: 400,
  floorLoadingKPa: 12,
  positionsAvailable: 180,
  plantCapacityKW: 6000,
  plantSupplyC: 6,
  platform: "gb300_nvl72",
};

async function main() {
  head("Starting the stack");

  start("postgrest", "node",
    [path.join("tests", "e2e", "postgrest-stub.mjs"), "supabase/migrations", String(PG_PORT)]);
  await waitFor("postgrest", async () => (await fetch(`${PG}/rest/v1/leads?select=*&limit=1`)).ok);
  ok("in-memory PostgREST, built from supabase/migrations", true, PG);

  start("engine", PYTHON, ["-m", "gridforge", "serve", "--port", String(ENGINE_PORT)], {
    GRIDFORGE_API_KEYS: ENGINE_KEY,
  });
  await waitFor("engine", async () => (await fetch(`${ENGINE}/health`)).ok);
  ok("the capacity engine", true, ENGINE);

  start("site", "npx", ["next", "start", "-p", String(SITE_PORT)], {
    SUPABASE_URL: PG,
    SUPABASE_SERVICE_ROLE_KEY: "local-verify",
    GRIDFORGE_API_URL: ENGINE,
    GRIDFORGE_API_KEY: ENGINE_KEY,
    GRIDFORGE_KEY_SECRET: "local-verify-signing-secret",
    STRIPE_SECRET_KEY: "sk_test_local_verify",
    STRIPE_WEBHOOK_SECRET: WH_SECRET,
    ADMIN_PASSWORD,
    CRON_SECRET,
    NEXT_PUBLIC_SITE_URL: SITE,
    RESEND_API_KEY: "",
  });
  await waitFor("site", async () => (await fetch(SITE)).ok);
  ok("the production build", true, SITE);

  // --- the free funnel -------------------------------------------------------
  head("The free read, and the link that leaves the browser tab");
  const q = await (
    await fetch(`${SITE}/api/qualify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...HALL, email: "ops@northhall.example" }),
    })
  ).json();
  ok("the qualifier returns a real engine read", q.ok === true, q.headline);
  ok("naming the binding constraint", Boolean(q.result?.as_found?.binding_constraint),
     q.result?.as_found?.binding_constraint);
  ok("and nothing priced leaks into the free tier",
     !JSON.stringify(q).includes("EUR") && !JSON.stringify(q).includes("capex"));
  const shareToken = (q.share || "").split("/").pop();
  ok("a shareable read was minted", Boolean(shareToken));
  ok("the share link resolves", (await fetch(`${SITE}/q/${shareToken}`)).status === 200);
  ok("a token never minted 404s", (await fetch(`${SITE}/q/not-a-real-token`)).status === 404);

  // --- the flagship engagement ----------------------------------------------
  head("The engagement — purchase to delivered document");
  const qualId = (await (await sb(`qualifications?token=eq.${shareToken}&select=id`)).json())?.[0]?.id;
  const paid = await hook(
    checkout("density_screen", { metadata: { kind: "density_screen", company: "North Hall", qualification_id: qualId } })
  );
  ok("the webhook accepts the purchase", paid.status === 200, `HTTP ${paid.status}`);

  let row = (await (await sb(`deliverables?stripe_session_id=eq.cs_density_screen&select=*`)).json())[0];
  ok("an engagement is opened", Boolean(row?.token), row?.status);
  ok("carrying the qualification it came from", row?.qualification_id === qualId);
  await hook(checkout("density_screen"));
  ok("a redelivered webhook opens no second engagement",
     (await (await sb(`deliverables?stripe_session_id=eq.cs_density_screen&select=id`)).json()).length === 1);

  const token = row.token;
  ok("the intake page resolves for the buyer", (await fetch(`${SITE}/intake/${token}`)).status === 200);
  ok("and 404s for a token never issued", (await fetch(`${SITE}/intake/nope`)).status === 404);

  const gen = await fetch(`${SITE}/api/intake/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(HALL),
  });
  ok("the intake generates a document", gen.status === 200, `HTTP ${gen.status}`);

  row = (await (await sb(`deliverables?token=eq.${token}&select=*`)).json())[0];
  ok("it is a DRAFT — release is a human act", row?.status === "draft", row?.status);
  ok("titled from the hall", Boolean(row?.title), row?.title);
  ok("the customer cannot read a draft", (await fetch(`${SITE}/api/deliverable/${token}`)).status === 409);
  ok("the hall's own binding constraint was captured for the follow-on offer",
     Boolean(row?.intake?._gridforge?.binding), row?.intake?._gridforge?.binding);

  ok("a wrong admin password is refused",
     (await fetch(`${SITE}/api/admin/login`, { method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({ password: "wrong" }) })).status === 401);
  const login = await fetch(`${SITE}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  ok("the founder signs in", login.status === 200);
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  ok("release refuses without that session",
     (await fetch(`${SITE}/api/admin/deliverables`, { method: "PATCH",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({ token, action: "release" }) })).status === 401);
  ok("and succeeds with it",
     (await fetch(`${SITE}/api/admin/deliverables`, { method: "PATCH",
       headers: { "content-type": "application/json", cookie },
       body: JSON.stringify({ token, action: "release" }) })).status === 200);

  ok("the customer can now read it", (await fetch(`${SITE}/api/deliverable/${token}`)).status === 200);
  const page = await (await fetch(`${SITE}/deliverable/${token}`)).text();
  const binding = String(row?.intake?._gridforge?.binding || "").toLowerCase();
  ok("and the follow-on offer names THEIR constraint, not a generic one",
     binding.length > 0 && page.toLowerCase().includes(`relieves ${binding}`),
     (page.match(/Now somebody has to buy[^<]{0,90}/) || ["(generic)"])[0]);
  ok("a released engagement cannot be regenerated",
     (await fetch(`${SITE}/api/intake/${token}`, { method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify(HALL) })).status === 409);

  // --- the thin-intake case the Density Screen exists for ---------------------
  head("A thin intake — the case the engine recommends this product for");
  await hook(checkout("density_screen", {
    id: "cs_thin", metadata: { kind: "density_screen", company: "Thin Hall" },
  }));
  const thinRow = (await (await sb(`deliverables?stripe_session_id=eq.cs_thin&select=*`)).json())[0];
  ok("a second engagement is opened", Boolean(thinRow?.token));

  // Exactly what the FREE qualifier asks for. The three the free tier never
  // needed — firm capacity, floor loading, plant capacity — are absent.
  const THIN = { ...HALL };
  delete THIN.firmCapacityMVA;
  delete THIN.floorLoadingKPa;
  delete THIN.plantCapacityKW;

  const thin = await fetch(`${SITE}/api/intake/${thinRow.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(THIN),
  });
  const thinBody = await thin.json();
  ok("the paid workflow accepts it", thin.status === 200,
     `HTTP ${thin.status} ${JSON.stringify(thinBody).slice(0, 150)}`);
  ok("and says what it assumed, with where to get each one",
     (thinBody.assumed ?? []).length === 3,
     (thinBody.assumed ?? []).map((a) => a.field).join(", "));

  const thinAfter = (await (await sb(`deliverables?token=eq.${thinRow.token}&select=*`)).json())[0];
  ok("the engine still names what binds this hall",
     Boolean(thinAfter?.intake?._gridforge?.binding), thinAfter?.intake?._gridforge?.binding);
  ok("on the customer's OWN numbers, not ours",
     thinAfter?.intake?.lv?.tapoff_max_A === 63 && thinAfter?.intake?.grid?.contracted_MW === 12);
  ok("and the blanks were sent as gaps, never as zeroes",
     !("firm_capacity_MVA" in (thinAfter?.intake?.grid ?? {})) &&
     !("floor_loading_kPa" in (thinAfter?.intake?.hall ?? {})) &&
     !("chilled_water_capacity_kW" in (thinAfter?.intake?.thermal?.plant ?? {})));

  await fetch(`${SITE}/api/admin/deliverables`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ token: thinRow.token, action: "release" }),
  });
  const thinDoc = JSON.stringify(
    await (await fetch(`${SITE}/api/deliverable/${thinRow.token}`)).json()
  ).toLowerCase();
  ok("the delivered document declares its assumptions rather than hiding them",
     thinDoc.includes("assum"), thinDoc.includes("assum") ? "named in the document" : "NOT NAMED");
  ok("and tells them what to go and measure — the thing they bought",
     thinDoc.includes("measure") || thinDoc.includes("data request") || thinDoc.includes("request"),
     "data-request list present");

  ok("a Procurement Specification still refuses the same thin intake",
     await (async () => {
       await hook(checkout("procurement_spec", {
         id: "cs_spec_thin", amount_total: 1800000,
         metadata: { kind: "procurement_spec", company: "Thin Hall" },
       }));
       const r = (await (await sb(`deliverables?stripe_session_id=eq.cs_spec_thin&select=*`)).json())[0];
       if (!r?.token) return false;
       const res = await fetch(`${SITE}/api/intake/${r.token}`, {
         method: "POST", headers: { "content-type": "application/json" },
         body: JSON.stringify(THIN),
       });
       return res.status === 422;
     })(),
     "duties on a purchase order may not rest on our assumptions");

  // --- the recurring products ------------------------------------------------
  head("Hall Watch — the subscription has to keep delivering, and stop when it ends");
  await hook(checkout("hall_watch", { id: "cs_hall_watch", metadata: { kind: "hall_watch", company: "North Hall" } }));
  let w = (await (await sb(`watches?stripe_subscription_id=eq.sub_hall_watch&select=*`)).json())[0];
  ok("a watch is opened by the purchase", Boolean(w?.token), w?.status);

  const engineIntake = {
    project: { client: "North Hall", reference: "North Hall/H1" },
    hall: { id: "H1", positions_available: 180, floor_loading_kPa: 12 },
    grid: { firm_capacity_MVA: 15, contracted_MW: 12, current_site_peak_MW: 7.4, current_it_load_MW: 4.9 },
    lv: { busway_ampacity_A: 400, busway_runs: 6, tapoff_max_A: 63, voltage_V: 400 },
    thermal: { plant: { chilled_water_capacity_kW: 6000, design_supply_C: 6 } },
    compute: { platform: "gb300_nvl72" },
    scenarios: ["retained_air", "rdhx", "hybrid_dlc", "full_dlc", "full_dlc_btm"],
  };
  const setWatch = (patch) =>
    sb(`watches?token=eq.${w.token}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify(patch) });
  const cron = () => fetch(`${SITE}/api/cron/watches`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });

  ok("the cron refuses without its secret", (await fetch(`${SITE}/api/cron/watches`)).status === 401);
  await setWatch({ intake: engineIntake });
  let r = await (await cron()).json();
  ok("the first run records a baseline rather than inventing a change",
     r.results?.[0]?.status === "baseline_recorded", JSON.stringify(r.results || []).slice(0, 120));

  await setWatch({ next_run_at: "2020-01-01T00:00:00Z" });
  await cron();
  let notes = await (await sb(`watch_notes?watch_id=eq.${w.id}&select=*`)).json();
  ok("an unchanged hall still gets a note", notes.length >= 1, `${notes.length} note(s)`);
  ok("saying nothing material moved, rather than manufacturing a finding",
     notes[0]?.material === false, String(notes[0]?.headline).slice(0, 70));

  await setWatch({ intake: { ...engineIntake, grid: { ...engineIntake.grid, contracted_MW: 9 } },
                   next_run_at: "2020-01-01T00:00:00Z" });
  await cron();
  notes = await (await sb(`watch_notes?watch_id=eq.${w.id}&select=*`)).json();
  ok("a real change produces a further note naming what moved", notes.length >= 2,
     String(notes[notes.length - 1]?.headline).slice(0, 90));

  await hook({ id: "evt_watch_cancel", type: "customer.subscription.deleted",
               data: { object: { id: "sub_hall_watch", object: "subscription" } } });
  w = (await (await sb(`watches?token=eq.${w.token}&select=*`)).json())[0];
  ok("cancellation stops the watch", w?.status === "cancelled", w?.status);
  await setWatch({ next_run_at: "2020-01-01T00:00:00Z" });
  ok("and no further quarterly work is done for free",
     (await (await cron()).json()).considered === 0);

  head("GridForge Intelligence — entitlement follows the money");
  const sub = (over) => hook({ id: `evt_int_${over.id}`, type: "checkout.session.completed",
    data: { object: { object: "checkout_session", customer_email: "director@northhall.example",
      customer: "cus_int", subscription: "sub_int", amount_total: 199900,
      metadata: { kind: "intelligence_subscription", plan: "team" }, ...over } } });
  const status = async () =>
    (await (await fetch(`${SITE}/api/subscription-status`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "director@northhall.example" }) })).json());
  ok("not a subscriber before paying", (await status()).active === false);
  await sub({ id: "cs_int_1" });
  ok("entitled after paying", (await status()).active === true);
  await sub({ id: "cs_int_1" });
  ok("a redelivered event does not double-issue",
     (await (await sb(`subscriptions?email=eq.director%40northhall.example&status=eq.active&select=id`)).json()).length === 1);
  await hook({ id: "evt_int_del", type: "customer.subscription.deleted",
               data: { object: { id: "sub_int", object: "subscription" } } });
  ok("cancellation withdraws the entitlement", (await status()).active === false);
  ok("and the paid surface closes with it",
     (await fetch(`${SITE}/api/scenarios?email=director%40northhall.example`)).status === 402);
}

try {
  await main();
} catch (err) {
  failures++;
  console.error("\n  ERROR ", err instanceof Error ? err.message : err);
} finally {
  stopAll();
}

head("Result");
console.log(`  ${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
