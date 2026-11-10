import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCTS } from "@/lib/products";
import { leadSchema } from "@/lib/lead";

const read = (p: string) => readFileSync(p, "utf8");

// Statements an independent honesty review proved false or unsupported on 2026-11-10. Each one is pinned so it cannot come back unnoticed.
describe("statements the repository cannot back", () => {
  it("no surface says professional-indemnity or signatory arrangements govern reliance (none exist)", () => {
    for (const f of ["gridforge/reporting/study.py", "gridforge/reporting/proposal.py", "gridforge/reporting/deck.py", "gridforge/reporting/board.py", "public/reference/envelope_study.md", "public/reference/proposal.md"]) {
      expect(read(f), f).not.toMatch(/arrangements govern reliance/i);
      expect(read(f), f).not.toMatch(/is an engineering opinion supported by a documented model/i);
    }
  });

  it("the Terms template states no VAT, refund or product name the code does not implement", () => {
    const t = read("app/legal/terms/page.tsx");
    expect(t).not.toMatch(/reverse-charge/i);
    expect(t).not.toMatch(/refundable in full/i);
    expect(t).not.toMatch(/Single-Hall/);
    expect(t).not.toMatch(/one-time free allowance/);
  });

  it("/evidence does not say the engine refuses below-floor claims in every mode (only an issued deliverable is refused)", () => {
    const t = read("app/evidence/page.tsx");
    expect(t).not.toMatch(/The engine enforces this; it is not a guideline/);
    expect(t).toMatch(/screening mode/);
  });

  it("the checkout line items for the two deposit products say 'Deposit, not the fee' and name the band", () => {
    for (const id of ["envelope_study_deposit", "portfolio_screen_deposit"] as const) {
      const p = PRODUCTS[id];
      expect(p.description, id).toMatch(/^Deposit, not the fee\./);
      const [lo, hi] = p.opensBandCents!;
      const eur = (c: number) => `€${(c / 100).toLocaleString("en-US")}`;
      expect(p.description, id).toContain(`within ${eur(lo)} to ${eur(hi)}`);
    }
  });

  it("Hall Watch states no working-day turnaround it has no mechanism for", () => {
    expect(PRODUCTS.hall_watch.turnaroundDays).toBe(0);
  });

  it("no source claims a ranking the engine does not compute, a 'usually electrical' statistic or 'senior' credentials", () => {
    for (const f of ["gridforge/api/tools.py", "lib/ai/tools.ts"]) expect(read(f), f).not.toMatch(/racks per euro/);
    expect(read("lib/ai/prompts/system.ts")).not.toMatch(/usually electrical/);
    expect(read("lib/ai/prompts/system.ts")).not.toMatch(/You are an engineer/);
    expect(read("app/api/cite/route.ts")).not.toMatch(/Quote freely/);
    for (const f of ["app/pricing/page.tsx", "app/about/page.tsx", "components/home/Sections.tsx", "components/ThreePaths.tsx", "lib/product-pages.ts", "lib/notifications.ts"]) {
      expect(read(f), f).not.toMatch(/senior (power-systems )?engineer/i);
    }
  });

  it("the live-data consoles do not call a 15-30 minute old interval 'real time' or 'live'", () => {
    const c = read("components/LiveConsole.tsx") + read("components/LoadSimulator.tsx");
    expect(c).not.toMatch(/streaming in real time/);
    expect(c).not.toMatch(/REAL-TIME SIM/);
    expect(c).not.toMatch(/live price/i);
    expect(read("app/account/login/page.tsx")).not.toMatch(/Access live/);
  });
});

describe("/api/audit is not an open mail relay", () => {
  const route = read("app/api/audit/route.ts");
  it("reads a bounded body", () => {
    expect(route).toMatch(/readBoundedJson\(req, 16 \* 1024\)/);
    expect(route).not.toMatch(/await req\.json\(\)/);
  });
  it("mails a fixed acknowledgement that echoes nothing the caller typed", () => {
    const start = route.indexOf("Confirmation email to the lead");
    const mail = route.slice(start, route.indexOf("catch (err)", start));
    expect(mail).not.toMatch(/record\.(capacity|location|message|name|company)/);
  });
  it("the lead schema bounds every free-text field", () => {
    const base = { capacity: "12 MW", location: "Dublin", urgency: "immediate", gridStatus: "in_queue", services: ["a"], message: "x".repeat(20), name: "Ann", company: "Acme", email: "a@b.co" };
    expect(leadSchema.safeParse(base).success).toBe(true);
    for (const [k, v] of [["message", "x".repeat(4001)], ["location", "x".repeat(161)], ["capacity", "x".repeat(41)], ["name", "x".repeat(161)], ["company", "x".repeat(161)], ["services", Array(9).fill("a")], ["email", "a".repeat(250) + "@b.co"]] as const) {
      expect(leadSchema.safeParse({ ...base, [k]: v }).success, k).toBe(false);
    }
  });
});
