#!/usr/bin/env node
/**
 * Rendered-browser acceptance for the evidence-confirmation workflow: a buyer of a Density Screen opens their intake link, attaches a
 * PDF, confirms a figure from it, submits, and the document the REAL capacity engine generates names the file.
 *
 *   node tests/e2e/evidence-journey.mjs            (uses `next dev`; set E2E_NEXT=start after `npm run build` to use the production server)
 *
 * MANUAL, like tests/e2e/browser-journeys.mjs: no CI job runs it (Playwright is not a project dependency). The database is the local
 * PostgREST stand-in built from the migrations and the object store is in memory; the engine is the real one. Nothing here talks to
 * Supabase, Stripe or any outside service. Exit codes: 0 passed, 1 a check failed, 2 the browser part could not run.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright"));
} catch (err) {
  console.error(`evidence journey NOT RUN: Playwright could not be loaded (${String(err).split("\n")[0]}). Set PLAYWRIGHT_MODULE.`);
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const P = { pg: Number(process.env.E2E_EV_PG || 54349), engine: Number(process.env.E2E_EV_ENGINE || 8109), site: Number(process.env.E2E_EV_SITE || 3928) };
const pg = `http://127.0.0.1:${P.pg}`, engineUrl = `http://127.0.0.1:${P.engine}`, site = `http://127.0.0.1:${P.site}`;
const TOKEN = "ev-journey-intake-token";
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };

const procs = [];
const group = (cmd, args, env = {}) => { const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore", detached: true }); procs.push(c); return c; };
const stop = () => { for (const c of procs) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } } };
const until = async (label, probe, tries = 240) => { for (let i = 0; i < tries; i++) { try { if (await probe()) return; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error(`${label} did not come up`); };
const rows = async (q) => (await fetch(`${pg}/rest/v1/${q}`, { headers: { apikey: "local" } })).json();

let browser;
try {
  group("node", [path.join("tests", "e2e", "postgrest-stub.mjs"), "supabase/migrations", String(P.pg)]);
  await until("postgrest", async () => (await fetch(`${pg}/rest/v1/leads?select=*&limit=1`)).ok);
  group(process.env.E2E_PYTHON || "python3", ["-m", "gridforge", "serve", "--port", String(P.engine)], { GRIDFORGE_API_KEYS: "ev-engine-key", GRIDFORGE_RATE_LIMIT: "100000" });
  await until("engine", async () => (await fetch(`${engineUrl}/health`)).ok);
  const prod = process.env.E2E_NEXT === "start";
  group("npx", ["next", prod ? "start" : "dev", "-p", String(P.site)], {
    SUPABASE_URL: pg, NEXT_PUBLIC_SUPABASE_URL: pg, NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anon", SUPABASE_SERVICE_ROLE_KEY: "local-verify",
    GRIDFORGE_API_URL: engineUrl, GRIDFORGE_API_KEY: "ev-engine-key", GRIDFORGE_KEY_SECRET: "ev-signing-secret", ADMIN_PASSWORD: "ev-admin",
    NEXT_PUBLIC_SITE_URL: site, GRIDFORGE_TRUSTED_IP_HEADER: "x-forwarded-for", RATE_LIMIT_HMAC_KEY: "ev-rate-limit-key-0123456789abcdef0123456789",
    NODE_ENV: prod ? "production" : "development", NEXT_TELEMETRY_DISABLED: "1",
  });
  await until("site", async () => (await fetch(site + "/")).ok, 480);

  // An engagement the way the webhook leaves it: paid, taking its intake.
  const seeded = await fetch(`${pg}/rest/v1/deliverables`, { method: "POST", headers: { "content-type": "application/json", apikey: "local", prefer: "return=representation" },
    body: JSON.stringify({ token: TOKEN, intake_token: TOKEN, kind: "density_screen", status: "awaiting_intake", email: "buyer@browser.example", company: "Journey Hall", stripe_session_id: "cs_ev_journey" }) });
  check(seeded.ok, "an engagement is open for intake");

  browser = await chromium.launch({ args: ["--no-sandbox"] });
  for (const width of [375, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${width % 200}` } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${site}/intake/${TOKEN}`, { waitUntil: "networkidle" });
    const panel = page.getByTestId("intake-evidence");
    await panel.waitFor({ timeout: 20_000 });
    check(true, `[${width}px] the evidence panel renders for a Density Screen`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `[${width}px] no horizontal overflow`);
    check((await panel.innerText()).includes("We do not read your file"), `[${width}px] the panel says plainly that the file is not read`);

    if (width === 375) { await ctx.close(); continue; }

    // Before any file: nothing to confirm from.
    check((await panel.innerText()).includes("Attach"), "with no document the fields say what to attach");
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    await panel.locator('input[type="file"]').setInputFiles({ name: "dso_agreement.pdf", mimeType: "application/pdf", buffer: pdf });
    await page.getByText("dso_agreement.pdf", { exact: false }).first().waitFor({ timeout: 15_000 });
    check(true, "the PDF attaches and is listed");

    const firm = panel.locator("div.rounded.border", { hasText: "Firm connection capacity" }).last();
    await firm.getByLabel("Where in it").fill("clause 4.2");
    await firm.getByLabel(/Value/).fill("31");
    await firm.getByRole("button", { name: "Confirm" }).click();
    await panel.getByText("31 MVA — dso_agreement.pdf, clause 4.2").waitFor({ timeout: 15_000 });
    check(true, "the figure is confirmed from the file, with its place in it");
    check(await page.locator('input[type="number"]').nth(0).evaluate(() => true), "(form still present)");
    check(await page.getByLabel(/Firm connection · MVA/).isDisabled(), "the typed firm-capacity field is disabled once it is confirmed");
    check(!(await page.getByTestId("will-assume").innerText()).includes("DSO connection agreement"), "a confirmed figure is no longer listed among the assumptions");

    // Reload: the confirmation is the server's, not the page's.
    await page.reload({ waitUntil: "networkidle" });
    await page.getByTestId("intake-evidence").getByText("31 MVA — dso_agreement.pdf, clause 4.2").waitFor({ timeout: 15_000 });
    check(true, "after a reload the confirmation is still there");

    // The rest of a Density Screen's intake.
    const fill = async (label, v) => page.getByLabel(label, { exact: false }).first().fill(v);
    await fill("Site name", "Journey Hall"); await fill("Hall id", "H1");
    await fill("Contracted", "12"); await fill("Current site peak", "7.4"); await fill("Current IT load", "4.9");
    await fill("Supply temperature", "6"); await fill("Busway ampacity", "400"); await fill("Tap-off", "63"); await fill("Positions available", "180");
    await page.getByRole("button", { name: /Submit the hall/ }).click();
    try {
      await page.getByText("Received", { exact: true }).first().waitFor({ timeout: 90_000 });
      check(true, "the intake is accepted");
    } catch {
      const invalid = await page.evaluate(() => [...document.querySelectorAll(":invalid")].map((e) => e.getAttribute("name") || e.id || e.closest("label")?.innerText?.split("\n")[0] || e.tagName));
      const shown = await page.locator("form").innerText().then((t) => t.split("\n").filter((l) => /fail|valid|could not|error|required|differs/i.test(l)).slice(0, 6));
      console.log("  diagnostic: invalid fields:", JSON.stringify(invalid), "| messages:", JSON.stringify(shown));
      throw new Error("the intake was not accepted");
    }

    const [row] = await rows(`deliverables?token=eq.${TOKEN}&select=status,document_html,intake`);
    check(row?.status === "draft", `the engagement moves to a reviewable draft (status ${row?.status})`);
    const html = String(row?.document_html ?? "");
    check(html.includes("dso_agreement.pdf") && html.includes("clause 4.2"), "THE DOCUMENT THE BUYER PAID FOR NAMES THE FILE AND THE PLACE IN IT");
    check(html.includes("Figures supplied with a source") && html.includes("not independently verified"), "and says it was not independently verified");
    check(row?.intake?.grid?.firm_capacity_MVA?.evidence === "E5", "the engine received the figure as customer data (E5), not as a bare number");
    check(!/buyer@browser\.example/.test(html), "the buyer's email is not in the document");
    const objs = await (await fetch(`${pg}/__objects`)).json();
    check(objs.length === 1 && objs[0].includes("/intake/"), "the file is in the object store under the engagement's prefix");
    check(errors.length === 0, `no page errors (${errors.join("; ").slice(0, 120)})`);
    await ctx.close();
  }
} catch (err) {
  console.error(String(err?.stack || err));
  failures.push(`journey aborted: ${String(err).split("\n")[0]}`);
} finally {
  await browser?.close();
  stop();
}
console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nevidence journey passed");
process.exit(failures.length ? 1 : 0);
