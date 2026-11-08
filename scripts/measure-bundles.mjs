#!/usr/bin/env node
// Lab measurement of the bytes a route transfers on first load, against a RUNNING production build:
//   npm run build && npx next start -p 3140
//   NODE_PATH=/opt/node-tools/node_modules node scripts/measure-bundles.mjs [--base URL] [--routes /a,/b] > measured.json
// Mobile viewport (375 px), cold cache, no scrolling, wait for network idle. Bytes are transferred (encoded) bytes as the browser
// reports them over the wire, split by resource type. These are lab bytes for comparing builds; they are not Core Web Vitals and say
// nothing about field performance. Next's link PREFETCH traffic is aborted (scripts/perf-prefetch-filter.mjs): whether it finished before
// "networkidle" depended on machine load and made the same build measure differently from run to run.
import { createRequire } from "node:module";
import { isPrefetchRequest } from "./perf-prefetch-filter.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const DEFAULT_ROUTES = [
  "/",
  "/workspace",
  "/intelligence",
  "/dashboard",
  "/pricing",
  "/qualify",
  "/developers",
  "/account",
  "/account/login",
  "/power/compare",
  "/power/deploy",
  "/products",
  "/for",
  "/about",
  "/contact",
  "/reference",
  "/constraints",
  "/evidence",
  "/products/density-screen",
  "/constraints/busway-ampacity",
  "/for/ai-operators",
  "/lead-times",
  "/commissioned",
  "/platforms",
  "/observatory",
  "/observatory/presenter",
  "/legal/terms",
  "/legal/privacy",
  "/legal/security",
  "/guides/nameplate-vs-useful-compute",
  "/account/sites",
  "/admin",
  "/admin/login",
  "/admin/pipeline",
  "/admin/reviews",
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function measureRoute(browser, base, route) {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, deviceScaleFactor: 1, isMobile: true });
  const page = await context.newPage();
  await context.route("**/*", (route) => {
    const r = route.request();
    return isPrefetchRequest({ url: r.url(), headers: r.headers() }) ? route.abort() : route.continue();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const types = new Map();
  const bytes = { js: 0, css: 0, image: 0, font: 0, document: 0, other: 0 };
  let requests = 0;
  cdp.on("Network.responseReceived", (e) => types.set(e.requestId, e.type));
  cdp.on("Network.loadingFinished", (e) => {
    requests += 1;
    const t = types.get(e.requestId);
    const k =
      t === "Script" ? "js" : t === "Stylesheet" ? "css" : t === "Image" ? "image" : t === "Font" ? "font" : t === "Document" ? "document" : "other";
    bytes[k] += e.encodedDataLength;
  });
  let status = 0;
  try {
    const res = await page.goto(new URL(route, base).toString(), { waitUntil: "networkidle", timeout: 60_000 });
    status = res ? res.status() : 0;
    await page.waitForTimeout(500);
  } finally {
    await context.close();
  }
  const kb = (n) => Math.round((n / 1024) * 10) / 10;
  return {
    route,
    status,
    requests,
    js_kb: kb(bytes.js),
    css_kb: kb(bytes.css),
    image_kb: kb(bytes.image),
    font_kb: kb(bytes.font),
    document_kb: kb(bytes.document),
    other_kb: kb(bytes.other),
  };
}

async function main() {
  const base = arg("--base", process.env.PERF_BASE_URL || "http://localhost:3140");
  const routes = arg("--routes", "") ? arg("--routes", "").split(",") : DEFAULT_ROUTES;
  const browser = await chromium.launch();
  const out = [];
  try {
    for (const r of routes) out.push(await measureRoute(browser, base, r));
  } finally {
    await browser.close();
  }
  process.stdout.write(JSON.stringify({ base, viewport: "375x800 mobile, cold cache, no scroll", measured: out }, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
