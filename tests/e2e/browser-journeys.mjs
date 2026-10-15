#!/usr/bin/env node
/**
 * Rendered-browser acceptance: the production build, driven in Chromium at phone, tablet and laptop
 * widths. Source inspection cannot see an overflowing layout, an unlabelled control, or a form that
 * claims success on failure; this does.
 *
 *   npm run build && node tests/e2e/browser-journeys.mjs
 *
 * Playwright is not a project dependency. Point PLAYWRIGHT_MODULE at an install (default
 * /opt/node-tools/node_modules/playwright) and CHROMIUM at a browser (default /opt/pw-browsers/chromium).
 * The server runs with no Supabase, Stripe or engine configured, so every journey below also proves the
 * UNCONFIGURED path is honest: no false success, no spinner that never ends.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright");
const PORT = Number(process.env.E2E_PORT || 3917);
const BASE = `http://127.0.0.1:${PORT}`;
const WIDTHS = [375, 768, 1280];
const PAGES = ["/", "/pricing", "/qualify", "/developers", "/platforms", "/power/deploy", "/intelligence",
  "/reference", "/workspace", "/constraints", "/legal/terms", "/account/login"];

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);

const server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore", env: { ...process.env, NODE_ENV: "production" } });
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

  await browser.close();
} finally {
  server.kill("SIGTERM");
}

if (failures.length) {
  console.error(`browser journeys: ${failures.length} failure(s)`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`browser journeys: ${PAGES.length * WIDTHS.length} page renders and 4 journeys passed`);
