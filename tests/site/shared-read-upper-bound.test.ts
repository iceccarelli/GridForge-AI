/**
 * /q/[token], the capacity read on a link, was the one place a free read's rack counts were printed as facts.
 *
 * The free qualifier (/api/qualify) sends no transformer or UPS figures, so the engine treats both as "no limit" and every free read is an UPPER
 * BOUND: the live page says "at most" and shows the engine's warnings. The shared page said "stops at N racks", "Deployable as found N" and
 * "After the relief ladder N" with neither, and a unit-slip read that came back "0 racks" read as a fact about the hall.
 *
 * What is stored with a shared link: the qualifications table has ONE jsonb column, `inputs`, which holds the figures the visitor typed, not the
 * engine's answer, and the engine's `warnings` are not kept anywhere. Persisting them needs a new column (a migration), so this page prints the
 * fixed upper-bound note and, at zero, a fixed check-your-inputs note that does not claim a warning it cannot show.
 */
import fs from "node:fs";
import path from "node:path";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FREE_READ_UPPER_BOUND_NOTE, SHARED_ZERO_RACKS_NOTE } from "@/lib/qualify-readout";
import { PostgrestFake } from "./postgrest-fake";

const text = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

let db: PostgrestFake;
let restore: () => void;

beforeEach(() => {
  Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" });
  db = new PostgrestFake(["qualifications"]);
  restore = db.install();
});
afterEach(() => restore());

function seed(over: Record<string, unknown> = {}) {
  db.seed("qualifications", [
    {
      id: "00000000-0000-4000-8000-000000000001",
      created_at: "2026-11-13T10:00:00Z",
      token: "tok_shared",
      site_name: "North Hall",
      hall_id: "H1",
      metro: "Dublin",
      country: "IE",
      platform: "GB300 NVL72",
      inputs: { contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9 },
      racks_as_found: 14,
      racks_after_relief: 28,
      binding_constraint: "Rack feed / tap-off rating",
      intake_completeness: 0.5,
      company: null,
      email: null,
      status: "scored",
      follow_up_requested_at: null,
      ...over,
    },
  ]);
}

async function page(token = "tok_shared"): Promise<string> {
  const { default: Page } = await import("@/app/q/[token]/page");
  return text(renderToStaticMarkup((await Page({ params: Promise.resolve({ token }) })) as React.ReactElement));
}

describe("the shared page says 'at most' for every rack count and prints the fixed note", () => {
  it("the heading, 'Deployable as found' and 'After the relief ladder' are upper bounds, not facts", async () => {
    seed();
    const t = await page();
    expect(t).toContain("at most 14 racks");
    expect(t).toMatch(/Deployable as found\s+at most 14/);
    expect(t).toMatch(/After the relief ladder\s+at most 28/);
    // No count is printed bare: the old forms are gone.
    expect(t).not.toMatch(/stops at 14 racks/);
    expect(t).not.toMatch(/Deployable as found\s+14\b/);
    expect(t).not.toMatch(/After the relief ladder\s+28\b/);
  });

  it("prints the one fixed note, from the shared constant", async () => {
    seed();
    expect(FREE_READ_UPPER_BOUND_NOTE).toBe("A free read treats transformers and UPS as no limit, so each rack count is an upper bound.");
    expect(await page()).toContain(FREE_READ_UPPER_BOUND_NOTE);
  });

  it("a single rack is 'at most 1 rack'", async () => {
    seed({ racks_as_found: 1, racks_after_relief: 1 });
    expect(await page()).toContain("at most 1 rack");
  });

  it("the note is the constant's, typed nowhere in the page", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app/q/[token]/page.tsx"), "utf8");
    expect(src).toContain("FREE_READ_UPPER_BOUND_NOTE");
    expect(src).not.toContain("treats transformers and UPS");
  });
});

describe("a zero read is not a fact about the hall on this page", () => {
  it("'0 racks' carries the check-your-inputs note, says so without claiming a warning it cannot show, and is not 'stops at 0 racks'", async () => {
    seed({ racks_as_found: 0, racks_after_relief: 0 });
    const t = await page();
    expect(t).toContain(SHARED_ZERO_RACKS_NOTE);
    expect(t).not.toMatch(/stops at 0 racks/);
    expect(t).toMatch(/Deployable as found\s+at most 0/);
    // The note names the cause it cannot rule out, and the next step; it does not say "the warning shown with this result" (none is shown here).
    expect(SHARED_ZERO_RACKS_NOTE).toMatch(/wrong unit/);
    expect(SHARED_ZERO_RACKS_NOTE).toMatch(/Check your inputs/i);
    expect(SHARED_ZERO_RACKS_NOTE).toContain("/qualify");
    expect(SHARED_ZERO_RACKS_NOTE).not.toMatch(/warning shown with this result/);
    expect(t).toContain(FREE_READ_UPPER_BOUND_NOTE);
  });

  it("a read with racks after the ladder but none today still carries the zero note (today's count is the one at 0)", async () => {
    seed({ racks_as_found: 0, racks_after_relief: 6 });
    expect(await page()).toContain(SHARED_ZERO_RACKS_NOTE);
  });

  it("a read with racks today does not carry it", async () => {
    seed();
    expect(await page()).not.toContain(SHARED_ZERO_RACKS_NOTE);
  });
});
