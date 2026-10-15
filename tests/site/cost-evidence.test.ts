/**
 * Rules of the cost-evidence layer that need no database: what a reviewer must state, what is refused before the
 * store is touched, and how an accepted row is handed to the engine. Fixtures are SYNTHETIC.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { reviewEvidence, toEngineEntry, withdrawEvidence, type EvidenceRow } from "@/lib/cost-evidence";

const ID = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:9"; // never reached: every case below is refused first
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unused";
});

describe("a review states what it decides", () => {
  it.each([
    ["not a uuid", { evidence_id: "x", decision: "accepted" }, 404],
    ["no decision", { evidence_id: ID }, 422],
    ["no reviewer", { evidence_id: ID, decision: "accepted", basis: "firm_quote", comparability: "exact" }, 422],
    ["no basis (never defaulted)", { evidence_id: ID, decision: "accepted", reviewer: "R", comparability: "exact" }, 422],
    ["an invented basis", { evidence_id: ID, decision: "accepted", reviewer: "R", basis: "market_price", comparability: "exact" }, 422],
    ["no comparability", { evidence_id: ID, decision: "accepted", reviewer: "R", basis: "firm_quote" }, 422],
    ["a rejection that claims a basis", { evidence_id: ID, decision: "rejected", reviewer: "R", basis: "firm_quote" }, 422],
  ])("refuses %s before touching the store", async (_n, body, status) => {
    const r = await reviewEvidence(body as Record<string, unknown>);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(status);
  });

  it("a withdrawal names who withdrew it", async () => {
    const r = await withdrawEvidence({ evidence_id: ID });
    expect(r.ok === false && r.status).toBe(422);
  });
});

describe("an accepted row reaches the engine with its provenance and nothing re-derived", () => {
  const row = {
    id: ID, project_id: "22222222-2222-4222-8222-222222222222", cost_key: "transformer.replacement", unit: "EUR", value: 2340000,
    currency: "EUR", supplier: "SYNTHETIC-SUPPLIER-A", received_on: "2026-10-01", valid_until: "2099-12-31", scope: "Replace transformer",
    quoted_quantity: 23.4, quoted_quantity_unit: "MVA", response_digest: "a".repeat(64), comparability: "exact",
    reviewed_comparability: "limited", reviewed_basis: "firm_quote", reviewer: "Test Reviewer", reviewed_at: "2026-10-05T10:00:00Z",
    includes_keys: ["transformer.install"], reviewed_region: "IE", synthetic: true, state: "accepted",
  } as unknown as EvidenceRow;

  it("keeps the lump, its quantity and unit, the reviewer's basis and comparability, and the synthetic flag", () => {
    expect(toEngineEntry(row)).toMatchObject({
      key: "transformer.replacement", unit: "EUR", value: 2340000, quoted_quantity: 23.4, quoted_quantity_unit: "MVA",
      basis: "firm_quote", comparability: "limited", status: "accepted", evidence_id: ID, reviewer: "Test Reviewer",
      reviewed_on: "2026-10-05", includes_keys: ["transformer.install"], synthetic: true, project: row.project_id,
      response_ref: "a".repeat(64), region: "IE",
    });
  });

  it("never turns a lump into a per-unit price or the reverse", () => {
    const perUnit = toEngineEntry({ ...row, unit: "EUR/MVA", quoted_quantity: null, quoted_quantity_unit: null } as EvidenceRow);
    expect(perUnit).toMatchObject({ unit: "EUR/MVA", quoted_quantity: null, value: 2340000 });
    expect(toEngineEntry(row)).toMatchObject({ unit: "EUR", value: 2340000 });
  });
});
