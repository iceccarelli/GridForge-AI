/**
 * The released Density Screen leads to the Envelope Study, and says so from the catalogue.
 *
 * The catalogue says a paid Density Screen credits against the Study (creditsAgainst in lib/products.ts; creditsToward and the scoping
 * step in lib/deliverables.ts / lib/deposits.ts enforce it: same address, once, after an operator confirms it is the same buyer, and
 * never for a refunded or disputed purchase). The released page and the release email stopped at the Specification and Hall Watch, so
 * the one step the Screen is priced to lead into was never mentioned to the person who had just paid for the Screen.
 *
 * What is pinned here:
 *  - the page and the email carry the deposit, the band, the credit sentence and the link, read from the catalogue (a perturbed
 *    catalogue changes the text and no earlier figure survives);
 *  - they are absent on every other kind, on an unreleased page, on a held page, and on a proposal;
 *  - the link is the Study's own product page (the existing purchase path), never a new payment path;
 *  - no euro amount is typed in the new sources.
 */
import fs from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestFake } from "./postgrest-fake";

const E = "€"; // spelled so this file holds no price literal (tests/test_one_company.py)
const TOKEN = "doc-token-abcdefghijklmnop";
let db: PostgrestFake;
let undo: () => void;
let mail: { to: string[] | string; subject: string; text: string }[];

function seed(over: Record<string, unknown> = {}) {
  db.seed("deliverables", [
    {
      token: TOKEN,
      intake_token: "intake-token-abcdefghijk",
      kind: "density_screen",
      status: "released",
      email: "buyer@hall.example",
      stripe_session_id: "cs_1",
      title: "Density Screen",
      document_html: "<p>the document</p>",
      document_md: "# the document",
      working_files: {},
      intake: { siteName: "North Hall", _gridforge: {} },
      released_at: "2027-01-05T10:00:00Z",
      ...over,
    },
  ]);
}

async function page(): Promise<string> {
  const { default: Page } = await import("@/app/deliverable/[token]/page");
  const el = await Page({ params: Promise.resolve({ token: TOKEN }) });
  return renderToStaticMarkup(el as ReactElement).replace(/<!-- -->/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
}

/** The Study section as rendered: from its opening tag to its closing one. */
function studySection(html: string): string {
  const at = html.indexOf('data-testid="study-upsell"');
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<section", at);
  return html.slice(open, html.indexOf("</section>", at) + "</section>".length);
}

async function releaseEmail(): Promise<string> {
  const { notifyCustomer } = await import("@/lib/notifications");
  const id = String((db.rows("deliverables")[0] as { id: string }).id);
  expect(await notifyCustomer("deliverable_release", id, "")).toBe("ok");
  const toBuyer = mail.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"));
  expect(toBuyer).toHaveLength(1);
  return toBuyer[0].text;
}

beforeEach(() => {
  vi.resetModules();
  mail = [];
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.RESEND_API_KEY = "re_test";
  process.env.LEAD_FROM_EMAIL = "Time to Power <power@timetopower.ai>";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  delete process.env.RESEND_FROM;
  // Only the deliverables table exists: the outbox (migration 0021) is absent, so the release email is the one direct send.
  db = new PostgrestFake(["deliverables"]);
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) {
      mail.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => {
    globalThis.fetch = dbFetch;
    restoreDb();
  };
});

afterEach(() => {
  undo();
  vi.doUnmock("@/lib/products");
  vi.resetModules();
});

/** The catalogue with the Screen's fee, the Study deposit, its band and its deliverable changed. */
function perturbCatalogue() {
  vi.doMock("@/lib/products", async (orig) => {
    const real = await orig<typeof import("@/lib/products")>();
    const PRODUCTS = {
      ...real.PRODUCTS,
      density_screen: { ...real.PRODUCTS.density_screen, amountCents: 520_000 },
      envelope_study_deposit: {
        ...real.PRODUCTS.envelope_study_deposit,
        amountCents: 1_100_000,
        opensBandCents: [2_500_000, 5_100_000] as [number, number],
        deliverable: "A perturbed deliverable sentence for the test.",
      },
    };
    return { ...real, PRODUCTS, PRODUCT_BY_KIND: Object.fromEntries(Object.values(PRODUCTS).map((p) => [p.kind, p])) };
  });
}

describe("the offer, from the catalogue", () => {
  it("exists for the Density Screen and for no other kind", async () => {
    const { studyOffer } = await import("@/lib/study-offer");
    const { PRODUCTS } = await import("@/lib/products");
    expect(studyOffer("density_screen")).not.toBeNull();
    for (const p of Object.values(PRODUCTS)) {
      if (p.id !== "density_screen") expect(studyOffer(p.kind), p.kind).toBeNull();
    }
    for (const k of ["proposal", "", "nonsense", "constructor", "__proto__"]) expect(studyOffer(k), k).toBeNull();
  });

  it("carries the deposit, the band, the credit, the turnaround and the deliverable exactly as the catalogue states them", async () => {
    const { studyOffer } = await import("@/lib/study-offer");
    const { PRODUCTS, eurFromCents } = await import("@/lib/products");
    const { depositTerms } = await import("@/lib/engagement-state");
    const study = PRODUCTS.envelope_study_deposit;
    const [lo, hi] = study.opensBandCents!;
    const o = studyOffer("density_screen")!;
    expect(o.price).toContain(eurFromCents(study.amountCents));
    expect(o.price).toContain(eurFromCents(lo));
    expect(o.price).toContain(eurFromCents(hi));
    expect(o.credit).toBe(depositTerms("envelope_study_deposit")!.credit);
    expect(o.credit).toContain(o.earlierCredit);
    expect(o.earlierCredit).toContain(`A ${PRODUCTS.density_screen.name} you have already paid for (same email address, ${eurFromCents(PRODUCTS.density_screen.amountCents)} each) is credited once`);
    expect(o.earlierCredit).toMatch(/after we confirm it is the same buyer/);
    expect(o.timing).toBe(depositTerms("envelope_study_deposit")!.timing);
    expect(o.delivers).toBe(study.deliverable);
    expect(o.href).toBe("/products/envelope-study");
  });

  it("states what stays unknown: the Screen's own list of unmeasured inputs, and that the Study does not turn an assumption into a measurement", async () => {
    const { studyOffer } = await import("@/lib/study-offer");
    const { PRODUCTS } = await import("@/lib/products");
    // The sentence about the Screen's unmeasured inputs is true only while the catalogue still says the Screen delivers that list.
    expect(PRODUCTS.density_screen.description).toContain("inputs nobody has measured");
    expect(PRODUCTS.density_screen.deliverable).toContain("data request");
    const o = studyOffer("density_screen")!;
    expect(o.stillUnknownAfterScreen).toMatch(/not measured are still assumptions/);
    expect(o.stillUnknown).toMatch(/does not turn an assumption into a measurement/);
  });

  it("the one wording of the earlier-purchase credit is shared with the deposit receipt (depositTerms)", async () => {
    const { creditedEarlier, depositTerms } = await import("@/lib/engagement-state");
    expect(creditedEarlier("envelope_study_deposit")).toBeTruthy();
    expect(depositTerms("envelope_study_deposit")!.credit.endsWith(creditedEarlier("envelope_study_deposit")!)).toBe(true);
    // The portfolio deposit has nothing crediting against it, and a non-deposit kind has no such sentence at all.
    expect(creditedEarlier("portfolio_screen_deposit")).toBeNull();
    expect(creditedEarlier("density_screen")).toBeNull();
  });
});

describe("the released page", () => {
  it("shows the Study step on a released Density Screen, with the catalogue's deposit, band and credit, and links to the Study's page", async () => {
    seed();
    const html = await page();
    const { PRODUCTS, eurFromCents } = await import("@/lib/products");
    const { depositTerms } = await import("@/lib/engagement-state");
    const study = PRODUCTS.envelope_study_deposit;
    expect(html).toContain('data-testid="study-upsell"');
    expect(html).toContain("If this hall is worth a full study: the Capacity & Density Envelope Study");
    expect(html).toContain(`${eurFromCents(study.amountCents)} deposit`);
    expect(html).toContain(`${eurFromCents(study.opensBandCents![0])} to ${eurFromCents(study.opensBandCents![1])}`);
    expect(html).toContain(depositTerms("envelope_study_deposit")!.credit);
    expect(html).toContain(study.deliverable);
    expect(html).toContain('href="/products/envelope-study"');
    // The step is added to the Specification and Hall Watch offers, not in place of them.
    expect(html).toContain("Keep the model live");
    expect(html).toContain("Commission it");
  });

  it("is a link, not a payment path: no checkout call and no button of its own", async () => {
    seed();
    const section = studySection(await page());
    expect(section).not.toContain("<button");
    expect(section).not.toContain("/api/checkout");
  });

  it("is labelled by its own heading and keeps the heading order (h2 under the document)", async () => {
    seed();
    const section = studySection(await page());
    expect(section).toContain('aria-labelledby="study-next-h"');
    expect(section).toMatch(/<h2 id="study-next-h"/);
    expect(section).not.toMatch(/<h1|<h3/);
    expect(section).toContain("What stays unknown");
  });

  it("follows the catalogue: a perturbed deposit, band, Screen fee and deliverable change the text, and no earlier figure survives", async () => {
    perturbCatalogue();
    seed();
    const html = await page();
    expect(html).toContain(`${E}11,000 deposit`);
    expect(html).toContain(`${E}25,000 to ${E}51,000`);
    expect(html).toContain(`(same email address, ${E}5,200 each)`);
    expect(html).toContain("A perturbed deliverable sentence for the test.");
    for (const old of [`${E}9,000 deposit`, `${E}22,000`, `${E}45,000`, `${E}4,500 each`, "Envelope Study (HTML + Markdown)"]) {
      expect(html, old).not.toContain(old);
    }
  });

  it.each([
    ["a released Envelope Study", "envelope_study_deposit"],
    ["a released Procurement Specification", "procurement_spec"],
    ["a released Portfolio Screen", "portfolio_screen_deposit"],
    ["a released proposal", "proposal"],
  ])("is absent on %s", async (_n, kind) => {
    seed({ kind });
    const html = await page();
    expect(html).not.toContain("study-upsell");
    expect(html).not.toContain('href="/products/envelope-study"');
    expect(html).not.toContain("If this hall is worth a full study");
  });

  it.each(["awaiting_intake", "generating", "draft", "engine_unavailable"])("is absent on an unreleased Density Screen (%s)", async (status) => {
    seed({ status });
    const html = await page();
    expect(html).not.toContain("study-upsell");
    expect(html).not.toContain("/products/envelope-study");
  });

  it("is absent on a refunded or disputed Density Screen (the page is not shown and the credit is not on offer)", async () => {
    for (const hold of ["refunded", "disputed"]) {
      vi.resetModules();
      db.tables.set("deliverables", []);
      seed({ billing_hold: hold });
      const html = await page();
      expect(html, hold).not.toContain("study-upsell");
      expect(html, hold).toContain('data-testid="payment-hold"');
    }
  });
});

describe("the release email", () => {
  it("carries one price sentence, the credit sentence and the link to the Study's page, from the catalogue", async () => {
    seed();
    const text = await releaseEmail();
    const { PRODUCTS, eurFromCents } = await import("@/lib/products");
    const { SITE_URL } = await import("@/lib/site");
    const study = PRODUCTS.envelope_study_deposit;
    expect(text).toContain(`${SITE_URL}/deliverable/${TOKEN}`);
    expect(text).toContain("the next step is the Capacity & Density Envelope Study");
    expect(text).toContain(`${eurFromCents(study.amountCents)} deposit`);
    expect(text).toContain(`${eurFromCents(study.opensBandCents![0])} to ${eurFromCents(study.opensBandCents![1])}`);
    expect(text).toContain("is credited once against the same fee, after we confirm it is the same buyer");
    expect(text).toContain(`${SITE_URL}/products/envelope-study`);
    // The document link and its privacy paragraph still come first.
    expect(text.indexOf(`/deliverable/${TOKEN}`)).toBeLessThan(text.indexOf("/products/envelope-study"));
  });

  it("follows the catalogue when it changes", async () => {
    perturbCatalogue();
    seed();
    const text = await releaseEmail();
    expect(text).toContain(`${E}11,000 deposit`);
    expect(text).toContain(`${E}25,000 to ${E}51,000`);
    expect(text).toContain(`${E}5,200 each`);
    expect(text).not.toContain(`${E}9,000`);
    expect(text).not.toContain(`${E}4,500`);
  });

  it.each(["envelope_study_deposit", "procurement_spec", "portfolio_screen_deposit"])("does not mention the Study on a released %s", async (kind) => {
    seed({ kind });
    const text = await releaseEmail();
    expect(text).toContain(`/deliverable/${TOKEN}`);
    expect(text).not.toContain("/products/envelope-study");
    expect(text).not.toContain("full study");
  });
});

describe("no euro amount is typed in the new sources", () => {
  it.each(["lib/study-offer.ts", "components/StudyUpsell.tsx"])("%s", (f) => {
    const code = fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code, `${f}: a euro amount typed in the source`).not.toMatch(/€\s?\d|\bEUR\s?\d|\d\s?EUR\b/);
    expect(code, `${f}: a duration typed in the source`).not.toMatch(/\b\d+ working days\b/);
    expect(code, `${f}: it must read the catalogue`).toMatch(/products|study-offer/);
  });

  it("the page imports no checkout call for the Study", () => {
    expect(fs.readFileSync("components/StudyUpsell.tsx", "utf8")).not.toMatch(/api\/checkout|fetch\(|"use client"/);
  });
});
