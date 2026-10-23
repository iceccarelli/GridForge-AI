/**
 * Release and the money behind it: a payment refunded or disputed since checkout is not handed over without a person saying so.
 *
 * The set-up below is copied from release-workflow.test.ts, whose defects are:
 *  - intake POST only refused `released`, so after a draft existed the customer
 *    could resubmit, flipping status to `generating` and rewriting document_html
 *    under the reviewer's feet;
 *  - release only checked document_html existed, ignored the write's result, and
 *    emailed the buyer even when nothing had been recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { adminToken } from "@/lib/admin";
import { documentHash } from "@/lib/deliverables";
import { PostgrestFake } from "./postgrest-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }),
}));
const sent: { to: string }[] = [];
vi.mock("@/lib/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/mail")>()),
  sendMail: async (m: { to: string }) => { sent.push(m); return { sent: true, id: "m1" }; },
  notifyOperator: async () => ({ sent: true, id: "m2" }),
}));

const DOC = "<p>reviewed draft</p>";
let db: PostgrestFake;
let restore: () => void;

function seed(over: Record<string, unknown> = {}) {
  db.seed("deliverables", [
    { token: "doc-token", intake_token: "intake-token", kind: "density_screen", status: "draft",
      email: "buyer@hall.example", company: "North Hall", document_html: DOC, document_md: "x",
      intake: { siteName: "North Hall", _gridforge: { document_sha256: documentHash(DOC) } }, ...over },
  ]);
}
const row = () => db.rows("deliverables")[0] as any;
const patch = (b: unknown) =>
  new Request(siteUrl("/x"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const admin = async () => import("@/app/api/admin/deliverables/route");
const intake = async () => import("@/app/api/intake/[token]/route");

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  jar.length = 0;
  sent.length = 0;
  db = new PostgrestFake(["deliverables"]);
  restore = db.install();
  jar.push({ name: "gf_admin", value: adminToken()! });
});
afterEach(() => restore());


let standing: { state: string; detail?: string; partial_refund_cents?: number } = { state: "ok", partial_refund_cents: 0 };
vi.mock("@/lib/payment-standing", () => ({ paymentStanding: async () => standing }));

const releaseBody = (extra: Record<string, unknown> = {}) =>
  patch({ token: "doc-token", reviewed_hash: documentHash(DOC), reviewed_by: "A. Rivera", ...extra });

describe("release checks that the payment still stands", () => {
  beforeEach(() => { standing = { state: "ok", partial_refund_cents: 0 }; });

  it.each([
    ["refunded", "this payment has been refunded in full", 409],
    ["disputed", "the card issuer has opened a dispute on this payment", 409],
    ["unavailable", undefined, 503],
  ])("a %s payment is not released, the buyer is not emailed, and the row stays a draft", async (state, detail, status) => {
    seed({ stripe_session_id: "cs_test_1" });
    standing = { state, ...(detail ? { detail } : {}) };
    const { PATCH } = await admin();
    const res = await PATCH(releaseBody());
    expect(res.status).toBe(status);
    expect((await res.json()).payment_standing).toBe(state);
    expect(row().status).toBe("draft");
    expect(sent).toHaveLength(0);
  });

  it.each(["refunded", "disputed", "unavailable"])("the operator can release a %s payment anyway, and the record says so", async (state) => {
    seed({ stripe_session_id: "cs_test_1" });
    standing = { state, detail: "x" };
    const { PATCH } = await admin();
    const res = await PATCH(releaseBody({ acknowledge_payment_issue: true }));
    expect(res.status).toBe(200);
    expect(row().status).toBe("released");
    expect(row().intake._gridforge.review.payment_override).toBe(state);
  });

  it("a malformed release is refused for what is wrong with it before Stripe is asked (wrong hash 409, no reviewer 422)", async () => {
    seed({ stripe_session_id: "cs_test_1" });
    standing = { state: "unavailable" };
    const { PATCH } = await admin();
    expect((await PATCH(patch({ token: "doc-token", reviewed_hash: "0".repeat(64), reviewed_by: "A. Rivera" }))).status).toBe(409);
    expect((await PATCH(patch({ token: "doc-token", reviewed_hash: "0".repeat(64) }))).status).toBe(422);
    expect(row().status).toBe("draft");
  });

  it("a release with nothing to override carries no override mark", async () => {
    seed({ stripe_session_id: "cs_test_1" });
    const { PATCH } = await admin();
    expect((await PATCH(releaseBody({ acknowledge_payment_issue: true }))).status).toBe(200);
    expect(row().intake._gridforge.review.payment_override).toBeUndefined();
  });

  it("a standing payment, a partial refund and an unchecked row release as before", async () => {
    for (const s of [{ state: "ok", partial_refund_cents: 0 }, { state: "ok", partial_refund_cents: 5000 }, { state: "unchecked" }]) {
      db = new PostgrestFake(["deliverables"]); restore(); restore = db.install();
      seed({ stripe_session_id: "cs_test_1" });
      standing = s;
      const { PATCH } = await admin();
      expect((await PATCH(releaseBody())).status).toBe(200);
    }
  });
});
