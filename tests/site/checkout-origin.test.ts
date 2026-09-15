/**
 * Where a Stripe checkout is allowed to send somebody afterwards.
 *
 * app/api/checkout and app/api/subscribe built success_url and cancel_url from
 * the request's own Origin header, which the caller chooses. So anyone could mint
 * a genuine Checkout Session against this merchant whose success page was their
 * own domain: the payment still arrived here, but the customer finished their
 * purchase somewhere else, wearing our credibility on the way out.
 *
 * Nothing leaked — the session id in that URL is not a credential and no route in
 * this repository accepts one — so it is a phishing and brand vector rather than a
 * theft vector. Both routes now take the origin through checkoutOrigin().
 */
import { describe, expect, it } from "vitest";
import { SITE_URL, checkoutOrigin } from "@/lib/site";

describe("checkoutOrigin", () => {
  it("honours the site's own origin", () => {
    expect(checkoutOrigin(SITE_URL)).toBe(new URL(SITE_URL).origin);
  });

  it("falls back when there is no Origin header at all", () => {
    expect(checkoutOrigin(null)).toBe(SITE_URL);
    expect(checkoutOrigin(undefined)).toBe(SITE_URL);
    expect(checkoutOrigin("")).toBe(SITE_URL);
  });

  it("refuses somebody else's domain — THE regression", () => {
    expect(checkoutOrigin("https://evil.example")).toBe(SITE_URL);
  });

  it("refuses a lookalike that merely starts the same way", () => {
    const mine = new URL(SITE_URL).host;
    expect(checkoutOrigin(`https://${mine}.evil.example`)).toBe(SITE_URL);
    expect(checkoutOrigin(`https://evil.example/?x=${mine}`)).toBe(SITE_URL);
  });

  it("refuses a different scheme or port on the same host", () => {
    const mine = new URL(SITE_URL);
    if (mine.protocol === "https:") {
      expect(checkoutOrigin(`http://${mine.host}`)).toBe(SITE_URL);
    }
    expect(checkoutOrigin(`${mine.protocol}//${mine.hostname}:8443`)).toBe(SITE_URL);
  });

  it("refuses a javascript: or data: origin rather than echoing it", () => {
    expect(checkoutOrigin("javascript:alert(1)")).toBe(SITE_URL);
    expect(checkoutOrigin("data:text/html,x")).toBe(SITE_URL);
  });

  it("refuses something that is not a URL at all", () => {
    expect(checkoutOrigin("not a url")).toBe(SITE_URL);
    expect(checkoutOrigin("//evil.example")).toBe(SITE_URL);
  });

  it("never returns a value that is not an origin we chose", () => {
    const allowed = new Set([SITE_URL, new URL(SITE_URL).origin]);
    // The domain is never written out here — lib/site.ts is the only file allowed
    // to name it, and a test that hardcodes it is the same drift as a page that
    // does. The lookalike is built from the registry instead.
    const mine = new URL(SITE_URL).host;
    for (const hostile of [
      "https://evil.example",
      `https://${mine}.evil.example`,
      "http://localhost:1337",
      "ftp://evil.example",
      "\\\\evil.example",
    ]) {
      expect(allowed.has(checkoutOrigin(hostile))).toBe(true);
    }
  });
});
