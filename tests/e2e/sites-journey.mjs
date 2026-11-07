#!/usr/bin/env node
/**
 * Rendered-browser check of /account/sites: the production build, a REAL PostgreSQL with migrations 0049-0051 behind REAL PostgREST, and a
 * stand-in for Supabase Auth, driven in Chromium at 1440 and 390 px with the keyboard.
 *
 * MANUAL: no CI job runs this file (Playwright is not a project dependency). What it proves: the page renders for a verified session, a person can
 * create an organisation, a site, a hall and record a figure by keyboard alone, errors are announced in role=alert, unrecorded fields read "missing",
 * the page does not overflow sideways, and nothing throws in the console. It also drives the hall's EXPORT (JSON and CSV downloads, read back from disk),
 * IMPORT (template, a bounded file, the mandatory preview with rejected rows and their reasons, nothing written before the keyboard-operated confirm, the
 * report, a second identical import writing nothing) and the "what changed" diff (two points and one field's steps; a claim is back-dated in the real
 * database with psql for this, so the PG* variables must point at the database behind PostgREST), then runs axe (WCAG 2 A/AA) with those panels open.
 * What it does NOT prove: Supabase Auth itself (the session is a stand-in:
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
import { execFileSync, spawn } from "node:child_process";
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
    // the timeline's first page is fetched again after a write (and only that): wait for the replaced marker to arrive
    const replacedLine = page.locator("ol li", { hasText: /40 MVA.*replaced by a later figure/s });
    await replacedLine.first().waitFor({ timeout: 15000 }).catch(() => {});
    check(at("the timeline keeps the replaced figure, marked as replaced"), (await replacedLine.count()) >= 1);

    // the history of a field is one click away and keeps the replaced figure
    await page.getByRole("button", { name: "History of grid.firm_capacity_mva" }).click();
    const hist = page.locator("#history-title");
    await hist.waitFor({ timeout: 10000 });
    await page.locator("section[aria-labelledby=history-title] li", { hasText: "40 MVA" }).waitFor({ timeout: 10000 });
    const histText = await page.locator("section[aria-labelledby=history-title]").innerText();
    check(at("the field's history lists the replaced figure and the current one"), /40 MVA/.test(histText) && /replaced by a later figure/.test(histText) && /42 MVA/.test(histText) && /current/.test(histText), histText.replace(/\s+/g, " ").slice(0, 700));
    check(at("opening the history moves focus to its heading"), await hist.evaluate((el) => el === document.activeElement));
    await page.getByRole("button", { name: "Close history" }).click();

    // ---- EXPORT: three downloads, read back from disk
    const download = async (name) => {
      const [d] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.getByRole("button", { name }).click()]);
      return { name: d.suggestedFilename(), text: fs.readFileSync(await d.path(), "utf8") };
    };
    const figs = await download("Download CSV: current figures");
    check(at("export: the figures CSV carries the declaration, the columns, the figure with its declared origin and class, and who recorded it"),
      /declaration of the person who recorded each figure/.test(figs.text) && /field_path,value,unit,declared_origin,declared_class,as_of,source_file_name/.test(figs.text)
      && /grid\.firm_capacity_mva,42,MVA,assumed,E1,/.test(figs.text) && figs.text.includes(me) && /^gridforge-hall-a1-figures-\d{4}-\d\d-\d\d\.csv$/.test(figs.name), figs.name + " " + figs.text.slice(0, 300));
    await page.locator("[role=status]", { hasText: "Downloaded gridforge-hall-a1-figures" }).waitFor({ timeout: 5000 });
    check(at("export: the download is announced in a status region"), true);
    const rec = await download("Download JSON (figures and timeline)");
    const recDoc = JSON.parse(rec.text.replace(/^﻿/, ""));
    check(at("export: the JSON record has the declaration, the replaced figure's id, a complete timeline, and no storage reference or token"),
      /declaration of the person who recorded/.test(recDoc.declaration) && recDoc.timelineComplete === true && recDoc.timeline.length >= 2 && typeof recDoc.currentInputs[0].supersedesId === "string"
      && recDoc.currentInputs[0].declaredOrigin === "assumed" && !/storage|token|sha256/i.test(rec.text), rec.text.slice(0, 300));
    const tlc = await download("Download CSV: timeline");
    check(at("export: the timeline CSV is oldest first and keeps the replaced figure"), /replaced_by_later_figure/.test(tlc.text) && /grid\.firm_capacity_mva = 40 MVA/.test(tlc.text) && tlc.text.indexOf("= 40 MVA") < tlc.text.indexOf("= 42 MVA"));

    // ---- IMPORT: template, refusals before the preview, the preview, the confirm, the report
    const tpl = await download("Download CSV template");
    check(at("import: the template lists the expected fields with their units and no figures"), /holds no real data/.test(tpl.text) && /grid\.firm_capacity_mva,,MVA,,,,,/.test(tpl.text) && (tpl.text.match(/^[a-z0-9_.]+,,/gm) || []).length === 8);
    const importAlert = page.locator("section[aria-labelledby=import-title] [role=alert]");
    await page.locator("#import-file").setInputFiles({ name: "huge.csv", mimeType: "text/csv", buffer: Buffer.alloc(300 * 1024, "a") });
    await importAlert.filter({ hasText: "256 KB" }).waitFor({ timeout: 5000 });
    check(at("import: a file over 256 KB is refused before it is read, in an alert that takes focus"), await importAlert.evaluate((el) => el === document.activeElement));
    await page.locator("#import-file").setInputFiles({ name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from("field_path,origin,class,as_of,notes\nx,assumed,E0,2026-01-01,hi\n") });
    await importAlert.filter({ hasText: "Unknown column" }).waitFor({ timeout: 5000 });
    check(at("import: an unknown column refuses the whole file by name"), (await page.locator("tbody tr[data-status]").count()) === 0);
    const importCsv = [
      "field_path,value,unit,origin,class,as_of,source_kind,source_id",
      "GRID.firm_capacity_MVA,44,MVA,assumed,E1,2026-10-01,,",
      "grid.contracted_mw,30,MW,assumed,E1,2026-10-01,,",
      "hall.floor_loading_kpa,12,kPa,assumed,E5,2026-10-01,,",
      "grid.firm_capcity_mva,9,MVA,assumed,E0,2026-10-01,,",
      "\"=cmd|' /C calc'!A0\",1,,assumed,E0,2026-10-01,,",
      "hall.rack_positions,100,,measured,E3,2026-10-01,,",
    ].join("\n");
    const serverInputs = () => page.evaluate(async (hallLabel) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const h = { Authorization: "Bearer " + JSON.parse(localStorage.getItem(key)).access_token };
      const sites = await (await fetch("/api/sites", { headers: h })).json();
      const hall = sites.sites.flatMap((x) => x.halls).find((x) => x.label === hallLabel).id;
      return { ...(await (await fetch(`/api/halls/${hall}/inputs`, { headers: h })).json()), hallId: hall };
    }, "Hall A1");
    await page.locator("#import-file").setInputFiles({ name: "figures.csv", mimeType: "text/csv", buffer: Buffer.from(importCsv) });
    const previewTitle = page.locator("#import-preview-title");
    await previewTitle.waitFor({ timeout: 15000 });
    check(at("import: the preview heading takes focus and says nothing has been written"), (await previewTitle.evaluate((el) => el === document.activeElement)) && /nothing has been written yet/.test(await previewTitle.innerText()));
    const statuses = await page.locator("section[aria-labelledby=import-title] tbody tr[data-status]").evaluateAll((trs) => trs.map((t) => t.getAttribute("data-status")));
    check(at("import: every row has a status: replaces, new, three rejected"), JSON.stringify(statuses) === JSON.stringify(["supersede", "new", "rejected", "rejected", "rejected", "rejected"]), JSON.stringify(statuses));
    const previewText = await page.locator("section[aria-labelledby=import-title]").innerText();
    check(at("import: the summary counts add up"), /6 rows: 1 new, 1 replacing a current figure, 0 unchanged, 4 rejected/.test(previewText.replace(/\s+/g, " ")), previewText.replace(/\s+/g, " ").slice(0, 400));
    check(at("import: the class cap, the unknown path, the hostile path and the missing source are rejected with their reason BEFORE anything is sent"),
      /cannot claim a class above E3; E5 is refused/.test(previewText) && /not a field this registry knows/.test(previewText) && /not a dotted path/.test(previewText) && /measured figure needs a source file/.test(previewText));
    check(at("import: a supersede names what it replaces and says the earlier figure stays"), /Replaces: 42 MVA, declared assumed, declared class E1.*earlier figure stays in the history/s.test(previewText));
    const before = await serverInputs();
    check(at("import: previewing wrote nothing"), before.inputs.length === 1 && before.inputs[0].value === 42, JSON.stringify(before.inputs.map((i) => i.fieldPath)));
    const confirmBtn = page.locator("#import-confirm");
    check(at("import: the confirm is disabled until the replacement is acknowledged"), await confirmBtn.isDisabled());
    await page.locator("#import-confirm-replace").focus();
    await page.keyboard.press("Space");
    check(at("import: the acknowledgement is operated by keyboard and enables the confirm"), (await page.locator("#import-confirm-replace").isChecked()) && (await confirmBtn.isEnabled()));
    await confirmBtn.focus();
    await page.keyboard.press("Enter");
    const reportTitle = page.locator("#import-report-title");
    await reportTitle.waitFor({ timeout: 30000 });
    check(at("import: the report says it finished and takes focus"), /Import finished/.test(await reportTitle.innerText()) && (await reportTitle.evaluate((el) => el === document.activeElement)));
    await page.locator("tbody tr", { hasText: "44 MVA" }).waitFor({ timeout: 15000 });
    await page.locator("tbody tr", { hasText: "30 MW" }).waitFor({ timeout: 15000 });
    const after = await serverInputs();
    check(at("import: the figures table shows exactly the written rows, and the server holds exactly them"),
      after.inputs.length === 2 && after.inputs.find((i) => i.fieldPath === "grid.firm_capacity_mva")?.value === 44 && after.inputs.find((i) => i.fieldPath === "grid.contracted_mw")?.origin === "assumed", JSON.stringify(after.inputs.map((i) => [i.fieldPath, i.value])));
    const reportText = await page.locator("section[aria-labelledby=import-title]").innerText();
    check(at("import: the report counts what was written"), /2 figures written to Hall A1/.test(reportText.replace(/\s+/g, " ")));
    await page.locator("#import-file").setInputFiles({ name: "figures.csv", mimeType: "text/csv", buffer: Buffer.from(importCsv) });
    await previewTitle.waitFor({ timeout: 15000 });
    const again = (await page.locator("section[aria-labelledby=import-title]").innerText()).replace(/\s+/g, " ");
    check(at("import: the same file again writes nothing: two rows are unchanged and the confirm says there is nothing to write"), /2 unchanged, 4 rejected/.test(again) && (await confirmBtn.isDisabled()) && /Nothing to write/.test(again), again.slice(0, 300));
    await page.getByRole("button", { name: "Discard this preview" }).click();

    // ---- DIFF: back-date the first claim in the real database so the history spans two days, then compare
    try {
      execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", process.env.GF_PG_DB || "gf", "-c",
        `set session_replication_role = replica; update hall_inputs set created_at = timestamp with time zone '2026-09-01 10:00:00+00' where supersedes_id is null and field_path = 'grid.firm_capacity_mva' and hall_id = '${after.hallId}';`], { stdio: "pipe" });
      check(at("diff setup: the first claim was back-dated in the database"), true);
    } catch (e) { check(at("diff setup: the first claim was back-dated in the database (psql)"), false, String(e.message).slice(0, 200)); }
    await page.getByRole("button", { name: "Show what changed" }).click();
    await page.locator("#diff-from").waitFor({ timeout: 15000 });
    const diffOptions = await page.locator("#diff-from option").allInnerTexts();
    check(at("diff: the points are the days something was recorded, plus the start; now is the later point"), diffOptions.some((o) => /2026-09-01/.test(o)) && diffOptions.some((o) => /Before the first recorded figure/.test(o)), diffOptions.join(" | "));
    check(at("diff: the earlier point defaults to the previous day"), (await page.locator("#diff-from").inputValue()) === "2026-09-01");
    await page.locator("#diff-summary").waitFor({ timeout: 5000 });
    const diffText = (await page.locator("#diff-body").innerText()).replace(/\s+/g, " ");
    check(at("diff: capacity is listed as changed, contracted as added, each with the evidence it rests on"),
      /1 changed, 1 added, 0 withdrawn, 0 that cannot be told, 0 unchanged/.test(diffText) && /value: 40 MVA → (to )?44 MVA/.test(diffText) && /Rests on: declared assumed E1, no file cited → declared assumed E1, no file cited/.test(diffText)
      && /Rests on: no figure → declared assumed E1, no file cited/.test(diffText), diffText.slice(0, 700));
    const diffSection = (await page.locator("section[aria-labelledby=diff-title]").innerText()).replace(/\s+/g, " ");
    check(at("diff: it never calls a change an improvement, says it is not a recalculated capacity, and says file status is the live one"), !/improv|better|saving/i.test(diffSection) && /not a recalculated capacity result/.test(diffSection) && /its status now/.test(diffSection));
    await page.locator("#diff-to").selectOption("2026-09-01");
    await page.locator("#diff-from").selectOption("now").catch(() => {});
    const bad = page.locator("#diff-body [role=alert]", { hasText: "Choose an earlier point first" });
    check(at("diff: a later 'from' than 'to' is refused in an alert"), (await bad.count()) === 1);
    await page.locator("#diff-to").selectOption("now");
    await page.locator("#diff-from").selectOption("2026-09-01");
    await page.getByLabel("One field's successive values").check();
    await page.locator("#diff-field").selectOption("grid.firm_capacity_mva");
    await page.locator("#diff-body ol li").first().waitFor({ timeout: 10000 });
    const steps = await page.locator("#diff-body ol > li").allInnerTexts();
    check(at("diff: one field's steps are first recorded, then each correction, each with what it rests on"), steps.length === 3 && /First recorded/.test(steps[0]) && /Correction/.test(steps[1]) && steps.every((x) => /Rests on:/.test(x)), steps.join(" || ").replace(/\s+/g, " ").slice(0, 500));
    await page.getByLabel("Two points in time").check();

    // ---- accessibility with every new panel open: axe, the keyboard path to the file input, and no sideways scroll
    const toFile = await tabTo(page, "import-file", 400);
    check(at("keyboard reaches the import file input"), toFile > 0, `tabs: ${toFile}`);
    const axePath = path.join(ROOT, "node_modules", "axe-core", "axe.min.js");
    if (fs.existsSync(axePath)) {
      await page.addScriptTag({ content: fs.readFileSync(axePath, "utf8") });
      const axe = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(" ")}`));
      check(at("axe: no WCAG 2 A/AA violation with export, import (after a report) and the diff open"), axe.length === 0, axe.join(" | ").slice(0, 600));
    } else check(at("axe-core is installed"), false, "node_modules/axe-core/axe.min.js is missing");
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(at("no sideways scroll of the page with the new panels open"), wide <= 1, `overflow ${wide}px`);
    await shot(page, `sites-panels-${width}`);

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
