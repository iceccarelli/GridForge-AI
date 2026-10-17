/**
 * The invitation secret (lib/team-token.ts), the mail redaction that covers its link, and the plan copy that states the seat
 * counts the database enforces.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redact } from "@/lib/mail";
import { siteUrl } from "@/lib/site";
import { INTELLIGENCE_PLANS } from "@/lib/products";
import { PLANS, seatLine } from "@/lib/subscriptions";
import { hashInviteToken, inviteToken, isInviteToken } from "@/lib/team-token";

const ID = "11111111-1111-4111-8111-111111111111";
const saved = { ...process.env };
beforeEach(() => {
  delete process.env.INTELLIGENCE_INVITE_SECRET;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_key_one";
});
afterEach(() => { process.env = { ...saved }; });

describe("the invitation secret", () => {
  it("is derived, strong, URL-safe and stable for one invitation (the outbox rebuilds the same link for every retry)", () => {
    const t = inviteToken(ID)!;
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isInviteToken(t)).toBe(true);
    expect(inviteToken(ID)).toBe(t);
  });

  it("differs per invitation and per server key, and reveals neither", () => {
    const a = inviteToken(ID)!;
    expect(inviteToken("22222222-2222-4222-8222-222222222222")).not.toBe(a);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_key_two";
    expect(inviteToken(ID)).not.toBe(a);
    process.env.INTELLIGENCE_INVITE_SECRET = "a-dedicated-secret-of-at-least-32-characters";
    const dedicated = inviteToken(ID)!;
    expect(dedicated).not.toBe(a);
    expect(dedicated).not.toContain(ID);
    process.env.INTELLIGENCE_INVITE_SECRET = "too-short";   // below 32 characters it is ignored, not used weakly
    expect(inviteToken(ID)).not.toBe(dedicated);
  });

  it("cannot be minted without a key to derive it from: invitations fail closed", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(inviteToken(ID)).toBeNull();
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_key_one";
    expect(inviteToken("")).toBeNull();
  });

  it("is stored only as a SHA-256 hash that is not the secret", () => {
    const t = inviteToken(ID)!;
    const h = hashInviteToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(hashInviteToken(t)).toBe(h);
  });

  it("is recognised only in the exact shape this module mints", () => {
    for (const bad of ["", "x", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "=", "A".repeat(42) + "/", 7, null, undefined, {}]) {
      expect(isInviteToken(bad)).toBe(false);
    }
  });
});

describe("the link never reaches a log", () => {
  it("redacts the invitation path like every other capability link", () => {
    const t = inviteToken(ID)!;
    const line = redact(`send failed for ${siteUrl("/account/invite/" + t)} to a@b.example`);
    expect(line).not.toContain(t);
    expect(line).toContain("/account/invite/[redacted]");
    expect(line).not.toContain("a@b.example");
  });
});

describe("plan copy states what is enforced", () => {
  it("each plan's seat line comes from the catalogue", () => {
    expect(seatLine(1)).toBe("1 seat: the billing owner");
    expect(seatLine(5)).toBe("5 seats, including the billing owner");
    expect(seatLine(null)).toMatch(/^Unlimited seats/);
    for (const plan of PLANS) {
      expect(plan.features).toContain(seatLine(INTELLIGENCE_PLANS[plan.id].seats));
    }
  });

  it("claims no tier-specific feature beyond seats", () => {
    const text = PLANS.flatMap((p) => p.features).join(" ").toLowerCase();
    for (const word of ["sso", "alerts", "dedicated", "sla", "api access", "priority"]) expect(text).not.toContain(word);
  });
});
