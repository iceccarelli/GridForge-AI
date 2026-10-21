/**
 * The release of a reviewed deliverable: what the reviewer approves is everything the buyer gets; a release names its
 * reviewer; the buyer's email is a durable obligation, retried and observable; a re-click never claims "already emailed" while
 * the email is still pending; and a buyer's bid comparison never overwrites a concurrent change.
 *
 * MOCKS: PostgREST fake database, intercepted mail. The version trigger and the check constraint of 0036 are proven on
 * PostgreSQL in tests/test_delivery_handoff_migration.py and the realdb journey.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminToken } from "@/lib/admin";
import { siteUrl } from "@/lib/site";
import { packHash, packHashV2, putWorkingFile, reviewHash } from "@/lib/deliverables";
import { PostgrestFake } from "./postgrest-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const TOKEN = "doc-token-abcdefghijklmnop";
let db: PostgrestFake;
let undo: () => void;
let mail: { to: string[] | string; subject: string; text: string; key: string | null }[];
let providerDown = false;

const FILES = {
  "scenarios.csv": "name,binds_first\nA,Busway\n",
  "provenance.csv": "k,v\n1,2\n",
  "response_template.json": "{\"values\":{}}",
  "specification.json": "{\"constraint_id\":\"cdu_capacity\"}",
  "bundle.json": "{\"expected\":[\"study\"],\"generated\":\"2027-01-01T00:00:00Z\"}",
};
function draft(over: Record<string, unknown> = {}) {
  db.seed("deliverables", [{
    token: TOKEN, intake_token: "intake-token-abcdefghijk", kind: "density_screen", status: "draft", email: "buyer@hall.example",
    stripe_session_id: "cs_1", title: "Density Screen", document_html: "<p>study</p>", document_md: "# study", deck_html: "<p>deck</p>",
    working_files: { ...FILES }, row_version: 0, intake: { siteName: "North Hall", _gridforge: { hash_version: 2 } }, ...over,
  }]);
  return db.rows("deliverables")[0] as any;
}
const row = () => db.rows("deliverables")[0] as any;
const release = async (body: Record<string, unknown> = {}) =>
  (await import("@/app/api/admin/deliverables/route")).PATCH(
    new Request(siteUrl("/x"), { method: "PATCH", body: JSON.stringify({ token: TOKEN, reviewed_hash: reviewHash(row()), reviewed_by: "A. Rivera", ...body }) }));
const toBuyer = () => mail.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"));
const notices = () => (db.rows("customer_notifications") as any[]).filter((n) => n.kind === "deliverable_release");

beforeEach(() => {
  mail = []; providerDown = false; jar.length = 0;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.RESEND_API_KEY = "re_test";
  process.env.LEAD_FROM_EMAIL = "Time to Power <power@timetopower.ai>";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  delete process.env.RESEND_FROM;
  db = new PostgrestFake(["deliverables", "customer_notifications"]);
  db.uniqueKeys.set("customer_notifications", [["dedupe_key"]]);
  db.rowDefaults.set("customer_notifications", () => ({
    status: "pending", attempts: 0, max_attempts: 6, next_attempt_at: new Date(0).toISOString(),
    claimed_until: null, last_error: null, last_http_status: null, provider_message_id: null, accepted_at: null,
  }));
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) {
      if (providerDown) return new Response("{}", { status: 503 });
      mail.push({ ...JSON.parse(String(init?.body)), key: (init?.headers as Record<string, string>)["Idempotency-Key"] ?? null });
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = dbFetch; restoreDb(); };
  jar.push({ name: "gf_admin", value: adminToken()! });
});
afterEach(() => undo());

describe("the reviewed hash covers every file the buyer gets", () => {
  it.each([
    ["the markdown", (r: any) => { r.document_md = "# a different study"; }],
    ["the walkthrough deck", (r: any) => { r.deck_html = "<p>a different deck</p>"; }],
    ["a CSV table", (r: any) => { r.working_files["scenarios.csv"] = "name,binds_first\nA,Tap-off\n"; }],
    ["the response schedule", (r: any) => { r.working_files["response_template.json"] = "{\"values\":{\"x\":1}}"; }],
    ["the specification", (r: any) => { r.working_files["specification.json"] = "{\"constraint_id\":\"other\"}"; }],
    ["a file added after review", (r: any) => { r.working_files["extra.csv"] = "a\n1\n"; }],
    ["the document", (r: any) => { r.document_html = "<p>changed</p>"; }],
  ])("changing %s after review changes the hash, and release refuses the stale one — THE regression", async (_n, mutate) => {
    const r = draft();
    const reviewed = reviewHash(r);
    mutate(r);
    expect(reviewHash(r)).not.toBe(reviewed);
    const res = await release({ reviewed_hash: reviewed });
    expect(res.status).toBe(409);
    expect(row().status).toBe("draft");
    expect(toBuyer()).toHaveLength(0);
  });

  it("the buyer's own bid comparison is not part of what is reviewed (it is created after release)", () => {
    const r = draft();
    const before = reviewHash(r);
    r.working_files["bid_comparison.json"] = "{\"ranked\":[]}";
    expect(reviewHash(r)).toBe(before);
  });

  it("an unambiguous encoding: moving bytes between two parts changes the hash", () => {
    const a = packHashV2({ document_html: "ab", document_md: "c", working_files: null });
    const b = packHashV2({ document_html: "a", document_md: "bc", working_files: null });
    expect(a).not.toBe(b);
  });

  it("a pack generated before v2 keeps its study-and-board fingerprint until it is regenerated, so a reviewed one still releases", async () => {
    const r = draft({ intake: { siteName: "North Hall" } });                 // no hash_version: generated before this change
    expect(reviewHash(r)).toBe(packHash(r));
    r.document_md = "# changed markdown";                                      // legacy hash does not see it (documented limitation)
    expect((await release()).status).toBe(200);
  });
});

describe("a release names its reviewer", () => {
  it.each([undefined, "", "   "])("reviewed_by %j is refused and nothing changes", async (name) => {
    draft();
    const res = await release({ reviewed_by: name });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error).toMatch(/reviewed_by is required/);
    expect(row().status).toBe("draft");
    expect(toBuyer()).toHaveLength(0);
    expect(notices()).toHaveLength(0);
  });

  it("the name is recorded with the release", async () => {
    draft();
    expect((await release({ reviewed_by: "  A. Rivera, P.Eng. " })).status).toBe(200);
    expect(row().intake._gridforge.review).toMatchObject({ by: "A. Rivera, P.Eng.", pack_sha256: reviewHash({ ...row(), intake: { _gridforge: { hash_version: 2 } } }) });
  });
});

describe("the release email is a durable obligation", () => {
  it("is queued and delivered once; a re-click does not send again and says it was accepted", async () => {
    draft();
    const body: any = await (await release()).json();
    expect(body).toMatchObject({ ok: true, status: "released", customer_notified: true, buyer_email: "accepted" });
    expect(toBuyer()).toHaveLength(1);
    expect(toBuyer()[0].text).toContain(`/deliverable/${TOKEN}`);
    expect(toBuyer()[0].key).toMatch(/^deliverable_release:/);
    expect(notices()).toEqual([expect.objectContaining({ status: "accepted", subject_table: "deliverables" })]);
    const again: any = await (await release()).json();
    expect(again).toMatchObject({ customer_notified: false, buyer_email: "accepted" });
    expect(again.notify_error).toMatch(/Already released; the buyer was emailed/);
    expect(toBuyer()).toHaveLength(1);
  });

  it("a provider outage is QUEUED, not lost: observable, retried by the sweep, and a re-click does not claim 'already emailed'", async () => {
    draft();
    providerDown = true;
    const first: any = await (await release()).json();
    expect(first).toMatchObject({ status: "released", customer_notified: false, buyer_email: "pending" });
    expect(first.notify_error).toMatch(/queued and retried automatically/);
    expect(first.link).toContain(`/deliverable/${TOKEN}`);
    expect(notices()).toEqual([expect.objectContaining({ status: "pending", attempts: 1 })]);
    expect(toBuyer()).toHaveLength(0);

    // a re-click while it is pending: NOT "already emailed"
    const click: any = await (await release()).json();
    expect(click).toMatchObject({ customer_notified: false, buyer_email: "pending" });
    expect(click.notify_error).not.toMatch(/Already released/);
    expect(click.notify_error).toMatch(/not been delivered yet/);

    // the provider recovers and the sweep delivers it, once
    providerDown = false;
    for (const n of notices()) n.next_attempt_at = new Date(0).toISOString();
    const { sweepNotifications } = await import("@/lib/notifications");
    await sweepNotifications();
    expect(toBuyer()).toHaveLength(1);
    expect(notices()[0].status).toBe("accepted");
    const done: any = await (await release()).json();
    expect(done.notify_error).toMatch(/Already released; the buyer was emailed/);
    expect(toBuyer()).toHaveLength(1);
  });

  it("a re-click while pending and due makes the attempt itself", async () => {
    draft();
    providerDown = true;
    await release();
    providerDown = false;
    for (const n of notices()) n.next_attempt_at = new Date(0).toISOString();
    const click: any = await (await release()).json();
    expect(click.buyer_email).toBe("accepted");
    expect(toBuyer()).toHaveLength(1);
  });

  it("a buyer with NO address on record is a persisted, observable abandonment — not a transient return value", async () => {
    draft({ email: null });
    const body: any = await (await release()).json();
    expect(body).toMatchObject({ status: "released", customer_notified: false, buyer_email: "abandoned" });
    expect(body.notify_error).toMatch(/no email address on record.*will not be retried.*Send them the link yourself/);
    expect(notices()).toEqual([expect.objectContaining({ status: "abandoned", last_error: "no_recipient" })]);
    const { listNotifications } = await import("@/lib/notifications");
    const open = await listNotifications("open");
    expect(open.items.some((n) => n.kind === "deliverable_release" && n.status === "abandoned")).toBe(true);
    // and a re-click still says so, instead of "already released"
    const again: any = await (await release()).json();
    expect(again.buyer_email).toBe("abandoned");
    expect(again.notify_error).toMatch(/no email address on record/);
  });

  it("a document pulled back before the retry is NOT announced", async () => {
    draft();
    providerDown = true;
    await release();
    const { PATCH } = await import("@/app/api/admin/deliverables/route");
    expect((await PATCH(new Request(siteUrl("/x"), { method: "PATCH", body: JSON.stringify({ token: TOKEN, action: "unrelease" }) }))).status).toBe(200);
    providerDown = false;
    for (const n of notices()) n.next_attempt_at = new Date(0).toISOString();
    const { sweepNotifications } = await import("@/lib/notifications");
    await sweepNotifications();
    expect(toBuyer()).toHaveLength(0);
    expect(notices()[0].status).toBe("cancelled");
  });

  it("where the outbox is not available, it is one direct attempt, as before", async () => {
    draft();
    db.dropTable("customer_notifications");
    const body: any = await (await release()).json();
    expect(body).toMatchObject({ status: "released", customer_notified: true });
    expect(body.buyer_email).toBeUndefined();
    expect(toBuyer()).toHaveLength(1);
    expect(toBuyer()[0].key).toMatch(/^deliverable-release-/);
  });
});

describe("a buyer's bid comparison never overwrites a concurrent change (compare-and-set on the row version)", () => {
  it("a lost race is re-read and retried: BOTH the concurrent file and the comparison survive", async () => {
    draft({ status: "released", row_version: 3 });
    const real = globalThis.fetch;
    let raced = false;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
      if (!raced && (init?.method ?? "GET") === "PATCH" && url.includes("/deliverables?")) {
        raced = true;                                                      // a regeneration lands between our read and our write
        row().working_files = { ...row().working_files, "scenarios.csv": "regenerated\n" };
        row().row_version += 1;
      }
      return real(i, init);
    }) as typeof fetch;
    try {
      expect(await putWorkingFile(TOKEN, "bid_comparison.json", "{\"ranked\":[1]}")).toBe(true);
    } finally { globalThis.fetch = real; }
    expect(row().working_files["scenarios.csv"]).toBe("regenerated\n");       // the concurrent write was NOT overwritten
    expect(row().working_files["bid_comparison.json"]).toBe("{\"ranked\":[1]}");
    expect(row().row_version).toBe(5);
  });

  it("gives up honestly (false) when it keeps losing, and writes nothing stale", async () => {
    draft({ status: "released", row_version: 1 });
    const real = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") row().row_version += 1;       // always raced
      return real(i, init);
    }) as typeof fetch;
    try {
      expect(await putWorkingFile(TOKEN, "bid_comparison.json", "{}", 3)).toBe(false);
    } finally { globalThis.fetch = real; }
    expect(row().working_files["bid_comparison.json"]).toBeUndefined();
  });

  it("without the version column (migration 0036 not applied) it still stores the file", async () => {
    draft({ status: "released" });
    delete row().row_version;
    expect(await putWorkingFile(TOKEN, "bid_comparison.json", "{}")).toBe(true);
    expect(row().working_files["bid_comparison.json"]).toBe("{}");
  });

  it("the bids route stores through it", async () => {
    const src = (await import("node:fs")).readFileSync("app/api/deliverable/[token]/bids/route.ts", "utf8");
    expect(src).toContain("putWorkingFile");
    expect(src).not.toMatch(/updateByToken\(/);
  });
});
