#!/usr/bin/env node
/**
 * Rendered-browser acceptance for the Portfolio Screen's hall list: a buyer opens their intake link, sees the multi-hall form (not the
 * one-hall form), downloads the template, pastes a hall list, is told what was understood BEFORE anything is sent, is refused clearly for
 * a one-row list, a non-numeric cell and a hall listed twice, and finally submits five halls; the REAL engine ranks them and the
 * engagement becomes a reviewable draft with a model pack per hall.
 *
 *   node tests/e2e/portfolio-journey.mjs           (uses `next dev`; set E2E_NEXT=start after `npm run build` to use the production server)
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
  console.error(`portfolio journey NOT RUN: Playwright could not be loaded (${String(err).split("\n")[0]}). Set PLAYWRIGHT_MODULE.`);
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const P = { pg: Number(process.env.E2E_PF_PG || 54351), engine: Number(process.env.E2E_PF_ENGINE || 8111), site: Number(process.env.E2E_PF_SITE || 3930) };
const pg = `http://127.0.0.1:${P.pg}`, engineUrl = `http://127.0.0.1:${P.engine}`, site = `http://127.0.0.1:${P.site}`;
const TOKEN = "pf-journey-intake-token";
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
  group(process.env.E2E_PYTHON || "python3", ["-m", "gridforge", "serve", "--port", String(P.engine)], { GRIDFORGE_API_KEYS: "pf-engine-key", GRIDFORGE_RATE_LIMIT: "100000" });
  await until("engine", async () => (await fetch(`${engineUrl}/health`)).ok);
  const prod = process.env.E2E_NEXT === "start";
  group("npx", ["next", prod ? "start" : "dev", "-p", String(P.site)], {
    SUPABASE_URL: pg, NEXT_PUBLIC_SUPABASE_URL: pg, NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anon", SUPABASE_SERVICE_ROLE_KEY: "local-verify",
    GRIDFORGE_API_URL: engineUrl, GRIDFORGE_API_KEY: "pf-engine-key", GRIDFORGE_KEY_SECRET: "pf-signing-secret", ADMIN_PASSWORD: "pf-admin",
    NEXT_PUBLIC_SITE_URL: site, GRIDFORGE_TRUSTED_IP_HEADER: "x-forwarded-for", RATE_LIMIT_HMAC_KEY: "pf-rate-limit-key-0123456789abcdef0123456789",
    NODE_ENV: prod ? "production" : "development", NEXT_TELEMETRY_DISABLED: "1",
  });
  await until("site", async () => (await fetch(site + "/")).ok, 480);

  // An engagement the way "Open intake" leaves it: a scoped Portfolio Screen deposit whose intake link has been sent.
  const seeded = await fetch(`${pg}/rest/v1/deliverables`, { method: "POST", headers: { "content-type": "application/json", apikey: "local", prefer: "return=representation" },
    body: JSON.stringify({ token: TOKEN, intake_token: TOKEN, kind: "portfolio_screen_deposit", status: "awaiting_intake", email: "fund@browser.example", company: "Estate Fund", stripe_session_id: "cs_pf_journey", amount_cents: 1500000 }) });
  check(seeded.ok, "a Portfolio Screen engagement is open for intake");

  const HEADER = "siteName,hallId,metro,country,contractedMW,currentPeakMW,currentItLoadMW,buswayAmpacityA,tapoffMaxA,positionsAvailable,plantSupplyC,firmCapacityMVA,floorLoadingKPa,plantCapacityKW,platform";
  const HALLS = [
    "North Hall,H1,Dublin,IE,12,7.4,4.9,400,63,180,6,15,12,6000,gb300_nvl72",
    "South Hall,H2,Cork,IE,30,18,12,1600,250,400,7,36,15,16000,gb300_nvl72",
    "East Hall,H3,Galway,IE,6,4.2,2.5,250,63,90,8,,,,gb300_nvl72",
    "West Hall,H4,Limerick,IE,20,11,7,800,125,260,6,24,12,11000,gb200_nvl72",
    "Port Hall,H5,Dublin,IE,45,30,20,3200,400,700,6,52,18,30000,gb300_nvl72",
  ];

  browser = await chromium.launch({ args: ["--no-sandbox"] });
  for (const width of [375, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true, extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${width % 200}` } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${site}/intake/${TOKEN}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "The halls to rank" }).waitFor({ timeout: 30_000 });
    check(true, `[${width}px] the multi-hall form renders for a Portfolio Screen`);
    check((await page.getByRole("heading", { name: "The hall's own numbers" }).count()) === 0, `[${width}px] it is NOT the one-hall form`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `[${width}px] no horizontal overflow`);
    check((await page.getByText("optional, named as an assumption if blank").count()) >= 3, `[${width}px] the three optional figures say they become named assumptions`);

    if (width === 375) { await ctx.close(); continue; }

    // The template is the documented header, downloaded.
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download the template/ }).click()]);
    const tpl = (await (await import("node:fs/promises")).readFile(await dl.path(), "utf8")).trim();
    check(tpl.startsWith("siteName,hallId,metro,country,contractedMW") && tpl.split(",").length === HEADER.split(",").length, "the template downloads with the documented columns");

    const box = page.getByLabel("Hall list as CSV");
    const submit = page.getByRole("button", { name: "Submit the portfolio" });
    const alerts = () => page.locator("ul[role=alert]").innerText().catch(() => "");
    check(await submit.isDisabled(), "nothing can be submitted before a list is pasted");

    // A one-row list: refused in the page, before any request.
    let requests = 0;
    page.on("request", (r) => { if (r.url().includes("/api/intake/") && r.method() === "POST") requests++; });
    await box.fill(`${HEADER}\n${HALLS[0]}`);
    await page.getByText("Understood 1 hall", { exact: false }).waitFor();
    await submit.click();
    check((await alerts()).includes("at least 2 halls"), "one hall is refused in the page, saying a ranking needs at least two");
    check(requests === 0, "and no request was sent");

    // A cell that is not a number.
    await box.fill(`${HEADER}\n${HALLS[0]}\n${HALLS[1].replace(",30,", ",thirty,")}`);
    await submit.click();
    check(/contractedMW: "thirty" is not a number/.test(await alerts()), "a non-numeric cell is named by hall and column");
    check(requests === 0, "and still no request was sent");

    // An unknown column.
    await box.fill(`${HEADER},bogus\n${HALLS[0]},1\n${HALLS[1]},2`);
    await submit.click();
    check(/Unknown column: bogus/.test(await alerts()), "an unknown column is named");

    // The same hall twice: the page lets it through to the server, which refuses it by name and nothing is generated.
    await box.fill(`${HEADER}\n${HALLS[0]}\n${HALLS[0]}`);
    await page.getByText("Understood 2 halls", { exact: false }).waitFor();
    await submit.click();
    await page.getByText(/repeats site/, { exact: false }).first().waitFor({ timeout: 30_000 });
    check(true, "a hall listed twice is refused by the server, naming the repeat");
    const [still] = await rows(`deliverables?token=eq.${TOKEN}&select=status`);
    check(still?.status === "awaiting_intake", "and the engagement is still awaiting its intake");

    // The real submission: five halls from a file, ranked by the real engine.
    await page.locator('input[type="file"]').setInputFiles({ name: "halls.csv", mimeType: "text/csv", buffer: Buffer.from(`${HEADER}\n${HALLS.join("\n")}\n`) });
    await page.getByText("Understood 5 halls", { exact: false }).waitFor({ timeout: 10_000 });
    check((await page.getByText("Understood 5 halls").innerText()).includes("North Hall/H1"), "the pasted list is read back to the buyer before they submit");
    await page.getByLabel("Name printed on the document").fill("Estate Fund");
    await page.getByLabel("Rank the halls by").selectOption("min_cost");
    await submit.click();
    try {
      await page.getByText("Portfolio received", { exact: true }).waitFor({ timeout: 120_000 });
      check(true, "the portfolio is accepted");
    } catch {
      console.log("  diagnostic:", JSON.stringify((await alerts()).slice(0, 400)));
      throw new Error("the portfolio was not accepted");
    }
    await page.getByText("What we assumed", { exact: false }).click();
    const assumed = await page.locator("details").innerText();
    check(/East Hall \/ H3: firmCapacityMVA/.test(assumed) && /East Hall \/ H3: plantCapacityKW/.test(assumed), "East Hall's three blank figures are named as its assumptions");
    check(!/North Hall \/ H1:/.test(assumed), "North Hall supplied all three and is not listed");

    const [row] = await rows(`deliverables?token=eq.${TOKEN}&select=status,title,document_md,working_files,intake`);
    check(row?.status === "draft", `the engagement moves to a reviewable draft (status ${row?.status})`);
    check(/Portfolio Screen/.test(row?.title ?? "") && /5 halls/.test(row?.title ?? ""), "the document is the Portfolio Screen of five halls");
    const files = Object.keys(row?.working_files ?? {});
    check(files.filter((f) => f.startsWith("model_pack_")).length === 5, "there is one model pack per hall");
    check(["NORTH-HALL_H1", "SOUTH-HALL_H2", "EAST-HALL_H3", "WEST-HALL_H4", "PORT-HALL_H5"].every((s) => files.includes(`model_pack_${s}.json`)), "each pack is named after its own site and hall");
    check(["North Hall", "South Hall", "East Hall", "West Hall", "Port Hall"].every((h) => String(row?.document_md).includes(h)), "every hall is in the ranking document");
    check(/Estate Fund/.test(String(row?.document_md)), "the name the buyer chose is on the document");
    check(row?.intake?.objective === "min_cost", "the ranking objective they chose reached the engine");

    // After submission the same link says so, and takes nothing more.
    await page.reload({ waitUntil: "networkidle" });
    const again = await fetch(`${site}/api/intake/${TOKEN}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77" }, body: JSON.stringify({ halls: [] }) });
    check(again.status === 409 || again.status === 422, `a second submission is not accepted (HTTP ${again.status})`);
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
console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nportfolio journey passed");
process.exit(failures.length ? 1 : 0);
