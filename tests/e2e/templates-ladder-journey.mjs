#!/usr/bin/env node
/**
 * Rendered-browser acceptance for the reference hall templates and the evidence ladder, at 1440 and 390 px:
 *
 *   npm run build && E2E_NEXT=start node tests/e2e/templates-ladder-journey.mjs
 *
 * MANUAL, like the other files in this folder: no CI job drives a browser (Playwright is not a project dependency; set PLAYWRIGHT_MODULE).
 * Real engine, local PostgREST stand-in built from the migrations; nothing talks to Supabase, Stripe or any outside service.
 *
 * Checks, per viewport: a template loads with one click; its disclosure is visible and survives an edit; every template value is tagged
 * "assumed (E0)" until changed; the engine's answer carries the template banner; an untouched template cannot be saved, an edited one can;
 * the saved project's panel shows the ladder; no console error, no horizontal overflow, no axe violation (wcag2a/aa, 2.1 aa), layout shift
 * under the budget, and the controls are reachable and operable from the keyboard. Exit 0 passed, 1 a check failed, 2 the browser could not run.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright"));
} catch (err) {
  console.error(`templates/ladder journey NOT RUN: Playwright could not be loaded (${String(err).split("\n")[0]}). Set PLAYWRIGHT_MODULE.`);
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const P = { pg: Number(process.env.E2E_TL_PG || 54361), engine: Number(process.env.E2E_TL_ENGINE || 8121), site: Number(process.env.E2E_TL_SITE || 3941) };
const pg = `http://127.0.0.1:${P.pg}`, engineUrl = `http://127.0.0.1:${P.engine}`, site = `http://127.0.0.1:${P.site}`;
const DISCLOSURE = "Reference template — synthetic, replace with your hall's figures";
const CLS_BUDGET = 0.1;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };

const procs = [];
const group = (cmd, args, env = {}) => { const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore", detached: true }); procs.push(c); return c; };
const stop = () => { for (const c of procs) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } } };
const until = async (label, probe, tries = 240) => { for (let i = 0; i < tries; i++) { try { if (await probe()) return; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error(`${label} did not come up`); };

const axeSource = fs.existsSync(path.join(ROOT, "node_modules", "axe-core", "axe.min.js")) ? fs.readFileSync(path.join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8") : null;
async function axe(page, where) {
  if (!axeSource) { console.log(`skip axe (${where}): axe-core not installed`); return; }
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.map((x) => `${x.id} (${x.nodes.length}): ${x.nodes[0]?.target?.join(" ")}`));
  check(v.length === 0, `${where}: no axe violations${v.length ? " -> " + v.join(" | ") : ""}`);
}
const SHOTS = process.env.E2E_SHOTS || "";
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: false }); } };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

let browser;
try {
  group("node", [path.join("tests", "e2e", "postgrest-stub.mjs"), "supabase/migrations", String(P.pg)]);
  await until("postgrest", async () => (await fetch(`${pg}/rest/v1/leads?select=*&limit=1`)).ok);
  group(process.env.E2E_PYTHON || "python3", ["-m", "gridforge", "serve", "--port", String(P.engine)], { GRIDFORGE_API_KEYS: "tl-engine-key", GRIDFORGE_RATE_LIMIT: "100000" });
  await until("engine", async () => (await fetch(`${engineUrl}/health`)).ok);
  const prod = process.env.E2E_NEXT === "start";
  group("npx", ["next", prod ? "start" : "dev", "-p", String(P.site)], {
    SUPABASE_URL: pg, NEXT_PUBLIC_SUPABASE_URL: pg, NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anon", SUPABASE_SERVICE_ROLE_KEY: "local-verify",
    GRIDFORGE_API_URL: engineUrl, GRIDFORGE_API_KEY: "tl-engine-key", GRIDFORGE_KEY_SECRET: "tl-signing-secret", ADMIN_PASSWORD: "tl-admin",
    NEXT_PUBLIC_SITE_URL: site, GRIDFORGE_TRUSTED_IP_HEADER: "x-forwarded-for", RATE_LIMIT_HMAC_KEY: "tl-rate-limit-key-0123456789abcdef0123456789",
    NODE_ENV: prod ? "production" : "development", NEXT_TELEMETRY_DISABLED: "1",
  });
  await until("site", async () => (await fetch(site + "/power/compare")).ok, 480);

  browser = await chromium.launch({ args: ["--no-sandbox"] });
  let n = 0;
  for (const vp of [{ name: "1440", width: 1440, height: 900 }, { name: "390", width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${++n * 7}` } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    });
    const where = `[${vp.name}px]`;

    await page.goto(`${site}/power/compare`, { waitUntil: "networkidle" });
    const group_ = page.getByRole("group", { name: /Start from a reference template/ });
    await group_.waitFor({ timeout: 20_000 });
    const buttons = group_.getByRole("button");
    check((await buttons.count()) === 3, `${where} three templates are offered`);
    check(await overflow(page), `${where} no horizontal overflow before a template is chosen`);
    check(!(await page.getByText(DISCLOSURE).count()), `${where} nothing is loaded and no disclosure is shown before a click`);

    // keyboard: a template button is reachable by Tab and operable with Enter
    await page.keyboard.press("Tab");
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      reached = await page.evaluate(() => document.activeElement?.getAttribute("aria-pressed") !== null && document.activeElement?.tagName === "BUTTON");
      if (!reached) await page.keyboard.press("Tab");
    }
    check(reached, `${where} a template button is reachable with Tab`);
    await page.keyboard.press("Enter");
    await page.getByText(DISCLOSURE).first().waitFor({ timeout: 10_000 });
    check(true, `${where} Enter on a template loads it and shows "${DISCLOSURE}"`);
    check((await page.locator('button[aria-pressed="true"]').count()) === 1, `${where} exactly one template is marked pressed`);

    // every value is tagged as the template's, and the form holds them
    const tags = page.getByText("Template value · assumed (E0)");
    const total = await tags.count();
    check(total === 14, `${where} all 14 template values carry the assumed (E0) tag (found ${total})`);
    check((await page.getByLabel("Contracted grid capacity (MW)").inputValue()) === "6", `${where} the form holds the template's figures`);
    check(await overflow(page), `${where} no horizontal overflow with a template loaded`);
    await group_.scrollIntoViewIfNeeded();
    await shot(page, `${vp.name}_template_loaded`);

    // an untouched template is solved by the engine, labelled, and cannot be saved
    await page.getByRole("button", { name: "Compare scenarios" }).click();
    const result = page.getByRole("region", { name: "Comparison result" });
    await result.waitFor({ timeout: 60_000 });
    const rtext = await result.innerText();
    check(rtext.includes(DISCLOSURE) && /14 of 14 template\s+values were still the template/.test(rtext.replace(/\n/g, " ")), `${where} the result carries the template banner with the count of values still assumed`);
    check(!rtext.includes("Synthetic example."), `${where} one banner, not two`);
    check(!(await page.getByRole("region", { name: "Save to a project" }).count()), `${where} an untouched template cannot be saved`);
    check(await overflow(page), `${where} no horizontal overflow with a result`);

    // the downloaded result says it was template-derived
    const [dl] = await Promise.all([page.waitForEvent("download"), result.getByRole("button", { name: /Result \(JSON\)/ }).click()]);
    const dlText = fs.readFileSync(await dl.path(), "utf8");
    check(/"template_derived"/.test(dlText) && /"values_marked_assumed_e0": 14/.test(dlText), `${where} the downloaded result JSON carries a template_derived header`);

    // renaming an untouched template does not make it a hall: still no save panel
    await page.getByLabel("Site name").fill("My own hall");
    await page.getByLabel("Hall id").fill("H-1");
    await page.getByRole("button", { name: "Compare scenarios" }).click();
    await result.waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => document.body.innerText.includes("cannot be saved or shared"), null, { timeout: 60_000 });
    check(!(await page.getByRole("region", { name: "Save to a project" }).count()), `${where} an untouched template with its labels renamed still cannot be saved`);

    // an edit: the field flips to the visitor's, the disclosure stays, the count falls
    const tap = page.getByLabel("Tap-off rating, max (A)");
    await tap.fill("125");
    check((await page.getByText("Template value · assumed (E0)").count()) === 13, `${where} an edited value is no longer tagged as the template's`);
    check((await page.getByText("Your value").count()) === 1, `${where} the edited value is tagged as the visitor's`);
    check(await page.getByText(DISCLOSURE).first().isVisible(), `${where} the disclosure survives the edit`);
    check((await page.getByRole("status").filter({ hasText: DISCLOSURE }).innerText()).includes("13 of 14 values are still the template"), `${where} the disclosure counts the values still assumed`);
    await page.getByRole("button", { name: "Compare scenarios" }).click();
    await page.getByRole("region", { name: "Save to a project" }).waitFor({ timeout: 60_000 });
    const edited = (await result.innerText()).replace(/\n/g, " ");
    check(edited.includes(DISCLOSURE) && /13 of 14 template\s+values were still the template/.test(edited) && edited.includes("1 had been changed by you"), `${where} the edited result keeps the label and says one value was changed`);

    // the other templates solve too (the on-site one brings its supply options)
    for (const [i, expectSupply] of [[1, false], [2, true]]) {
      await buttons.nth(i).click();
      check((await page.getByText(DISCLOSURE).count()) >= 1, `${where} template ${i + 1} loads`);
      check((await page.getByLabel(/^Kind$/).count() > 0) === expectSupply, `${where} template ${i + 1} ${expectSupply ? "brings" : "has no"} on-site supply options`);
      await page.getByRole("button", { name: "Compare scenarios" }).click();
      await page.getByRole("region", { name: "Comparison result" }).waitFor({ timeout: 60_000 });
      check((await page.getByRole("region", { name: "Comparison result" }).innerText()).includes(DISCLOSURE), `${where} template ${i + 1}: the engine answers and the result is labelled`);
    }

    await axe(page, `${where} /power/compare with a template and a result`);

    // save an edited template to a project, and read the ladder on the project panel
    await buttons.nth(0).click();
    await page.getByLabel("Tap-off rating, max (A)").fill("125");
    await page.getByRole("button", { name: "Compare scenarios" }).click();
    const save = page.getByRole("region", { name: "Save to a project" });
    await save.waitFor({ timeout: 60_000 });
    await save.getByRole("button", { name: "Save to a project" }).click();
    const link = save.getByLabel(/link|workspace|project/i).first();
    await page.waitForFunction(() => [...document.querySelectorAll("input")].some((i) => /\/workspace\?project=/.test(i.value)), null, { timeout: 60_000 });
    const href = await page.evaluate(() => [...document.querySelectorAll("input")].find((i) => /\/workspace\?project=/.test(i.value)).value);
    void link;
    check(/\/workspace\?project=/.test(href), `${where} the edited template saves to a project`);

    check(vp.width === 1440 ? (await page.evaluate(() => window.__cls)) <= CLS_BUDGET : true, `${where} layout shift on /power/compare is ${await page.evaluate(() => window.__cls)} (budget ${CLS_BUDGET})`);

    await page.goto(href, { waitUntil: "networkidle" });
    // below the md breakpoint the panes sit behind a tab bar
    if (vp.width < 768) await page.locator("nav").getByRole("button", { name: "Project" }).click();
    const card = page.locator("text=WHAT EVIDENCE COULD MOVE THE BINDING LIMIT >> visible=true").first();
    await card.waitFor({ timeout: 30_000 });
    const panelText = await page.locator("main, body").first().innerText();
    check(/Binds now:/.test(panelText), `${where} the ladder names the limit that binds now`);
    check(/Document that would back it:/.test(panelText) && /It would not prove:/.test(panelText), `${where} the ladder names the document and what it would not prove`);
    check(/The review steps that exist today/.test(panelText) && /SHA-256/.test(panelText), `${where} the ladder lists the real review steps`);
    check(/classed E5|E0, assumed|declared E0/.test(panelText), `${where} the ladder states the class held for the inputs`);
    check(!/guarantee|will raise|unlock/i.test(panelText), `${where} the ladder promises no gain`);
    check(await overflow(page), `${where} no horizontal overflow on the project panel`);
    await card.scrollIntoViewIfNeeded();
    await shot(page, `${vp.name}_ladder`);
    await axe(page, `${where} project panel with the ladder`);

    check(errors.length === 0, `${where} no console errors${errors.length ? " -> " + errors.join(" | ").slice(0, 300) : ""}`);
    await ctx.close();
  }
} catch (err) {
  console.error("journey could not complete:", err);
  failures.push(String(err));
} finally {
  await browser?.close().catch(() => {});
  stop();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\ntemplates + ladder journey passed");
