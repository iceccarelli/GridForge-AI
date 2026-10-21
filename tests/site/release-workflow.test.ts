/**
 * The release workflow: what the operator reviewed is exactly what the buyer gets.
 *
 * Defects held here:
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

describe("customer resubmission", () => {
  it.each(["draft", "generating"])("is refused once the engagement is '%s' and the document is untouched", async (status) => {
    // A real in-flight row carries the claim stamp (lib/engagement-state.ts); an unstamped one is a stale claim.
    seed({ status, ...(status === "generating" ? { intake: { _gridforge: { generating_since: new Date().toISOString() } } } : {}) });
    const { POST } = await intake();
    const res = await POST(
      new Request(siteUrl("/x"), { method: "POST", body: JSON.stringify({ siteName: "Other Hall" }) }),
      { params: Promise.resolve({ token: "intake-token" }) }
    );
    expect(res.status).toBe(409);
    expect(row().status).toBe(status);
    expect(row().document_html).toBe(DOC);
  });

  it("is possible again after an operator reopens the engagement", async () => {
    seed();
    const { PATCH } = await admin();
    expect((await PATCH(patch({ token: "doc-token", action: "reopen" }))).status).toBe(200);
    expect(row().status).toBe("awaiting_intake");
  });
});

describe("release", () => {
  it("releases the reviewed draft, then emails the buyer", async () => {
    seed();
    const { PATCH } = await admin();
    const res = await PATCH(patch({ token: "doc-token", reviewed_hash: documentHash(DOC), reviewed_by: "A. Rivera" }));
    expect(res.status).toBe(200);
    expect(row().status).toBe("released");
    expect(sent).toHaveLength(1);
  });

  it("refuses without the hash of what was reviewed", async () => {
    seed();
    const { PATCH } = await admin();
    expect((await PATCH(patch({ token: "doc-token" }))).status).toBe(422);
    expect(row().status).toBe("draft");
    expect(sent).toHaveLength(0);
  });

  it("refuses when the draft changed after it was reviewed", async () => {
    seed();
    const reviewed = documentHash(DOC);
    row().document_html = "<p>rewritten after review</p>";
    const { PATCH } = await admin();
    const res = await PATCH(patch({ token: "doc-token", reviewed_hash: reviewed, reviewed_by: "A. Rivera" }));
    expect(res.status).toBe(409);
    expect(row().status).toBe("draft");
    expect(sent).toHaveLength(0);
  });

  it.each(["generating", "awaiting_intake", "engine_unavailable"])("refuses a '%s' engagement even if it holds a document", async (status) => {
    seed({ status });
    const { PATCH } = await admin();
    const res = await PATCH(patch({ token: "doc-token", reviewed_hash: documentHash(DOC), reviewed_by: "A. Rivera" }));
    expect(res.status).toBe(409);
    expect(row().status).toBe(status);
    expect(sent).toHaveLength(0);
  });

  it("does not email the buyer or claim success when the write fails", async () => {
    seed();
    db.failMethod = { method: "PATCH", status: 500, body: '{"message":"down"}' };
    const { PATCH } = await admin();
    const res = await PATCH(patch({ token: "doc-token", reviewed_hash: documentHash(DOC), reviewed_by: "A. Rivera" }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await res.json()).ok).toBe(false);
    expect(row().status).toBe("draft");
    expect(sent).toHaveLength(0);
  });

  it("does not email twice on a repeated click", async () => {
    seed();
    const { PATCH } = await admin();
    const b = { token: "doc-token", reviewed_hash: documentHash(DOC), reviewed_by: "A. Rivera" };
    await PATCH(patch(b));
    const again = await PATCH(patch(b));
    expect((await again.json()).customer_notified).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
