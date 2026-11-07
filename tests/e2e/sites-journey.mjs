#!/usr/bin/env node
/**
 * Rendered-browser check of /account/sites: the production build, a REAL PostgreSQL with migrations 0049-0051 behind REAL PostgREST, and a
 * stand-in for Supabase Auth, driven in Chromium at 1440 and 390 px with the keyboard.
 *
 * MANUAL: no CI job runs this file (Playwright is not a project dependency). What it proves: the page renders for a verified session, a person can
 * create an organisation, a site, a hall and record a figure by keyboard alone, errors are announced in role=alert, unrecorded fields read "missing",
 * the page does not overflow sideways, and nothing throws in the console. What it does NOT prove: Supabase Auth itself (the session is a stand-in:
 * the bearer `tok:<email>` verifies as that address, `unv:<email>` as an unconfirmed one), or a deployment.
 *
 *   # 1. a fresh database and PostgREST (a PostgreSQL superuser in PG*; see scripts/realdb-up.sh)
 *   bash scripts/realdb-up.sh && . /tmp/gf-realdb/realdb.env
 *   # 2. a build that knows where "Supabase" is (the auth stand-in below listens on E2E_AUTH_PORT, default 3951)
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3951 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-test npm run build
 *   # 3. drive it
 *   GF_PGRST_URL=$GF_PGRST_URL GF_PGRST_JWT=$GF_PGRST_JWT node tests/e2e/sites-journey.mjs [screenshot-dir]
 *
 * Exit codes: 0 all passed, 1 a check failed, 2 the browser or the stack could not run (nothing was driven).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright"));
} catch (err) {
  console.error(`sites journey NOT RUN: Playwright could not be loaded (${err instanceof Error ? err.message.split("\n")[0] : err}). Set PLAYWRIGHT_MODULE.`);
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PGRST = process.env.GF_PGRST_URL, JWT = process.env.GF_PGRST_JWT;
if (!PGRST || !JWT) { console.error("sites journey NOT RUN: GF_PGRST_URL / GF_PGRST_JWT are not set (scripts/realdb-up.sh writes them)."); process.exit(2); }
const AUTH_PORT = Number(process.env.E2E_AUTH_PORT || 3951), SITE_PORT = Number(process.env.E2E_SITE_PORT || 3917);
const SHOTS = process.argv[2] || "";
const AUTH = `http://127.0.0.1:${AUTH_PORT}`, SITE = `http://127.0.0.1:${SITE_PORT}`;

const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${detail}`}`); if (!ok) failures.push(name); };
const uid = () => crypto.randomBytes(4).toString("hex");

// ---- the stand-in: Supabase Auth's /auth/v1/user, and /rest/v1/* forwarded to the real PostgREST
const gateway = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = req.url || "";
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.startsWith("/auth/v1/user")) {
    const m = /^Bearer (tok|unv):(.+)$/.exec(req.headers.authorization || "");
    if (!m) return send(401, {});
    return send(200, { email: m[2], ...(m[1] === "tok" ? { email_confirmed_at: "2026-01-01T00:00:00Z" } : {}) });
  }
  if (!url.startsWith("/rest/v1/")) return send(404, {});
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length"].includes(k)) headers[k] = v;
  const r = await fetch(PGRST + url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method || "") ? undefined : Buffer.concat(chunks) });
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => gateway.listen(AUTH_PORT, "127.0.0.1", r));

const server = spawn("npx", ["next", "start", "-p", String(SITE_PORT)], {
  cwd: ROOT, stdio: "ignore", detached: true,
  env: {
    ...process.env, NODE_ENV: "production", SUPABASE_URL: AUTH, SUPABASE_SERVICE_ROLE_KEY: JWT, NEXT_PUBLIC_SUPABASE_URL: AUTH, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test",
    GRIDFORGE_TRUSTED_IP_HEADER: "x-forwarded-for", RATE_LIMIT_HMAC_KEY: "sites-journey-rate-limit-key-0123456789abcdef",
  },
});
const stop = async () => { try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ } gateway.close(); };
process.on("exit", () => { try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ } });

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(SITE + "/account/login")).ok; } catch { /* not yet */ } if (!up) await new Promise((r) => setTimeout(r, 500)); }
  if (!up) { console.error("sites journey NOT RUN: the site did not come up (was it built with NEXT_PUBLIC_SUPABASE_URL=" + AUTH + "?)"); await stop(); process.exit(2); }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--no-sandbox"] });
  const benign = (t) => /Failed to load resource|status of (4|5)\d\d/.test(t);       // a refused request is the app's honest answer, not a defect

  async function session(width, height, token, label) {
    const ctx = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` } });
    if (token) {
      await ctx.addInitScript(([key, value]) => { try { localStorage.setItem(key, value); } catch { /* blocked */ } }, [
        "sb-127-auth-token",
        JSON.stringify({ access_token: token, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: crypto.randomUUID(), email: token.replace(/^[a-z]+:/, ""), aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" } }),
      ]);
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error" && !benign(m.text())) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    return { ctx, page, errors, label };
  }

  /** Press Tab until the focused element has this id; returns how many presses it took (or -1). */
  async function tabTo(page, id, max = 80) {
    for (let n = 1; n <= max; n++) {
      await page.keyboard.press("Tab");
      if ((await page.evaluate(() => document.activeElement?.id || "")) === id) return n;
    }
    return -1;
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true }); } };

  // ---- signed out, and signed in with an unconfirmed address
  {
    const s = await session(1440, 900, null, "signed-out");
    await s.page.goto(SITE + "/account/sites");
    await s.page.waitForURL(/\/account\/login/, { timeout: 15000 }).catch(() => {});
    check("signed out: /account/sites sends the visitor to sign in", /\/account\/login/.test(s.page.url()), s.page.url());
    await s.ctx.close();
    const u = await session(1440, 900, `unv:unconfirmed-${uid()}@journey.example`, "unconfirmed");
    await u.page.goto(SITE + "/account/sites");
    const confirm = u.page.locator("[role=alert]", { hasText: "Confirm your email" });
    await confirm.waitFor({ timeout: 15000 }).catch(() => {});
    check("an unconfirmed address is told to confirm and sees no data", (await confirm.count()) === 1 && (await u.page.locator("table").count()) === 0);
    await u.ctx.close();
  }

  // ---- the journey, at both widths
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const me = `editor-${uid()}@journey.example`;
    const { ctx, page, errors } = await session(width, height, `tok:${me}`, `${width}px`);
    const at = (s) => `${width}px: ${s}`;
    await page.goto(SITE + "/account/sites");
    await page.getByRole("heading", { name: "What is recorded about your halls" }).waitFor({ timeout: 20000 });
    check(at("the page renders for a verified session"), true);
    check(at("the honest-reading panel is there"), /declaration/.test(await page.locator("#honesty").locator("xpath=..").innerText()));
    check(at("with no organisation it says so"), await page.getByText("You are not in an organisation yet").isVisible());

    // organisation, by keyboard
    const toOrg = await tabTo(page, "new-org-name");
    check(at("keyboard reaches the organisation field"), toOrg > 0, `tabs: ${toOrg}`);
    await page.keyboard.type(`Acme ${uid()}`);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { level: 2 }).filter({ hasText: "your role: owner" }).waitFor({ timeout: 15000 });
    check(at("an organisation is created by keyboard and the creator is its owner"), true);

    // site: the data kind is required; the error is announced in role=alert and takes focus
    await page.locator('[id^="new-site-"][id$="-name"]').fill(`Dublin ${uid()}`);
    await page.getByRole("button", { name: "Add site" }).click();
    const alert1 = page.locator("form[aria-labelledby$='-title'] [role=alert]", { hasText: "production, test or synthetic" });
    await alert1.waitFor({ timeout: 5000 });
    check(at("a site without a data kind is refused in an alert"), true);
    check(at("the alert takes focus"), await alert1.evaluate((el) => el === document.activeElement));
    await page.locator('[id^="new-site-"][id$="-origin"]').selectOption("synthetic");
    await page.locator('[id^="new-site-"][id$="-country"]').fill("IE");
    await page.getByRole("button", { name: "Add site" }).click();
    await page.getByText("Data kind: synthetic").waitFor({ timeout: 15000 });
    check(at("a site is added and shows its data kind"), true);

    // hall
    await page.getByLabel("New hall label").fill("Hall A1");
    await page.getByRole("button", { name: "Add hall" }).click();
    await page.getByRole("button", { name: "Hall A1" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Hall A1" }).click();
    await page.getByRole("table").waitFor({ timeout: 15000 });
    const rows = page.locator("tbody tr");
    check(at("every expected field is listed and every one reads missing"), (await rows.count()) === 8 && (await page.locator("tbody td", { hasText: /^missing$/ }).count()) >= 16);
    check(at("no empty cell in the figures table"), (await page.locator("tbody td:empty").count()) === 0);
    check(at("the table says origin and class are declared"), /declared by the person who recorded the figure/.test(await page.locator("caption").innerText()));

    // a measured figure without a file is refused before it is sent; an assumed one is recorded
    await page.getByLabel("Field", { exact: true }).fill("grid.firm_capacity_MVA");
    await page.getByLabel("Origin").selectOption("measured");
    await page.getByLabel("Value", { exact: true }).fill("40");
    check(at("choosing a field fills in its usual unit"), (await page.getByLabel("Unit (optional)").inputValue()) === "MVA");
    await page.getByRole("button", { name: "Record figure" }).click();
    const alert2 = page.locator("[role=alert]", { hasText: "needs a source file" });
    await alert2.first().waitFor({ timeout: 5000 });
    check(at("a measured figure without a source file is refused in an alert"), true);
    await page.getByLabel("Origin").selectOption("assumed");
    check(at("an assumed figure is not offered a class above E3"), await page.locator('#rec-class option[value="E5"]').isDisabled());
    await page.getByLabel("Declared evidence class (your declaration)").selectOption("E1");
    await page.getByRole("button", { name: "Record figure" }).click();
    await page.locator("tbody tr", { hasText: "40 MVA" }).waitFor({ timeout: 15000 });
    const row = await page.locator("tbody tr", { hasText: "40 MVA" }).innerText();
    check(at("the figure is recorded with origin, class, date and recorder"), /declared assumed/.test(row) && /E1/.test(row) && /20\d\d-\d\d-\d\d/.test(row) && row.includes(me), row.replace(/\s+/g, " "));
    check(at("an assumed figure is not shown as measured"), !/measured|verified/i.test(row));

    // a correction replaces it and says so
    await page.getByLabel("Field", { exact: true }).fill("grid.firm_capacity_MVA");
    check(at("recording over a field says it will replace it"), await page.getByText("Your entry will replace it; the earlier figure stays in the history.").isVisible());
    await page.getByLabel("Value", { exact: true }).fill("42");
    await page.getByRole("button", { name: "Record a correction" }).click();
    await page.locator("tbody tr", { hasText: "42 MVA" }).waitFor({ timeout: 15000 }).catch(async () => {
      console.log("  correction did not appear; alerts:", JSON.stringify(await page.locator("[role=alert]").allInnerTexts()));
    });
    check(at("the correction is current and the old figure is no longer in the current table"), (await page.locator("tbody tr", { hasText: "40 MVA" }).count()) === 0);
    await page.locator("ol li", { hasText: "40 MVA" }).waitFor({ timeout: 15000 });
    check(at("the timeline keeps the replaced figure, marked as replaced"), /replaced by a later figure/.test(await page.locator("ol li", { hasText: "40 MVA" }).innerText()));

    // the history of a field is one click away and keeps the replaced figure
    await page.getByRole("button", { name: "History of grid.firm_capacity_mva" }).click();
    const hist = page.locator("#history-title");
    await hist.waitFor({ timeout: 10000 });
    await page.locator("section[aria-labelledby=history-title] li", { hasText: "40 MVA" }).waitFor({ timeout: 10000 });
    const histText = await page.locator("section[aria-labelledby=history-title]").innerText();
    check(at("the field's history lists the replaced figure and the current one"), /40 MVA/.test(histText) && /replaced by a later figure/.test(histText) && /42 MVA/.test(histText) && /current/.test(histText), histText.replace(/\s+/g, " ").slice(0, 200));
    check(at("opening the history moves focus to its heading"), await hist.evaluate((el) => el === document.activeElement));
    await page.getByRole("button", { name: "Close history" }).click();

    // more than a page of events: the page says older events are not shown, and "Load older" brings every one exactly once
    const made = await page.evaluate(async () => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const tok = JSON.parse(localStorage.getItem(key)).access_token;
      const h = { Authorization: "Bearer " + tok, "Content-Type": "application/json" };
      const sites = await (await fetch("/api/sites", { headers: h })).json();
      const hall = sites.sites[0].halls[0].id;
      let ok = 0;
      for (let i = 0; i < 33; i++) {
        const r = await fetch(`/api/halls/${hall}/inputs`, { method: "POST", headers: h, body: JSON.stringify({ fieldPath: `bulk.f${i}`, value: i, evidenceClass: "E1", origin: "assumed", asOf: "2026-01-01" }) });
        if (r.status === 201) ok++;
      }
      return ok;
    });
    check(at("33 more figures were recorded (setup)"), made === 33, String(made));
    await page.reload();
    await page.getByRole("button", { name: "Hall A1" }).click();
    await page.locator("ol li").first().waitFor({ timeout: 15000 });
    check(at("a full page of events says older ones are not shown"), await page.getByText(/Older events are not shown\. This is the newest 30\./).isVisible());
    const firstPage = await page.locator("main ol li, ol li").count();
    const load = page.getByRole("button", { name: "Load older events" });
    await load.focus();
    await page.keyboard.press("Enter");
    await page.getByText(/Older events are not shown/).waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
    const total = await page.locator("ol li").count();
    check(at("Load older (by keyboard) brings the rest and the notice goes away"), total > firstPage && (await page.getByText(/Older events are not shown/).count()) === 0, `${firstPage} -> ${total}`);
    const texts = await page.locator("ol li").allInnerTexts();
    check(at("no event is shown twice"), new Set(texts.map((t) => t.replace(/\s+/g, " "))).size === texts.length, `${texts.length} items`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(at("no sideways scroll of the page"), overflow <= 1, `overflow ${overflow}px`);
    await shot(page, `sites-${width}`);
    check(at("no console errors"), errors.length === 0, errors.join(" | ").slice(0, 400));
    await ctx.close();
  }
  // ---- a person who was ADDED to an organisation is told by whom and can leave
  {
    const boss = `boss-${uid()}@journey.example`, guest = `guest-${uid()}@journey.example`;
    const site = async (who, path, method = "GET", body) => (await fetch(SITE + path, { method, headers: { Authorization: `Bearer tok:${who}`, "x-forwarded-for": "198.51.100.77", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
    const org = (await site(boss, "/api/orgs", "POST", { name: `Boss org ${uid()}` })).org.id;
    await site(boss, `/api/orgs/${org}/members`, "POST", { email: guest, role: "viewer" });
    const g = await session(1440, 900, `tok:${guest}`, "guest");
    g.page.on("dialog", (d) => d.accept());
    await g.page.goto(SITE + "/account/sites");
    const note = g.page.getByRole("group", { name: /You were added to/ });
    await note.waitFor({ timeout: 20000 });
    const noteText = await note.innerText();
    check("an added member is told who added them and that they did not have to accept", noteText.includes(boss) && /did not have to accept/.test(noteText), noteText.replace(/\s+/g, " ").slice(0, 160));
    await g.page.getByRole("button", { name: /^Leave / }).click();
    await note.waitFor({ state: "detached", timeout: 15000 });
    const mine = await site(guest, "/api/orgs");
    check("leaving removes the organisation at once, on the server too", mine.ok && mine.orgs.length === 0);
    check("no console errors for the added member", g.errors.length === 0, g.errors.join(" | ").slice(0, 300));
    await g.ctx.close();
  }
  await browser.close();
} catch (err) {
  console.error("sites journey ERROR:", err instanceof Error ? err.message : err);
  failures.push("journey threw");
}
await stop();
console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
