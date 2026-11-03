import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConstraintReference, PlatformEntry } from "@/lib/constraints";
import { PRODUCT_PAGES, productForPage } from "@/lib/product-pages";
import { eurFromCents } from "@/lib/products";
import { CARD_SIZE, DEFAULT_CARD, cardAlt, cardElement, clamp, renderCard, titleSize } from "@/lib/share-card";
import { constraintCard, platformCard, productCard } from "@/lib/share-content";
import { pageablePlatforms } from "@/lib/platform-pages";

const ref = JSON.parse(readFileSync("public/reference/constraints.json", "utf8")) as ConstraintReference;
const platforms = pageablePlatforms((JSON.parse(readFileSync("public/reference/platforms.json", "utf8")) as { platforms: PlatformEntry[] }).platforms);

describe("clamp and titleSize", () => {
  it("never exceeds the length, ends on a word, and says it was cut", () => {
    const t = "A rack feed current that is tested at the wrong voltage passes a tap-off that cannot carry the rack at all";
    for (const n of [20, 40, 60, 90]) {
      const c = clamp(t, n);
      expect(c.length).toBeLessThanOrEqual(n);
      expect(c.endsWith("…")).toBe(true);
      expect(t.startsWith(c.slice(0, -1))).toBe(true);
    }
    expect(clamp("short", 20)).toBe("short");
    expect(clamp("  spaced   out  ", 20)).toBe("spaced out");
  });

  it("steps the title size down as it grows, so three lines always fit", () => {
    expect(titleSize("Busway ampacity")).toBeGreaterThan(titleSize("x".repeat(60)));
    for (const len of [10, 28, 29, 48, 49, 72, 73, 96]) {
      const lines = Math.ceil((len * titleSize("x".repeat(len)) * 0.55) / 1040);
      expect(lines, `${len} chars`).toBeLessThanOrEqual(3);
    }
  });
});

describe("what each card says is the page's own data", () => {
  it("a card for every constraint, from its own fields", () => {
    expect(ref.constraints.length).toBe(13);
    for (const c of ref.constraints) {
      const card = constraintCard(c);
      expect(card.title).toBe(c.name);
      expect(card.subtitle).toBe(c.headline);
      expect(card.facts!.length).toBeLessThanOrEqual(4);
      if (c.lead_time_weeks) expect(card.facts!.join(" ")).toContain(`${c.lead_time_weeks.low} to ${c.lead_time_weeks.high} weeks (indicative)`);
      expect(cardAlt(card).length).toBeLessThanOrEqual(200);
    }
  });

  it("a card for every platform page, with the library's figures", () => {
    expect(platforms.length).toBeGreaterThan(0);
    for (const p of platforms) {
      const facts = platformCard(p).facts!.join(" | ");
      expect(facts).toContain(`${p.rack_kW} kW per rack`);
      expect(facts).toContain(`${p.flow_l_per_min_per_rack} l/min`);
      expect(facts).toContain(`${Math.round(p.liquid_fraction * 100)}% liquid`);
    }
  });

  it("a card for every engagement, priced from the catalogue and never promising a result", () => {
    for (const page of PRODUCT_PAGES) {
      const p = productForPage(page);
      const card = productCard(page, p);
      expect(card.facts!.join(" ")).toContain(eurFromCents(p.amountCents));
      if (p.opensBandCents) expect(card.facts!.join(" ")).toContain(`Opens ${eurFromCents(p.opensBandCents[0])} to ${eurFromCents(p.opensBandCents[1])}`);
      expect(JSON.stringify(card).toLowerCase()).not.toMatch(/guarantee|market leader|trusted by|best-in-class/);
    }
  });

  it("the default card makes no claim a page could not back", () => {
    expect(JSON.stringify(DEFAULT_CARD).toLowerCase()).not.toMatch(/guarantee|customers|leader|rated|award/);
  });
});

describe("the card is drawn", () => {
  it("as a 1200x630 PNG, for the default, a constraint, a platform and an engagement", async () => {
    const cards = [DEFAULT_CARD, constraintCard(ref.constraints[0]), platformCard(platforms[0]), productCard(PRODUCT_PAGES[0], productForPage(PRODUCT_PAGES[0]))];
    for (const c of cards) {
      const res = renderCard(c);
      const buf = Buffer.from(await res.arrayBuffer());
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(buf.readUInt32BE(0)).toBe(0x89504e47);
      expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([CARD_SIZE.width, CARD_SIZE.height]);
      expect(buf.length).toBeLessThan(600 * 1024);
    }
  }, 60_000);

  it("a hostile title is clamped, not allowed to run off the card", () => {
    const el = cardElement({ kicker: "k".repeat(300), title: "T".repeat(400), subtitle: "s".repeat(900), facts: Array.from({ length: 9 }, (_, i) => `fact ${i} ${"x".repeat(80)}`) });
    expect(JSON.stringify(el).length).toBeLessThan(6000);
  });
});

describe("brand assets", () => {
  const png = (f: string) => {
    const b = readFileSync(`public/${f}`);
    return { sig: b.readUInt32BE(0), w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
  };
  it.each([["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512], ["icon-maskable-512.png", 512], ["logo.png", 512]])("%s is a square %i px PNG", (f, n) => {
    const i = png(f);
    expect(i.sig).toBe(0x89504e47);
    expect([i.w, i.h]).toEqual([n, n]);
  });
  it("favicon.ico is an ICO container with 16, 32 and 48 px images", () => {
    const b = readFileSync("public/favicon.ico");
    expect(b.readUInt16LE(2)).toBe(1);
    const count = b.readUInt16LE(4);
    expect(count).toBe(3);
    const sizes = Array.from({ length: count }, (_, i) => b.readUInt8(6 + i * 16));
    expect(sizes).toEqual([16, 32, 48]);
    for (let i = 0; i < count; i++) {
      const len = b.readUInt32LE(6 + i * 16 + 8), off = b.readUInt32LE(6 + i * 16 + 12);
      expect(b.readUInt32BE(off)).toBe(0x89504e47);
      expect(off + len).toBeLessThanOrEqual(b.length);
    }
  });
});

describe("the page-card registry", () => {
  it("every id a page names exists, and every entry is used by a page", async () => {
    const { PAGE_CARDS, pageImages } = await import("@/lib/page-cards");
    const { execFileSync } = await import("node:child_process");
    const used = new Set(
      execFileSync("grep", ["-rhoE", 'pageImages\\("[a-z-]+"\\)', "app"], { encoding: "utf8" })
        .split("\n").filter(Boolean).map((m) => /"([a-z-]+)"/.exec(m)![1])
    );
    expect([...used].filter((id) => !(id in PAGE_CARDS))).toEqual([]);
    expect(Object.keys(PAGE_CARDS).filter((id) => !used.has(id))).toEqual([]);
    for (const id of Object.keys(PAGE_CARDS)) {
      const [img] = pageImages(id);
      expect(img.url).toBe(`/cards/${id}.png`);
      expect([img.width, img.height]).toEqual([1200, 630]);
      expect(img.alt.length).toBeGreaterThan(10);
    }
  });

  it("each card draws, from its own words, as a 1200x630 PNG", async () => {
    const { PAGE_CARDS } = await import("@/lib/page-cards");
    for (const [id, card] of Object.entries(PAGE_CARDS)) {
      const buf = Buffer.from(await renderCard(card).arrayBuffer());
      expect([buf.readUInt32BE(16), buf.readUInt32BE(20)], id).toEqual([1200, 630]);
      expect(JSON.stringify(card).toLowerCase(), id).not.toMatch(/guarantee|customers|market leader|award|trusted by/);
    }
  }, 120_000);

  it("the route serves exactly the registry and nothing else", async () => {
    const { GET, generateStaticParams } = await import("@/app/cards/[file]/route");
    const { PAGE_CARDS } = await import("@/lib/page-cards");
    expect(generateStaticParams().map((p) => p.file).sort()).toEqual(Object.keys(PAGE_CARDS).map((i) => `${i}.png`).sort());
    const ok = await GET(new Request("http://x/cards/pricing.png"), { params: Promise.resolve({ file: "pricing.png" }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    for (const bad of ["nope.png", "__proto__.png", "constructor.png", "../x.png", "pricing"]) {
      const r = await GET(new Request("http://x/c"), { params: Promise.resolve({ file: bad }) });
      expect(r.status, bad).toBe(404);
    }
  }, 60_000);
});
