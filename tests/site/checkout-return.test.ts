/**
 * The page a buyer lands on after cancelling Stripe Checkout.
 *
 * app/api/checkout/route.ts sends a cancelled one-off product to /qualify?purchase=cancelled and everything else (the deposit, a buyer who came from
 * a shared project link) to /pricing?deposit=cancelled. Nothing read either parameter, so a buyer who changed their mind landed on a page that did
 * not acknowledge it. Now a dismissible notice says "Checkout cancelled — nothing was charged", names no state the URL could forge, and links back
 * to the product page they left (a catalogue id, validated) and to the free check.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANCEL_RETURNS, isCancelledReturn, productBack, LAST_CHECKOUT_KEY } from "@/lib/checkout-return";
import { REMEMBER_MS, rememberCheckout, takeRememberedCheckout } from "@/lib/checkout-return-key";
import { PRODUCTS } from "@/lib/products";
import { PRODUCT_PAGES } from "@/lib/product-pages";

const ROOT = path.resolve(__dirname, "../..");
const params = (q: string) => new URLSearchParams(q);
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const nav = vi.hoisted(() => ({ path: "/qualify", query: "purchase=cancelled" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path, useSearchParams: () => new URLSearchParams(nav.query), useRouter: () => ({ push: () => {}, replace: () => {} }) }));

describe("which URLs are a cancelled return", () => {
  it("is exactly the two cancel_urls the checkout route sets, read from that route's source", () => {
    const route = fs.readFileSync(path.join(ROOT, "app/api/checkout/route.ts"), "utf8");
    const urls = [...route.matchAll(/\$\{origin\}(\/[a-z]+\?[a-z]+=cancelled)/g)].map((m) => m[1]).sort();
    expect(urls).toEqual(CANCEL_RETURNS.map((r) => `${r.path}?${r.param}=cancelled`).sort());
  });

  it("the one-off product's cancel_url names the product by its validated catalogue id, and only that line of the route changed", () => {
    const route = fs.readFileSync(path.join(ROOT, "app/api/checkout/route.ts"), "utf8");
    expect(route).toContain("cancel_url: product && !fromBuyerLink ? `${origin}/qualify?purchase=cancelled&product=${product.id}` : `${origin}/pricing?deposit=cancelled`,");
    // `product` is PRODUCTS[productId] and productId only ever comes from isProductId (the catalogue), so a client cannot put text in the URL.
    expect(route).toMatch(/const product = productId \? PRODUCTS\[productId\] : null;/);
    expect(route).toMatch(/!isProductId\(b\.product\)/);
    for (const id of Object.keys(PRODUCTS)) expect(PRODUCTS[id as keyof typeof PRODUCTS].id).toBe(id);
  });

  it("shows on /qualify?purchase=cancelled and /pricing?deposit=cancelled and nowhere else", () => {
    expect(isCancelledReturn("/qualify", params("purchase=cancelled"))).toBe(true);
    expect(isCancelledReturn("/pricing", params("deposit=cancelled"))).toBe(true);
    expect(isCancelledReturn("/pricing", params("purchase=cancelled"))).toBe(false);
    expect(isCancelledReturn("/qualify", params("deposit=cancelled"))).toBe(false);
    expect(isCancelledReturn("/", params("purchase=cancelled"))).toBe(false);
    expect(isCancelledReturn("/qualify", params(""))).toBe(false);
    expect(isCancelledReturn(null, params("purchase=cancelled"))).toBe(false);
  });

  it("needs the exact value 'cancelled': success, other words, case changes and look-alikes show nothing", () => {
    for (const v of ["success", "canceled", "CANCELLED", "cancelled ", "cancelled%00", "true", "1", "<b>cancelled</b>", "cancelled&purchase=x", ""]) {
      expect(isCancelledReturn("/qualify", new URLSearchParams({ purchase: v })), JSON.stringify(v)).toBe(false);
    }
  });
});

describe("the product the visitor left comes from the catalogue, never from the URL's text", () => {
  it("accepts a catalogue id or a product-page slug and returns the catalogue's own name and the page's own path", () => {
    const b = productBack("density_screen")!;
    expect(b.name).toBe(PRODUCTS.density_screen.name);
    expect(b.href).toBe("/products/density-screen");
    expect(productBack("density-screen")!.id).toBe("density_screen");
    for (const p of PRODUCT_PAGES) expect(productBack(p.productId)!.href).toBe(`/products/${p.slug}`);
  });

  it("returns nothing for hostile, unknown, prototype-chain or oversized values", () => {
    const hostile = ["<script>alert(1)</script>", "https://evil.example/", "//evil.example", "javascript:alert(1)", "../../admin", "density_screen/../../x", "__proto__", "constructor", "toString", "hasOwnProperty", "", "x".repeat(10_000), "density_screen\n", " density_screen", "DENSITY_SCREEN", null, undefined];
    for (const h of hostile) expect(productBack(h as string | null | undefined), JSON.stringify(h)?.slice(0, 40)).toBeNull();
  });

  it("a product with no page of its own (an API plan) has no 'page I left', so the notice offers the general list", () => {
    expect(productBack("api_triage")).toBeNull();
  });

  it("every link it can produce is a site-relative path", () => {
    for (const id of Object.keys(PRODUCTS)) {
      const b = productBack(id);
      if (b) expect(b.href).toMatch(/^\/products\/[a-z0-9-]+$/);
    }
  });
});

describe("the notice", () => {
  async function banner(productParam: string | null, useRemembered = true) {
    const Banner = (await import("@/components/CheckoutCancelledBanner")).default;
    return html(React.createElement(Banner, { productParam, useRemembered, onDismiss: () => {} }));
  }
  const unesc = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

  it("says checkout was cancelled and nothing was charged, links the free check, and can be dismissed", async () => {
    const h = await banner(null);
    expect(unesc(h)).toContain("Checkout cancelled — nothing was charged.");
    expect(h).toContain('href="/qualify"');
    expect(h).toContain('data-testid="checkout-cancelled"');
    expect(h).toMatch(/<button[^>]*aria-label="Dismiss this notice"/);
  });

  it("is drawn in the page flow under the header, never fixed over the page", async () => {
    const h = await banner(null);
    expect(h).not.toMatch(/\bfixed\b|\bsticky\b|\babsolute\b/);
    expect(h).toMatch(/pt-\[4\.25rem\] sm:pt-\[5\.25rem\]/); // clears the 64 / 80 px header inside its own box
    expect(h).toMatch(/relative z-\[1\]/); // above the page it is pulled over, so its links are never covered
  });

  it("is plain content: the announcement is made by the live region, not by a role on the notice", async () => {
    expect(await banner(null)).not.toMatch(/role="(status|alert)"|aria-live/);
  });

  it("links back to the product page the buyer left when the product is a catalogue id", async () => {
    const h = await banner("density_screen");
    expect(h).toContain('href="/products/density-screen"');
    expect(unesc(h)).toContain(`Back to the ${PRODUCTS.density_screen.name}`);
  });

  it("with no product (or a hostile one) offers the general list and reflects nothing from the query", async () => {
    for (const hostileValue of ["<script>alert(1)</script>", "https://evil.example/", "javascript:alert(1)", '"><img src=x onerror=alert(1)>', "__proto__"]) {
      const h = await banner(hostileValue);
      expect(h).toContain('href="/products"');
      expect(h).not.toContain(hostileValue);
      expect(h).not.toMatch(/evil\.example|onerror|<script|javascript:/i);
      const hrefs = [...h.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      for (const href of hrefs) expect(href).toMatch(/^\/[a-z0-9/-]*$/);
    }
  });

  it("is mounted once in the site shell, inside Suspense, and is fetched only when a cancelled return is showing", () => {
    const layout = fs.readFileSync(path.join(ROOT, "app/layout.tsx"), "utf8");
    expect(layout).toMatch(/<Suspense fallback=\{null\}>\s*<CheckoutReturnNotice \/>/);
    const wrapper = fs.readFileSync(path.join(ROOT, "components/CheckoutReturnNotice.tsx"), "utf8");
    expect(wrapper).toMatch(/dynamic\(\(\) => import\("@\/components\/CheckoutCancelledBanner"\)/);
    expect(wrapper).not.toMatch(/product-pages|lib\/products/); // the catalogue is not in every page's bundle
  });
});

describe("the announcement and the keyboard", () => {
  it("the shell mounts an EMPTY polite live region first (it is filled only after the notice has appeared)", async () => {
    nav.path = "/qualify";
    nav.query = "purchase=cancelled";
    const { CheckoutReturnNotice } = await import("@/components/CheckoutReturnNotice");
    const h = html(React.createElement(CheckoutReturnNotice));
    expect(h).toMatch(/<div role="status" aria-live="polite" class="sr-only" data-testid="checkout-cancelled-live"><\/div>/);
    nav.query = "";
    expect(html(React.createElement(CheckoutReturnNotice))).toMatch(/data-testid="checkout-cancelled-live"><\/div>/); // present on every page, empty
  });

  it("fills the region from a timer after the notice shows, clears it with the notice, and Escape dismisses", () => {
    const src = fs.readFileSync(path.join(ROOT, "components/CheckoutReturnNotice.tsx"), "utf8");
    expect(src).toMatch(/window\.setTimeout\(\(\) => setAnnouncement\(CANCELLED_TITLE\), \d+\)/);
    expect(src).toMatch(/if \(!shows\) \{\s*setAnnouncement\(""\)/);
    expect(src).toMatch(/e\.key === "Escape"\) dismiss\(\)/);
  });
});

describe("a remembered product is consumed, expires and is never used on /pricing", () => {
  afterEach(() => vi.unstubAllGlobals());
  function stubStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
    return store;
  }

  it("is removed as it is read, so a second return cannot reuse it", () => {
    const store = stubStorage();
    rememberCheckout("density_screen", 1_000);
    expect(store.has(LAST_CHECKOUT_KEY)).toBe(true);
    expect(takeRememberedCheckout(2_000)).toBe("density_screen");
    expect(store.has(LAST_CHECKOUT_KEY)).toBe(false);
    expect(takeRememberedCheckout(3_000)).toBeNull();
  });

  it("a stale id (older than an hour), a future-dated one, a malformed one and a non-string are refused, and still cleared", () => {
    const store = stubStorage();
    rememberCheckout("density_screen", 0);
    expect(takeRememberedCheckout(REMEMBER_MS + 1)).toBeNull();
    expect(store.has(LAST_CHECKOUT_KEY)).toBe(false);
    rememberCheckout("density_screen", 10_000);
    expect(takeRememberedCheckout(5_000)).toBeNull();
    store.set(LAST_CHECKOUT_KEY, "density_screen");
    expect(takeRememberedCheckout()).toBeNull();
    store.set(LAST_CHECKOUT_KEY, JSON.stringify({ id: 7, at: Date.now() }));
    expect(takeRememberedCheckout()).toBeNull();
    expect(store.size).toBe(0);
  });

  it("the banner reads it once per show, only names a product from it on /qualify, and the wrapper passes that", () => {
    const b = fs.readFileSync(path.join(ROOT, "components/CheckoutCancelledBanner.tsx"), "utf8");
    // read-and-clear happens BEFORE the early return, so an id that is not used is still consumed
    expect(b.indexOf("takeRememberedCheckout()")).toBeGreaterThan(-1);
    expect(b.indexOf("takeRememberedCheckout()")).toBeLessThan(b.indexOf("if (back || !useRemembered) return;"));
    expect(fs.readFileSync(path.join(ROOT, "components/CheckoutReturnNotice.tsx"), "utf8")).toContain('useRemembered={pathname === "/qualify"}');
  });
});

describe("remembering which product was sent to Stripe", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("startCommission stores the catalogue id in sessionStorage just before it leaves, and still navigates to Stripe's URL", async () => {
    const store = new Map<string, string>();
    const loc = { href: "" };
    vi.stubGlobal("window", { location: loc, sessionStorage: { setItem: (k: string, v: string) => store.set(k, v) } });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, url: "https://checkout.stripe.test/c/pay_1" }), { status: 200 }));
    const { startCommission } = await import("@/lib/ui");
    const out = await startCommission("density_screen", { context: "hero" });
    expect(out).toEqual({ ok: true });
    expect(JSON.parse(store.get(LAST_CHECKOUT_KEY)!)).toMatchObject({ id: "density_screen", at: expect.any(Number) });
    expect(loc.href).toBe("https://checkout.stripe.test/c/pay_1");
  });

  it("a blocked sessionStorage never stops the redirect", async () => {
    const loc = { href: "" };
    vi.stubGlobal("window", { location: loc, sessionStorage: { setItem: () => { throw new Error("blocked"); } } });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, url: "https://checkout.stripe.test/c/pay_2" }), { status: 200 }));
    const { startCommission } = await import("@/lib/ui");
    expect(await startCommission("density_screen")).toEqual({ ok: true });
    expect(loc.href).toBe("https://checkout.stripe.test/c/pay_2");
  });

  it("does not touch what the checkout request asks for or how a failure is reported", async () => {
    const loc = { href: "" };
    vi.stubGlobal("window", { location: loc, sessionStorage: { setItem: () => {} } });
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: false, error: "Payments not configured" }), { status: 503 });
    });
    const { startCommission } = await import("@/lib/ui");
    const out = await startCommission("density_screen", { context: "hero" });
    expect(out.ok).toBe(false);
    expect(loc.href).toBe("");
    expect(bodies[0]).toMatchObject({ product: "density_screen", service: "hero" });
  });
});
