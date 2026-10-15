/**
 * The administrator's review screen and the customer's run history: what they show and what they offer. The
 * components are rendered to static markup with real props (no browser); the routes they call are exercised against
 * the real database in cost-evidence.realdb.test.ts. Fixtures are SYNTHETIC.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CostEvidenceReview } from "@/components/CostEvidenceReview";
import { BidComparison } from "@/components/BidComparison";
import { COMPARABILITIES, REVIEW_BASES, STATE_META, eligibility, reviewBody, withdrawBody } from "@/lib/evidence-review";
import type { EvidenceRow, EvidenceState } from "@/lib/cost-evidence";

const STATES: EvidenceState[] = ["validated", "invalid", "accepted", "rejected", "superseded", "withdrawn"];

function row(state: EvidenceState, n: number, over: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`, deliverable_id: "d", project_id: null, cost_key: "transformer.replacement",
    unit: "EUR", value: 2_340_000, currency: "EUR", supplier: `SYNTHETIC-SUPPLIER-${state.toUpperCase()}`, received_on: "2026-10-01",
    valid_until: "2099-12-31", reference: `SYN-${n}`, scope: "Replace transformer", quoted_quantity: 23.4, quoted_quantity_unit: "MVA",
    specification: { project: "Reference Project (synthetic)", hall: "DUB-01", constraint: "transformer_capacity", sized_for_racks: 69 },
    response_digest: String(n).repeat(64), validation_status: state === "invalid" ? "invalid" : "validated",
    problems: state === "invalid" ? ["currency USD: the specification requires EUR"] : [], limitations: ["lead time not stated"],
    comparability: "exact", synthetic: true, submitted_at: "2026-10-01T10:00:00Z", state,
    reviewed_basis: ["accepted", "superseded", "withdrawn"].includes(state) ? "firm_quote" : null,
    reviewed_comparability: ["accepted", "superseded", "withdrawn"].includes(state) ? "exact" : null,
    includes_keys: ["transformer.install"], reviewed_region: "IE",
    reviewer: ["accepted", "rejected", "superseded", "withdrawn"].includes(state) ? "Test Reviewer" : null,
    reviewed_at: ["accepted", "rejected", "superseded", "withdrawn"].includes(state) ? "2026-10-05T10:00:00Z" : null,
    review_reason: state === "rejected" ? "out of scope" : null,
    superseded_by: state === "superseded" ? "00000000-0000-4000-8000-0000000000ff" : null,
    retired_kind: state === "superseded" || state === "withdrawn" ? state : null,
    retired_at: state === "superseded" || state === "withdrawn" ? "2026-10-06T10:00:00Z" : null,
    retirement_reason: state === "withdrawn" ? "supplier retracted" : null, retired_by: state === "withdrawn" ? "Test Withdrawer" : null,
    ...over,
  } as EvidenceRow;
}

const html = (items: EvidenceRow[], error?: string) =>
  renderToStaticMarkup(React.createElement(CostEvidenceReview, { initial: items, initialError: error }));
const card = (markup: string, state: string) => {
  const m = markup.match(new RegExp(`<li[^>]*data-state="${state}"[\\s\\S]*?</li>`));
  expect(m, `a card for ${state}`).toBeTruthy();
  return m![0];
};

describe("what may be done to a line is decided by its state alone", () => {
  it("offers accept/reject only to validated lines, withdraw only to accepted ones, and nothing else", () => {
    const e = (state: EvidenceState, valid_until: string | null = "2099-12-31") => eligibility({ state, valid_until, validation_status: "validated" });
    expect(e("validated")).toMatchObject({ accept: true, reject: true, withdraw: false });
    expect(e("accepted")).toMatchObject({ accept: false, reject: false, withdraw: true });
    for (const s of ["invalid", "rejected", "superseded", "withdrawn"] as EvidenceState[]) {
      expect(e(s)).toMatchObject({ accept: false, reject: false, withdraw: false });
    }
  });
  it("does not offer to accept an expired line (the database would refuse) but still lets it be rejected", () => {
    const x = eligibility({ state: "validated", valid_until: "2026-01-01", validation_status: "validated" }, "2026-10-15");
    expect(x).toMatchObject({ accept: false, reject: true });
    expect(x.blocked).toContain("2026-01-01");
  });
  it("only an accepted line is described as influencing a run", () => {
    expect(STATES.filter((s) => STATE_META[s].influences)).toEqual(["accepted"]);
    expect(STATE_META.validated.meaning).toMatch(/influences no run/i);
  });
});

describe("the request a decision sends carries what the API and database demand", () => {
  const f = { decision: "accepted" as const, reviewer: "R", basis: "firm_quote", comparability: "exact", region: " IE ", includes: "a.b, c.d ,", reason: " r " };
  it("accepting needs a reviewer, a basis and a comparability, never defaulted", () => {
    expect(reviewBody({ ...f, reviewer: " " })).toMatchObject({ ok: false });
    expect(reviewBody({ ...f, basis: "" })).toMatchObject({ ok: false });
    expect(reviewBody({ ...f, basis: "market_price" })).toMatchObject({ ok: false });
    expect(reviewBody({ ...f, comparability: "" })).toMatchObject({ ok: false });
    expect(reviewBody(f)).toEqual({ ok: true, body: { decision: "accepted", reviewer: "R", basis: "firm_quote", comparability: "exact", includes_keys: ["a.b", "c.d"], region: "IE", reason: "r" } });
    for (const b of REVIEW_BASES) expect(reviewBody({ ...f, basis: b }).ok).toBe(true);
    for (const c of COMPARABILITIES) expect(reviewBody({ ...f, comparability: c }).ok).toBe(true);
  });
  it("rejecting needs a reviewer and carries no basis or comparability (the API refuses them)", () => {
    expect(reviewBody({ ...f, decision: "rejected", reviewer: "" }).ok).toBe(false);
    const r = reviewBody({ ...f, decision: "rejected", reason: "" });
    expect(r.ok && Object.keys(r.body).sort()).toEqual(["decision", "reason", "reviewer"]);
    expect(r.ok && (r.body as Record<string, unknown>).basis).toBeUndefined();
  });
  it("withdrawing names who withdrew", () => {
    expect(withdrawBody({ by: "", reason: "x" }).ok).toBe(false);
    expect(withdrawBody({ by: " P ", reason: "" })).toEqual({ ok: true, body: { retired_by: "P", reason: undefined } });
  });
});

describe("the review screen renders every lifecycle state distinctly and truthfully", () => {
  const markup = html(STATES.map((s, i) => row(s, i + 1)));

  it("labels each state and says what it means", () => {
    for (const s of STATES) {
      const c = card(markup, s);
      expect(c).toContain(`>${STATE_META[s].label}<`);
      expect(c).toContain(STATE_META[s].meaning.replace(/'/g, "&#x27;"));
    }
    expect(new Set(STATES.map((s) => STATE_META[s].tone)).size).toBe(6);
  });

  it("offers Review only on a validated line and Withdraw only on an accepted one", () => {
    expect(card(markup, "validated")).toContain("Review…");
    expect(card(markup, "accepted")).toContain("Withdraw…");
    expect(card(markup, "accepted")).not.toContain("Review…");
    for (const s of ["invalid", "rejected", "superseded", "withdrawn"]) {
      const c = card(markup, s);
      expect(c, s).not.toContain("Review…");
      expect(c, s).not.toContain("Withdraw…");
      expect(c, s).not.toContain("<button");
    }
  });

  it("shows supplier, line, units, value, scope, stated quantity, specification, response digest and the synthetic flag", () => {
    const c = card(markup, "validated");
    for (const needle of ["SYNTHETIC-SUPPLIER-VALIDATED", "transformer.replacement", "2,340,000", "EUR / EUR", "Replace transformer", "23.4 MVA (lump)",
      "DUB-01", "transformer_capacity", "sized for 69 racks", "1".repeat(64), "synthetic", "SYN-1", "until 2099-12-31", "lead time not stated"]) {
      expect(c, needle).toContain(needle);
    }
  });

  it("shows problems for an invalid line, the reviewer's decision for reviewed lines, and the retirement for retired ones", () => {
    expect(card(markup, "invalid")).toContain("currency USD");
    const rej = card(markup, "rejected");
    expect(rej).toContain("Test Reviewer");
    expect(rej).toContain("out of scope");
    const acc = card(markup, "accepted");
    expect(acc).toContain("basis firm_quote");
    expect(acc).toContain("comparability exact");
    expect(acc).toContain("region IE");
    expect(acc).toContain("transformer.install");
    expect(card(markup, "superseded")).toContain("replaced by 00000000-0000-4000-8000-0000000000ff");
    const wd = card(markup, "withdrawn");
    expect(wd).toContain("Test Withdrawer");
    expect(wd).toContain("supplier retracted");
  });

  it("counts the lines by state, shows an empty queue plainly and surfaces a load failure", () => {
    expect(markup).toContain("validated 1 · invalid 1 · accepted 1 · rejected 1 · superseded 1 · withdrawn 1");
    expect(html([])).toContain("No quotation lines have been received.");
    const failed = html([], "The cost evidence queue could not be read.");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("could not be read");
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("the admin pipeline page checks the admin cookie before it reads any supplier pricing", () => {
    const page = read("app/admin/pipeline/page.tsx");
    expect(page.indexOf("verifyAdminCookie")).toBeGreaterThan(-1);
    expect(page.indexOf("redirect(\"/admin/login\")")).toBeLessThan(page.indexOf("evidenceQueue("));
    expect(page).toContain("<CostEvidenceReview");
  });

  it("the review screen calls only the existing admin evidence routes", () => {
    const src = read("components/CostEvidenceReview.tsx");
    const urls = [...src.matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1]);
    expect(urls.sort()).toEqual(["/api/admin/cost-evidence/${id}/${action}", "/api/admin/cost-evidence?state=${next}"].sort());
    expect(src).toContain('action: "review" | "withdraw"');
  });

  it("every admin evidence route checks the admin cookie before doing anything", () => {
    for (const p of ["app/api/admin/cost-evidence/route.ts", "app/api/admin/cost-evidence/[id]/review/route.ts", "app/api/admin/cost-evidence/[id]/withdraw/route.ts"]) {
      const src = read(p);
      expect(src.indexOf("verifyAdminCookie"), p).toBeGreaterThan(-1);
      expect(src.indexOf("verifyAdminCookie"), p).toBeLessThan(src.search(/await (evidenceQueue|reviewEvidence|withdrawEvidence|readJson)/));
    }
  });

  it("the customer page no longer relies on a data: URL as the only copy of a run", () => {
    const src = read("components/BidComparison.tsx");
    expect(src).not.toContain("data:text/html");
    expect(src).toContain("/api/deliverable/${token}/evidence-run");
    expect(src).toContain("artifact_url");
  });

  it("the customer component renders for a reload with no state from any earlier request", () => {
    const out = renderToStaticMarkup(React.createElement(BidComparison, { token: "t".repeat(24), initial: null }));
    expect(out).toContain("Compare the bids");
  });
});
