#!/usr/bin/env node
/**
 * Rendered-browser acceptance for the first screen, the navigation and the trust chrome (stream W1).
 *
 *   npm run build && node tests/e2e/first-screen-journey.mjs
 *
 * MANUAL, like the other files in this folder: no CI job drives a browser. It starts `next start` on E2E_PORT with NO Supabase, Stripe or
 * engine configured (every check below is about what a cold visitor sees), unless E2E_BASE_URL points at a server that is already up.
 * Playwright is not a project dependency: set PLAYWRIGHT_MODULE (default tries /opt/node22 and /opt/node-tools). axe-core is used when
 * node_modules has it. Screenshots go to E2E_OUT (default the OS temp dir), never into the repository.
 *
 * What it measures, at 1440x900 and at 390x844 (mobile emulation):
 *   - the first viewport: that the audience, the decision, the data needed, what you receive, try-now, the difference and the next step are
 *     all answerable from TEXT that is fully visible, and that the three calls to action are there, in order and weight;
 *   - that no keyboard-focusable control sits inside an aria-hidden / opacity-0 / pointer-events-none container;
 *   - how many Tab presses reach the first "Try the free capacity check" control and the one in the hero;
 *   - the fixed chrome (px of the viewport covered by fixed or sticky bars) before and after a scroll;
 *   - layout shift (PerformanceObserver) over a full scroll;
 *   - console errors, horizontal overflow, axe violations;
 *   - the cancelled-checkout banner on /qualify and /pricing, with hostile query values;
 *   - that /observatory carries no paid call to action in the header.
 * Exit codes: 0 all checks passed, 1 a check failed, 2 the browser part could not run.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let chromium;
for (const m of [process.env.PLAYWRIGHT_MODULE, "playwright", "/opt/node22/lib/node_modules/playwright", "/opt/node-tools/node_modules/playwright"]) {
  if (!m) continue;
  try { ({ chromium } = require(m)); break; } catch { /* try the next */ }
}
if (!chromium) {
  console.error("first-screen journey NOT RUN: Playwright could not be loaded. Set PLAYWRIGHT_MODULE.");
  process.exit(2);
}
const PORT = Number(process.env.E2E_PORT || 3927);
const EXTERNAL = process.env.E2E_BASE_URL;
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "first-screen-"));
fs.mkdirSync(OUT, { recursive: true });
const TAG = process.env.E2E_TAG || "run";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];
const TAB_BUDGET = { desktop: 8, mobile: 6 };
const CLS_BUDGET = 0.1;

const failures = [];
const report = {};
const fail = (where, what) => failures.push(`${where}: ${what}`);

let server;
async function up() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + "/")).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not come up");
}

// The seven questions a buyer brings to the first screen, each answered by visible text. The patterns are deliberately about the CLAIM, not
// the exact words, so a rewording that keeps the answer still passes and one that drops it fails.
const QUESTIONS = {
  audience: /operators?[\s\S]*investors?[\s\S]*engineers?/i,
  decision: /how many ai racks can your hall power/i,
  dataNeeded: /7 numbers[\s\S]*no card/i,
  whatYouReceive: /relief ladder[\s\S]*lead times[\s\S]*evidence/i,
  trust: /pilot-stage and founder-led[\s\S]*calibration ledger is empty/i,
  tryNow: /try the free capacity check/i,
  difference: /independent[\s\S]*(sell no equipment|no equipment)/i,
  nextStep: /see a sample deliverable/i,
};
const CTAS = [/try the free capacity check/i, /see a sample deliverable/i, /order a density screen/i];

function benign(text) {
  // No backend is configured: the data calls answer 4xx/5xx and the browser logs that; the UI's reaction is what is tested.
  return /Failed to load resource|status of (4|5)\d\d/.test(text);
}

/** Runs in the page: text that is fully inside the viewport, and the geometry of the three calls to action. */
function foldProbe(ctaSources) {
  const vh = window.innerHeight, vw = window.innerWidth;
  const shown = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    }
    return true;
  };
  const fully = (r) => r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= vh + 1 && r.left >= -1 && r.right <= vw + 1;
  // The fixed header covers the top of the viewport; text under it is not "visible" for this purpose.
  const nav = document.querySelector("nav[aria-label='Primary']");
  const navBottom = nav ? nav.getBoundingClientRect().bottom : 0;
  const leaves = [...document.querySelectorAll("main h1, main h2, main p, main a, main button, main li, main dt, main dd, main span, main div")]
    .filter((el) => shown(el) && [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()))
    .filter((el) => { const r = el.getBoundingClientRect(); return fully(r) && r.top >= navBottom - 1; })
    .map((el) => ({ t: el.textContent.replace(/\s+/g, " ").trim(), top: Math.round(el.getBoundingClientRect().top), left: Math.round(el.getBoundingClientRect().left) }));
  const text = leaves.map((l) => l.t).join(" \n ");
  const ctas = ctaSources.map((src) => {
    const re = new RegExp(src, "i");
    const el = [...document.querySelectorAll("main a, main button")].find((e) => shown(e) && re.test(e.textContent || ""));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { label: el.textContent.replace(/\s+/g, " ").trim(), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
      inView: fully(r), bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 40), color: cs.color, border: cs.borderTopWidth, weight: cs.fontWeight };
  });
  const h1 = document.querySelector("main h1");
  const els = ctaSources.map((src) => { const re = new RegExp(src, "i"); return [...document.querySelectorAll("main a, main button")].find((e) => shown(e) && re.test(e.textContent || "")); });
  const order = els.every(Boolean) && els.every((e, i) => i === 0 || Boolean(els[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING));
  return { text, ctas, order, h1: h1 ? h1.textContent.replace(/\s+/g, " ").trim() : null, h1Rect: h1 ? (({ top, bottom }) => ({ top: Math.round(top), bottom: Math.round(bottom) }))(h1.getBoundingClientRect()) : null,
    scrollW: document.documentElement.scrollWidth, innerW: vw, vh };
}

/** Runs in the page: focusable elements that a keyboard user can reach but a sighted user cannot see. */
function hiddenTabbableProbe() {
  const FOCUSABLE = "a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex='-1'])";
  const out = [];
  for (const el of document.querySelectorAll(FOCUSABLE)) {
    if (el.disabled) continue;
    let reason = null;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute("inert")) { reason = null; break; }
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden") { reason = null; break; }
      if (!reason) {
        if (n.getAttribute("aria-hidden") === "true") reason = "aria-hidden";
        else if (Number(s.opacity) === 0) reason = "opacity-0";
      }
    }
    if (reason) out.push(`${reason}: <${el.tagName.toLowerCase()}> ${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40)}`);
  }
  return out;
}

/** Runs in the page: the fixed or sticky elements covering the viewport, as px of height at the top and the bottom. */
function chromeProbe() {
  const vh = window.innerHeight, vw = window.innerWidth;
  const bars = [];
  for (const el of document.querySelectorAll("body *")) {
    const s = getComputedStyle(el);
    if (s.position !== "fixed" && s.position !== "sticky") continue;
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0 || s.pointerEvents === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= vh) continue;
    if (el.closest("[aria-hidden='true']")) continue;
    bars.push({ el: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${(el.getAttribute("class") || "").split(/\s+/).slice(0, 2).join(".")}`,
      top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width),
      bar: r.width >= vw * 0.9 });
  }
  const topBars = bars.filter((b) => b.bar && b.top < vh / 2);
  const bottomBars = bars.filter((b) => b.bar && b.top >= vh / 2);
  const px = (list) => { const s = new Set(); for (const b of list) for (let y = Math.max(0, b.top); y < Math.min(vh, b.bottom); y++) s.add(y); return s.size; };
  return { bars, topBarPx: px(topBars), bottomBarPx: px(bottomBars), totalPx: px([...topBars, ...bottomBars]), pct: Math.round((px([...topBars, ...bottomBars]) / vh) * 100), topCount: topBars.length, bottomCount: bottomBars.length };
}

async function newPage(browser, vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error" && !benign(m.text())) errs.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 200)));
  return { ctx, page, errs };
}

async function tabCount(page) {
  await page.evaluate(() => { (document.activeElement)?.blur?.(); window.scrollTo(0, 0); });
  await page.mouse.move(0, 0);
  let first = null, hero = null;
  for (let i = 1; i <= 40; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      return { text: (e.textContent || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60), inMain: Boolean(e.closest("main")), href: e.getAttribute("href") };
    });
    if (!info) continue;
    if (first === null && /try the free capacity check/i.test(info.text)) first = i;
    if (hero === null && info.inMain && /try the free capacity check/i.test(info.text)) { hero = i; break; }
  }
  return { firstPrimary: first, hero };
}

async function runViewport(browser, vp) {
  const { ctx, page, errs } = await newPage(browser, vp);
  const where = `home@${vp.name}`;
  await page.addInitScript(() => {
    window.__shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shifts.push({ v: e.value, t: Math.round(e.startTime), src: (e.sources || []).map((s) => (s.node ? `${s.node.tagName}.${String(s.node.className || "").slice(0, 40)} ${Math.round(s.previousRect.y)}->${Math.round(s.currentRect.y)}` : "?")) });
    }).observe({ type: "layout-shift", buffered: true });
  });
  const res = await page.goto(BASE + "/", { waitUntil: "networkidle" });
  if (!res || res.status() !== 200) fail(where, `status ${res && res.status()}`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${TAG}_home_${vp.name}_fold.png`) });
  const r = (report[vp.name] = {});

  // 1. First viewport content.
  const fold = await page.evaluate(foldProbe, CTAS.map((c) => c.source));
  r.h1 = fold.h1;
  r.fold = Object.fromEntries(Object.entries(QUESTIONS).map(([k, re]) => [k, re.test(fold.text)]));
  for (const [k, ok] of Object.entries(r.fold)) if (!ok) fail(where, `first viewport does not answer "${k}" from fully visible text`);
  r.worked = /synthetic reference hall/i.test(fold.text) && /as found/i.test(fold.text) && /with on-site supply/i.test(fold.text) && /Class E\d \(/.test(fold.text) && /weeks to full capacity/i.test(fold.text);
  if (!r.worked) fail(where, "the worked-result panel (synthetic reference hall, as found, with on-site supply, cost and time lines, evidence class) is not fully inside the first viewport");
  r.ctas = fold.ctas;
  if (fold.ctas.some((c) => !c)) fail(where, "one of the three calls to action is missing from the page");
  else {
    if (fold.ctas.some((c) => !c.inView)) fail(where, `a call to action is not fully inside the first viewport: ${fold.ctas.map((c) => `${c.label}@${c.top}-${c.bottom}`).join(" | ")}`);
    if (!fold.order) fail(where, "the three calls to action are not in the order primary, secondary, tertiary (document order)");
    const [p, s, t] = fold.ctas;
    const filled = (c) => c.bgImage !== "none" || !/rgba\(0, 0, 0, 0\)/.test(c.bg);
    if (!filled(p)) fail(where, "the primary call to action is not a filled button");
    if (filled(t)) fail(where, "the paid call to action is a filled button; it must be the tertiary (text/outline)");
    if (/rgb\(255, 176, 32\)/.test(p.bg + p.color + s.color)) fail(where, "the free path is still amber");
  }
  if (fold.scrollW > fold.innerW + 1) fail(where, `horizontal overflow ${fold.scrollW} > ${fold.innerW}`);

  // 2. Nothing focusable hidden from sight (at the top, and once the rail has appeared).
  r.hiddenTabbableTop = await page.evaluate(hiddenTabbableProbe);
  r.chromeTop = await page.evaluate(chromeProbe);

  // 3. Keyboard reach of the primary call to action.
  r.tab = await tabCount(page);
  if (r.tab.firstPrimary === null || r.tab.firstPrimary > TAB_BUDGET[vp.name]) fail(where, `first "Try the free capacity check" is Tab stop ${r.tab.firstPrimary} (budget ${TAB_BUDGET[vp.name]})`);
  if (r.tab.hero === null) fail(where, "the hero's primary call to action is not reachable by Tab within 40 stops");

  // 4. A full scroll: layout shift, then the chrome that is fixed over the page, and what is tabbable but hidden.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((res) => setTimeout(res, 250)); }
  });
  await page.waitForTimeout(2000);
  const shifts = await page.evaluate(() => window.__shifts);
  r.cls = Number(shifts.reduce((a, s) => a + s.v, 0).toFixed(3));
  r.clsTop = shifts.slice().sort((a, b) => b.v - a.v).slice(0, 3).map((s) => `${s.v.toFixed(3)}@${s.t}ms ${s.src.join(",")}`);
  if (r.cls > CLS_BUDGET) fail(where, `layout shift ${r.cls} over a full scroll (budget ${CLS_BUDGET})`);
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(500);
  r.chromeScrolled = await page.evaluate(chromeProbe);
  r.hiddenTabbableScrolled = await page.evaluate(hiddenTabbableProbe);
  for (const [k, list] of [["top", r.hiddenTabbableTop], ["scrolled", r.hiddenTabbableScrolled]]) {
    if (list.length) fail(where, `${list.length} focusable control(s) hidden from sight at ${k}: ${list.slice(0, 3).join("; ")}`);
  }
  // The budget is for the phone, where fixed chrome is a fifth of the screen; on a wide screen the section rail is a second, thin top bar.
  for (const [k, c] of vp.mobile ? [["top", r.chromeTop], ["scrolled", r.chromeScrolled]] : []) {
    if (c.topCount > 1 || c.bottomCount > 1) fail(where, `fixed chrome at ${k}: ${c.topCount} top / ${c.bottomCount} bottom bars (budget 1 + 1)`);
  }
  await page.screenshot({ path: path.join(OUT, `${TAG}_home_${vp.name}_scrolled.png`) });

  // 5. axe.
  try {
    const axePath = path.join(ROOT, "node_modules", "axe-core", "axe.min.js");
    if (fs.existsSync(axePath)) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.addScriptTag({ content: fs.readFileSync(axePath, "utf8") });
      const axe = await page.evaluate(async () => {
        const res = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
        return res.violations.map((v) => `${v.id} (${v.nodes.length})`);
      });
      r.axe = axe;
      if (axe.length) fail(where, `axe violations: ${axe.join(", ")}`);
    } else r.axe = "axe-core not installed";
  } catch (e) { r.axe = "axe failed: " + String(e).slice(0, 100); }

  r.errors = errs;
  if (errs.length) fail(where, "console: " + errs.join(" | "));
  await ctx.close();
}

async function mobileBubble(browser) {
  // The "Scope my site" launcher must not sit on top of a primary call to action or a form field. Checked on the page where fields matter
  // (the qualifier), at phone size, at several scroll positions.
  const vp = VIEWPORTS[1];
  const { ctx, page } = await newPage(browser, vp);
  await page.goto(BASE + "/qualify", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const overlaps = new Set();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 200) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(80);
    const o = await page.evaluate(() => {
      const b = document.querySelector("button[aria-label^='Scope my site']");
      if (!b) return { bubble: false, hits: [] };
      const cs = getComputedStyle(b);
      if (cs.visibility === "hidden") return { bubble: false, hits: [] };
      const a = b.getBoundingClientRect();
      const hits = [];
      for (const el of document.querySelectorAll("main input:not([type=hidden]), main select, main textarea, main button, main a[href]")) {
        if (el === b) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (a.left < r.right && r.left < a.right && a.top < r.bottom && r.top < a.bottom) hits.push((el.textContent || el.getAttribute("aria-label") || el.getAttribute("name") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40));
      }
      return { bubble: true, hits };
    });
    for (const h of o.hits) overlaps.add(h);
  }
  report.bubbleOverlapsOnQualify = [...overlaps];
  if (overlaps.size) fail("qualify@mobile", `the Scope-my-site launcher covers: ${[...overlaps].join(" | ")}`);
  await ctx.close();
}

async function cancelledBanner(browser) {
  const cases = [
    { url: "/qualify?purchase=cancelled", expect: true },
    { url: "/pricing?deposit=cancelled", expect: true },
    { url: "/qualify?purchase=cancelled&product=density_screen", expect: true, link: /\/products\/density-screen/ },
    { url: "/qualify?purchase=cancelled&product=%3Cscript%3Ealert(1)%3C%2Fscript%3E", expect: true, noReflect: "<script>" },
    { url: "/qualify?purchase=cancelled&product=https%3A%2F%2Fevil.example%2F", expect: true, noReflect: "evil.example" },
    { url: "/qualify?purchase=%3Cb%3Ex%3C%2Fb%3E", expect: false },
    { url: "/qualify", expect: false },
    { url: "/pricing?deposit=success", expect: false },
  ];
  for (const vp of VIEWPORTS) {
    for (const c of cases) {
      const { ctx, page, errs } = await newPage(browser, vp);
      const where = `banner ${c.url}@${vp.name}`;
      await page.goto(BASE + c.url, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      const banner = page.locator("[data-testid='checkout-cancelled']");
      const n = await banner.count();
      if (Boolean(n) !== c.expect) fail(where, c.expect ? "no 'Checkout cancelled' banner" : "a banner appeared although nothing was cancelled");
      if (n) {
        const txt = (await banner.innerText()).replace(/\s+/g, " ");
        if (!/checkout cancelled/i.test(txt) || !/nothing was charged/i.test(txt)) fail(where, `wrong words: ${txt}`);
        const hrefs = await banner.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
        if (!hrefs.some((h) => h === "/qualify")) fail(where, `no link to the free check: ${hrefs}`);
        for (const h of hrefs) if (!/^\/[a-z0-9\-/]*$/i.test(h || "")) fail(where, `a link that is not a relative site path: ${h}`);
        if (c.link && !hrefs.some((h) => c.link.test(h))) fail(where, `expected a link back to the product page, got ${hrefs}`);
        if (c.noReflect && (await banner.innerHTML()).includes(c.noReflect)) fail(where, `reflected hostile input ${c.noReflect}`);
        // The notice is in the flow: it must not cover the page's H1, and its own links and button must be what a click on them reaches.
        const geo = await page.evaluate(() => {
          const h1 = document.querySelector("main h1");
          const b = document.querySelector("[data-testid='checkout-cancelled']");
          const hit = (el) => { const r = el.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12)); return Boolean(e && (e === el || el.contains(e))); };
          const card = b.firstElementChild; // the visible box; the outer element also carries the padding that clears the header
          const br = card.getBoundingClientRect(), hr = h1.getBoundingClientRect();
          return { h1Hit: hit(h1), h1Top: Math.round(hr.top), bannerBottom: Math.round(br.bottom), bannerTop: Math.round(br.top), navBottom: Math.round(document.querySelector("nav[aria-label='Primary']").getBoundingClientRect().bottom),
            controlsHit: [...b.querySelectorAll("a,button")].every(hit), positions: [...new Set([b, b.firstElementChild].map((e) => getComputedStyle(e).position))] };
        });
        if (!geo.h1Hit) fail(where, "the page H1 is covered by something (elementFromPoint does not reach it)");
        if (geo.h1Top < geo.bannerBottom) fail(where, `the H1 (top ${geo.h1Top}) starts above the notice's bottom (${geo.bannerBottom})`);
        if (geo.bannerTop < geo.navBottom - 1) fail(where, `the notice (top ${geo.bannerTop}) sits under the header (bottom ${geo.navBottom})`);
        if (!geo.controlsHit) fail(where, "a link or the dismiss button inside the notice is covered (elementFromPoint misses it)");
        if (geo.positions.some((p) => p === "fixed" || p === "sticky")) fail(where, `the notice is ${geo.positions.join("/")} positioned`);
        // The announcement: an EMPTY live region exists from the start and is filled after the notice appears.
        const live = await page.locator("[data-testid='checkout-cancelled-live']").innerText();
        if (!/checkout cancelled/i.test(live)) fail(where, `the live region was not filled: "${live}"`);
        if (c.url.startsWith("/qualify?purchase=cancelled") && !c.noReflect && !c.link) {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(250);
          if (await banner.count()) fail(where, "Escape does not dismiss the notice");
          else report[`escapeDismissOk_${vp.name}`] = true;
          if (/purchase=cancelled/.test(page.url())) fail(where, "the marker is still in the address after dismissing");
          if (await page.locator("[data-testid='checkout-cancelled-live']").innerText()) fail(where, "the live region was not cleared with the notice");
        } else if (c.url === "/pricing?deposit=cancelled") {
          await banner.getByRole("button", { name: /dismiss/i }).click();
          await page.waitForTimeout(200);
          if (await banner.count()) fail(where, "the dismiss button does not dismiss");
          else report[`dismissOk_${vp.name}`] = true;
        }
      } else {
        // not shown: the live region is still there and empty
        const live = await page.locator("[data-testid='checkout-cancelled-live']").count();
        if (!live) fail(where, "the empty live region is not in the shell");
      }
      if (errs.length) fail(where, "console: " + errs.join(" | "));
      await ctx.close();
    }

    // The remembered product: names the page on /qualify, is consumed, is stale after an hour, and is never used on /pricing.
    for (const [label, setup, url, expectLink, expectCleared] of [
      ["remembered, fresh, on /qualify", { id: "density_screen", ageMs: 1000 }, "/qualify?purchase=cancelled", /\/products\/density-screen/, true],
      ["remembered but stale (2 h)", { id: "density_screen", ageMs: 2 * 3600 * 1000 }, "/qualify?purchase=cancelled", null, true],
      ["remembered, on /pricing", { id: "density_screen", ageMs: 1000 }, "/pricing?deposit=cancelled", null, true],
      ["hostile remembered id", { id: "<script>", ageMs: 1000 }, "/qualify?purchase=cancelled", null, true],
    ]) {
      const { ctx, page } = await newPage(browser, vp);
      const where = `remembered ${label}@${vp.name}`;
      await page.goto(BASE + "/qualify", { waitUntil: "networkidle" });
      await page.evaluate(({ id, ageMs }) => sessionStorage.setItem("gf:last-checkout-product", JSON.stringify({ id, at: Date.now() - ageMs })), setup);
      await page.goto(BASE + url, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      const hrefs = await page.locator("[data-testid='checkout-cancelled'] a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
      if (expectLink ? !hrefs.some((h) => expectLink.test(h)) : hrefs.some((h) => /\/products\/[a-z]/.test(h || ""))) fail(where, `links were ${hrefs}`);
      const left = await page.evaluate(() => sessionStorage.getItem("gf:last-checkout-product"));
      if (expectCleared && left !== null) fail(where, "the remembered id was not cleared");
      await ctx.close();
    }
  }
}

async function assistantMenu(browser) {
  const vp = VIEWPORTS[1];
  for (const [route, offered] of [["/", true], ["/pricing", true], ["/workspace", false], ["/observatory", false]]) {
    const { ctx, page, errs } = await newPage(browser, vp);
    const where = `assistant menu ${route}@mobile`;
    await page.goto(BASE + route, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    await page.locator("#main-menu-toggle").click();
    const entry = page.getByRole("button", { name: /Ask the scoping assistant \(AI\)/ });
    const n = await entry.count();
    if (Boolean(n) !== offered) fail(where, offered ? "the menu has no assistant entry" : "the menu offers an assistant that does not exist on this page (dead control)");
    if (offered && n) {
      await entry.click();
      const dlg = page.getByRole("dialog", { name: /scoping assistant/i });
      await dlg.waitFor({ timeout: 15000 }).catch(() => fail(where, "the assistant did not open from the menu"));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      const focused = await page.evaluate(() => { const e = document.activeElement; const r = e && e.getBoundingClientRect(); return { id: e && e.id, visible: Boolean(r && r.width > 0 && r.height > 0) }; });
      if (focused.id !== "main-menu-toggle" || !focused.visible) fail(where, `focus after closing the assistant is ${JSON.stringify(focused)}, not the visible menu button`);
      else report.assistantFocusReturnOk = true;
    }
    if (errs.length) fail(where, "console: " + errs.join(" | "));
    await ctx.close();
  }
}

async function signInMenu(browser) {
  const vp = VIEWPORTS[0];
  const { ctx, page } = await newPage(browser, vp);
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const btn = page.getByRole("button", { name: /^Sign in$/ });
  await btn.focus();
  await page.keyboard.press("Enter");
  if ((await btn.getAttribute("aria-expanded")) !== "true") fail("sign-in menu", "does not open from the keyboard");
  await page.keyboard.press("Tab"); // into the first item
  if ((await btn.getAttribute("aria-expanded")) !== "true") fail("sign-in menu", "closed while focus was still inside it");
  await page.keyboard.press("Tab"); // second item
  await page.keyboard.press("Tab"); // out of the menu
  await page.waitForTimeout(150);
  if ((await btn.getAttribute("aria-expanded")) !== "false") fail("sign-in menu", "still open after Tab left it");
  if (await page.locator("#sign-in-menu").count()) fail("sign-in menu", "the list is still in the page after Tab left it");
  report.signInMenuTabOutOk = (await btn.getAttribute("aria-expanded")) === "false";
  await ctx.close();
}

async function observatoryHeader(browser) {
  for (const vp of VIEWPORTS) {
    const { ctx, page } = await newPage(browser, vp);
    await page.goto(BASE + "/observatory", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    // A paid CALL TO ACTION is a button that starts checkout (the observatory's own FunnelCta links to the product page, by design).
    const paid = await page.evaluate(() => [...document.querySelectorAll("button")].filter((e) => /€\s?\d|density screen/i.test(e.textContent || "") && e.getBoundingClientRect().width > 0 && !e.closest("[aria-hidden='true']")).map((e) => (e.textContent || "").trim().slice(0, 60)));
    report[`observatoryPaid_${vp.name}`] = paid;
    if (paid.length) fail(`observatory@${vp.name}`, `a paid call to action is on the page: ${paid.join(" | ")}`);
    await ctx.close();
  }
}

try {
  if (!EXTERNAL) {
    server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: ROOT, stdio: "ignore", detached: true, env: { ...process.env, NODE_ENV: "production" } });
  }
  await up();
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  for (const vp of VIEWPORTS) await runViewport(browser, vp);
  await mobileBubble(browser);
  await cancelledBanner(browser);
  await assistantMenu(browser);
  await signInMenu(browser);
  await observatoryHeader(browser);
  await browser.close();
} catch (err) {
  console.error("first-screen journey could not run:", err && err.message ? err.message : err);
  if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ } }
  process.exit(2);
}
if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ } }

fs.writeFileSync(path.join(OUT, `${TAG}_report.json`), JSON.stringify({ report, failures }, null, 1));
console.log(JSON.stringify(report, null, 1));
console.log(`\nscreenshots and report: ${OUT}`);
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):\n  ` + failures.join("\n  "));
  process.exit(1);
}
console.log("\nfirst-screen journey: all checks passed");
