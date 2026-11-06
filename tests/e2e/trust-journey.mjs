#!/usr/bin/env node
/**
 * Rendered-browser acceptance for the trust changes: the home page's scenario reel (reduced motion, Pause/Play, the visitor's inputs are never
 * overwritten), the contact form (keyboard path, success, validation, a store that is down), the AI-assistant label, the token-route and
 * Content-Security-Policy-Report-Only headers, axe, and every CSP report-only violation the browser actually raises on the audited pages.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54351 GRIDFORGE_API_URL=http://127.0.0.1:8111 npm run build   # the CSP is built from these
 *   node tests/e2e/trust-journey.mjs
 *
 * MANUAL, like the other files here: no CI job runs it (Playwright is not a project dependency). Everything is local: the PostgREST stand-in built
 * from the migrations, the real capacity engine, and the production build. No Stripe, Supabase, Resend or other outside service is reached, and no
 * email is sent. Exit codes: 0 passed, 1 a check failed, 2 the browser part could not run. CSP report-only observations are PRINTED, not asserted:
 * they are a list for the owner, not a pass/fail.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright"));
} catch (err) {
  console.error(`trust journey NOT RUN: Playwright could not be loaded (${String(err).split("\n")[0]}). Set PLAYWRIGHT_MODULE.`);
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const P = {
  pg: Number(process.env.E2E_TJ_PG || 54351), engine: Number(process.env.E2E_TJ_ENGINE || 8111),
  site: Number(process.env.E2E_TJ_SITE || 3931), bare: Number(process.env.E2E_TJ_BARE || 3932),
};
const pg = `http://127.0.0.1:${P.pg}`, engineUrl = `http://127.0.0.1:${P.engine}`, site = `http://127.0.0.1:${P.site}`, bare = `http://127.0.0.1:${P.bare}`;
const AXE = path.join(ROOT, "node_modules", "axe-core", "axe.min.js");
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
const note = (what) => console.log(`note ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const procs = [];
const group = (cmd, args, env = {}) => { const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore", detached: true }); procs.push(c); return c; };
const stop = () => { for (const c of procs) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } } };
const until = async (label, probe, tries = 240) => { for (let i = 0; i < tries; i++) { try { if (await probe()) return; } catch { /* not up */ } await sleep(500); } throw new Error(`${label} did not come up`); };
const rows = async (q) => (await fetch(`${pg}/rest/v1/${q}`, { headers: { apikey: "local" } })).json();

const baseEnv = {
  NEXT_PUBLIC_SUPABASE_URL: pg, NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anon", GRIDFORGE_API_URL: engineUrl, GRIDFORGE_API_KEY: "tj-engine-key",
  GRIDFORGE_KEY_SECRET: "tj-signing-secret", ADMIN_PASSWORD: "tj-admin", GRIDFORGE_TRUSTED_IP_HEADER: "x-forwarded-for",
  RATE_LIMIT_HMAC_KEY: "tj-rate-limit-key-0123456789abcdef0123456789", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
};

/** The CSP violations the browser raised, keyed by page. Filled by watch(). */
const csp = new Map();
const problems = [];

function watch(page, label) {
  const entry = { violations: new Set(), consoleErrors: [], failed: [], bad: [] };
  csp.set(label, entry);
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Report Only|Refused to/i.test(t)) entry.violations.add(t.replace(/\s+/g, " ").slice(0, 260));
    else if (m.type() === "error") entry.consoleErrors.push(t.slice(0, 200));
  });
  page.on("pageerror", (e) => entry.consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on("requestfailed", (r) => entry.failed.push(`${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => { if (r.status() >= 400) entry.bad.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  page.on("request", (r) => {
    if (r.url().endsWith("/api/csp-report")) {
      try {
        const j = JSON.parse(r.postData() || "{}");
        const b = j["csp-report"] ?? j;
        const blocked = String(b["blocked-uri"] ?? "").replace(/^(https?:\/\/[^/]+).*$/, "$1");
        // The route logs only directive and origin; the harness also notes WHERE in our own files it came from, for the owner's list.
        const src = String(b["source-file"] ?? "").replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
        entry.violations.add(`report: ${b["effective-directive"] ?? b["violated-directive"]} blocked=${blocked || "(none)"}${src ? ` from ${src}:${b["line-number"] ?? "?"}` : ""}`);
      } catch { /* not JSON */ }
    }
  });
  return entry;
}

// One slow step must not hang the run: every wait is bounded, and the whole run has a ceiling.
const watchdog = setTimeout(() => { console.error("trust journey watchdog: run exceeded 25 minutes"); stop(); process.exit(1); }, 25 * 60_000);
watchdog.unref();
const guarded = async (label, fn) => { try { await fn(); } catch (err) { check(false, `${label} aborted: ${String(err).split("\n")[0].slice(0, 160)}`); } };

const caption = (page) => page.getByTestId("ttp-caption").innerText();
const rangeValue = (page, name) => page.getByRole("slider", { name }).inputValue();

async function reelJourney(browser, width, height, reduced, ipTail) {
  const tag = `${width}px${reduced ? " reduced-motion" : ""}`;
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? "reduce" : "no-preference", extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${ipTail}` } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  watch(page, `reel ${tag}`);
  await page.goto(site + "/", { waitUntil: "load" });
  // The planner is a lazy island: it mounts when its placeholder is scrolled near.
  await page.getByText("The time-to-power planner loads as you scroll to it.").scrollIntoViewIfNeeded({ timeout: 30_000 });
  const pauseBtn = page.getByRole("button", { name: "Pause scenario autoplay" });
  const playBtn = page.getByRole("button", { name: "Play scenario autoplay" });
  await page.getByTestId("ttp-caption").waitFor({ timeout: 60_000 });

  if (reduced) {
    check(await playBtn.isVisible(), `[${tag}] a visitor who prefers reduced motion gets Play, not an autoplaying reel`);
    const c0 = await caption(page);
    await sleep(13_000);
    check((await caption(page)) === c0, `[${tag}] nothing advanced on its own after 13 s`);
    await playBtn.focus();
    await page.keyboard.press("Enter");
    check(await pauseBtn.isVisible(), `[${tag}] Play (keyboard) starts it, and the control becomes Pause`);
    await page.waitForFunction((c) => document.querySelector('[data-testid="ttp-caption"]')?.textContent !== c, c0, { timeout: 16_000 }).then(() => check(true, `[${tag}] after an explicit Play it advances (jumping, no glide)`), () => check(false, `[${tag}] after an explicit Play it advances`));
    await ctx.close();
    return;
  }

  check(await pauseBtn.isVisible(), `[${tag}] a visible Pause control is present while the reel plays`);
  const box = await pauseBtn.boundingBox();
  check(!!box && box.height >= 40, `[${tag}] the Pause control is a comfortable target (${box ? Math.round(box.width) : "?"}x${box ? Math.round(box.height) : "?"} px)`);
  const c0 = await caption(page);
  await page.waitForFunction((c) => document.querySelector('[data-testid="ttp-caption"]')?.textContent !== c, c0, { timeout: 20_000 }).then(() => check(true, `[${tag}] unattended, the reel advances to the next scenario`), () => check(false, `[${tag}] the reel advances`));
  // Pause with the keyboard, then prove it stays paused longer than a dwell.
  await pauseBtn.focus();
  await page.keyboard.press("Enter");
  await playBtn.waitFor({ timeout: 5_000 });
  await sleep(1_800); // let a glide in flight land
  const c1 = await caption(page), mw1 = await rangeValue(page, "Capacity");
  await sleep(13_000);
  check((await caption(page)) === c1 && (await rangeValue(page, "Capacity")) === mw1, `[${tag}] Pause holds: caption and Capacity unchanged after 13 s`);
  await playBtn.focus();
  await page.keyboard.press("Space");
  await pauseBtn.waitFor({ timeout: 5_000 });
  await page.waitForFunction((c) => document.querySelector('[data-testid="ttp-caption"]')?.textContent !== c, c1, { timeout: 20_000 }).then(() => check(true, `[${tag}] Play (keyboard) resumes it`), () => check(false, `[${tag}] Play resumes it`));
  // The visitor changes an input: the reel stops for good and never overwrites it.
  const cap = page.getByRole("slider", { name: "Capacity" });
  await cap.focus();
  await page.keyboard.press("End");
  const mine = await rangeValue(page, "Capacity");
  check(mine === "500", `[${tag}] the visitor sets Capacity with the keyboard (${mine})`);
  check(await page.getByText("Autoplay stopped; your inputs are kept.").isVisible(), `[${tag}] the panel says autoplay stopped`);
  check((await pauseBtn.count()) === 0 && (await playBtn.count()) === 0, `[${tag}] no Pause/Play control is left to restart it`);
  check((await caption(page)).startsWith("Your inputs"), `[${tag}] the caption now says these are the visitor's inputs, not a scenario`);
  await sleep(24_000); // longer than the old 20 s resume plus a dwell
  check((await rangeValue(page, "Capacity")) === "500" && (await caption(page)).startsWith("Your inputs"), `[${tag}] 24 s later the visitor's value is intact (the old code overwrote it after 20 s)`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `[${tag}] no horizontal overflow on the home page`);
  await ctx.close();
}

async function contactJourney(browser, width, height, ipTail) {
  const tag = `${width}px`;
  const ctx = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${ipTail}` } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  watch(page, `contact ${tag}`);
  await page.goto(site + "/contact", { waitUntil: "networkidle" });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `[${tag}] /contact: no horizontal overflow`);
  check(await page.locator('a[href^="mailto:"]').first().isVisible(), `[${tag}] the mailto fallback is still visible`);

  // Keyboard path: Tab to the first field, then through the form to the button, never landing on the honeypot.
  let seq = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
    seq.push(id);
    if (id === "contact-name") break;
  }
  check(seq.at(-1) === "contact-name", `[${tag}] Tab reaches the first field (${seq.length} presses from the top)`);
  const typed = [["contact-name", "Ada Journey"], ["contact-email", "ada@journey.example"], ["contact-company", "Journey Hall Co"], ["contact-message", "We have a 48 MW hall and the tap-offs are the problem."], ["contact-mw", "48"]];
  const order = ["contact-name"];
  for (let i = 0; i < typed.length; i++) {
    const [id, value] = typed[i];
    const active = await page.evaluate(() => document.activeElement?.id);
    if (active !== id) { check(false, `[${tag}] Tab order: expected ${id}, focus is on ${active}`); break; }
    await page.keyboard.type(value);
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim()));
  }
  check(!order.includes("contact-website"), `[${tag}] the honeypot is not in the tab order (order: ${order.join(" > ")})`);
  check(/Send enquiry/.test(String(order.at(-1))), `[${tag}] the sixth Tab lands on the submit button`);
  await page.keyboard.press("Enter");
  const status = page.getByRole("status").filter({ hasText: "Your message was saved." });
  await status.waitFor({ timeout: 20_000 });
  check(true, `[${tag}] Enter on the button submits and the page says the message was saved`);
  check(await status.evaluate((el) => el === document.activeElement), `[${tag}] focus moves to the confirmation`);
  const leads = await rows("leads?select=name,company,email,message,capacity_mw,context,source,location,status&order=created_at.desc&limit=1");
  check(leads[0]?.company === "Journey Hall Co" && leads[0]?.context === "contact-form" && Number(leads[0]?.capacity_mw) === 48 && leads[0]?.status === "new", `[${tag}] the enquiry is in the leads table (context ${leads[0]?.context}, ${leads[0]?.capacity_mw} MW)`);

  if (width >= 1000) {
    // A server-side validation error (the browser's own checks are bypassed on purpose): shown against the field, announced, and focus is in the alert.
    await page.goto(site + "/contact", { waitUntil: "networkidle" });
    await page.evaluate(() => { document.querySelector("form").noValidate = true; });
    await page.fill("#contact-name", "Ada Journey"); await page.fill("#contact-email", "not-an-address");
    await page.fill("#contact-company", "Journey Hall Co"); await page.fill("#contact-message", "short");
    await page.getByRole("button", { name: "Send enquiry" }).click();
    await page.locator("#contact-email-err").waitFor({ timeout: 10_000 });
    check((await page.locator("#contact-email").getAttribute("aria-invalid")) === "true" && (await page.locator("#contact-email").getAttribute("aria-describedby")) === "contact-email-err", `[${tag}] a refused field is marked invalid and described by its message`);
    check(await page.locator('form [role="alert"]').evaluate((el) => el === document.activeElement), `[${tag}] focus moves to the error summary`);
    check((await rows("leads?select=id")).length === 1, `[${tag}] a refused enquiry stored nothing`);
  }
  await ctx.close();
}

async function bareContact(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.150" } });
  const page = await ctx.newPage();
  watch(page, "contact (store not configured)");
  await page.goto(bare + "/contact", { waitUntil: "networkidle" });
  await page.fill("#contact-name", "Ada Journey"); await page.fill("#contact-email", "ada@journey.example");
  await page.fill("#contact-company", "Journey Hall Co"); await page.fill("#contact-message", "We have a 48 MW hall and the tap-offs are the problem.");
  await page.getByRole("button", { name: "Send enquiry" }).click();
  const alert = page.locator('form [role="alert"]'); // not getByRole: Next adds its own route announcer with role=alert
  await alert.filter({ hasText: /not (saved|sent)/ }).waitFor({ timeout: 20_000 });
  check(true, "with no store configured the form says the message was NOT sent (never a false success)");
  check((await alert.innerText()).includes("power@") || (await alert.innerText()).includes("@"), "and the error names the email address to use instead");
  check(await alert.evaluate((el) => el === document.activeElement), "focus moves to that error");
  check((await page.getByText("Your message was saved.").count()) === 0, "no success message is shown");
  await ctx.close();
}

async function axeScan(browser, route, label) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(site + route, { waitUntil: "networkidle" });
  await page.addScriptTag({ path: AXE });
  const res = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(" ")) }));
  });
  console.log(`axe ${label}: ${res.length ? JSON.stringify(res) : "no violations"}`);
  const mine = res.filter((v) => v.nodes.some((n) => /contact-|ttp-|#form-h|form/.test(n)));
  check(mine.length === 0, `axe: nothing reported on the new form or reel controls (${label})`);
  await ctx.close();
  return res;
}

let browser;
try {
  group("node", [path.join("tests", "e2e", "postgrest-stub.mjs"), "supabase/migrations", String(P.pg)]);
  await until("postgrest", async () => (await fetch(`${pg}/rest/v1/leads?select=*&limit=1`)).ok);
  group(process.env.E2E_PYTHON || "python3", ["-m", "gridforge", "serve", "--port", String(P.engine)], { GRIDFORGE_API_KEYS: "tj-engine-key", GRIDFORGE_RATE_LIMIT: "100000" });
  await until("engine", async () => (await fetch(`${engineUrl}/health`)).ok);
  group("npx", ["next", "start", "-p", String(P.site)], { ...baseEnv, SUPABASE_URL: pg, SUPABASE_SERVICE_ROLE_KEY: "local-verify", NEXT_PUBLIC_SITE_URL: site });
  group("npx", ["next", "start", "-p", String(P.bare)], { ...baseEnv, NEXT_PUBLIC_SITE_URL: bare, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", RATE_LIMIT_HMAC_KEY: baseEnv.RATE_LIMIT_HMAC_KEY });
  await until("site", async () => (await fetch(site + "/")).ok, 240);
  await until("bare site", async () => (await fetch(bare + "/")).ok, 240);

  // --- headers, over real HTTP -------------------------------------------------------------------------------------------
  const home = await fetch(site + "/");
  const rep = home.headers.get("content-security-policy-report-only") ?? "";
  check(/report-uri \/api\/csp-report/.test(rep) && /script-src 'self' 'unsafe-inline'/.test(rep) && !/unsafe-eval/.test(rep), "the home page carries Content-Security-Policy-Report-Only with report-uri and no eval");
  check(rep.includes(engineUrl) && rep.includes(pg), "the report-only connect-src names this deployment's engine and auth host (built from its settings)");
  check(/frame-ancestors 'self'/.test(home.headers.get("content-security-policy") ?? ""), "the enforced CSP is unchanged");
  await fetch(`${pg}/rest/v1/api_accounts`, { method: "POST", headers: { "content-type": "application/json", apikey: "local" }, body: JSON.stringify({ token: "tj-portal-token-0123456789", account: "tj-acct", email: "ops@tj.example", company: "TJ", plan: "api_scale", monthly_units: 2500, status: "active" }) });
  const viaHeader = await fetch(site + "/api/keys", { headers: { authorization: "Bearer tj-portal-token-0123456789" } });
  check(viaHeader.status === 200 && viaHeader.headers.get("deprecation") === null && /no-store/.test(viaHeader.headers.get("cache-control") ?? ""), "GET /api/keys with the Authorization header: 200, no deprecation, no-store");
  check(viaHeader.headers.get("referrer-policy") === "no-referrer" && /noindex/.test(viaHeader.headers.get("x-robots-tag") ?? ""), "and it is served with the token-route headers (no-referrer, noindex) by the real server");
  const viaQuery = await fetch(site + "/api/keys?token=tj-portal-token-0123456789");
  check(viaQuery.status === 200 && viaQuery.headers.get("deprecation") === "true", "the query form still works and is marked Deprecation: true");
  const uHeader = await fetch(site + "/api/usage", { headers: { authorization: "Bearer tj-portal-token-0123456789" } });
  check([200, 503].includes(uHeader.status) && /no-store/.test(uHeader.headers.get("cache-control") ?? "") && uHeader.headers.get("referrer-policy") === "no-referrer", `GET /api/usage with the header: no-store and token-route headers (status ${uHeader.status})`);
  const rpt = await fetch(site + "/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report", "x-forwarded-for": "203.0.113.201" }, body: JSON.stringify({ "csp-report": { "violated-directive": "img-src", "blocked-uri": "https://x.example/a?b=c" } }) });
  check(rpt.status === 204, "POST /api/csp-report answers 204 over real HTTP");

  browser = await chromium.launch({ args: ["--no-sandbox"] });

  // --- the AI label ------------------------------------------------------------------------------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.160" } });
    const page = await ctx.newPage();
    watch(page, "assistant");
    await page.goto(site + "/pricing", { waitUntil: "networkidle" });
    const launcher = page.getByRole("button", { name: /Scope my site/ });
    check(/scoping assistant \(AI\)/.test((await launcher.getAttribute("aria-label")) ?? ""), "the launcher's accessible name says AI assistant and contains its visible words");
    await launcher.click();
    const dlg = page.getByRole("dialog", { name: "Time to Power scoping assistant (AI)" });
    await dlg.waitFor({ timeout: 20_000 });
    const text = await dlg.innerText();
    check(/I'm the Time to Power scoping assistant, an AI\. I'm not a human engineer/.test(text) && !/scoping engineer/i.test(text), "the open panel introduces itself as an AI, not an engineer");
    await ctx.close();
  }

  // --- the reel and the contact form, desktop and phone ------------------------------------------------------------------
  const skipReel = process.env.E2E_TJ_SKIP_REEL === "1";
  if (!skipReel) {
  await guarded("reel 1440", () => reelJourney(browser, 1440, 900, false, 11));
  await guarded("reel 390", () => reelJourney(browser, 390, 844, false, 12));
  await guarded("reel reduced 1440", () => reelJourney(browser, 1440, 900, true, 13));
  await guarded("reel reduced 390", () => reelJourney(browser, 390, 844, true, 14));
  }
  await guarded("contact 1440", () => contactJourney(browser, 1440, 900, 21));
  await guarded("contact 390", () => contactJourney(browser, 390, 844, 22));
  await guarded("contact (no store)", () => bareContact(browser));
  await guarded("axe home", () => axeScan(browser, "/", "home"));
  await guarded("axe contact", () => axeScan(browser, "/contact", "contact"));

  // --- every CSP report-only violation on the audited pages --------------------------------------------------------------
  const pages = ["/", "/pricing", "/qualify", "/reference", "/contact", "/developers", "/platforms", "/constraints", "/products", "/about", "/evidence", "/lead-times", "/for", "/intelligence", "/power/compare", "/workspace", "/account/login", "/legal/privacy", "/observatory"];
  for (const [i, route] of pages.entries()) {
    const ctx = await browser.newContext({ viewport: { width: i % 2 ? 390 : 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": `203.0.114.${i + 1}` } });
    const page = await ctx.newPage();
    watch(page, route);
    try {
      await page.goto(site + route, { waitUntil: "load", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      for (let y = 0; y < 12; y++) { await page.mouse.wheel(0, 900); await sleep(250); } // mount the lazy islands
      await sleep(1_500);
    } catch (err) { problems.push(`${route}: ${String(err).split("\n")[0]}`); }
    await ctx.close();
  }
} catch (err) {
  console.error(String(err?.stack || err));
  failures.push(`journey aborted: ${String(err).split("\n")[0]}`);
} finally {
  await browser?.close();
  stop();
}

console.log("\n=== CSP report-only observations (NOT enforced; a list for the owner) ===");
const all = new Map();
for (const [label, e] of csp) for (const v of e.violations) { const k = v.replace(/^\[Report Only\]\s*/, ""); (all.get(k) ?? all.set(k, new Set()).get(k)).add(label); }
if (all.size === 0) console.log("none observed");
for (const [v, where] of all) console.log(`- ${v}\n    on: ${[...where].slice(0, 8).join(", ")}${where.size > 8 ? ` (+${where.size - 8})` : ""}`);
console.log("\n=== console errors, failed requests, HTTP >= 400 per page (de-duplicated) ===");
for (const [label, e] of csp) {
  const items = [...new Set([...e.consoleErrors.map((x) => `console: ${x}`), ...e.failed.map((x) => `failed: ${x}`), ...e.bad.map((x) => `http: ${x}`)])];
  if (items.length) console.log(`${label}:\n  ${items.slice(0, 8).join("\n  ")}`);
}
if (problems.length) console.log("page problems:", problems.join("; "));
console.log(failures.length ? `\n${failures.length} check(s) FAILED:\n- ${failures.join("\n- ")}` : "\ntrust journey passed");
process.exit(failures.length ? 1 : 0);
