#!/usr/bin/env node
/**
 * Rendered-browser check of the supplier-quotation loop: the production build, a REAL PostgreSQL with migrations through 0054 behind REAL PostgREST,
 * the REAL capacity engine, and an in-memory stand-in for Supabase Storage. Driven in Chromium at 1440 and 390 px, by keyboard where it matters.
 *
 *   1. a project holder attaches a (synthetic) quotation PDF and records what it says; a bad claim is refused in role=alert; the saved one reads
 *      "not yet counted"
 *   2. the administrator verifies the FILE and then accepts the RECORD on /admin/reviews; before the file is verified the accept control is not offered
 *   3. the Time-to-Power comparison, asked again with the project's token, shows the engine's capex before and after, the ladder steps that moved
 *      from a library placeholder to a firm supplier quote, and says the date did not move
 * with axe (WCAG 2 A/AA), the console, horizontal overflow and the zero-hardware-margin statement checked on each surface.
 *
 * MANUAL: no CI job runs this file (Playwright is not a project dependency). Every supplier, price and document is a SYNTHETIC fixture.
 *
 *   bash scripts/realdb-up.sh && . $GF_REALDB_DIR/realdb.env       # a fresh database and PostgREST (PG* = a superuser)
 *   npm run build
 *   GF_PGRST_URL=$GF_PGRST_URL GF_PGRST_JWT=$GF_PGRST_JWT node tests/e2e/quotation-journey.mjs [screenshot-dir]
 *
 * Exit codes: 0 all passed, 1 a check failed, 2 the browser or the stack could not run.
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
  console.error(`quotation journey NOT RUN: Playwright could not be loaded (${String(err).split("\n")[0]}). Set PLAYWRIGHT_MODULE.`);
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PGRST = process.env.GF_PGRST_URL, JWT = process.env.GF_PGRST_JWT;
if (!PGRST || !JWT) { console.error("quotation journey NOT RUN: GF_PGRST_URL / GF_PGRST_JWT are not set (scripts/realdb-up.sh writes them)."); process.exit(2); }
const GW_PORT = Number(process.env.E2E_GW_PORT || 3961), SITE_PORT = Number(process.env.E2E_SITE_PORT || 3962), ENGINE_PORT = Number(process.env.E2E_ENGINE_PORT || 8162);
const SHOTS = process.argv[2] || "";
const GW = `http://127.0.0.1:${GW_PORT}`, SITE = `http://127.0.0.1:${SITE_PORT}`, ENGINE = `http://127.0.0.1:${ENGINE_PORT}`;
const ADMIN_PASSWORD = "journey-admin-password";

const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` - ${detail}`}`); if (!ok) failures.push(name); };
const uid = () => crypto.randomBytes(4).toString("hex");
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// ---- the stand-in: /rest/v1/* forwarded to the real PostgREST, and the three Storage calls upload and review make
const objects = new Map();
const gateway = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = req.url || "";
  if (url.startsWith("/rest/v1/")) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length"].includes(k)) headers[k] = v;
    const r = await fetch(PGRST + url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method || "") ? undefined : body });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const rb = url.match(/^\/storage\/v1\/object\/authenticated\/(.+)$/);
  if (rb && req.method === "GET") {
    const o = objects.get(decodeURIComponent(rb[1]));
    if (!o) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"statusCode":"404","error":"not_found","code":"NoSuchKey"}'); }
    res.writeHead(200, { "content-type": o.type }); return res.end(o.bytes);
  }
  const m = url.match(/^\/storage\/v1\/object\/(.+)$/);
  if (m) {
    const ref = decodeURIComponent(m[1]);
    if (req.method === "POST") {
      if (objects.has(ref)) { res.writeHead(409); return res.end("{}"); }
      objects.set(ref, { bytes: body, type: String(req.headers["content-type"]) });
      res.writeHead(200); return res.end("{}");
    }
    if (req.method === "DELETE") { objects.delete(ref); res.writeHead(200); return res.end("{}"); }
  }
  res.writeHead(404); res.end("{}");
});
await new Promise((r) => gateway.listen(GW_PORT, "127.0.0.1", r));

const procs = [];
const group = (cmd, args, env) => { const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore", detached: true }); procs.push(c); return c; };
const stop = () => { for (const c of procs) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } } gateway.close(); };
process.on("exit", () => { for (const c of procs) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } } });
const until = async (label, probe, tries = 160) => { for (let i = 0; i < tries; i++) { try { if (await probe()) return true; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 500)); } return false; };

group(process.env.E2E_PYTHON || "python3", ["-m", "gridforge", "serve", "--port", String(ENGINE_PORT)], { GRIDFORGE_API_KEYS: "journey-engine-key", GRIDFORGE_RATE_LIMIT: "100000" });
group("npx", ["next", "start", "-p", String(SITE_PORT)], {
  NODE_ENV: "production", SUPABASE_URL: GW, SUPABASE_SERVICE_ROLE_KEY: JWT, NEXT_PUBLIC_SUPABASE_URL: GW, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test",
  GRIDFORGE_API_URL: ENGINE, GRIDFORGE_API_KEY: "journey-engine-key", ADMIN_PASSWORD, ADMIN_SESSION_SECRET: crypto.randomBytes(24).toString("hex") + "journey",
  GRIDFORGE_TRUSTED_IP_HEADER: "x-forwarded-for", RATE_LIMIT_HMAC_KEY: "quotation-journey-rate-limit-key-0123456789abcdef", NEXT_PUBLIC_SITE_URL: SITE,
  NEXT_TELEMETRY_DISABLED: "1",
});
if (!(await until("engine", async () => (await fetch(`${ENGINE}/health`)).ok)) || !(await until("site", async () => (await fetch(SITE + "/")).ok))) {
  console.error("quotation journey NOT RUN: the engine or the site did not come up (was `npm run build` run?)");
  stop(); process.exit(2);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--no-sandbox"] });
const benign = (t) => /Failed to load resource|status of (4|5)\d\d/.test(t);            // a refused request is the app's honest answer, not a defect
const axeFile = path.join(ROOT, "node_modules", "axe-core", "axe.min.js");
async function axe(page) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: fs.readFileSync(axeFile, "utf8") });
  return page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(" ")}`));
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true }); } };
const STATEMENT = "sells no equipment, takes no margin on any purchase and quotes no equipment itself";
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function session(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !benign(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  return { ctx, page, errors };
}

try {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const at = (s) => `${width}px: ${s}`;
    const tag = `${width}-${uid()}`;
    const fileName = `quotation-${tag}.pdf`;

    // ---------------------------------------------------------------- 1. the project holder
    const holder = await session(width, height);
    const created = await holder.ctx.request.post(SITE + "/api/projects", { data: { project_name: `Quotation journey ${tag}` } });
    const token = (await created.json()).project_token;
    check(at("a project exists"), typeof token === "string" && token.length > 10);

    await holder.page.goto(`${SITE}/workspace?project=${token}`);
    if (width < 700) await holder.page.getByRole("button", { name: /project/i }).last().click();
    // at 390 px the desktop pane stays in the DOM (hidden) beside the mobile one: drive the visible one
    const section = holder.page.locator('[data-testid="quotation-section"]:visible').first();
    await section.waitFor({ timeout: 30000 });
    check(at("the quotation section renders for the open project"), true);
    check(at("it says we sell no equipment, take no margin and quote none"), (await section.innerText()).includes(STATEMENT));
    check(at("no overflow sideways"), await noOverflow(holder.page));

    // the document, through the existing upload
    await section.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% SYNTHETIC quotation ${tag}\n%%EOF\n`) });
    await section.getByRole("button", { name: "Attach file" }).click();
    await section.getByText("was attached", { exact: false }).first().waitFor({ timeout: 20000 });
    check(at("the document attaches and the upload says it is unverified"), (await section.innerText()).includes("unverified and unclassified"));

    const form = section.locator('[data-testid="quotation-form"]');
    const label = (t) => form.getByLabel(t, { exact: false });
    const fill = async (over = {}) => {
      await label("Quotation document").selectOption({ label: `${fileName} (unverified)` });
      await label("What it prices").selectOption({ label: "Coolant distribution units (CDU), supplied and mechanically installed" });
      await label("Price (EUR)").fill("317450");
      await label("Price is").selectOption("EUR");
      await label("Kind of quotation").selectOption("firm_quote");
      await label("Supplier name").fill("SYNTHETIC-SUPPLIER-A");
      await label("Quoted on").fill(day(-3));
      await label("Valid until").fill(over.until ?? "2099-12-31");
      await label("Lead time quoted").fill("26");
      await label("What the quotation covers").fill("supply and mechanical install of the CDUs");
      await label("Scope and comparability notes").fill("excludes civils");
      await label("Your name").fill("A. Holder");
    };
    // a quotation that has already expired is refused, in words, in role=alert, and nothing is recorded
    await fill({ until: day(-1) });
    await label("Your name").press("Enter");
    const alert = form.locator("[role=alert]");
    await alert.waitFor({ timeout: 15000 });
    check(at("an expired quotation is refused in role=alert"), /after today/.test(await alert.innerText()));
    check(at("...and nothing was recorded"), (await holder.ctx.request.get(`${SITE}/api/projects/${token}/cost-evidence`).then((r) => r.json())).claims.length === 0);
    // the good one, submitted by keyboard (Enter in the last field)
    await label("Valid until").fill("2099-12-31");
    await label("Your name").press("Enter");
    await section.getByText("Recorded and not yet counted").waitFor({ timeout: 20000 });
    const list = section.getByRole("list", { name: "Supplier quotations of this project" });
    await list.waitFor({ timeout: 10000 });
    const text = await list.innerText();
    check(at("the saved quotation reads 'not yet counted' and says it is waiting for a reviewer"), /not yet counted/i.test(text) && /waiting for a reviewer/.test(text));
    check(at("the file's standing is shown beside it"), /file not yet verified/.test(text) && text.includes(fileName));
    check(at("the quoted lead time is called customer-supplied and unverified"), /customer-supplied, unverified/.test(text));
    check(at("no storage path is on the page"), !/project-evidence\//.test(await holder.page.content()));
    await shot(holder.page, `holder-${width}`);
    const v1 = await axe(holder.page);
    check(at("axe: no WCAG 2 A/AA violation on the quotation section"), v1.length === 0, v1.join("; "));
    check(at("no console errors (holder)"), holder.errors.length === 0, holder.errors.join(" | "));
    const claims = (await holder.ctx.request.get(`${SITE}/api/projects/${token}/cost-evidence`).then((r) => r.json())).claims;
    const claimId = claims[0].id;

    // ---------------------------------------------------------------- 2. the administrator
    const admin = await session(width, height);
    await admin.page.goto(SITE + "/admin/login");
    await admin.page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await admin.page.locator('input[type="password"]').press("Enter");
    await admin.page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
    await admin.page.goto(SITE + "/admin/reviews");
    const card = admin.page.locator(`article[data-claim-id="${claimId}"]`);
    await card.waitFor({ timeout: 30000 }).catch(async (e) => { console.error(`admin page at ${admin.page.url()}:`, (await admin.page.locator("body").innerText()).slice(0, 600)); throw e; });
    const cardText = await card.innerText();
    check(at("the gate shows the claims beside the file's name, type, size and digest"), cardText.includes("SYNTHETIC-SUPPLIER-A") && cardText.includes(fileName) && /SHA-256/.test(cardText) && cardText.includes("317,450"));
    check(at("it shows the claimed lead time as the submitter's claim"), /26 weeks \(the submitter's claim/.test(cardText));
    check(at("it shows the file is not yet verified and offers no accept"), /has not been verified/.test(cardText) && (await card.locator('option[value="accepted"]').count()) === 0);
    check(at("the gate repeats that the name is self-typed under one shared password"), /not an authenticated identity/.test(await admin.page.getByTestId("quotation-review").innerText()));
    check(at("no storage path is on the review page"), !/project-evidence\//.test(await admin.page.content()));
    check(at("the statement is on the gate"), (await admin.page.getByTestId("quotation-review").innerText()).includes(STATEMENT));
    check(at("no overflow sideways (admin)"), await noOverflow(admin.page));

    // verify the FILE in the existing section, by keyboard-operable controls
    const fileCard = admin.page.locator("article", { hasText: fileName }).filter({ hasText: "SHA-256 at upload" }).first();
    await fileCard.getByRole("button", { name: "Review this file" }).click();
    await fileCard.getByLabel("Verify —", { exact: false }).check();
    await fileCard.getByLabel("Your name", { exact: false }).fill("F. Keane");
    await fileCard.getByLabel("Reason", { exact: false }).fill("opened it; the digest matches");
    await fileCard.getByRole("button", { name: "Record decision" }).click();
    await admin.page.getByText("Recorded: verified by F. Keane", { exact: false }).waitFor({ timeout: 20000 });
    check(at("the file is verified by the server-computed digest"), true);
    // the gate now follows
    await card.locator('option[value="accepted"]').first().waitFor({ state: "attached", timeout: 10000 });
    check(at("the accept control appears once the file is verified"), (await card.getByText("verified just now", { exact: false }).count()) === 1);
    await card.getByLabel("Decision").selectOption("accepted");
    await card.getByLabel("Your name", { exact: false }).fill("R. Reviewer");
    await card.getByLabel("Reason").fill("matches the document");
    const v2 = await axe(admin.page);
    check(at("axe: no WCAG 2 A/AA violation on /admin/reviews with the quotation open"), v2.length === 0, v2.join("; "));
    await card.getByRole("button", { name: "Accept this quotation" }).click();
    await admin.page.getByText("Recorded: quotation accepted by R. Reviewer", { exact: false }).waitFor({ timeout: 20000 });
    check(at("the quotation is accepted"), true);
    await shot(admin.page, `admin-${width}`);
    check(at("no console errors (admin)"), admin.errors.length === 0, admin.errors.join(" | "));
    await admin.ctx.close();

    // the holder sees it counted
    const after = (await holder.ctx.request.get(`${SITE}/api/projects/${token}/cost-evidence`).then((r) => r.json())).claims[0];
    check(at("the holder's list now offers it to the engine, as a firm supplier quote"), after.counted === true && after.review?.basis_label === "firm supplier quote");

    // ---------------------------------------------------------------- 3. the comparison, asked again with the quotation
    const cmp = await session(width, height);
    await cmp.page.goto(`${SITE}/power/compare?project=${token}`);
    const f = (t) => cmp.page.getByLabel(t, { exact: false }).first();
    for (const [lbl, val] of [["Site name", "Journey Hall"], ["Hall id", "H1"], ["Contracted grid capacity", "12"], ["Current site peak", "7.4"], ["Current IT load", "4.9"], ["Busway ampacity", "400"], ["Tap-off rating", "63"], ["Free rack positions", "180"], ["Chilled-water design supply", "6"], ["Firm connection capacity", "15"], ["Floor loading", "12"], ["Chilled-water plant capacity", "6000"]]) await f(lbl).fill(val);
    await cmp.page.getByRole("button", { name: /^Compare/ }).first().click();
    const panel = cmp.page.getByTestId("quotation-effect");
    await panel.waitFor({ timeout: 60000 });
    check(at("the effect panel is on the comparison"), true);
    check(at("it carries the zero-margin statement"), (await panel.innerText()).includes(STATEMENT));
    check(at("the project token is prefilled from the link"), (await panel.getByLabel("Project token").inputValue()) === token);
    await panel.getByRole("button", { name: "Apply my accepted quotations" }).focus();
    await cmp.page.keyboard.press("Enter");
    const result = panel.getByTestId("effect-result");
    await result.waitFor({ timeout: 60000 });
    const r = await result.innerText();
    check(at("it says how many accepted quotations were offered and used"), /1 accepted quotation offered to the engine; it applied 1/.test(r));
    check(at("it shows capex before and after"), (await result.getByTestId("capex-move").count()) > 0 && /€[\d,]+ → €[\d,]+/.test(r));
    check(at("it says the capex is modelled and incomplete when the engine says so"), !/Capex complete: before \w+, after no/.test(r) || /modelled, incomplete/.test(r));
    check(at("it shows whether capex is complete, as the engine says"), (await result.getByTestId("complete-after").count()) > 0 && /Capex complete: before (yes|no|not reported), after (yes|no|not reported)/.test(r));
    check(at("it names the steps that moved, from a library placeholder to a firm supplier quote"), /library placeholder \(not a price\)/.test(r) && /firm supplier quote/.test(r));
    check(at("it says the date did not move and why"), /does not take a lead time from a quotation|does not supply a lead time/.test(r));
    check(at("it shows the quoted lead time as unverified by the engine"), /26 weeks quoted/.test(r) && /engine does not use a quoted lead time/.test(r));
    check(at("no overflow sideways (comparison)"), await noOverflow(cmp.page));
    await shot(cmp.page, `effect-${width}`);
    const v3 = await axe(cmp.page);
    check(at("axe: no WCAG 2 A/AA violation on the comparison with the effect shown"), v3.length === 0, v3.join("; "));
    check(at("no console errors (comparison)"), cmp.errors.length === 0, cmp.errors.join(" | "));
    await cmp.ctx.close();
    await holder.ctx.close();
  }
} catch (err) {
  console.error("quotation journey stopped:", err instanceof Error ? err.message : err);
  failures.push("the journey stopped before it finished");
}
await browser.close();
stop();
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
