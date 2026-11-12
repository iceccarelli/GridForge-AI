#!/usr/bin/env node
/**
 * Proves the link card against a RUNNING build (`next build && next start`), reading the HTML and fetching the images the way a platform's
 * crawler does. Usage: node scripts/check-share-cards.mjs http://127.0.0.1:3000   (the server must be started with
 * NEXT_PUBLIC_SITE_URL set to the same origin, because every card URL is made absolute from it).
 *
 * For each public page: exactly one of each Open Graph / Twitter tag, absolute URLs on the site's own origin, og:url equal to the canonical,
 * the right og:type, an image that returns 200 as a 1200x630 PNG under 600 KB (WhatsApp's practical limit), alt text, no twitter:site or
 * creator (there is no account). Site-wide: favicon.ico, apple-touch-icon (180 PNG), manifest with 192 and 512 icons, theme-color,
 * security.txt, contact.vcf and the robots/sitemap entries for /about. Exit 0 = all pass.
 */
import { readFileSync } from "node:fs";

const BASE = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const failures = [];
const check = (ok, what) => { if (!ok) { failures.push(what); console.log(`FAIL ${what}`); } };
let n = 0;

const slugs = JSON.parse(readFileSync("public/reference/constraints.json", "utf8")).constraints.map((c) => c.slug);
const platforms = JSON.parse(readFileSync("public/reference/platforms.json", "utf8")).platforms.filter((p) => !p.generic && p.sources?.length).map((p) => p.id);
const PAGES = [
  ["/", "website"], ["/about", "website"], ["/constraints", "website"], [`/constraints/${slugs[0]}`, "article"], [`/constraints/${slugs[slugs.length - 1]}`, "article"],
  ["/platforms", "website"], [`/platforms/${platforms[0]}`, "website"], ["/products", "website"], ["/products/density-screen", "website"],
  ["/products/envelope-study", "website"], ["/pricing", "website"], ["/qualify", "website"], ["/evidence", "website"], ["/lead-times", "website"],
  ["/developers", "website"], ["/legal/privacy", "website"],
];

const metas = (html) => [...html.matchAll(/<meta\s+([^>]*?)\/?>/gi)].map((m) => Object.fromEntries([...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const prop = (ms, key) => ms.filter((m) => (m.property ?? m.name) === key).map((m) => decode(m.content ?? ""));
const links = (html, rel) => [...html.matchAll(/<link\s+([^>]*?)\/?>/gi)].map((m) => Object.fromEntries([...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]))).filter((l) => (l.rel ?? "").split(/\s+/).includes(rel));
const pngSize = (buf) => (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null);

const seen = new Set();
for (const [path, ogType] of PAGES) {
  const res = await fetch(BASE + path, { redirect: "follow" });
  check(res.status === 200, `${path} answers 200 (${res.status})`);
  const html = await res.text();
  const ms = metas(html);
  const one = (key) => { const v = prop(ms, key); n++; check(v.length === 1 && v[0] !== "", `${path}: exactly one non-empty ${key} (${v.length})`); return v[0] ?? ""; };
  const title = one("og:title"), desc = one("og:description"), url = one("og:url"), image = one("og:image");
  one("og:image:alt"); one("twitter:image:alt");
  const type = one("og:type"), site = one("og:site_name"), locale = one("og:locale");
  check(type === ogType, `${path}: og:type is ${ogType} (${type})`);
  check(site === "Time to Power", `${path}: og:site_name (${site})`);
  check(/^[a-z]{2}_[A-Z]{2}$/.test(locale), `${path}: og:locale (${locale})`);
  check(prop(ms, "og:image:width")[0] === "1200" && prop(ms, "og:image:height")[0] === "630", `${path}: og:image width and height are declared 1200x630`);
  check(prop(ms, "og:image:type")[0] === "image/png", `${path}: og:image:type is image/png`);
  check(title.length > 8 && title.length <= 90, `${path}: og:title length ${title.length}`);
  check(desc.length >= 40 && desc.length <= 300, `${path}: og:description length ${desc.length}`);
  for (const u of [url, image, prop(ms, "twitter:image")[0] ?? ""]) check(u.startsWith(BASE + "/") || u === BASE, `${path}: ${u.slice(0, 80)} is absolute on the site's own origin`);
  const canonical = links(html, "canonical").map((l) => decode(l.href));
  check(canonical.length === 1 && canonical[0] === url, `${path}: canonical equals og:url (${canonical[0]} vs ${url})`);
  check(prop(ms, "twitter:card")[0] === "summary_large_image", `${path}: twitter:card is summary_large_image`);
  check(prop(ms, "twitter:image")[0] === image || /\/twitter-image/.test(prop(ms, "twitter:image")[0] ?? ""), `${path}: twitter:image present`);
  check(prop(ms, "twitter:site").length === 0 && prop(ms, "twitter:creator").length === 0, `${path}: no twitter:site or creator (no account exists)`);
  check(prop(ms, "og:image").length === 1, `${path}: a single og:image`);
  check(prop(ms, "theme-color").length >= 1, `${path}: theme-color is set`);
  if (!seen.has(image)) {
    seen.add(image);
    if (!image) continue;
    const img = await fetch(image);
    const buf = Buffer.from(await img.arrayBuffer());
    const sz = pngSize(buf);
    check(img.status === 200 && (img.headers.get("content-type") ?? "").startsWith("image/png"), `${path}: the card image answers 200 image/png`);
    check(sz && sz.w === 1200 && sz.h === 630, `${path}: the card image is really 1200x630 (${sz ? `${sz.w}x${sz.h}` : "not a PNG"})`);
    check(buf.length < 600 * 1024, `${path}: the card image is under 600 KB (${Math.round(buf.length / 1024)} KB)`);
  }
}
check(seen.size >= 5, `distinct cards for the different page types (${seen.size})`);

// site-wide assets
const home = await (await fetch(BASE + "/")).text();
const icons = links(home, "icon").map((l) => l.href);
check(icons.some((h) => h.endsWith("favicon.ico")) && icons.some((h) => /\.svg/.test(h)) && icons.some((h) => /icon-192\.png/.test(h)), "the page links an ico, an svg and a png icon");
const apple = links(home, "apple-touch-icon");
check(apple.length === 1 && /180x180/.test(apple[0].sizes ?? "") && /\.png/.test(apple[0].href), "one apple-touch-icon, 180x180 PNG");
const fav = await fetch(BASE + "/favicon.ico");
const favBuf = Buffer.from(await fav.arrayBuffer());
check(fav.status === 200 && favBuf.readUInt16LE(2) === 1 && favBuf.readUInt16LE(4) >= 3, "/favicon.ico answers 200 and is an ICO with several sizes");
const at = Buffer.from(await (await fetch(BASE + "/apple-touch-icon.png")).arrayBuffer());
check(pngSize(at)?.w === 180 && pngSize(at)?.h === 180, "apple-touch-icon.png is 180x180");
const manifest = await (await fetch(BASE + "/manifest.webmanifest")).json();
check(manifest.name === "Time to Power" && manifest.icons.some((i) => i.sizes === "192x192") && manifest.icons.some((i) => i.sizes === "512x512"), "the manifest has a name and 192 and 512 icons");
for (const i of manifest.icons) { const b = Buffer.from(await (await fetch(BASE + i.src)).arrayBuffer()); const s = pngSize(b); check(s && `${s.w}x${s.h}` === i.sizes, `manifest icon ${i.src} is ${i.sizes}`); }
const logo = pngSize(Buffer.from(await (await fetch(BASE + "/logo.png")).arrayBuffer()));
check(logo && logo.w === 512 && logo.h === 512, "logo.png is 512x512 (the organisation's logo)");

const sec = await (await fetch(BASE + "/.well-known/security.txt")).text();
const exp = /^Expires: (.+)$/m.exec(sec)?.[1];
check(/^Contact: mailto:\S+@\S+$/m.test(sec) && exp && Date.parse(exp) > Date.now() + 120 * 864e5 && Date.parse(exp) < Date.now() + 400 * 864e5, `security.txt has a contact and an Expires ${exp} between 4 and 13 months ahead`);
const vcf = await fetch(BASE + "/contact.vcf");
const vtxt = await vcf.text();
check(vcf.status === 200 && (vcf.headers.get("content-type") ?? "").includes("text/vcard") && /^BEGIN:VCARD/.test(vtxt) && /EMAIL[^:]*:power@timetopower\.ai/.test(vtxt) && !/^(TEL|ADR)/m.test(vtxt), "contact.vcf is a vCard with the email and no invented telephone or address");
const sm = await (await fetch(BASE + "/sitemap.xml")).text();
check(sm.includes("/about</loc>") && sm.includes("/platforms/") && sm.includes("/products/"), "the sitemap lists /about, platform and product pages");
const llms = await (await fetch(BASE + "/llms.txt")).text();
check(llms.includes("/about") && llms.includes("power@timetopower.ai"), "llms.txt names /about and the contact address");

// the entity: one organisation, by @id, on every page that mentions it
const ld = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const flat = (docs) => docs.flatMap((d) => (d["@graph"] ? d["@graph"] : [d]));
const orgFull = (docs) => flat(docs).filter((x) => [].concat(x["@type"]).includes("Organization") && x.logo);
for (const path of ["/", "/about"]) {
  const docs = ld(await (await fetch(BASE + path)).text());
  const full = orgFull(docs);
  check(full.length === 1 && full[0]["@id"] === `${BASE}/#organization`, `${path}: exactly one full Organization node with the shared @id`);
  check(full[0]?.logo?.url === `${BASE}/logo.png` && full[0]?.contactPoint?.email === "power@timetopower.ai", `${path}: the organisation carries a real logo URL and the contact email`);
  const text = JSON.stringify(docs);
  check(!/aggregateRating|"review"|telephone|streetAddress|foundingDate|numberOfEmployees|"award"/.test(text), `${path}: no rating, review, phone, street address, founding date, headcount or award`);
}
for (const path of ["/products/density-screen", `/constraints/${slugs[0]}`, `/platforms/${platforms[0]}`, "/lead-times"]) {
  const docs = ld(await (await fetch(BASE + path)).text());
  check(orgFull(docs).length === 0, `${path}: no second full Organization (it references the shared one)`);
  check(JSON.stringify(docs).includes(`${BASE}/#organization`), `${path}: points at the shared organisation @id`);
}
// a missing URL (unmatched, and one a dynamic route refuses with notFound()): HTTP 404, a title of its own, and ONE robots tag. Next writes
// `noindex` on every not-found response; the root layout's `index, follow` must not be repeated beside it (app/not-found.tsx).
const titleOf = (html) => [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => decode(m[1]));
const homeTitle = titleOf(home)[0];
for (const path of ["/this-page-does-not-exist", "/products/not-a-product"]) {
  const res = await fetch(BASE + path, { redirect: "manual" });
  const html = await res.text();
  const titles = titleOf(html);
  const robots = prop(metas(html), "robots");
  check(res.status === 404, `${path}: a missing page answers 404 (${res.status})`);
  check(titles.length === 1 && titles[0] !== homeTitle && /not found/i.test(titles[0]), `${path}: the 404 has its own title, not the home page's (${titles.join(" | ")})`);
  check(robots.length === 1 && robots[0] === "noindex", `${path}: the 404 carries exactly one robots tag, noindex (${robots.join(" | ")})`);
}
console.log(failures.length ? `\n${failures.length} of ${n}+ checks FAILED` : `\nshare cards, icons and entity: all checks passed (${n} tag checks across ${PAGES.length} pages)`);
process.exit(failures.length ? 1 : 0);
