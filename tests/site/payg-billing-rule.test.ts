/**
 * The billing rule a customer reads is ONE sentence, and it is the engine's. The engine publishes it at /v1/version and /v1/tools
 * (gridforge/api/metering.py BILLING_RULE, committed in public/reference/tools.json by the generator that CI diffs); the website
 * builds it from the same catalogue figures (lib/payg-pricing.ts billingRuleText). This pins them byte for byte, and pins the
 * honest statement of the carry-forward rule, including the edge: a balance that never reaches the minimum is never invoiced.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { billingRuleText } from "@/lib/payg-pricing";
import { billingRuleText as rule2 } from "@/lib/payg";
import { PAYG } from "@/lib/products";
import { eurExact } from "@/lib/payg-pricing";

const published = (JSON.parse(fs.readFileSync(path.join(process.cwd(), "public/reference/tools.json"), "utf8")) as { payg: { billing_rule: string } }).payg.billing_rule;

describe("one billing rule, said the same everywhere", () => {
  it("the website's sentence equals the engine's published BILLING_RULE, byte for byte", () => {
    expect(billingRuleText()).toBe(published);
  });

  it("there is one function: lib/payg re-exports it, so the usage API and the portal cannot say different things", () => {
    expect(rule2()).toBe(billingRuleText());
  });

  it("states the carry-forward rule honestly, with the catalogue's figures and the edge case", () => {
    const t = billingRuleText();
    const min = eurExact(PAYG.minInvoiceCents);
    expect(t).toContain(`under the ${min} minimum invoice is not invoiced on its own`);
    expect(t).toMatch(/carried forward and added to the next month, and so on from month to month/);
    expect(t).toContain(`A balance that never reaches ${min} is never invoiced.`);
    expect(t).toContain(`${eurExact(PAYG.unitPriceCents)} a unit`);
    expect(t).toMatch(/net ledger units for the UTC month \(charges minus refunds\)/);
    expect(t).toMatch(/refunded and never charged/);
    expect(t).toMatch(/Free-allowance usage is never invoiced/);
    expect(t).toMatch(/hard stop/);
  });
});
