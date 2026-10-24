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
 * The purchase journey (qualifier -> Density Screen checkout -> paid webhook -> intake) runs here end to end, with two local stand-ins
 * for the outside services (tests/e2e/stand-ins.mjs): a Stripe that RECORDS the Checkout Session the site asks it to create, so the
 * metadata can be asserted, and a mail provider that records what would have been sent, so "exactly one email" is counted at the
 * provider and not inferred. The site reaches them through a harness-only preload (tests/e2e/redirect-outbound.cjs). Neither
 * stand-in takes a payment or proves anything about Stripe or Resend; the webhook events are signed here, not sent by Stripe.
 * A second site process with no Stripe key and no engine URL exercises the refusals. Set E2E_LOGS=1 to print what each process
 * said when a check fails (E2E_LOG_LINES=n for more than the last 12 lines).
 *
 * Nothing here touches production. It spawns its own engine, its own in-memory
 * database and its own server on local ports, and kills them on the way out. For
 * the hosted stack use scripts/verify-entitlement.mjs, which is a different job.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStandIns } from "./stand-ins.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PG_PORT = Number(process.env.E2E_PG_PORT || 54329);
const ENGINE_PORT = Number(process.env.E2E_ENGINE_PORT || 8089);
const SITE_PORT = Number(process.env.E2E_SITE_PORT || 3009);
/** A second site process, started only for the "payments / engine not configured" refusals: same stack, no Stripe key, no engine URL. */
const BARE_PORT = Number(process.env.E2E_BARE_SITE_PORT || SITE_PORT + 1);

const SITE = `http://127.0.0.1:${SITE_PORT}`;
const PG = `http://127.0.0.1:${PG_PORT}`;
const ENGINE = `http://127.0.0.1:${ENGINE_PORT}`;
const BARE = `http://127.0.0.1:${BARE_PORT}`;

const WH_SECRET = "whsec_local_verify_secret";
const ADMIN_PASSWORD = "local-verify-admin-password";
const CRON_SECRET = "local-verify-cron-secret";
const ENGINE_KEY = "local-verify-engine-key";

const PYTHON = process.env.E2E_PYTHON || "python3";
const OPERATOR = "operator@gridforge.test";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The Stripe / email stand-ins, set once main() has started them. */
let ins;

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
    // Own process group: `npx next start` is a wrapper, and killing only the wrapper leaves next-server running on the
    // port, so the NEXT run died with EADDRINUSE. stopAll() signals the whole group.
    detached: true,
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
      if (tail.length > (Number(process.env.E2E_LOG_LINES) || 40)) tail.shift();
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
  return "\n      " + tail.slice(-(Number(process.env.E2E_LOG_LINES) || 12)).join("\n      ");
}
function stopAll() {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      try { c.kill("SIGTERM"); } catch { /* already gone */ }
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
/**
 * A checkout.session.completed event. `payment_status` is stated here, once, and is "paid" unless a scenario says otherwise:
 * Stripe always sends it, and the webhook refuses a session without one (app/api/stripe/webhook/route.ts, checkoutIsPaid).
 * The guard in tests/site/checkout-fixture-guard.test.ts reads this file too. To build a malformed payload, pass
 * `{ payment_status: undefined }` and it is dropped from the JSON.
 */
function checkout(kind, over = {}, opts = {}) {
  return {
    id: opts.eventId ?? `evt_${over.id ?? `cs_${kind}`}`,
    type: opts.eventType ?? "checkout.session.completed",
    data: {
      object: {
        id: `cs_${kind}`,
        object: "checkout_session",
        payment_status: "paid",
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

/** Release the draft exactly as the operator's button does: bound to the hash of the document that was read. */
/**
 * The fingerprint a reviewer approves, re-implemented here on purpose (an independent statement of lib/deliverables.ts
 * packHashV2): every delivered file, name and length prefixed, except the bid comparison the buyer creates afterwards.
 */
function packHashV2(row) {
  const h = crypto.createHash("sha256");
  const part = (name, body) => {
    const b = Buffer.from(body ?? "", "utf8");
    h.update(`${name}\0${b.length}\0`, "utf8");
    h.update(b);
  };
  h.update("gridforge-pack-v2\0", "utf8");
  part("document_html", row.document_html);
  part("document_md", row.document_md);
  part("deck_html", row.deck_html);
  const files = row.working_files ?? {};
  for (const name of Object.keys(files).filter((n) => n !== "bid_comparison.json").sort()) part(`file:${name}`, files[name]);
  return h.digest("hex");
}

// The stack's checkout sessions (cs_density_screen ...) are fabricated, so Stripe cannot say whether their payments stand and the
// release gate (lib/payment-standing.ts) refuses them. The helper therefore takes the operator's explicit acknowledgement, the
// route's own override; the gate itself is asserted below without it, and in tests/site/release-payment-standing.test.ts.
async function release(token, cookie, acknowledge = true) {
  const row = (await (await sb(`deliverables?token=eq.${token}&select=document_html,document_md,deck_html,working_files,intake`)).json())[0] ?? {};
  const v2 = row?.intake?._gridforge?.hash_version === 2;
  const hash = v2 ? packHashV2(row) : crypto.createHash("sha256").update(row?.document_html ?? "", "utf8").digest("hex");
  return fetch(`${SITE}/api/admin/deliverables`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ token, action: "release", reviewed_hash: hash, reviewed_by: "A. Reviewer", ...(acknowledge ? { acknowledge_payment_issue: true } : {}) }),
  });
}

async function main() {
  // The harness plays the trusted proxy: a request to the site carries one client's address unless it names its own.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    if (!String(url).startsWith(SITE)) return realFetch(url, init);
    const headers = new Headers(init.headers);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", "198.51.100.200");
    return realFetch(url, { ...init, headers });
  };

  head("Starting the stack");

  start("postgrest", "node",
    [path.join("tests", "e2e", "postgrest-stub.mjs"), "supabase/migrations", String(PG_PORT)]);
  await waitFor("postgrest", async () => (await fetch(`${PG}/rest/v1/leads?select=*&limit=1`)).ok);
  ok("in-memory PostgREST, built from supabase/migrations", true, PG);

  const engineChild = start("engine", PYTHON, ["-m", "gridforge", "serve", "--port", String(ENGINE_PORT)], {
    GRIDFORGE_API_KEYS: ENGINE_KEY,
    // The engine rate-limits by client address and here every request comes from the one site process, so its own limiter
    // would mask the site's limits this run is trying to observe. Raised for the harness only.
    GRIDFORGE_RATE_LIMIT: "100000",
  });
  await waitFor("engine", async () => (await fetch(`${ENGINE}/health`)).ok);
  ok("the capacity engine", true, ENGINE);

  // The two outside services the purchase journey touches, as local stand-ins (tests/e2e/stand-ins.mjs): a Stripe that records the
  // Checkout Session it was asked to create, and a mail provider that records the messages it was asked to send. The site reaches
  // them through a --require preload that exists only in this harness (tests/e2e/redirect-outbound.cjs). Nothing here is, or
  // proves anything about, Stripe or Resend.
  ins = await startStandIns();
  ok("Stripe and email stand-ins (they record what the site sent; no live account is touched)", true, ins.base);

  const siteEnv = {
    SUPABASE_URL: PG,
    NEXT_PUBLIC_SUPABASE_URL: PG,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anon",
    SUPABASE_SERVICE_ROLE_KEY: "local-verify",
    GRIDFORGE_API_URL: ENGINE,
    GRIDFORGE_API_KEY: ENGINE_KEY,
    GRIDFORGE_KEY_SECRET: "local-verify-signing-secret",
    STRIPE_SECRET_KEY: "sk_test_local_verify",
    STRIPE_WEBHOOK_SECRET: WH_SECRET,
    ADMIN_PASSWORD,
    CRON_SECRET,
    NEXT_PUBLIC_SITE_URL: SITE,
    RESEND_API_KEY: "re_test_local_verify",
    LEAD_FROM_EMAIL: "Time to Power <ops@gridforge.test>",
    LEAD_TO_EMAIL: OPERATOR,
    E2E_STANDIN: ins.target,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${path.join(ROOT, "tests", "e2e", "redirect-outbound.cjs")}`.trim(),
    // This is a production build, so the rate limiter needs the same thing production gives it: a declared source for the
    // caller's address. Here the harness plays the proxy and writes x-forwarded-for itself (see the fetch wrapper at the top of main).
    GRIDFORGE_TRUSTED_IP_HEADER: "x-forwarded-for",
    RATE_LIMIT_HMAC_KEY: "local-verify-rate-limit-key-0123456789abcdef",
  };
  start("site", "npx", ["next", "start", "-p", String(SITE_PORT)], siteEnv);
  await waitFor("site", async () => (await fetch(SITE)).ok);
  ok("the production build", true, SITE);

  // --- the Time-to-Power comparison: real build -> real route -> real engine ----
  head("Time-to-Power scenario comparison");
  const ttpHall = { siteName: "Verify Hall", hallId: "H1", contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9,
    buswayAmpacityA: 400, tapoffMaxA: 63, positionsAvailable: 180, plantSupplyC: 6, firmCapacityMVA: 15,
    floorLoadingKPa: 12, plantCapacityKW: 6000, platform: "gb300_nvl72" };
  const ttpCmpRes = await fetch(`${SITE}/api/power/compare`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hall: ttpHall, objective: "fastest" }) });
  const ttpCmp = await ttpCmpRes.json();
  ok("the comparison route answers from the engine", ttpCmpRes.status === 200 && ttpCmp.result?.schema === "gridforge/ttp-compare/1",
     ttpCmp.result?.request_digest?.slice(0, 12));
  const undated = (ttpCmp.result?.scenarios || []).find((r) => r.time_to_power.status !== "dated");
  ok("a scenario with nothing deployable has no date and says why", Boolean(undated) && undated.time_to_power.weeks === null
     && Boolean(undated.time_to_power.reason));
  ok("assumed lead times make it indicative", ttpCmp.result?.grade === "indicative");
  const ttpCmpBad = await fetch(`${SITE}/api/power/compare`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hall: { ...ttpHall, contractedMW: undefined } }) });
  ok("an incomplete hall is refused, not guessed at", ttpCmpBad.status === 422);
  ok("the page is served", (await fetch(`${SITE}/power/compare`)).status === 200);

  // --- saved comparison -> read-only buyer page -> checkout guard: real build, real engine, real routes -------------------
  head("Saved comparison, buyer link and buyer page");
  const owner = { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" };
  const saveRes = await fetch(`${SITE}/api/power/compare/save`, { method: "POST", headers: owner,
    body: JSON.stringify({ compare: { hall: ttpHall, objective: "fastest" }, project: { project_name: "Verify Hall expansion", company: "Verify Co" } }) });
  const savedText = await saveRes.text();
  let saved = {};
  try { saved = JSON.parse(savedText); } catch { console.error(`  save answered ${saveRes.status} with a non-JSON body: ${savedText.slice(0, 160)}`); }
  ok("a comparison saves to a new project, answered by the engine", saveRes.status === 201 && Boolean(saved.project_token) && saved.request_digest === ttpCmp.result?.request_digest,
     saved.request_digest?.slice(0, 12));
  const stored = (await (await sb(`project_comparisons?select=request_digest,grade`)).json())[0];
  ok("the stored row is the engine's answer to that question", stored?.request_digest === saved.request_digest && stored?.grade === "indicative");
  const shareRes = await fetch(`${SITE}/api/projects/${saved.project_token}/share`, { method: "POST" });
  const share = await shareRes.json();
  ok("the owner mints a read-only buyer link", shareRes.status === 201 && /^\/p\/[A-Za-z0-9_-]{43}$/.test(share.share_path ?? ""));
  const shareRow = (await (await sb(`project_shares?select=token_hash`)).json())[0];
  ok("only the hash of the link is stored", Boolean(shareRow?.token_hash) && !JSON.stringify(shareRow).includes(share.share_path.slice(3)));
  const pageRes = await fetch(`${SITE}${share.share_path}`);
  const pageHtml = await pageRes.text();
  ok("the buyer page renders the decision, the evidence class and the quotation basis",
     pageRes.status === 200 && pageHtml.includes("Verify Hall expansion") && pageHtml.includes("Decision") && /E0/.test(pageHtml) && /not decision-grade/.test(pageHtml));
  ok("it states the empty calibration ledger", pageHtml.includes("The calibration ledger is empty today"));
  ok("it offers the Density Screen at the catalogue price, with its credit",
     pageHtml.includes("Density Screen") && pageHtml.includes("€4,500") && pageHtml.includes("Credits in full against"));
  ok("it is not indexable, not referred, and carries no credential",
     /name="robots" content="[^"]*noindex/.test(pageHtml) && /name="referrer" content="no-referrer"/.test(pageHtml)
     && !pageHtml.includes(saved.project_token) && !/workspace\?project/.test(pageHtml));
  ok("robots.txt keeps /p/ closed to every crawler", /Disallow: \/p\//.test(await (await fetch(`${SITE}/robots.txt`)).text()));
  ok("a link that was never minted is a 404", (await fetch(`${SITE}/p/${"a".repeat(43)}`)).status === 404);
  ok("so is a truncated one", (await fetch(`${SITE}${share.share_path.slice(0, 20)}`)).status === 404);
  const badBuy = async (body) => (await fetch(`${SITE}/api/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  ok("checkout refuses a link that was never minted, before Stripe is touched", (await badBuy({ product: "density_screen", project_share_token: "b".repeat(43) })) === 404);
  ok("and the edit token is not a buyer link", (await badBuy({ product: "density_screen", project_share_token: saved.project_token })) === 404);
  ok("and a product that cannot be commissioned for a project", (await badBuy({ product: "api_triage", project_share_token: share.share_path.slice(3) })) === 400);
  const revoke = await fetch(`${SITE}/api/projects/${saved.project_token}/share`, { method: "DELETE" });
  ok("the owner revokes the link", revoke.status === 200 && (await revoke.json()).revoked === true);
  ok("the revoked link is a 404 and cannot start a checkout",
     (await fetch(`${SITE}${share.share_path}`)).status === 404 && (await badBuy({ product: "density_screen", project_share_token: share.share_path.slice(3) })) === 404);
  const limited = [];
  for (let i = 0; i < 8; i++) {
    limited.push((await fetch(`${SITE}/api/power/compare/save`, { method: "POST", headers: { ...owner, "x-forwarded-for": "198.51.100.99" },
      body: JSON.stringify({ compare: { hall: ttpHall }, project: { project_name: `Limited ${i}` } }) })).status);
  }
  ok("the save route is rate limited per caller, before the engine", limited.slice(0, 6).every((c) => c === 201) && limited.slice(6).every((c) => c === 429), limited.join(","));
  const counterRows = await (await sb(`rate_limit_windows?select=subject`)).json();
  ok("the counter holds a keyed hash of the caller, never the address",
     counterRows.length > 0 && counterRows.every((r) => /^[0-9a-f]{64}$/.test(r.subject)) && !JSON.stringify(counterRows).includes("198.51.100"));

  // --- provider spend: the guard on the paths that were open, through the real production build ---------------------------
  head("Provider-spend guard on the public routes");
  const hallBody = { contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, plantSupplyC: 6, positionsAvailable: 180 };
  const qualifyAs = (via, body = hallBody) => fetch(`${SITE}/api/qualify`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": via }, body: JSON.stringify(body) });
  const big = await qualifyAs("198.51.100.140", { ...hallBody, name: "x".repeat(40 * 1024) });
  ok("an oversized qualifier body is refused before the engine (413)", big.status === 413);
  const deployBig = await fetch(`${SITE}/api/power/deploy/cases`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.141" },
    body: JSON.stringify({ load_profile: { csv: "x".repeat(600 * 1024) } }) });
  ok("a deployment request larger than the engine accepts is refused first (413)", deployBig.status === 413);
  // 30 per 10 minutes per caller. The caller is the LAST address in x-forwarded-for (the one the proxy wrote): what a client
  // typed in front of it changes nothing.
  const qs = [];
  for (let i = 0; i < 32; i++) qs.push((await qualifyAs(`10.9.${i}.1, 198.51.100.150`)).status);
  ok("the qualifier admits 30 and then refuses, whatever address the client claims", qs.slice(0, 30).every((c) => c === 200) && qs.slice(30).every((c) => c === 429), qs.join(","));
  const over = await qualifyAs("1.1.1.1, 198.51.100.150");
  ok("the refusal carries Retry-After", over.status === 429 && Number(over.headers.get("retry-after")) >= 1);
  ok("a different caller is unaffected", (await qualifyAs("198.51.100.151")).status === 200);
  const chatRes = await fetch(`${SITE}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  ok("chat is closed until its provider is configured, with no spend", chatRes.status === 503);
  const providerRows = await (await sb(`rate_limit_windows?select=bucket,subject,hits`)).json();
  const buckets = new Set(providerRows.map((r) => r.bucket));
  ok("both levels of the counter were used: request and provider",
     ["qualify", "engine_public_free_caller", "engine_public_free"].every((b) => buckets.has(b)), [...buckets].join(","));
  ok("and hold only keyed pseudonyms", providerRows.every((r) => /^[0-9a-f]{64}$/.test(r.subject)) && !JSON.stringify(providerRows).includes("198.51.100"));

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

  // The share link exists so the read reaches the person who signs. Its
  // "commission it" button linked to /pricing, so that person clicked to buy and
  // landed on a generic price list with the hall, the constraint and the
  // qualification all gone. Every share was a conversion handed back to the top of
  // the funnel.
  const qualId = (await (await sb(`qualifications?token=eq.${shareToken}&select=id`)).json())?.[0]?.id;
  const sharePage = await (await fetch(`${SITE}/q/${shareToken}`)).text();
  ok("the share page offers the engagement at its price",
     sharePage.includes("commission it") && sharePage.includes("4,500"));
  // The CTA itself must be a control that starts checkout, not an anchor to the
  // price list. The Navbar's own "Pricing" link is a different thing and stays.
  const ctaIsButton = /<button[^>]*>[^<]*commission it/.test(sharePage);
  const ctaIsPricingLink = /href="\/pricing"[^>]*>[^<]*commission it/.test(sharePage);
  ok("and commissions it in place rather than sending the buyer to a price list",
     ctaIsButton && !ctaIsPricingLink,
     ctaIsButton ? "checkout control present" : "the CTA is still a link");
  ok("carrying the qualification the read came from",
     sharePage.includes(String(qualId ?? "\u0000")), "qualification id on the page");

  // --- item 1: the reference the read hands to the Density Screen CTA ----------
  head("The qualifier result — the reference its CTA carries");
  const qRow = (await (await sb(`qualifications?id=eq.${qualId}&select=*`)).json())[0];
  ok("a persisted qualification comes back with BOTH its id and its token",
     UUID_RE.test(String(q.qualificationId)) && q.qualificationToken === shareToken && q.qualificationId === qualId,
     `${String(q.qualificationId).slice(0, 8)}… / token ${String(q.qualificationToken).length} chars`);
  ok("and says outright that it was saved", q.saved === true);
  ok("the share path is the result page the UI links to", q.share === `/q/${shareToken}`);
  ok("the stored read is this hall's own inputs and the engine's answer",
     qRow?.token === shareToken && qRow.inputs?.contractedMW === 12 && qRow.inputs?.tapoffMaxA === 63 && qRow.inputs?.positionsAvailable === 180
       && qRow.inputs?.siteName === "North Hall" && qRow.status === "scored" && qRow.binding_constraint === q.result?.as_found?.binding_constraint);
  ok("the result page the CTA sits on carries the id AND the token it will present to checkout",
     sharePage.includes(qualId) && sharePage.includes(shareToken), "both present in the page payload");

  // Hall B and hall C: other buyers' reads, to prove one read's reference never opens another's.
  const HALL_B = { ...HALL, siteName: "Other Hall", hallId: "B1", metro: "Cork", contractedMW: 20, currentPeakMW: 11, currentItLoadMW: 8.5,
    buswayAmpacityA: 630, tapoffMaxA: 125, positionsAvailable: 240, plantSupplyC: 8 };
  const readOf = async (hall, via = "198.51.100.210") =>
    (await (await fetch(`${SITE}/api/qualify`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": via }, body: JSON.stringify(hall) })).json());
  const qB = await readOf({ ...HALL_B, email: "ops@othergrid.example" });
  ok("a second hall gets its own, different, reference",
     qB.ok === true && UUID_RE.test(String(qB.qualificationId)) && qB.qualificationId !== qualId && qB.qualificationToken !== shareToken);

  // --- item 2: checkout validates the reference before Stripe sees anything -----
  head("Checkout — only a validated qualification id reaches Stripe");
  const checkoutAs = async (body, via = SITE) => {
    const r = await fetch(`${via}/api/checkout`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.220" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  /** One checkout; the Stripe stand-in's record of the session that was created is what is asserted, not the route's own say-so. */
  const attempt = async (label, body, expectedId) => {
    const n = ins.sessions().length;
    const r = await checkoutAs({ product: "density_screen", company: "Checkout Co", ...body });
    const rec = ins.sessions()[n];
    ok(label, r.status === 200 && r.body.ok === true && ins.sessions().length === n + 1 && rec?.params.metadata?.qualification_id === expectedId
         && r.body.url === rec?.session.url,
       `qualification_id=${JSON.stringify(rec?.params.metadata?.qualification_id)}`);
    return rec;
  };
  const buyA = await attempt("a matching, recent id + token puts ONLY the validated id in the Stripe session metadata",
    { qualificationId: qualId, qualificationToken: shareToken, capacityMW: 5 }, qualId);
  const wire = JSON.stringify(buyA.params);
  ok("and nothing else about the read: no token, no contact email, no hall name or place",
     [shareToken, "ops@northhall.example", "North Hall", "Dublin"].every((x) => !wire.includes(x)), "metadata + urls + line items scanned");
  const allowedKeys = new Set(["company", "capacity_mw", "service", "founding_applied", "kind", "qualification_id"]);
  ok("the metadata holds only the known keys, and the price is the catalogue's",
     Object.keys(buyA.params.metadata).every((k) => allowedKeys.has(k)) && buyA.params.line_items[0].price_data.unit_amount === "450000"
       && buyA.params.metadata.kind === "density_screen", Object.keys(buyA.params.metadata).join(","));
  const buyB = await attempt("the second hall's own reference is carried for the second hall",
    { qualificationId: qB.qualificationId, qualificationToken: qB.qualificationToken }, qB.qualificationId);

  const dropIdOnly = await attempt("an id with no token is dropped (an id is not a credential)", { qualificationId: qualId }, "");
  const dropWrong = await attempt("a wrong token is dropped", { qualificationId: qualId, qualificationToken: "not-the-token-0123456789" }, "");
  await attempt("a token with no id resolves to the read it belongs to (possession of the token is the proof)", { qualificationToken: shareToken }, qualId);
  const dropNone = await attempt("a missing reference leaves the purchase unattached", {}, "");
  await attempt("another read's token cannot vouch for this read's id", { qualificationId: qualId, qualificationToken: qB.qualificationToken }, "");
  await attempt("and this read's token cannot vouch for another read's id", { qualificationId: qB.qualificationId, qualificationToken: shareToken }, "");
  await attempt("a malformed id is dropped, not passed on", { qualificationId: "'; drop table--", qualificationToken: shareToken }, "");
  await attempt("a non-string reference is dropped", { qualificationId: { toString: "x" }, qualificationToken: ["a"] }, "");

  const aged = async (hours, label, expected, hall) => {
    const r = await readOf(hall, "198.51.100.211");
    await sb(`qualifications?id=eq.${r.qualificationId}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ created_at: new Date(Date.now() - hours * 3600_000).toISOString() }) });
    await attempt(label, { qualificationId: r.qualificationId, qualificationToken: r.qualificationToken }, expected ? r.qualificationId : "");
  };
  await aged(23, "a read 23 hours old is still inside the 24 hour window", true, { ...HALL, siteName: "Day-old Hall" });
  await aged(25, "a read 25 hours old is expired: dropped, the sale proceeds unattached", false, { ...HALL, siteName: "Stale Hall" });
  await aged(-1, "a read dated in the future is not a read: dropped", false, { ...HALL, siteName: "Clock-skew Hall" });

  const refused = async (label, body, status, expectError) => {
    const n = ins.sessions().length;
    const r = await checkoutAs(body);
    ok(label, r.status === status && r.body.ok === false && ins.sessions().length === n && (!expectError || expectError.test(String(r.body.error))),
       `HTTP ${r.status} ${String(r.body.error).slice(0, 80)}; sessions ${ins.sessions().length - n} created`);
  };
  await refused("an unknown product is refused, and no Stripe session exists", { product: "free_everything", qualificationId: qualId, qualificationToken: shareToken }, 400);
  await refused("so is a request that names no product (there is no generic deposit)", { qualificationId: qualId, qualificationToken: shareToken }, 400, /no generic deposit/i);
  await refused("so is an ambiguous selector", { product: "density_screen", sku: "density_screen" }, 400);
  await refused("an API plan is refused while key issuance is unverified: honest error, no payment taken, no session",
    { product: "api_triage" }, 503, /No payment was taken/);
  await refused("a buyer link that was never minted is refused before Stripe is touched", { product: "density_screen", project_share_token: "c".repeat(43) }, 404);


  // --- the flagship engagement ----------------------------------------------
  head("The engagement — purchase to delivered document");
  // The webhook event is built from the session the Stripe stand-in was actually asked to create (its id, its amount, its metadata),
  // so the join from the read to the engagement is the one checkout made and not one the harness typed. `paid` is the state Stripe
  // reports once the card has been charged; the stand-in never takes a payment, so this stands in for Stripe's word, nothing more.
  const completedFor = (rec, over = {}, opts = {}) => checkout("density_screen", {
    id: rec.id, amount_total: Number(rec.params.line_items[0].price_data.unit_amount), metadata: rec.params.metadata, ...over }, opts);
  const BUYER_A = "buyer@northhall.example";
  const BUYER_B = "buyer@othergrid.example";
  const sid = buyA.id;
  const mailsToBuyerA = () => ins.mailsTo(BUYER_A);
  ok("before payment: no engagement, no intake email",
     (await (await sb(`deliverables?stripe_session_id=eq.${sid}&select=id`)).json()).length === 0 && mailsToBuyerA().length === 0);

  const paidEvent = completedFor(buyA);
  const paid = await hook(paidEvent);
  ok("the webhook accepts the paid purchase", paid.status === 200, `HTTP ${paid.status}`);

  let row = (await (await sb(`deliverables?stripe_session_id=eq.${sid}&select=*`)).json())[0];
  const rowsFor = async (session) => (await (await sb(`deliverables?stripe_session_id=eq.${session}&select=*`)).json());
  ok("an engagement is opened", Boolean(row?.token), row?.status);
  ok("exactly ONE deliverable row, linked to the qualification the checkout validated",
     (await rowsFor(sid)).length === 1 && row?.qualification_id === qualId && row?.kind === "density_screen" && row?.status === "awaiting_intake"
       && row?.amount_cents === 450000);
  const intakeMail = mailsToBuyerA();
  ok("and exactly ONE intake email, carrying the INTAKE link and never the document token",
     intakeMail.length === 1 && intakeMail[0].text.includes(`/intake/${row.intake_token}`) && !intakeMail[0].text.includes(row.token),
     intakeMail[0]?.subject);

  const operatorBefore = ins.mailsTo(OPERATOR).length;
  const again = await hook(paidEvent);
  ok("the same event delivered again is acknowledged", again.status === 200, `HTTP ${again.status}`);
  ok("and opens no second engagement, sends no second intake email, tells the operator nothing new",
     (await rowsFor(sid)).length === 1 && mailsToBuyerA().length === 1 && ins.mailsTo(OPERATOR).length === operatorBefore);

  // A concurrent duplicate: Stripe can redeliver while the first delivery is still being handled. Only the unique index settles that
  // race, so the stand-in enforces the migration's own (tests/e2e/postgrest-stub.mjs).
  const operatorBeforeB = ins.mailsTo(OPERATOR).length;
  const eventB = completedFor(buyB, { customer_email: BUYER_B });
  const burst = await Promise.all(Array.from({ length: 8 }, () => hook(eventB)));
  const burstStatus = burst.map((r) => r.status);
  ok("eight concurrent deliveries of one event: every answer is a success or a retry request, never a half-answer",
     burstStatus.every((c) => c === 200 || c === 500) && burstStatus.includes(200), burstStatus.join(","));
  ok("they create exactly ONE engagement and send exactly ONE intake email, and tell the operator once",
     (await rowsFor(buyB.id)).length === 1 && ins.mailsTo(BUYER_B).length === 1 && ins.mailsTo(OPERATOR).length === operatorBeforeB + 1,
     `${ins.mailsTo(BUYER_B).length} mail(s); operator +${ins.mailsTo(OPERATOR).length - operatorBeforeB}`);
  ok("and Stripe's retry of a losing delivery lands on the one engagement",
     (await hook(eventB)).status === 200 && (await rowsFor(buyB.id)).length === 1 && ins.mailsTo(BUYER_B).length === 1);
  const rowB = (await rowsFor(buyB.id))[0];
  ok("the second hall's engagement is linked to ITS qualification", rowB?.qualification_id === qB.qualificationId);

  // Purchases whose reference checkout DROPPED: the engagement opens unattached, and nothing of anyone's read is seeded into it.
  await hook(completedFor(dropIdOnly, { customer_email: "idonly@attacker.example" }));
  await hook(completedFor(dropWrong, { customer_email: "wrongtoken@attacker.example" }));
  await hook(completedFor(dropNone, { customer_email: "noref@attacker.example" }));
  const unattached = [dropIdOnly, dropWrong, dropNone].map((r) => r.id);
  const unattachedRows = (await Promise.all(unattached.map(rowsFor))).map((r) => r[0]);
  ok("a purchase whose reference was dropped opens an engagement linked to nothing",
     unattachedRows.every((r) => Boolean(r) && (r.qualification_id ?? null) === null), unattachedRows.map((r) => String(r?.qualification_id)).join(","));

  const token = row.token;
  const intakeToken = row.intake_token;

  // Email was the single point of failure between a five-figure purchase and its
  // fulfilment. /commissioned now resolves the Stripe session and hands over the
  // intake link — and what it discloses is the INTAKE credential, not the document
  // one, so a session id in browser history is not a way to read the opinion.
  const commissioned = await (
    await fetch(`${SITE}/commissioned?session_id=${sid}`)
  ).text();
  ok("the post-payment page hands over the intake link, without waiting on email",
     commissioned.includes(`/intake/${row.intake_token}`),
     row.intake_token ? "intake link present" : "no intake token minted");
  ok("and does NOT disclose the document credential",
     Boolean(row.intake_token) && row.intake_token !== token && !commissioned.includes(token),
     "document token absent from the page");
  ok("the intake credential cannot read the document",
     (await fetch(`${SITE}/api/deliverable/${row.intake_token}`)).status === 404);


  // The seven numbers they typed into the FREE qualifier must follow them into
  // the thing they paid for. Re-typing them after the money is taken is where an
  // abandoned intake becomes revenue collected for a document nobody receives.
  const prefillOf = async (t) => (await (await fetch(`${SITE}/api/intake/${t}`)).json()).prefill ?? {};
  const pre = await prefillOf(intakeToken);
  ok("the intake is seeded from the qualification it was bought from",
     pre.contractedMW === "12" && pre.tapoffMaxA === "63" && pre.positionsAvailable === "180",
     `${Object.keys(pre).length} field(s) carried`);
  ok("every hall input of the read is carried, as the buyer typed it",
     pre.siteName === "North Hall" && pre.hallId === "H1" && pre.metro === "Dublin" && pre.platform === "gb300_nvl72"
       && pre.currentPeakMW === "7.4" && pre.currentItLoadMW === "4.9" && pre.buswayAmpacityA === "400" && pre.plantSupplyC === "6",
     Object.entries(pre).map(([k, v]) => `${k}=${v}`).join(" "));
  ok("and never carries the contact details of whoever ran it",
     !JSON.stringify(pre).includes("@"), "no contact details in the prefill");
  const preB = await prefillOf(rowB.intake_token);
  ok("the other hall's intake is seeded from ITS read, and neither carries a trace of the other",
     preB.siteName === "Other Hall" && preB.contractedMW === "20" && preB.metro === "Cork"
       && !JSON.stringify(preB).includes("North Hall") && !JSON.stringify(preB).includes("Dublin")
       && !JSON.stringify(pre).includes("Other Hall") && !JSON.stringify(pre).includes("Cork"));
  const stranger = await Promise.all(unattachedRows.map((r) => prefillOf(r.intake_token)));
  ok("a purchase that merely NAMED someone else's read (no matching token) gets an empty intake, not that hall's numbers",
     stranger.every((p) => Object.keys(p).length === 0), stranger.map((p) => Object.keys(p).length).join(","));

  ok("the intake page resolves for the buyer", (await fetch(`${SITE}/intake/${intakeToken}`)).status === 200);
  ok("and 404s for a token never issued", (await fetch(`${SITE}/intake/nope`)).status === 404);

  const gen = await fetch(`${SITE}/api/intake/${intakeToken}`, {
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
  ok("release refuses a document that is not the one that was reviewed",
     (await fetch(`${SITE}/api/admin/deliverables`, { method: "PATCH",
       headers: { "content-type": "application/json", cookie },
       body: JSON.stringify({ token, action: "release", reviewed_hash: "0".repeat(64), reviewed_by: "A. Reviewer" }) })).status === 409);
  ok("release refuses without a named reviewer",
     (await fetch(`${SITE}/api/admin/deliverables`, { method: "PATCH",
       headers: { "content-type": "application/json", cookie },
       body: JSON.stringify({ token, action: "release", reviewed_hash: "0".repeat(64) }) })).status === 422);
  ok("and is refused, with nothing released, while Stripe cannot say the payment still stands",
     (await release(token, cookie, false)).status === 503);
  ok("and succeeds with the hash of the draft that was read (the operator acknowledging the unchecked payment)",
     (await release(token, cookie)).status === 200);

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

  await release(thinRow.token, cookie);
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

  // --- the third thing the EUR 18,000 product promises -----------------------
  head("Procurement Specification — the bid comparison it has always promised");
  await hook(checkout("procurement_spec", {
    id: "cs_spec", amount_total: 1800000,
    metadata: { kind: "procurement_spec", company: "North Hall" },
  }));
  const specRow = (await (await sb(`deliverables?stripe_session_id=eq.cs_spec&select=*`)).json())[0];
  ok("the engagement opens", Boolean(specRow?.token));

  const specGen = await fetch(`${SITE}/api/intake/${specRow.intake_token}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(HALL),
  });
  ok("the specification generates", specGen.status === 200, `HTTP ${specGen.status}`);

  let specAfter = (await (await sb(`deliverables?token=eq.${specRow.token}&select=*`)).json())[0];
  const template = specAfter?.working_files?.["response_template.json"];
  ok("a machine-readable response schedule comes with it", Boolean(template));
  ok("and the relief it was written for is kept with the engagement",
     Boolean(specAfter?.intake?._gridforge?.spec?.constraint_id),
     specAfter?.intake?._gridforge?.spec?.constraint_id);

  // The customer cannot compare bids against a specification nobody has released.
  const early = await fetch(`${SITE}/api/deliverable/${specRow.token}/bids`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ responses: [{ supplier: "Alpha" }] }),
  });
  ok("bids are refused before the specification is released", early.status === 409);

  await release(specRow.token, cookie);

  // Three suppliers answer the schedule. The cheapest has the longest lead time.
  const tmpl = JSON.parse(template);
  const responses = [
    ["Alpha", 480000, 20],
    ["Beta", 392000, 44],
    ["Gamma", 455000, 26],
  ].map(([supplier, capex, lead]) => {
    const r = JSON.parse(JSON.stringify(tmpl));
    r.supplier = supplier;
    r.received_on = "2026-10-01";
    r.valid_until = "2099-12-31";
    r.values = { ...(r.values ?? {}), capex_eur: capex, lead_time_weeks: lead, install_weeks: 6 };
    r.compliance = Object.fromEntries(Object.keys(r.compliance ?? {}).map((k) => [k, "C"]));
    return r;
  });

  const cmp = await fetch(`${SITE}/api/deliverable/${specRow.token}/bids`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ responses }),
  });
  const cmpBody = await cmp.json();
  ok("the customer can compare the bids they collected", cmp.status === 200 && cmpBody.ok === true,
     `HTTP ${cmp.status} ${JSON.stringify(cmpBody).slice(0, 140)}`);
  ok("ranked against the capacity model", (cmpBody.ranked ?? []).length === 3,
     (cmpBody.ranked ?? []).map((r) => `${r.supplier} ${r.weeks_to_energised}wk`).join(", "));
  ok("in weeks as well as euros — the cheapest need not win",
     (cmpBody.ranked ?? []).every((r) => typeof r.weeks_to_energised === "number"),
     `leading: ${cmpBody.ranked?.[0]?.headline ?? "-"}`);
  ok("and it refuses to score what an engineer must",
     JSON.stringify(cmpBody).includes("scored by the engineer"));
  ok("the comparison is kept as a working file they can download",
     cmpBody.saved === true &&
       (await fetch(`${SITE}/api/deliverable/${specRow.token}?format=csv&file=bid_comparison.json`)).status === 200);

  // The route is only half the fix. The buyer is a procurement manager who has
  // just collected four filled-in schedules, not somebody who will POST JSON.
  const specPage = await (await fetch(`${SITE}/deliverable/${specRow.token}`)).text();
  // The button reads "Choose the completed schedules" until a comparison exists
  // and "Compare again" after, so accept either — what matters is that there is a
  // file input on the page and not an instruction to POST JSON.
  ok("the customer has somewhere on the page to put the supplier responses",
     specPage.includes("Compare the bids") &&
       /type="file"/.test(specPage) &&
       (specPage.includes("Choose the completed schedules") || specPage.includes("Compare again")),
     "file input present");
  ok("and reopening it shows the comparison already run, not an empty box",
     specPage.includes("Compare again") || specPage.includes("Alpha"),
     "prior comparison restored");

  ok("a Density Screen cannot be used for it",
     (await fetch(`${SITE}/api/deliverable/${token}/bids`, {
       method: "POST", headers: { "content-type": "application/json" },
       body: JSON.stringify({ responses }),
     })).status === 409);

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
    data: { object: { object: "checkout_session", payment_status: "paid", customer_email: "director@northhall.example",
      customer: "cus_int", subscription: "sub_int", amount_total: 199900,
      metadata: { kind: "intelligence_subscription", plan: "team" }, ...over } } });
  const bearer = { authorization: "Bearer tok:director@northhall.example" };
  const status = async () =>
    (await (await fetch(`${SITE}/api/subscription-status`, { method: "POST",
      headers: { "content-type": "application/json", ...bearer }, body: "{}" })).json());
  ok("a request naming the subscriber's email but carrying no verified identity is refused",
     (await fetch(`${SITE}/api/subscription-status`, { method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({ email: "director@northhall.example" }) })).status === 401);
  ok("not a subscriber before paying", (await status()).active === false);
  await sub({ id: "cs_int_1" });
  ok("entitled after paying", (await status()).active === true);
  const unconfirmed = await (await fetch(`${SITE}/api/subscription-status`, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer unconfirmed:director@northhall.example" }, body: "{}" })).json();
  ok("a session whose email was never confirmed is not shown the subscription", unconfirmed.active === false && unconfirmed.verified === false);
  await sub({ id: "cs_int_1" });
  ok("a redelivered event does not double-issue",
     (await (await sb(`subscriptions?email=eq.director%40northhall.example&status=eq.active&select=id`)).json()).length === 1);
  await hook({ id: "evt_int_del", type: "customer.subscription.deleted",
               data: { object: { id: "sub_int", object: "subscription" } } });
  ok("cancellation withdraws the entitlement", (await status()).active === false);
  ok("and the paid surface closes with it",
     (await fetch(`${SITE}/api/scenarios`, { headers: bearer })).status === 402);

  // --- item 4: negative paths ------------------------------------------------
  head("Negative paths — nothing is represented as paid, fulfilled or saved");
  const fault = (f) => fetch(`${PG}/__faults`, { method: "POST", body: JSON.stringify(f) });
  const clearFaults = () => fetch(`${PG}/__faults`, { method: "DELETE" });
  const countRows = async (q) => (await (await sb(q)).json()).length;
  /** A fresh Stripe-side session made by a real, valid checkout call (no reference), to pay or not pay below. */
  const freshSession = async () => {
    const n = ins.sessions().length;
    await checkoutAs({ product: "density_screen", company: "Negative Co" });
    return ins.sessions()[n];
  };
  const nothingFor = async (rec, who) =>
    (await rowsFor(rec.id)).length === 0 && ins.mailsTo(who).length === 0;

  // payment_status "unpaid": a delayed method that has completed checkout but not settled
  const sUnpaid = await freshSession();
  const unpaidWho = "unpaid@negative.example";
  const operatorMailsBefore = ins.mailsTo(OPERATOR).length;
  const commissionedBefore = await countRows("funnel_events?name=eq.engagement_commissioned&select=id");
  const unpaid = await hook(completedFor(sUnpaid, { payment_status: "unpaid", customer_email: unpaidWho }));
  ok("payment_status 'unpaid' is acknowledged (200) and says it fulfilled nothing",
     unpaid.status === 200 && JSON.parse(unpaid.body).fulfilled === false, unpaid.body);
  ok("no deliverable, no intake email, no operator notice, no funnel conversion",
     (await nothingFor(sUnpaid, unpaidWho)) && ins.mailsTo(OPERATOR).length === operatorMailsBefore
       && (await countRows("funnel_events?name=eq.engagement_commissioned&select=id")) === commissionedBefore);
  ok("an unpaid Intelligence checkout entitles nothing",
     await (async () => {
       const email = "unpaid-director@northhall.example";
       await hook({ id: "evt_int_unpaid", type: "checkout.session.completed", data: { object: { id: "cs_int_unpaid", object: "checkout_session",
         payment_status: "unpaid", customer_email: email, customer: "cus_iu", subscription: "sub_iu", amount_total: 199900,
         metadata: { kind: "intelligence_subscription", plan: "team" } } } });
       const st = await (await fetch(`${SITE}/api/subscription-status`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer tok:${email}` }, body: "{}" })).json();
       return (await countRows(`subscriptions?email=eq.${encodeURIComponent(email)}`)) === 0 && st.active === false;
     })());
  // ...and when the delayed payment does settle, THEN it is fulfilled, once.
  const settled = completedFor(sUnpaid, { customer_email: unpaidWho }, { eventType: "checkout.session.async_payment_succeeded", eventId: "evt_async_ok" });
  ok("the settled payment (async_payment_succeeded) then fulfils it, once however often it is delivered",
     (await hook(settled)).status === 200 && (await hook(settled)).status === 200 && (await rowsFor(sUnpaid.id)).length === 1 && ins.mailsTo(unpaidWho).length === 1);

  // an unrecognised payment_status is never read as money received
  const sUnknown = await freshSession();
  const unknown = await hook(completedFor(sUnknown, { payment_status: "requires_review", customer_email: "unknown@negative.example" }));
  ok("an unknown payment_status fulfils nothing and is acknowledged as not fulfilled",
     unknown.status === 200 && JSON.parse(unknown.body).fulfilled === false && (await nothingFor(sUnknown, "unknown@negative.example")));

  // a MISSING payment_status is malformed: refused with a 500 so Stripe redelivers, never read as paid and never acknowledged
  const sMissing = await freshSession();
  const missingWho = "missing@negative.example";
  const missing = await hook(completedFor(sMissing, { payment_status: undefined, customer_email: missingWho }));
  ok("a session with NO payment_status is refused with a 500 (Stripe redelivers), not read as paid and not acknowledged",
     missing.status === 500 && !/"ok":true/.test(missing.body), `HTTP ${missing.status}`);
  ok("and fulfils nothing: no deliverable, no email",
     await nothingFor(sMissing, missingWho));
  ok("redelivered with the status present, it is fulfilled once",
     (await hook(completedFor(sMissing, { customer_email: missingWho }))).status === 200 && (await rowsFor(sMissing.id)).length === 1 && ins.mailsTo(missingWho).length === 1);

  // signatures
  const sSig = await freshSession();
  const sigPayload = JSON.stringify(completedFor(sSig, { customer_email: "forged@negative.example" }));
  const postRaw = (headers, body) => fetch(`${SITE}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const badSig = await postRaw({ "stripe-signature": "t=1,v1=deadbeef" }, sigPayload);
  const noSig = await postRaw({}, sigPayload);
  const tampered = await postRaw({ "stripe-signature": signature(sigPayload) }, sigPayload.replace("450000", "1"));
  ok("an invalid, a missing and a tampered signature are all rejected (400)", [badSig.status, noSig.status, tampered.status].every((c) => c === 400),
     [badSig.status, noSig.status, tampered.status].join(","));
  ok("and nothing is fulfilled for any of them", await nothingFor(sSig, "forged@negative.example"));

  // the database fails during fulfilment: 500 for Stripe to retry, no half-state; the redelivery then fulfils once
  const sDb = await freshSession();
  const dbWho = "dbfail@negative.example";
  const notificationsBefore = await countRows("customer_notifications?select=id");
  await fault({ table: "deliverables", method: "POST", status: 500 });
  const dbDown = await hook(completedFor(sDb, { customer_email: dbWho }));
  await clearFaults();
  ok("the engagement cannot be written: the webhook answers 500 so Stripe redelivers", dbDown.status === 500, `HTTP ${dbDown.status}`);
  ok("and leaves no half-state: no deliverable, no email obligation, no email",
     (await nothingFor(sDb, dbWho)) && (await countRows("customer_notifications?select=id")) === notificationsBefore);
  ok("the redelivery, once the database is back, fulfils exactly once",
     (await hook(completedFor(sDb, { customer_email: dbWho }))).status === 200 && (await rowsFor(sDb.id)).length === 1 && ins.mailsTo(dbWho).length === 1);

  // the engagement is written but the email obligation cannot be recorded: the purchase is kept, Stripe is asked to retry, the email goes out once
  const sOutbox = await freshSession();
  const outboxWho = "outbox@negative.example";
  await fault({ table: "customer_notifications", method: "POST", status: 500 });
  const outboxDown = await hook(completedFor(sOutbox, { customer_email: outboxWho }));
  await clearFaults();
  ok("the intake email cannot be recorded: 500 so Stripe redelivers, the paid engagement is kept, nothing is claimed sent",
     outboxDown.status === 500 && (await rowsFor(sOutbox.id)).length === 1 && ins.mailsTo(outboxWho).length === 0, `HTTP ${outboxDown.status}`);
  ok("the redelivery sends the one email and opens no second engagement",
     (await hook(completedFor(sOutbox, { customer_email: outboxWho }))).status === 200 && (await rowsFor(sOutbox.id)).length === 1 && ins.mailsTo(outboxWho).length === 1);

  // the qualifier when the store cannot keep the read: the engine's answer is shown, but there is nothing to share or to join a purchase to
  const storedBefore = await countRows("qualifications?select=id");
  await fault({ table: "qualifications", method: "POST", status: 500 });
  const noStore = await readOf({ ...HALL, siteName: "Unsaved Hall" }, "198.51.100.230");
  ok("store cannot save the read: still the engine's real answer, but saved:false and NO reference (no id, no token, no share link)",
     noStore.ok === true && Boolean(noStore.result?.as_found?.binding_constraint) && noStore.saved === false
       && noStore.share === null && noStore.qualificationId === null && noStore.qualificationToken === null);
  await clearFaults();
  ok("and nothing was stored", (await countRows("qualifications?select=id")) === storedBefore);
  const unsavedBuy = await attempt("a purchase from that unsaved result is unattached (nothing to validate, nothing sent to Stripe)",
    { qualificationId: noStore.qualificationId ?? undefined, qualificationToken: noStore.qualificationToken ?? undefined }, "");
  ok("with no reference in the Stripe session at all", unsavedBuy.params.metadata.qualification_id === "");

  // --- the refusal site: no Stripe key, no engine ------------------------------
  head("A deployment with payments and the engine not configured");
  start("bare", "npx", ["next", "start", "-p", String(BARE_PORT)], { ...siteEnv, STRIPE_SECRET_KEY: "", GRIDFORGE_API_URL: "", GRIDFORGE_API_KEY: "", NEXT_PUBLIC_SITE_URL: BARE });
  await waitFor("bare", async () => (await fetch(BARE)).ok);
  const sessionsBefore = ins.sessions().length;
  const bareCheckout = await checkoutAs({ product: "density_screen", qualificationId: qualId, qualificationToken: shareToken }, BARE);
  ok("payments not configured: checkout is refused with the honest error (503) and creates no Stripe session",
     bareCheckout.status === 503 && bareCheckout.body.ok === false && bareCheckout.body.error === "Payments not configured" && ins.sessions().length === sessionsBefore,
     `HTTP ${bareCheckout.status} ${bareCheckout.body.error}`);
  const bareQualify = await fetch(`${BARE}/api/qualify`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.231" }, body: JSON.stringify(HALL) });
  const bareQ = await bareQualify.json();
  ok("engine not configured: the qualifier refuses (503) with no result and no reference",
     bareQualify.status === 503 && bareQ.ok === false && bareQ.reason === "unconfigured" && !bareQ.result && !bareQ.share && !bareQ.qualificationId && !bareQ.qualificationToken,
     `HTTP ${bareQualify.status} ${String(bareQ.error).slice(0, 70)}`);

  // --- the engine goes away ---------------------------------------------------------
  head("The engine is down");
  try { process.kill(-engineChild.pid, "SIGTERM"); } catch { engineChild.kill("SIGTERM"); }
  await waitFor("engine to stop", async () => { try { await fetch(`${ENGINE}/health`); return false; } catch { return true; } }, 40);
  const engRowsBefore = await countRows("qualifications?status=eq.engine_unavailable&select=id");
  const down = await fetch(`${SITE}/api/qualify`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.232" }, body: JSON.stringify({ ...HALL, siteName: "Engine-down Hall" }) });
  const downBody = await down.json();
  ok("engine down: 502, no invented result, no id, no token, no share link",
     down.status === 502 && downBody.ok === false && downBody.reason === "unreachable" && !downBody.result && !downBody.share && !downBody.qualificationId && !downBody.qualificationToken,
     `HTTP ${down.status}`);
  ok("it says plainly that no result was produced and that the figures were saved (they were)",
     /no result was produced/i.test(downBody.error) && downBody.saved === true && /saved/i.test(downBody.error) && !/NOT saved/.test(downBody.error));
  ok("and the saved figures are marked engine_unavailable, never scored",
     (await countRows("qualifications?status=eq.engine_unavailable&select=id")) === engRowsBefore + 1
       && (await countRows("qualifications?status=eq.scored&inputs->>siteName=eq.Engine-down%20Hall&select=id")) === 0);
  await fault({ table: "qualifications", method: "POST", status: 500 });
  const downNoStore = await fetch(`${SITE}/api/qualify`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.233" }, body: JSON.stringify(HALL) });
  const downNoStoreBody = await downNoStore.json();
  await clearFaults();
  ok("engine AND store down: 502, and the message does not pretend the figures were kept",
     downNoStore.status === 502 && downNoStoreBody.saved === false && /NOT saved/.test(downNoStoreBody.error) && !downNoStoreBody.qualificationId && !downNoStoreBody.share);
  ok("the only Stripe request the stand-in did not model is the release gate's session lookup (so nothing else reached for Stripe)",
     ins.state.unhandled.every((u) => /^GET \/v1\/checkout\/sessions\//.test(u)), [...new Set(ins.state.unhandled)].join(", ") || "no unmodelled Stripe call");
}

try {
  await main();
} catch (err) {
  failures++;
  console.error("\n  ERROR ", err instanceof Error ? err.message : err);
  for (const name of ["site", "bare", "engine", "postgrest"]) if (logs.has(name)) console.error(`  ${name} said:${say(name)}`);
} finally {
  stopAll();
  await ins?.close();
}

head("Result");
console.log(`  ${checks - failures}/${checks} passed`);
if (failures && process.env.E2E_LOGS) {
  for (const name of ["site", "bare", "engine", "postgrest"]) if (logs.has(name)) console.error(`  ${name} said:${say(name)}`);
}
process.exit(failures ? 1 : 0);
