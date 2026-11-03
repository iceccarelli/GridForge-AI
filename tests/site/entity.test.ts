import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FOUNDER_ID, LOGO_ID, ORG_ID, WEBSITE_ID, entityGraph, founderNode, orgRef, organizationNode, sameAsUrls, websiteNode } from "@/lib/entity";
import { engagementOfferJsonLd, constraintCatalogueJsonLd } from "@/lib/jsonld";
import { securityTxt, securityTxtExpires } from "@/lib/security-txt";
import { PRODUCT_PAGES, productForPage } from "@/lib/product-pages";
import { SITE, SITE_URL } from "@/lib/site";
import { GET as vcard } from "@/app/contact.vcf/route";
import manifest from "@/app/manifest";

const BANNED = /aggregateRating|"review"|telephone|streetAddress|postalCode|foundingDate|numberOfEmployees|"award"|"employee"/;

describe("one organisation, one identity", () => {
  it("ids are on the site's own origin and distinct", () => {
    const ids = [ORG_ID, WEBSITE_ID, LOGO_ID, FOUNDER_ID];
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id.startsWith(SITE_URL)).toBe(true);
  });

  it("the organisation node uses only facts the repository holds", () => {
    const o = organizationNode();
    expect(o["@id"]).toBe(ORG_ID);
    expect(o.email).toBe(SITE.email);
    expect(o.contactPoint.email).toBe(SITE.email);
    expect(o.founder).toEqual({ "@id": FOUNDER_ID });
    expect(o.location.map((l) => l.name)).toEqual(["Frankfurt, DE", "Toronto, CA"]);
    expect(o.logo.url).toBe(`${SITE_URL}/logo.png`);
    expect(JSON.stringify(entityGraph())).not.toMatch(BANNED);
  });

  it("sameAs holds the repository and any social URL that has actually been filled in, and nothing else", () => {
    const urls = sameAsUrls();
    expect(urls).toContain(SITE.repo);
    for (const [k, v] of Object.entries(SITE.social)) expect(urls.includes(v as string), k).toBe(Boolean(v));
    for (const u of urls) expect(u).toMatch(/^https:\/\//);
  });

  it("the founder and the website point back at the organisation", () => {
    expect(founderNode().worksFor).toEqual({ "@id": ORG_ID });
    expect(websiteNode().publisher).toEqual({ "@id": ORG_ID });
    expect(entityGraph()["@graph"]).toHaveLength(3);
  });

  it("every other node references the organisation by id instead of declaring a copy", () => {
    const ref = orgRef();
    expect(ref["@id"]).toBe(ORG_ID);
    for (const page of PRODUCT_PAGES) {
      const offer = engagementOfferJsonLd(productForPage(page)) as { itemOffered: { provider: unknown } };
      expect(offer.itemOffered.provider).toEqual(ref);
    }
    const ds = constraintCatalogueJsonLd(JSON.parse(readFileSync("public/reference/constraints.json", "utf8"))) as { creator: unknown; publisher: unknown };
    expect(ds.creator).toEqual(ref);
    expect(ds.publisher).toEqual(ref);
  });

  it("no source file declares its own Organization or ProfessionalService node any more", () => {
    for (const f of ["lib/jsonld.ts", "app/constraints/[slug]/page.tsx", "app/lead-times/page.tsx", "app/platforms/[id]/page.tsx", "components/JsonLd.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/"@type":\s*"(Organization|ProfessionalService)"/);
    }
  });
});

describe("/about", () => {
  it("renders the facts it markets, with one organisation in its structured data", async () => {
    const { default: About } = await import("@/app/about/page");
    const html = renderToStaticMarkup(React.createElement(About));
    for (const t of [SITE.email, SITE.baseLocation, SITE.founder, "pilot-stage", "We sell no equipment", "not an issued engineering opinion"]) expect(html).toContain(t);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));
    const nodes = blocks.flatMap((b) => (b["@graph"] ?? [b]));
    expect(nodes.filter((n: { "@type": unknown; logo?: unknown }) => [].concat(n["@type"] as never).includes("Organization" as never) && n.logo)).toHaveLength(1);
    expect(nodes.some((n: { "@type": string }) => n["@type"] === "AboutPage")).toBe(true);
    expect(html.toLowerCase()).not.toMatch(/customers|award|rated|founded in|employees/);
  });
});

describe("contact card, security.txt, manifest", () => {
  it("the vCard carries the email and the brand and invents no telephone or address", async () => {
    const res = vcard();
    const t = await res.text();
    expect(res.headers.get("content-type")).toContain("text/vcard");
    expect(t).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0/);
    expect(t).toContain(`EMAIL;TYPE=INTERNET,WORK:${SITE.email}`);
    expect(t).toMatch(/END:VCARD\r\n$/);
    expect(t).not.toMatch(/^(TEL|ADR)/m);
  });

  it("security.txt is RFC 9116: a contact, an Expires in the future (and not absurdly far), and no Encryption it cannot back", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const t = securityTxt(now);
    expect(t).toMatch(/^Contact: mailto:power@timetopower\.ai$/m);
    expect(securityTxtExpires(now)).toBe("2027-06-01T00:00:00Z");
    expect(t).toContain("Expires: 2027-06-01T00:00:00Z");
    expect(t).toMatch(/^Canonical: https:\/\/.+\/\.well-known\/security\.txt$/m);
    expect(t).not.toMatch(/Encryption|Acknowledgments/);
    // wherever "today" is, the commitment is 5 to 7 months ahead
    for (const d of ["2026-01-31", "2026-02-28", "2026-12-31", "2028-02-29"]) {
      const days = (Date.parse(securityTxtExpires(new Date(`${d}T00:00:00Z`))) - Date.parse(`${d}T00:00:00Z`)) / 864e5;
      expect(days, d).toBeGreaterThanOrEqual(150);
      expect(days, d).toBeLessThanOrEqual(215);
    }
  });

  it("the manifest names the product and points at icons that exist at the sizes it states", () => {
    const m = manifest();
    expect(m.name).toBe(SITE.name);
    expect(m.display).toBe("browser");
    for (const i of m.icons ?? []) {
      const b = readFileSync(`public${i.src}`);
      expect(`${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`).toBe(i.sizes);
    }
    expect((m.icons ?? []).some((i) => i.purpose === "maskable")).toBe(true);
  });
});
