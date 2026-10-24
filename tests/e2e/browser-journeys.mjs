#!/usr/bin/env node
/**
 * Rendered-browser acceptance: the production build, driven in Chromium at phone, tablet and laptop
 * widths. Source inspection cannot see an overflowing layout, an unlabelled control, or a form that
 * claims success on failure; this does.
 *
 *   npm run build && node tests/e2e/browser-journeys.mjs
 *
 * MANUAL: no CI job runs this file (Playwright is not a dependency of the project, and CI installs none), so its claims are checked
 * only when someone runs it; `npm run verify:local` is the automated gate. Do not read a green CI run as proof of these journeys.
 *
 * Playwright is not a project dependency. Point PLAYWRIGHT_MODULE at an install (default
 * /opt/node-tools/node_modules/playwright) and CHROMIUM at a browser (default /opt/pw-browsers/chromium).
 * The server runs with no Supabase, Stripe or engine configured, so every journey below also proves the
 * UNCONFIGURED path is honest: no false success, no spinner that never ends.
 *
 * Then the PURCHASE journeys run against a configured stack (the real capacity engine, a PostgREST stand-in built from the
 * migrations, a Stripe stand-in that records the Checkout Session it is asked for): qualify in the browser, see the result and the
 * Density Screen CTA, press it, and stop where Stripe's hosted page would begin. They prove the page asks checkout for the right
 * thing and that the browser follows the URL checkout returns. They do NOT prove a purchase: the "hosted page" is a local stand-in
 * that takes no card. A deployment with payments unconfigured is reported as a refused checkout, never as a purchase.
 * Exit codes: 0 all passed, 1 a journey failed, 2 the browser part could not run (nothing was driven).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStandIns } from "./stand-ins.mjs";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright"));
} catch (err) {
  // Not a pass: nothing was driven. The exit code says so (2), so a wrapper that only checks for 0 cannot mistake it for green.
  console.error(`browser journeys NOT RUN: Playwright could not be loaded (${err instanceof Error ? err.message.split("\n")[0] : err}). Set PLAYWRIGHT_MODULE.`);
  process.exit(2);
}
const PORT = Number(process.env.E2E_PORT || 3917);
const BASE = `http://127.0.0.1:${PORT}`;
const WIDTHS = [375, 768, 1280];
const PAGES = ["/", "/pricing", "/qualify", "/developers", "/platforms", "/power/deploy", "/intelligence",
  "/reference", "/workspace", "/constraints", "/legal/terms", "/account/login"];

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);

// detached = its own process group, so the whole group can be signalled: killing only the `npx` wrapper leaves next-server
// holding the port and breaks the next run.
const server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore", detached: true, env: { ...process.env, NODE_ENV: "production" } });
async function up() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("next start did not come up");
}

function benign(text) {
  // an unconfigured backend is expected to answer 5xx/4xx on the data calls; the UI's reaction is what is tested
  return /Failed to load resource|status of (4|5)\d\d/.test(text);
}


// --- the configured stack the purchase journeys run against ---------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PURCHASE_PORTS = {
  pg: Number(process.env.E2E_BROWSER_PG_PORT || 54339),
  engine: Number(process.env.E2E_BROWSER_ENGINE_PORT || 8099),
  site: Number(process.env.E2E_BROWSER_SITE_PORT || 3918),
  off: Number(process.env.E2E_BROWSER_OFF_PORT || 3919),
};
const WH_SECRET = "whsec_browser_journeys_secret";

async function startPurchaseStack() {
  const procs = [];
  const group = (cmd, args, env = {}) => {
    const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "ignore", detached: true });
    procs.push(c);
    return c;
  };
  const kill = (c) => { try { process.kill(-c.pid, "SIGTERM"); } catch { try { c.kill("SIGTERM"); } catch { /* gone */ } } };
  const until = async (label, probe) => {
    for (let i = 0; i < 120; i++) {
      try { if (await probe()) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${label} did not come up`);
  };
  const pg = `http://127.0.0.1:${PURCHASE_PORTS.pg}`;
  const engineUrl = `http://127.0.0.1:${PURCHASE_PORTS.engine}`;
  const site = `http://127.0.0.1:${PURCHASE_PORTS.site}`;
  const paymentsOff = `http://127.0.0.1:${PURCHASE_PORTS.off}`;
  const ins = await startStandIns();
  const stop = async () => { for (const c of procs) kill(c); await ins.close(); };
  try {
    group("node", [path.join("tests", "e2e", "postgrest-stub.mjs"), "supabase/migrations", String(PURCHASE_PORTS.pg)]);
    await until("postgrest", async () => (await fetch(`${pg}/rest/v1/leads?select=*&limit=1`)).ok);
    const engine = group(process.env.E2E_PYTHON || "python3", ["-m", "gridforge", "serve", "--port", String(PURCHASE_PORTS.engine)], {
      GRIDFORGE_API_KEYS: "browser-journeys-engine-key", GRIDFORGE_RATE_LIMIT: "100000",
    });
    await until("engine", async () => (await fetch(`${engineUrl}/health`)).ok);
    const env = (base) => ({
      SUPABASE_URL: pg, NEXT_PUBLIC_SUPABASE_URL: pg, NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anon", SUPABASE_SERVICE_ROLE_KEY: "local-verify",
      GRIDFORGE_API_URL: engineUrl, GRIDFORGE_API_KEY: "browser-journeys-engine-key", GRIDFORGE_KEY_SECRET: "browser-journeys-signing-secret",
      STRIPE_SECRET_KEY: "sk_test_browser_journeys", STRIPE_WEBHOOK_SECRET: WH_SECRET, ADMIN_PASSWORD: "browser-journeys-admin", CRON_SECRET: "browser-journeys-cron",
      NEXT_PUBLIC_SITE_URL: base, RESEND_API_KEY: "re_test_browser_journeys", LEAD_FROM_EMAIL: "Time to Power <ops@gridforge.test>",
      LEAD_TO_EMAIL: "operator@gridforge.test", E2E_STANDIN: ins.target,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${path.join(ROOT, "tests", "e2e", "redirect-outbound.cjs")}`.trim(),
      GRIDFORGE_TRUSTED_IP_HEADER: "x-forwarded-for", RATE_LIMIT_HMAC_KEY: "browser-journeys-rate-limit-key-0123456789abcdef", NODE_ENV: "production",
    });
    group("npx", ["next", "start", "-p", String(PURCHASE_PORTS.site)], env(site));
    // The same stack with the payment key absent: the deployment that must refuse a checkout rather than pretend.
    group("npx", ["next", "start", "-p", String(PURCHASE_PORTS.off)], { ...env(paymentsOff), STRIPE_SECRET_KEY: "" });
    await until("site", async () => (await fetch(site)).ok);
    await until("site (payments off)", async () => (await fetch(paymentsOff)).ok);

    /** Deliver a paid checkout.session.completed for a session the stand-in made, signed here (Stripe is not involved). */
    const recordPaidAndGetIntakeToken = async (made) => {
      const event = {
        id: `evt_${made.id}`, type: "checkout.session.completed",
        data: { object: { id: made.id, object: "checkout_session", payment_status: "paid", customer_email: "buyer@browser.example", customer: "cus_browser",
          amount_total: Number(made.params.line_items[0].price_data.unit_amount), metadata: made.params.metadata } },
      };
      const payload = JSON.stringify(event);
      const t = Math.floor(Date.now() / 1000);
      const v1 = crypto.createHmac("sha256", WH_SECRET).update(`${t}.${payload}`).digest("hex");
      const res = await fetch(`${site}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${v1}`, "content-type": "application/json", "x-forwarded-for": "198.51.100.51" }, body: payload });
      if (res.status !== 200) return null;
      const rows = await (await fetch(`${pg}/rest/v1/deliverables?stripe_session_id=eq.${made.id}&select=intake_token`, { headers: { apikey: "local-verify" } })).json();
      return rows[0]?.intake_token ?? null;
    };
    const stopEngine = async () => {
      kill(engine);
      await until("engine to stop", async () => { try { await fetch(`${engineUrl}/health`); return false; } catch { return true; } });
    };
    return { site, paymentsOff, pg, ins, recordPaidAndGetIntakeToken, stopEngine, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

try {
  await up();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

  for (const w of WIDTHS) {
    for (const p of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 800 } });
      const page = await ctx.newPage();
      const errs = [];
      page.on("console", (m) => { if (m.type() === "error" && !benign(m.text())) errs.push(m.text().slice(0, 160)); });
      page.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 160)));
      const res = await page.goto(BASE + p, { waitUntil: "networkidle" });
      const where = `${p}@${w}`;
      if (!res || res.status() !== 200) fail(where, `status ${res && res.status()}`);
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(where, "horizontal overflow");
      const unnamed = await page.evaluate(() => [...document.querySelectorAll("input:not([type=hidden]),select,textarea")].filter((el) => {
        if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return false;
        if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
        return !el.closest("label");
      }).length);
      if (unnamed) fail(where, `${unnamed} form control(s) with no accessible name`);
      const nameless = await page.evaluate(() => [...document.querySelectorAll("button,a[href]")].filter((el) =>
        !(el.textContent || "").trim() && !el.getAttribute("aria-label") && !el.querySelector("img[alt]:not([alt=''])")).length);
      if (nameless) fail(where, `${nameless} button/link(s) with no accessible name`);
      const h1 = await page.locator("h1").count();
      if (h1 !== 1) fail(where, `${h1} h1 elements`);
      if (errs.length) fail(where, "console: " + errs.join(" | "));
      await ctx.close();
    }
  }

  // Journey: the qualifier must not claim "saved" when nothing was stored.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + "/qualify", { waitUntil: "networkidle" });
    const submit = page.getByRole("button", { name: /find the binding constraint/i });
    await submit.click();
    await page.waitForTimeout(2500);
    const body = (await page.locator("body").innerText()).toLowerCase();
    if (/figures were saved|we will come back/.test(body)) fail("qualify journey", "claims saved/follow-up while nothing was persisted");
    await ctx.close();
  }

  // Journey: login with no auth configured shows an error rather than spinning for ever.
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + "/account/login", { waitUntil: "networkidle" });
    await page.getByLabel(/email/i).fill("someone@example.com");
    await page.getByRole("button", { name: /sign-in link|email me/i }).click();
    await page.waitForTimeout(1500);
    const stuck = await page.getByRole("button", { name: /sign-in link|email me/i }).isDisabled();
    if (stuck) fail("login journey", "button still disabled after the failure (spinner never ends)");
    await ctx.close();
  }

  // Journey: workspace chat failure is reported to the user.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + "/workspace", { waitUntil: "networkidle" });
    const box = page.getByRole("textbox").first();
    await box.fill("hello");
    await box.press("Enter");
    await page.waitForTimeout(2000);
    const text = (await page.locator("body").innerText()).toLowerCase();
    if (!/unavailable|try again|not configured|could not|error/.test(text)) fail("workspace journey", "chat failure produced no visible message");
    await ctx.close();
  }

  // Journey: the free-allowance form (no card, email only) on a deployment whose engine is not configured says so BEFORE anyone types:
  // the button is disabled and the notice points at what works now. It never claims a link was sent, at phone width.
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + "/developers", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const field = page.getByLabel(/email/i).first();
    await field.fill("someone@example.com");
    const submit = field.locator("xpath=ancestor::form//button[@type='submit']");
    if (!(await submit.isDisabled())) fail("free allowance journey", "the button is enabled although free keys are not open on this deployment");
    const body = (await page.locator("body").innerText()).toLowerCase();
    if (!/free developer keys are not open on this deployment yet/.test(body)) fail("free allowance journey", "no honest 'not open yet' notice");
    if (/check your email|we have sent|link is on its way/.test(body)) fail("free allowance journey", "claims an email was sent although nothing was");
    await ctx.close();
  }

  // Journey: the cost estimator answers from the published registry with no network, for a one-hall and a many-hall request.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + "/developers", { waitUntil: "networkidle" });
    const op = page.getByLabel(/operation/i).first();
    const text = async () => (await page.locator("body").innerText());
    const options = await op.locator("option").allTextContents();
    if (options.length < 3) fail("estimator journey", `only ${options.length} operations offered`);
    const portfolio = options.find((o) => /portfolio/i.test(o));
    if (!portfolio) fail("estimator journey", "no portfolio operation");
    else {
      await op.selectOption({ label: portfolio });
      const halls = page.getByLabel(/halls in one request/i).first();
      await halls.fill("10");
      await page.waitForTimeout(300);
      if (!/€\s?20\b|20\.00/.test(await text())) fail("estimator journey", "10 halls at 1 unit each should price at EUR 20 (10 units x EUR 2)");
    }
    await ctx.close();
  }

  // Journey: an unknown portal token is a not-found page, not a crash and not an empty account.
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const page = await ctx.newPage();
    const res = await page.goto(BASE + "/api-access/not-a-real-token", { waitUntil: "networkidle" });
    if (!res || res.status() !== 404) fail("portal journey", `unknown token answered ${res && res.status()}`);
    await ctx.close();
  }

  // Journey: pricing states the billing rule and the free path before any paid one.
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + "/pricing", { waitUntil: "networkidle" });
    const t = (await page.locator("body").innerText()).toLowerCase();
    if (!/in arrears/.test(t)) fail("pricing journey", "billing in arrears is not stated");
    if (!/free/.test(t) || !/no card|without a card|no payment card/.test(t)) fail("pricing journey", "the no-card free path is not stated");
    if (/unlimited re-run|named engineer|priority on new/.test(t)) fail("pricing journey", "an unbuilt promise is advertised");
    await ctx.close();
  }

  // Keyboard: the primary CTA on the home page is reachable by Tab and shows a focus ring.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + "/pricing", { waitUntil: "networkidle" });
    let ringed = false;
    for (let i = 0; i < 40 && !ringed; i++) {
      await page.keyboard.press("Tab");
      ringed = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return false;
        const s = getComputedStyle(el);
        return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== "none";
      });
    }
    if (!ringed) fail("pricing keyboard", "no focus indicator reached by Tab");
    await ctx.close();
  }


  // ---------------------------------------------------------------------------------------------------------------------------
  // Purchase journey: qualifier -> result and CTA -> checkout request -> redirect to the Stripe-hosted page (a local stand-in).
  //
  // WHAT THIS IS: the browser, the production build, the real capacity engine, a PostgREST stand-in built from the migrations, and a
  // Stripe stand-in that records the Checkout Session it was asked to create. It proves the page asks checkout for the right
  // thing (the read's id AND its token) and that the browser is sent to the URL checkout returned.
  // WHAT THIS IS NOT: a purchase. The stand-in's /pay/ page takes no card and no money; nothing here shows that Stripe's hosted page
  // works, that a card can be charged, or that Stripe will call the webhook. The webhook below is signed by this script, not sent
  // by Stripe, and only exists to show what the buyer's intake page looks like once a paid event has been recorded.
  // ---------------------------------------------------------------------------------------------------------------------------
  const stack = await startPurchaseStack();
  try {
    const gridHeaders = { "x-forwarded-for": "198.51.100.50" };
    const newPage = async (base, width = 1280) => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: gridHeaders });
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 160)));
      await page.goto(base + "/qualify", { waitUntil: "networkidle" });
      return { ctx, page, errs };
    };
    const HALL = { contractedMW: "14", currentPeakMW: "8.2", currentItLoadMW: "5.1", buswayAmpacityA: "400", tapoffMaxA: "63", plantSupplyC: "6", positionsAvailable: "150" };
    /** Fill the form with a distinctive hall, submit, and return what /api/qualify answered. */
    const qualifyInBrowser = async (page, siteName) => {
      for (const [k, v] of Object.entries(HALL)) await page.locator(`#qualify-${k}`).fill(v);
      await page.locator("#qualify-site").fill(siteName);
      await page.locator("#qualify-metro").fill("Galway");
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/api/qualify") && r.request().method() === "POST"),
        page.getByRole("button", { name: /find the binding constraint/i }).click(),
      ]);
      return { status: res.status(), body: await res.json().catch(() => ({})) };
    };
    const cta = (page) => page.getByRole("button", { name: /Commission the Density Screen/i });

    // 1. The happy path up to the Stripe boundary, at laptop width.
    {
      const { ctx, page, errs } = await newPage(stack.site);
      const q = await qualifyInBrowser(page, "Browser Hall");
      if (q.status !== 200 || q.body.ok !== true) fail("purchase journey", `qualify answered ${q.status} ${JSON.stringify(q.body).slice(0, 120)}`);
      else {
        if (!/^[0-9a-f-]{36}$/.test(String(q.body.qualificationId)) || typeof q.body.qualificationToken !== "string" || q.body.saved !== true) {
          fail("purchase journey", "the persisted read did not come back with both its id and its token");
        }
        await cta(page).waitFor({ state: "visible", timeout: 10_000 }).catch(() => fail("purchase journey", "the Density Screen CTA is not shown with the result"));
        const text = await page.locator("body").innerText();
        if (!q.body.headline || !text.includes(q.body.headline)) fail("purchase journey", "the result does not show the engine's headline");
        if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail("purchase journey", "horizontal overflow on the result");
        const before = stack.ins.sessions().length;
        const [req] = await Promise.all([
          page.waitForRequest((r) => r.url().endsWith("/api/checkout") && r.method() === "POST"),
          cta(page).click(),
        ]);
        const sent = JSON.parse(req.postData() || "{}");
        if (sent.product !== "density_screen") fail("purchase journey", `checkout was asked for ${sent.product}`);
        if (sent.qualificationId !== q.body.qualificationId || sent.qualificationToken !== q.body.qualificationToken) {
          fail("purchase journey", "the CTA did not send the read's id and token to checkout");
        }
        await page.waitForURL((u) => u.href.startsWith(stack.ins.base + "/pay/"), { timeout: 15_000 }).catch(() => fail("purchase journey", `the browser was not sent to the Stripe URL checkout returned (at ${page.url()})`));
        const made = stack.ins.sessions()[before];
        if (!made) fail("purchase journey", "no Checkout Session was created for the click");
        else {
          if (made.params.metadata?.qualification_id !== q.body.qualificationId) fail("purchase journey", "the Stripe session does not carry the validated qualification id");
          if (JSON.stringify(made.params).includes(q.body.qualificationToken)) fail("purchase journey", "the q-token reached Stripe");
          if (page.url() !== made.session.url) fail("purchase journey", `redirected to ${page.url()}, checkout returned ${made.session.url}`);
          const landed = await page.locator("body").innerText();
          if (!/Stripe Checkout stand-in/.test(landed) || !/No card is taken/.test(landed)) fail("purchase journey", "did not land on the stand-in's hosted page");

          // The buyer's side of a paid event, signed by this script: the intake page opens seeded from the read typed above.
          const intakeToken = await stack.recordPaidAndGetIntakeToken(made);
          if (!intakeToken) fail("purchase journey", "the (script-signed) paid event did not open an engagement");
          else {
            const intake = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: gridHeaders });
            const ip = await intake.newPage();
            await ip.goto(`${stack.site}/intake/${intakeToken}`, { waitUntil: "networkidle" });
            await ip.getByTestId("carried-over").waitFor({ timeout: 10_000 }).catch(() => fail("purchase journey", "the intake does not say numbers were carried over"));
            const val = (label) => ip.locator(`label:has-text("${label}") input`).first().inputValue().catch(() => "");
            const got = { contracted: await val("Contracted · MW"), peak: await val("Current site peak"), positions: await val("Rack positions available"), site: await val("Site name"), metro: await val("Metro") };
            if (got.contracted !== "14" || got.peak !== "8.2" || got.positions !== "150" || got.site !== "Browser Hall" || got.metro !== "Galway") {
              fail("purchase journey", `the intake was not seeded from the read: ${JSON.stringify(got)}`);
            }
            await intake.close();
          }
        }
      }
      if (errs.length) fail("purchase journey", errs.join(" | "));
      await ctx.close();
    }

    // 2. The same CTA at phone width: reachable, and the checkout request is the same.
    {
      const { ctx, page } = await newPage(stack.site, 375);
      const q = await qualifyInBrowser(page, "Phone Hall");
      if (q.body.ok !== true) fail("purchase journey (phone)", "no result");
      else {
        await cta(page).scrollIntoViewIfNeeded();
        const box = await cta(page).boundingBox();
        if (!box || box.x < 0 || box.x + box.width > 376) fail("purchase journey (phone)", "the CTA does not fit the phone viewport");
        if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail("purchase journey (phone)", "horizontal overflow");
      }
      await ctx.close();
    }

    // 3. Payments not configured: the buyer is told checkout is not live. It is reported as a refused checkout, never as a purchase.
    {
      const { ctx, page } = await newPage(stack.paymentsOff);
      const q = await qualifyInBrowser(page, "Refused Hall");
      if (q.body.ok !== true) fail("checkout refused journey", "no result to commission");
      else {
        const before = stack.ins.sessions().length;
        const [res] = await Promise.all([
          page.waitForResponse((r) => r.url().endsWith("/api/checkout") && r.request().method() === "POST"),
          cta(page).click(),
        ]);
        const body = await res.json().catch(() => ({}));
        await page.waitForTimeout(800);
        const alert = await page.getByRole("alert").allInnerTexts();
        const text = (await page.locator("body").innerText()).toLowerCase();
        if (res.status() !== 503 || body.error !== "Payments not configured") fail("checkout refused journey", `checkout answered ${res.status()} ${JSON.stringify(body)}`);
        if (!alert.some((a) => /not live on this deployment/i.test(a))) fail("checkout refused journey", `no honest refusal shown: ${JSON.stringify(alert)}`);
        if (/payment received|thank you|order confirmed|commissioned|purchase complete/.test(text)) fail("checkout refused journey", "the page speaks of a purchase");
        if (page.url().startsWith(stack.ins.base)) fail("checkout refused journey", "the browser left for a payment page although checkout was refused");
        if (stack.ins.sessions().length !== before) fail("checkout refused journey", "a Stripe session was created although payments are not configured");
        if (await cta(page).isDisabled()) fail("checkout refused journey", "the button stays disabled after the refusal (spinner never ends)");
      }
      await ctx.close();
    }

    // 4. The store cannot keep the read: the result is still shown, but the CTA carries no reference to Stripe.
    {
      const { ctx, page } = await newPage(stack.site);
      await fetch(`${stack.pg}/__faults`, { method: "POST", body: JSON.stringify({ table: "qualifications", method: "POST", status: 500 }) });
      const q = await qualifyInBrowser(page, "Unsaved Hall");
      await fetch(`${stack.pg}/__faults`, { method: "DELETE" });
      if (q.body.ok !== true || q.body.saved !== false || q.body.qualificationId !== null || q.body.share !== null) fail("unsaved read journey", `unexpected answer ${JSON.stringify({ ok: q.body.ok, saved: q.body.saved, id: q.body.qualificationId, share: q.body.share })}`);
      else {
        if (await page.locator('a[href^="/q/"]').count()) fail("unsaved read journey", "a share link is offered for a read that was not saved");
        const before = stack.ins.sessions().length;
        const [req] = await Promise.all([page.waitForRequest((r) => r.url().endsWith("/api/checkout")), cta(page).click()]);
        const sent = JSON.parse(req.postData() || "{}");
        if (sent.qualificationId || sent.qualificationToken) fail("unsaved read journey", "the CTA invented a reference");
        await page.waitForURL((u) => u.href.startsWith(stack.ins.base + "/pay/"), { timeout: 15_000 }).catch(() => fail("unsaved read journey", "no redirect"));
        if (stack.ins.sessions()[before]?.params.metadata?.qualification_id !== "") fail("unsaved read journey", "Stripe was given a qualification id for a read that was never saved");
      }
      await ctx.close();
    }

    // 5. The engine goes away: an honest error, no result, no CTA, nothing invented.
    {
      const { ctx, page } = await newPage(stack.site);
      await stack.stopEngine();
      const q = await qualifyInBrowser(page, "Engine-down Hall");
      const alert = (await page.getByRole("alert").allInnerTexts()).join(" ");
      if (q.status < 500 || q.body.ok !== false) fail("engine down journey", `qualify answered ${q.status}`);
      if (!/could not be reached|no result/i.test(alert)) fail("engine down journey", `no honest error shown: ${JSON.stringify(alert)}`);
      if (await cta(page).count()) fail("engine down journey", "a Commission button is offered with no result");
      if (/binding constraint:|racks today/i.test(await page.locator("body").innerText())) fail("engine down journey", "a result is shown although the engine produced none");
      await ctx.close();
    }
  } finally {
    await stack.stop();
  }

  await browser.close();
} finally {
  try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
}

if (failures.length) {
  console.error(`browser journeys: ${failures.length} failure(s)`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`browser journeys: ${PAGES.length * WIDTHS.length} page renders, 8 unconfigured-deployment journeys and 5 purchase journeys (happy path to the Stripe boundary, phone width, checkout refused, unsaved read, engine down) passed`);
