#!/usr/bin/env node
/**
 * Rasterise the brand mark (public/icon.svg) into the files platforms ask for: apple-touch-icon.png (180, full-bleed: iOS rounds it itself),
 * icon-192.png / icon-512.png (web app manifest), logo.png (512, the organisation's logo for structured data), icon-maskable-512.png
 * (full-bleed with the bolt inside the safe zone) and a multi-size favicon.ico (16, 32, 48 as PNG entries).
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright node scripts/build-brand-assets.mjs
 *
 * The outputs are COMMITTED (the build never needs a browser); tests/site/share-cards.test.ts checks they exist, are square, and are the
 * sizes the manifest and the structured data claim. Re-run this only when icon.svg changes.
 */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = (f) => path.join(ROOT, "public", f);
await readFile(pub("icon.svg"), "utf8"); // fail early if the mark is missing

const GRADIENT = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00E5FF"/><stop offset="1" stop-color="#38BDF8"/></linearGradient></defs>`;
const BOLT = `<path d="M35 12 L18 36 H30 L26 52 L46 26 H33 Z" fill="#051019" stroke="#051019" stroke-width="1.5" stroke-linejoin="round"/>`;
const svg = (size, { rx, scale = 1 }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${GRADIENT}<rect width="64" height="64" rx="${rx}" fill="url(#g)"/>` +
  `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${BOLT}</g></svg>`;

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
async function png(size, opts) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size, opts)}</body></html>`);
  return page.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
const out = {
  "apple-touch-icon.png": await png(180, { rx: 0 }),
  "icon-192.png": await png(192, { rx: 16 }),
  "icon-512.png": await png(512, { rx: 16 }),
  "logo.png": await png(512, { rx: 16 }),
  // maskable: full-bleed, the bolt shrunk into the inner 80% safe zone
  "icon-maskable-512.png": await png(512, { rx: 0, scale: 0.8 }),
};
for (const [name, buf] of Object.entries(out)) await writeFile(pub(name), buf);

// favicon.ico: an ICO container whose entries are PNG images (supported by every current browser and by Google's favicon fetcher)
const sizes = [16, 32, 48];
const imgs = [];
for (const s of sizes) imgs.push(await png(s, { rx: s >= 32 ? 8 : 4 }));
const head = Buffer.alloc(6);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = Buffer.alloc(16 * sizes.length);
sizes.forEach((s, i) => {
  const e = dir.subarray(i * 16, i * 16 + 16);
  e.writeUInt8(s, 0); e.writeUInt8(s, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += imgs[i].length;
});
await writeFile(pub("favicon.ico"), Buffer.concat([head, dir, ...imgs]));
await browser.close();
console.log("wrote", [...Object.keys(out), "favicon.ico"].join(", "));
