/**
 * GET /api/engagements matches the buyer's purchases on the VERIFIED session address. The Stripe webhook stores the address exactly
 * as the buyer typed it at checkout (`Jane.Doe@Acme.com`), the column is plain text and a PostgREST `eq` is case-sensitive, so the
 * lower-cased session address never matched and a paying buyer saw "no purchases" on /dashboard.
 *
 * The fix narrows the fetch case-insensitively (the ilike lib/deliverables.ts uses for credits, wildcards neutralised) and then
 * decides identity in code on the exact normalised address, so a wildcard in an address can never widen what a buyer is shown.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { bearerFor, installWithAuth } from "./auth-fake";

let db: PostgrestFake;
let restore: () => void;

const deliverable = (token: string, email: string | null) => ({
  token, intake_token: `intake_${token}`, kind: "density_screen", status: "awaiting_intake", title: null, amount_cents: 450000,
  email, created_at: "2026-11-01T00:00:00Z", released_at: null,
});
const watch = (token: string, email: string | null) => ({
  token, status: "active", cadence: "quarterly", site_name: "North", hall_id: "H1", email, created_at: "2026-11-01T00:00:00Z",
  last_run_at: null, next_run_at: null,
});

beforeEach(() => {
  resetMemoryLimiter();
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["deliverables", "watches"]);
  restore = installWithAuth(db).restore;
});
afterEach(() => restore());

async function engagementsFor(sessionEmail: string) {
  const { GET } = await import("@/app/api/engagements/route");
  const res = await GET(new Request(siteUrl("/api/engagements"), { headers: bearerFor(sessionEmail) }));
  return { status: res.status, body: (await res.json()) as { engagements: { documentToken: string | null; intakeToken: string | null }[]; watches: { token: string | null }[] } };
}

describe("a purchase stored with the buyer's capitalised address", () => {
  beforeEach(() => {
    db.seed("deliverables", [deliverable("doc_jane", "Jane.Doe@Acme.com")]);
    db.seed("watches", [watch("watch_jane", "Jane.Doe@Acme.com")]);
  });

  it("is found by the verified session address in lower case", async () => {
    const { status, body } = await engagementsFor("jane.doe@acme.com");
    expect(status).toBe(200);
    expect(body.engagements).toHaveLength(1);
    expect(body.engagements[0].intakeToken).toBe("intake_doc_jane");
    expect(body.watches).toHaveLength(1);
    expect(body.watches[0].token).toBe("watch_jane");
  });

  it("is found by a session whose address is capitalised the same way", async () => {
    const { body } = await engagementsFor("Jane.Doe@Acme.com");
    expect(body.engagements).toHaveLength(1);
    expect(body.watches).toHaveLength(1);
  });

  it("does not return the stored address spelling", async () => {
    const { body } = await engagementsFor("jane.doe@acme.com");
    // (The response names the session's own normalised address; what must not appear is the row's stored spelling.)
    expect(JSON.stringify(body)).not.toContain("Jane.Doe@Acme.com");
  });
});

describe("what a case-insensitive match must never widen to", () => {
  it("another buyer's rows never appear", async () => {
    db.seed("deliverables", [deliverable("doc_jane", "Jane.Doe@Acme.com"), deliverable("doc_other", "someone.else@acme.com")]);
    db.seed("watches", [watch("watch_jane", "Jane.Doe@Acme.com"), watch("watch_other", "someone.else@acme.com")]);
    const { body } = await engagementsFor("jane.doe@acme.com");
    expect(body.engagements.map((e) => e.intakeToken)).toEqual(["intake_doc_jane"]);
    expect(body.watches.map((w) => w.token)).toEqual(["watch_jane"]);
  });

  it("an address that differs only where the session address has `_` or `%` is not matched", async () => {
    db.seed("deliverables", [deliverable("doc_wild", "jane_doe@acme.com"), deliverable("doc_decoy", "janeXdoe@acme.com"), deliverable("doc_pct", "jane%doe@acme.com")]);
    db.seed("watches", [watch("watch_wild", "jane_doe@acme.com"), watch("watch_decoy", "janeXdoe@acme.com")]);
    // `_` in the buyer's own address: their row is found, the look-alike is not.
    const a = await engagementsFor("jane_doe@acme.com");
    expect(a.body.engagements.map((e) => e.intakeToken)).toEqual(["intake_doc_wild"]);
    expect(a.body.watches.map((w) => w.token)).toEqual(["watch_wild"]);
    // `%` in the session address must not behave as "anything".
    const b = await engagementsFor("jane%doe@acme.com");
    expect(b.body.engagements.map((e) => e.intakeToken)).toEqual(["intake_doc_pct"]);
    expect(b.body.watches).toHaveLength(0);
  });

  it("a `%` or `*` prefix in a session address cannot be used to list other buyers' purchases", async () => {
    db.seed("deliverables", [deliverable("doc_jane", "Jane.Doe@Acme.com"), deliverable("doc_other", "someone.else@acme.com")]);
    for (const attacker of ["%@acme.com", "*@acme.com", "_%@acme.com", "%"]) {
      const { body } = await engagementsFor(attacker);
      expect(body.engagements ?? []).toHaveLength(0);
    }
  });
});
