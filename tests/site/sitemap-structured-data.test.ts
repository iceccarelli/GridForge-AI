/// <reference types="vite/client" />
/**
 * Every sitemap page is a good machine-readable citizen, and the three surfaces that say which routes are public agree.
 *
 * The walk resolves each sitemap URL to its page module, renders it as the server does (with the deployed engine stubbed), and
 * asserts, per page:
 *   - one canonical, equal to the page's own URL and listed in the sitemap;
 *   - a single h1;
 *   - OpenGraph title, description and a card;
 *   - every JSON-LD block parses, uses only an allowed schema.org type, carries no rating, review, licence or invented sameAs,
 *     points at its own URL, prices only what the catalogue prices (or 0 for what the registry calls free), and is a FAQPage only
 *     where the same questions and answers are visible on the page;
 *   - the title and description are the page's own (no two pages share a title).
 * Then: the sitemap lists nothing robots.txt closes or noindex hides; llms.txt links only public pages; both link only pages that exist.
 *
 * Title/description LENGTH is measured in metadata-limits.test.ts; the types a page may emit are listed here so a new one is a decision.
 */
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { capabilityById } from "@/lib/capability-registry";
import { sameAsUrls } from "@/lib/entity";
import { INTELLIGENCE_PLANS, PAYG, PRODUCTS } from "@/lib/products";
import { SITE_URL } from "@/lib/site";
import { FULL_ENGINE, stubEngine } from "./engine-stub";

// The root layout loads fonts through next/font; the live feeds and the client-only forms need a browser or the network.
vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "" }) }));
vi.mock("@/components/PowerDeployCaseForm", () => ({ PowerDeployCaseForm: () => null }));
vi.mock("@/lib/observatory/sources", () => ({ getLiveContext: () => Promise.reject(new Error("offline")) }));

type Meta = {
  title?: unknown;
  description?: unknown;
  alternates?: { canonical?: string };
  robots?: { index?: boolean } | string;
  openGraph?: { title?: unknown; description?: unknown; url?: unknown; images?: unknown };
};
type PageModule = {
  default: (a: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => unknown;
  metadata?: Meta;
  generateMetadata?: (a: { params: Promise<Record<string, string>> }) => Promise<Meta>;
};
const pageModules = import.meta.glob<PageModule>("../../app/**/page.tsx");
const layoutModule = () => import("@/app/layout") as Promise<{ metadata: Meta }>;

/** The schema.org types a page's structured data may use. A new type is a decision, made here. */
const ALLOWED_TOP_LEVEL = new Set([
  // the types the pages are about
  "WebPage", "CollectionPage", "Dataset", "TechArticle", "SoftwareApplication", "BreadcrumbList", "FAQPage",
  // more specific kinds of the above: WebApplication is a SoftwareApplication; AboutPage and ContactPage are WebPages
  "WebApplication", "AboutPage", "ContactPage",
  // the site's identity, defined once in lib/entity.ts and referenced by @id everywhere else
  "Organization", "ProfessionalService", "Person", "WebSite",
  // priced things, derived from lib/products.ts (tests/site/jsonld-offers.test.ts), never typed
  "OfferCatalog", "Offer", "Service",
  // the metered engine API, with its free allowance, pay-as-you-go and plans as Offers (lib/jsonld.ts apiServiceJsonLd; tests/site/jsonld-offers.test.ts)
  "WebAPI",
]);
const ALLOWED_NESTED = new Set([
  "ListItem", "PropertyValue", "DataDownload", "ImageObject", "ContactPoint", "Place", "QuantitativeValue", "Question", "Answer",
  "CreativeWork", "UnitPriceSpecification", "Dataset", "WebSite", "Organization", "Offer", "Service", "ProfessionalService", "Person",
  "SoftwareApplication", "WebApplication",
]);
const FORBIDDEN_TYPES = /^(Review|AggregateRating|Rating|Product|Event|Article|NewsArticle|BlogPosting|HowTo|ClaimReview|Claim|Recipe|VideoObject|LocalBusiness|Brand)$/;
const FORBIDDEN_KEYS = ["aggregateRating", "review", "reviewRating", "ratingValue", "ratingCount", "reviewCount", "bestRating", "license", "licence", "interactionStatistic", "userCount", "award"];

const urlOf = (u: string) => new URL(u).pathname.replace(/\/$/, "") || "/";
let pages: { pathname: string; url: string }[] = [];

function resolve(pathname: string): { key: string; params: Record<string, string> } | null {
  const segs = pathname.split("/").filter(Boolean);
  for (const key of Object.keys(pageModules)) {
    const dirs = key.replace("../../app/", "").replace(/\/?page\.tsx$/, "").split("/").filter(Boolean);
    if (dirs.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    dirs.forEach((d, i) => {
      const m = /^\[(\w+)\]$/.exec(d);
      if (m) params[m[1]] = segs[i];
      else if (d !== segs[i]) ok = false;
    });
    if (ok) return { key, params };
  }
  return null;
}

interface Walked {
  pathname: string;
  html: string;
  visible: string;
  blocks: Record<string, any>[];
  invalid: number;
  meta: Meta;
  pageDir: string;
  hasOwnOpenGraph: boolean;
}
const walked: Walked[] = [];

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&rsquo;/g, "’").replace(/&lsquo;/g, "‘");
/**
 * The text a reader can see: scripts, styles and anything inside an element that is hidden (the `hidden` attribute or class, aria-hidden="true",
 * or inline display:none) are dropped, nested content included. `sr-only` text stays: it is read aloud and crawled, which is not hiding.
 */
export function stripHidden(html: string): string {
  const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr", "area", "base", "col", "embed", "track"]);
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<!--[\s\S]*?-->/g, "");
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  const isHidden = (attrs: string) =>
    /(^|\s)hidden(\s|=|$)/.test(attrs) ||
    /aria-hidden=["']true["']/.test(attrs) ||
    /style=["'][^"']*display:\s*none/i.test(attrs) ||
    /class=["'](?:[^"']*\s)?hidden(?:\s[^"']*)?["']/.test(attrs);
  let out = "";
  let last = 0;
  let hiddenDepth = 0;
  const stack: { name: string; hides: boolean }[] = [];
  for (let m = tag.exec(noScripts); m; m = tag.exec(noScripts)) {
    if (!hiddenDepth) out += noScripts.slice(last, m.index);
    last = m.index + m[0].length;
    const [, closing, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (VOID.has(name) || m[0].endsWith("/>")) continue;
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) {
          for (const gone of stack.splice(i)) if (gone.hides) hiddenDepth--;
          break;
        }
      }
    } else {
      const hides = isHidden(attrs);
      if (hides) hiddenDepth++;
      stack.push({ name, hides });
    }
    out += " ";
  }
  if (!hiddenDepth) out += noScripts.slice(last);
  return out;
}
const visibleText = (html: string) => decode(stripHidden(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Every typed node in a JSON-LD value, with whether it is top level. */
function nodes(value: unknown, top = true, out: { type: string; node: Record<string, any>; top: boolean }[] = []) {
  if (Array.isArray(value)) value.forEach((v) => nodes(v, top, out));
  else if (value && typeof value === "object") {
    const n = value as Record<string, any>;
    if (Array.isArray(n["@graph"])) n["@graph"].forEach((g: unknown) => nodes(g, true, out));
    else {
      const t = n["@type"];
      for (const type of Array.isArray(t) ? t : t ? [t] : []) out.push({ type: String(type), node: n, top });
      for (const [k, v] of Object.entries(n)) if (k !== "@type" && v && typeof v === "object") nodes(v, false, out);
    }
  }
  return out;
}
function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) (out.add(k), keysDeep(v, out));
  return out;
}

beforeAll(async () => {
  const stop = stubEngine(FULL_ENGINE);
  try {
    pages = (await sitemap()).map((u) => ({ url: u.url, pathname: urlOf(u.url) })).filter((p) => !p.pathname.endsWith(".html"));
    const layoutMeta = (await layoutModule()).metadata;
    for (const p of pages) {
      const hit = resolve(p.pathname);
      if (!hit) continue;
      const mod = await pageModules[hit.key]();
      const meta: Meta = mod.generateMetadata ? await mod.generateMetadata({ params: Promise.resolve(hit.params) }) : (mod.metadata ?? {});
      const html = renderToStaticMarkup((await mod.default({ params: Promise.resolve(hit.params), searchParams: Promise.resolve({}) })) as never);
      let invalid = 0;
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => {
        try {
          return [JSON.parse(m[1].replace(/\\u003c/g, "<"))];
        } catch {
          invalid++;
          return [];
        }
      });
      walked.push({
        pathname: p.pathname, html, visible: visibleText(html), blocks, invalid,
        meta: { ...meta, openGraph: meta.openGraph ?? layoutMeta.openGraph, robots: meta.robots ?? layoutMeta.robots },
        pageDir: path.join("app", hit.key.replace("../../app/", "").replace(/\/?page\.tsx$/, "")),
        hasOwnOpenGraph: Boolean(meta.openGraph),
      });
    }
  } finally {
    stop();
  }
}, 180_000);

describe("the walk covers the sitemap", () => {
  it("renders every sitemap page (the published sample documents under /reference are static files)", () => {
    expect(walked.length).toBeGreaterThan(40);
    expect(walked.map((w) => w.pathname)).toEqual(pages.map((p) => p.pathname));
  });
});

describe("per page: canonical, one h1, OpenGraph", () => {
  it("every page names itself canonical, and the canonical is in the sitemap", () => {
    const inSitemap = new Set(pages.map((p) => p.pathname));
    const bad: string[] = [];
    for (const w of walked) {
      const c = w.meta.alternates?.canonical;
      if (typeof c !== "string") {
        // The home page inherits the root layout's canonical.
        if (w.pathname !== "/") bad.push(`${w.pathname}: no canonical`);
        continue;
      }
      const pathOnly = c.startsWith("http") ? urlOf(c) : c.replace(/\/$/, "") || "/";
      if (pathOnly !== w.pathname) bad.push(`${w.pathname}: canonical is ${c}`);
      if (!inSitemap.has(pathOnly)) bad.push(`${w.pathname}: canonical ${c} is not in the sitemap`);
    }
    expect(bad).toEqual([]);
  });

  it("every page renders exactly one h1", () => {
    const bad = walked.map((w) => [w.pathname, (w.html.match(/<h1[\s>]/g) ?? []).length] as const).filter(([, n]) => n !== 1);
    expect(bad).toEqual([]);
  });

  it("every page has an OpenGraph title and description of its own and a card", () => {
    const bad: string[] = [];
    for (const w of walked) {
      const og = w.meta.openGraph;
      if (!og || typeof og.title !== "string" || typeof og.description !== "string" || !og.title || !og.description) {
        bad.push(`${w.pathname}: openGraph title/description missing`);
        continue;
      }
      // A page that sets its own openGraph replaces the layout's, card included: it needs images or an opengraph-image file of its own.
      const own = fs.readdirSync(w.pageDir).some((f) => /^opengraph-image\.(tsx|png|jpe?g)$/.test(f));
      const inherited = fs.existsSync("app/opengraph-image.tsx");
      const hasCard = w.hasOwnOpenGraph ? Boolean(og.images) || own : own || Boolean(og.images) || inherited;
      if (!hasCard) bad.push(`${w.pathname}: no social card`);
    }
    expect(bad).toEqual([]);
  });

  it("no two pages share a title or a description", async () => {
    // (The home page takes the root layout's default title, which is its own.)
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const w of walked) {
      // /legal pages and others inherit nothing: a missing title would fall back to the layout's default and collide.
      const key = JSON.stringify([typeof w.meta.title === "string" ? w.meta.title : JSON.stringify(w.meta.title), w.meta.description]);
      if (w.meta.title === undefined && w.pathname !== "/") {
        dup.push(`${w.pathname}: no title of its own`);
        continue;
      }
      if (seen.has(key)) dup.push(`${w.pathname} repeats the title and description of ${seen.get(key)}`);
      seen.set(key, w.pathname);
    }
    expect(dup).toEqual([]);
    const titles = new Map<string, string>();
    const sameTitle: string[] = [];
    for (const w of walked) {
      if (w.meta.title === undefined) continue;
      const t = typeof w.meta.title === "string" ? w.meta.title : JSON.stringify(w.meta.title);
      if (titles.has(t)) sameTitle.push(`${w.pathname} and ${titles.get(t)} share the title ${t}`);
      titles.set(t, w.pathname);
    }
    expect(sameTitle).toEqual([]);
  });
});

describe("the visible-text rule that FAQPage depends on", () => {
  it("drops text inside hidden, aria-hidden and display:none elements, nested content included, and keeps the rest", () => {
    const html =
      '<p>seen one</p><div hidden><p>gone a</p></div><div aria-hidden="true"><span>gone b</span></div>' +
      '<section style="display: none"><div><p>gone c</p></div></section><div class="mt-2 hidden"><b>gone d</b></div>' +
      '<details><summary>seen two</summary><p>seen three</p></details><span class="sr-only">seen four</span><p class="md:hidden">seen five</p>' +
      "<script>var gone = 'e';</script><p>seen six</p>";
    const t = visibleText(html);
    for (const s of ["seen one", "seen two", "seen three", "seen four", "seen five", "seen six"]) expect(t, s).toContain(s);
    for (const g of ["gone a", "gone b", "gone c", "gone d", "gone"]) expect(t, g).not.toContain(g);
  });

  it("a FAQ answer placed in a hidden element is not visible", () => {
    const html = '<h2>Q?</h2><div class="hidden"><p>The answer text of the question.</p></div>';
    expect(visibleText(html)).not.toContain("The answer text");
  });
});

describe("per page: structured data", () => {
  it("every JSON-LD block parses", () => {
    expect(walked.filter((w) => w.invalid).map((w) => w.pathname)).toEqual([]);
  });

  it("uses only allowed types, none of the types that imply a rating, review or product, and nothing nested that is not allowed", () => {
    const bad: string[] = [];
    for (const w of walked) {
      for (const { type, top } of nodes(w.blocks)) {
        if (FORBIDDEN_TYPES.test(type)) bad.push(`${w.pathname}: forbidden type ${type}`);
        else if (top && !ALLOWED_TOP_LEVEL.has(type)) bad.push(`${w.pathname}: type ${type} is not on the allowed list`);
        else if (!top && !ALLOWED_TOP_LEVEL.has(type) && !ALLOWED_NESTED.has(type)) bad.push(`${w.pathname}: nested type ${type} is not allowed`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("claims no rating, review, licence, award or usage figure", () => {
    const bad: string[] = [];
    for (const w of walked) {
      const keys = keysDeep(w.blocks);
      for (const k of FORBIDDEN_KEYS) if (keys.has(k)) bad.push(`${w.pathname}: ${k}`);
      // The visible text must not carry a star rating or review count either.
      if (/\b\d(\.\d)?\s*(?:\/\s*5|stars?)\b|\b\d+\s+reviews?\b/i.test(w.visible)) bad.push(`${w.pathname}: visible rating or review count`);
    }
    expect(bad).toEqual([]);
  });

  it("sameAs appears only on the organisation, and holds only the profiles lib/entity.ts really has", () => {
    const bad: string[] = [];
    for (const w of walked) {
      for (const { type, node } of nodes(w.blocks)) {
        if ("sameAs" in node) {
          if (!["Organization", "ProfessionalService"].includes(type)) bad.push(`${w.pathname}: sameAs on ${type}`);
          else expect(node.sameAs, w.pathname).toEqual(sameAsUrls());
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("every page's own nodes point at the page itself, and breadcrumbs end at it", () => {
    const inSitemap = new Set(pages.map((p) => p.pathname));
    const bad: string[] = [];
    for (const w of walked) {
      for (const { type, node, top } of nodes(w.blocks)) {
        if (!top) continue;
        if (["WebPage", "CollectionPage", "TechArticle", "SoftwareApplication", "WebApplication", "AboutPage", "ContactPage", "Dataset"].includes(type) && typeof node.url === "string") {
          if (urlOf(node.url) !== w.pathname) bad.push(`${w.pathname}: ${type} url is ${node.url}`);
          if (!node.url.startsWith(SITE_URL)) bad.push(`${w.pathname}: ${type} url is not on the site`);
        }
        if (type === "BreadcrumbList") {
          const items = node.itemListElement as { position: number; item: string }[];
          if (urlOf(items.at(-1)!.item) !== w.pathname) bad.push(`${w.pathname}: breadcrumb ends at ${items.at(-1)!.item}`);
          if (urlOf(items[0].item) !== "/") bad.push(`${w.pathname}: breadcrumb does not start at the home page`);
          items.forEach((it, i) => {
            if (it.position !== i + 1) bad.push(`${w.pathname}: breadcrumb positions`);
            const p = urlOf(it.item);
            if (!inSitemap.has(p) && !fs.existsSync(path.join("app", p))) bad.push(`${w.pathname}: breadcrumb item ${it.item} is not a page of this site`);
          });
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("a Dataset describes data the site really publishes: a file in public/ or a read-only API route, with a description", () => {
    const apiOk = new Set(["/api/constraints", "/api/cite"]);
    const bad: string[] = [];
    let seen = 0;
    for (const w of walked) {
      for (const { type, node, top } of nodes(w.blocks)) {
        if (type !== "Dataset" || !top) continue;
        seen++;
        if (typeof node.name !== "string" || typeof node.description !== "string" || node.description.length < 40) bad.push(`${w.pathname}: Dataset name/description`);
        const dists = ([] as any[]).concat(node.distribution ?? []);
        for (const d of dists) {
          const p = new URL(d.contentUrl).pathname;
          if (!apiOk.has(p) && !fs.existsSync(path.join("public", p))) bad.push(`${w.pathname}: distribution ${d.contentUrl} is not served`);
        }
        // Without a file, a Dataset must hold its values itself.
        if (dists.length === 0 && !(Array.isArray(node.variableMeasured) && node.variableMeasured.length)) bad.push(`${w.pathname}: Dataset with neither a distribution nor values`);
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });

  it("the synthetic observatory data is described as synthetic", () => {
    const obs = walked.find((w) => w.pathname === "/observatory")!;
    const ds = nodes(obs.blocks).find((n) => n.type === "Dataset")!.node;
    expect(String(ds.name + " " + ds.description).toLowerCase()).toContain("synthetic");
  });

  it("every price is a catalogue amount, or zero for the one thing the registry calls free; a SoftwareApplication carries no other offer", () => {
    const amounts = new Set<number>([
      ...Object.values(PRODUCTS).map((p) => p.amountCents),
      ...Object.values(INTELLIGENCE_PLANS).map((p) => p.priceCents),
      PAYG.unitPriceCents,
    ]);
    const bad: string[] = [];
    for (const w of walked) {
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            if (k === "price") {
              const cents = Math.round(Number(x) * 100);
              if (!amounts.has(cents) && cents !== 0) bad.push(`${w.pathname}: price ${x} is not a catalogue amount`);
              if (cents === 0 && w.pathname === "/qualify" && capabilityById("qualify")?.status !== "free") bad.push(`${w.pathname}: free offer while the registry says it is not`);
            } else walk(x);
          }
        }
      };
      walk(w.blocks);
      for (const { type, node } of nodes(w.blocks)) {
        if (["SoftwareApplication", "WebApplication"].includes(type) && node.offers) {
          const prices = ([] as any[]).concat(node.offers).map((o) => Math.round(Number(o.price) * 100));
          if (prices.some((c) => c !== 0 && !amounts.has(c))) bad.push(`${w.pathname}: application offer not in the catalogue`);
          if (prices.some((c) => c === 0) && node.isAccessibleForFree !== true) bad.push(`${w.pathname}: a zero offer without isAccessibleForFree`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("a FAQPage is emitted only where every question and answer is visible on the page", () => {
    const bad: string[] = [];
    let faqPages = 0;
    for (const w of walked) {
      for (const { type, node } of nodes(w.blocks)) {
        if (type !== "FAQPage") continue;
        faqPages++;
        const qs = node.mainEntity as { name: string; acceptedAnswer: { text: string } }[];
        if (!Array.isArray(qs) || qs.length === 0) bad.push(`${w.pathname}: empty FAQPage`);
        for (const q of qs ?? []) {
          const norm = (s: string) => s.replace(/\s+/g, " ").trim();
          if (!w.visible.includes(norm(q.name))) bad.push(`${w.pathname}: question not visible: ${q.name.slice(0, 60)}`);
          if (!w.visible.includes(norm(q.acceptedAnswer.text))) bad.push(`${w.pathname}: answer not visible: ${q.name.slice(0, 60)}`);
        }
      }
    }
    expect(faqPages).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });
});

describe("the published sample documents (public/reference/*.html) that the sitemap also lists", () => {
  // These are static files generated by scripts/build-reference.sh, not Next pages: they carry their own head and no social card (OpenGraph is
  // for pages that are shared; the samples are documents, and a card would be the site's, not theirs). What they must have is what a crawler
  // reads: one canonical equal to their own URL and listed in the sitemap, an indexable robots tag, a title and description, and one h1.
  it("each names itself canonical, is indexable, has a title, a description and one h1, and makes no structured-data claim", async () => {
    const htmlUrls = (await sitemap()).map((u) => u.url).filter((u) => u.endsWith(".html"));
    expect(htmlUrls.length).toBeGreaterThanOrEqual(6);
    const bad: string[] = [];
    for (const url of htmlUrls) {
      const file = path.join("public", new URL(url).pathname);
      const html = fs.readFileSync(file, "utf8");
      const canon = [...html.matchAll(/<link rel=['"]canonical['"] href=['"]([^'"]*)['"]/g)].map((m) => m[1]);
      if (canon.length !== 1 || canon[0] !== url) bad.push(`${url}: canonical is ${JSON.stringify(canon)}`);
      if (!/<meta name=['"]robots['"] content=['"]index/.test(html)) bad.push(`${url}: not indexable`);
      if (!/<title>[^<]{5,}<\/title>/.test(html)) bad.push(`${url}: no title`);
      if (!/<meta name=['"]description['"] content=['"][^'"]{40,}['"]/.test(html)) bad.push(`${url}: no description`);
      if ((html.match(/<h1[\s>]/g) ?? []).length !== 1) bad.push(`${url}: h1 count`);
      if (/application\/ld\+json/.test(html)) bad.push(`${url}: carries structured data this test does not vet`);
    }
    expect(bad).toEqual([]);
  });
});

describe("which routes are public: the sitemap, robots.txt and llms.txt agree", () => {
  const rules = robots().rules as { userAgent: string; allow?: string | string[]; disallow?: string | string[] }[];
  const arr = (v?: string | string[]) => (Array.isArray(v) ? v : v ? [v] : []);
  const star = rules.find((r) => r.userAgent === "*")!;
  /** robots.txt semantics for our rules: the longest matching prefix wins; allow wins a tie. */
  const allowedByRobots = (r: { allow?: string | string[]; disallow?: string | string[] }, p: string) => {
    const best = (list: string[]) => list.filter((x) => p.startsWith(x)).reduce((n, x) => Math.max(n, x.length), -1);
    return best(arr(r.allow)) >= best(arr(r.disallow));
  };

  it("no sitemap URL is closed by robots.txt for any crawler, or noindex", () => {
    const bad: string[] = [];
    for (const w of walked) {
      for (const r of rules) if (!allowedByRobots(r, w.pathname)) bad.push(`${w.pathname}: disallowed for ${r.userAgent}`);
      const rb = w.meta.robots;
      if (rb && typeof rb === "object" && rb.index === false) bad.push(`${w.pathname}: noindex but in the sitemap`);
    }
    expect(bad).toEqual([]);
  });

  it("every page that is private by design is closed in robots.txt and carries noindex or sits behind a token", () => {
    // The private route families: the signed-in surfaces, the token-addressed documents and the operator console.
    const closed = ["/dashboard", "/account", "/admin", "/api/", "/api-access/", "/deliverable/", "/watch/", "/intake/", "/q/", "/p/", "/commissioned", "/power/deploy/", "/workspace"];
    for (const c of closed) expect(arr(star.disallow), c).toContain(c);
    expect(arr(star.allow)).toEqual(expect.arrayContaining(["/", "/openapi.json", "/api/cite", "/api/constraints"]));
    expect(arr(star.allow)).not.toContain("/api/");
    for (const [dir, file] of [["app/account", "layout.tsx"], ["app/dashboard", "layout.tsx"], ["app/admin/login", "layout.tsx"], ["app/workspace", "page.tsx"]]) {
      expect(fs.readFileSync(path.join(dir, file), "utf8"), `${dir}/${file}`).toMatch(/robots:\s*\{\s*index:\s*false/);
    }
  });

  it("the sitemap, robots.txt and llms.txt name the sitemap/OpenAPI consistently and every robots rule set closes the same private paths", () => {
    const first = JSON.stringify(arr(star.disallow).sort());
    for (const r of rules) expect(JSON.stringify(arr(r.disallow).sort()), r.userAgent).toBe(first);
    expect((robots() as { sitemap?: string }).sitemap).toBe(`${SITE_URL}/sitemap.xml`);
  });

  it("every page llms.txt points a reader at is public, indexable and in the sitemap (or a published file of the site)", async () => {
    const { GET } = await import("@/app/llms.txt/route");
    const stop = stubEngine(FULL_ENGINE);
    let body: string;
    try {
      body = await (await GET()).text();
    } finally {
      stop();
    }
    const inSitemap = new Set(pages.map((p) => p.pathname));
    const links = [...body.matchAll(/https:\/\/timetopower\.ai(\/[^\s)`>\]"']*)/g)].map((m) => m[1].replace(/[.,;]+$/, ""));
    expect(links.length).toBeGreaterThan(30);
    // llms.txt cites one POST endpoint to start a purchase. It is an action, not a page: crawlers are rightly kept out of /api/.
    const ACTIONS = new Set(["/api/checkout"]);
    const bad: string[] = [];
    for (const l of links) {
      const p = l.split("#")[0].split("?")[0].replace(/\/$/, "") || "/";
      if (ACTIONS.has(p)) continue;
      for (const r of rules) {
        if (!allowedByRobots(r, p)) bad.push(`${l}: closed by robots.txt for ${r.userAgent}`);
      }
      const isPage = inSitemap.has(p);
      const isPublicFile = fs.existsSync(path.join("public", p));
      // Route handlers the site serves (llms.txt cites the OpenAPI, the vCard, the security file, the citation and checkout endpoints).
      const isRoute = ["/openapi.json", "/contact.vcf", "/.well-known/security.txt", "/api/cite", "/api/constraints", "/sitemap.xml", "/robots.txt"].includes(p);
      const isDynamicPublic = /^\/reference\/constraints\/[a-z0-9-]+\.json$/.test(p) && isPublicFile;
      if (!isPage && !isPublicFile && !isRoute && !isDynamicPublic) bad.push(`${l}: not a public page, file or route of the site`);
    }
    expect(bad).toEqual([]);
  });
});
