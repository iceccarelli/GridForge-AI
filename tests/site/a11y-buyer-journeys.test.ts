import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AudiencePage from "@/app/for/[slug]/page";
import ForIndex from "@/app/for/page";
import { resolveStep } from "@/lib/audience-links";
import { AUDIENCES } from "@/lib/audiences";

// Each /for/<buyer> page offers that buyer only the steps lib/audiences.ts lists for them, and promises no reply time, guarantee or
// equipment supply. The page's own copy already carries a disclaimer ("sells no equipment"); what is asserted here is the absence of a
// promise, not the absence of the word.

const html = async (slug: string) =>
  renderToStaticMarkup(await AudiencePage({ params: Promise.resolve({ slug }) })).replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

const hrefs = (out: string) => [...out.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);

describe("buyer pages offer only the buyer's own steps", () => {
  for (const a of AUDIENCES) {
    it(`/for/${a.slug}: its purchasable links are exactly the steps in its path`, async () => {
      const links = hrefs(await html(a.slug));
      const stepHrefs = a.path.map((s) => resolveStep(s).href);
      // Every link that leads to an offer (qualifier, a product page, pricing, developers) must be one of this buyer's steps.
      const offerLinks = links.filter((h) => h === "/qualify" || h === "/pricing" || h === "/developers" || h.startsWith("/products/") || h.startsWith("/power/") || h.startsWith("/checkout"));
      for (const h of offerLinks) expect(stepHrefs, `${a.slug}: ${h} is not one of its steps`).toContain(h);
      for (const h of stepHrefs) expect(links, `${a.slug}: step ${h} is missing`).toContain(h);
      // Everything else is navigation: home, the index, a constraint page, another buyer's page.
      for (const h of links) {
        const nav = h === "/" || h === "/for" || h.startsWith("/constraints/") || (h.startsWith("/for/") && h !== `/for/${a.slug}`);
        expect(nav || stepHrefs.includes(h), `${a.slug}: unexpected link ${h}`).toBe(true);
      }
    });

    it(`/for/${a.slug}: no buy button, form or checkout hand-off of its own`, async () => {
      const out = await html(a.slug);
      expect(out).not.toMatch(/<button|<form|<input|<select/);
    });

    it(`/for/${a.slug}: promises no reply time, guarantee, outcome or equipment supply`, async () => {
      const text = (await html(a.slug)).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
      expect(text).not.toMatch(/\b(reply|respond|response|get back to you|reach out)\b[^.]{0,60}\b(within|in under|in less than|same[- ]day|next[- ]day)\b/i);
      expect(text).not.toMatch(/\bwithin\s+\d+\s*(hours?|business days?|working days?|days?)\b/i);
      expect(text).not.toMatch(/\b(24|48)\s*[- ]?\s*(hour|hr)s?\b|\bsame[- ]day\b|\bby (tomorrow|end of day)\b/i);
      expect(text).not.toMatch(/\bguarantee[sd]?\b|\bwarrant(y|ies)\b|\brisk[- ]free\b|\bmoney[- ]back\b/i);
      expect(text).not.toMatch(/\bwe (will )?(supply|deliver|install|provide|source|procure)\s+(the\s+)?(equipment|transformers?|generators?|batteries|turbines|switchgear|racks?|hardware)\b/i);
    });
  }

  it("the index links to the seven pages and offers no purchase of its own", () => {
    const out = renderToStaticMarkup(React.createElement(ForIndex));
    const links = hrefs(out);
    for (const a of AUDIENCES) expect(links).toContain(`/for/${a.slug}`);
    expect(out).not.toMatch(/<button|<form/);
  });
});
