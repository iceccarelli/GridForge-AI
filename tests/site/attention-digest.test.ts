/**
 * The operator's "needs a person" list is pushed once a day, not only pulled (QA6-5).
 *
 * The 30-minute /api/cron/engagements sends ONE digest per UTC day through the mail provider with a per-day Idempotency-Key.
 * MOCKS: the PostgREST fake database, and a mail provider stand-in that implements Resend's documented idempotency (same key +
 * same payload returns the first result and sends nothing; same key + a different payload is a 409 invalid_idempotent_request).
 * NOT proven: Vercel running the cron, or an inbox receiving the mail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { digestText, sendDailyDigest, classify } from "@/lib/attention";
import { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let undo: () => void;
let delivered: { to: string[]; subject: string; text: string; key: string }[];
let provider: "up" | "down";
const seen = new Map<string, string>();

const NOW = "2027-02-01T08:00:00Z";
const ago = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  delivered = []; provider = "up"; seen.clear();
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.CRON_SECRET = "cron-secret-value";
  process.env.RESEND_API_KEY = "re_test";
  process.env.LEAD_FROM_EMAIL = "Time to Power <power@timetopower.ai>";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  delete process.env.RESEND_FROM;
  db = new PostgrestFake(["deliverables", "engagement_deposits", "watches", "watch_note_notices", "customer_notifications", "watch_notes"]);
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) {
      if (provider === "down") return new Response("{}", { status: 503 });
      const payload = String(init?.body);
      const key = (init?.headers as Record<string, string>)["Idempotency-Key"];
      if (seen.has(key)) {
        return seen.get(key) === payload
          ? new Response(JSON.stringify({ id: "em_first" }), { status: 200 })                       // the ORIGINAL result, nothing sent
          : new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 });
      }
      seen.set(key, payload);
      delivered.push({ ...JSON.parse(payload), key });
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = dbFetch; restoreDb(); };
});
afterEach(() => { undo(); vi.useRealTimers(); });

/** One of each kind of item the digest exists to push. */
function seedEverything() {
  db.seed("deliverables", [
    { token: "SECRET-DOC-TOKEN-aaaaaaaaaaaa", intake_token: "SECRET-INTAKE-bbbbbbbbbbbbb", kind: "density_screen", status: "generating", email: "a@hall.example", stripe_session_id: "cs_a",
      created_at: ago(5), intake: { _gridforge: { generating_since: ago(1) } } },
    { token: "t2", intake_token: "i2", kind: "procurement_spec", status: "draft", email: "b@hall.example", stripe_session_id: "cs_b", created_at: ago(6), intake: {} },
    { token: "t3", intake_token: "i3", kind: "density_screen", status: "awaiting_intake", email: "c@hall.example", stripe_session_id: "cs_c", created_at: ago(9) },
  ]);
  db.seed("engagement_deposits", [
    { kind: "envelope_study_deposit", status: "paid", email: "d@hall.example", amount_cents: 900_000, paid_at: ago(4) },
    { kind: "portfolio_screen_deposit", status: "scoped", email: "e@hall.example", amount_cents: 1_500_000, paid_at: ago(60), owner: "Ada", scoped_at: ago(40), delivery_due_on: "2027-01-10" },
    { kind: "envelope_study_deposit", status: "scoped", email: "f@hall.example", amount_cents: 900_000, paid_at: ago(60), owner: "Ada", scoped_at: ago(40) },
  ]);
  db.seed("watches", [
    { status: "paused", email: "g@hall.example", intake: { siteName: "H" }, created_at: ago(30), last_run_at: ago(10) },
    { status: "active", email: "h@hall.example", intake: null, created_at: ago(12) },
  ]);
  db.seed("customer_notifications", [
    { kind: "deliverable_release", status: "abandoned", last_error: "no_recipient", created_at: ago(3) },
    { kind: "intake_link", status: "ambiguous", created_at: ago(2) },
  ]);
  db.seed("watch_note_notices", [{ status: "abandoned", created_at: ago(2) }]);
}
const sweep = async () => (await (await import("@/app/api/cron/engagements/route")).GET(new Request(siteUrl("/api/cron/engagements"), { headers: { authorization: "Bearer cron-secret-value" } }))).json() as Promise<any>;

describe("the daily digest", () => {
  it("sends ONE email with every kind of item, with ids and ages and no token, from the 30-minute cron", async () => {
    seedEverything();
    const out = await sweep();
    expect(out.digest).toBe("sent");
    // (the sweep's own "moved N stuck engagements" notice is a separate email; the DIGEST is one)
    const digests = delivered.filter((d) => String(d.key ?? "").startsWith("attention-digest-"));
    expect(digests).toHaveLength(1);
    const m = digests[0];
    expect(m.to).toEqual(["ops@example.test"]);
    expect(m.key).toBe("attention-digest-2027-02-01");
    expect(m.subject).toBe("Paid work needs a person - 11 items (2027-02-01)");
    for (const line of [
      "Held (engine could not finish) (1)", "Draft waiting for review (1)", "Paid, numbers not submitted (1)", "Deposit, nobody has contacted the buyer (1)",
      "Deposit, past its delivery date (1)", "Deposit, scoped with no delivery date on file (1)", "Hall Watch, paused by a failed payment (1)",
      "Hall Watch, no numbers submitted (1)", "Hall Watch change note, email undelivered (1)", "Customer email undelivered or quarantined (2)",
    ]) expect(m.text, line).toContain(line);
    expect(m.text).toContain("owner: Ada / due 2027-01-10");
    expect(m.text).toContain("owner: nobody");
    expect(m.text).not.toMatch(/SECRET|intake-token|doc-token/);
    expect(m.text).toContain("ONE digest for 2027-02-01");
  });

  it("is idempotent per day: later runs the same day send nothing, even when the list has changed", async () => {
    seedEverything();
    expect(await sendDailyDigest()).toBe("sent");
    expect(await sendDailyDigest()).toBe("sent");                       // same text: the provider returns the original, nothing new is sent
    vi.setSystemTime(new Date("2027-02-01T08:30:00Z"));
    db.seed("engagement_deposits", [{ kind: "envelope_study_deposit", status: "paid", email: "new@hall.example", amount_cents: 900_000, paid_at: ago(5) }]);
    expect(await sendDailyDigest()).toBe("already_sent");               // different text, same day: the provider refuses the conflict
    vi.setSystemTime(new Date("2027-02-01T23:30:00Z"));
    expect(await sendDailyDigest()).toBe("already_sent");
    expect(delivered).toHaveLength(1);
  });

  it("sends again the next day while things are still waiting (a new key)", async () => {
    seedEverything();
    await sendDailyDigest();
    vi.setSystemTime(new Date("2027-02-02T08:00:00Z"));
    expect(await sendDailyDigest()).toBe("sent");
    expect(delivered.map((d) => d.key)).toEqual(["attention-digest-2027-02-01", "attention-digest-2027-02-02"]);
  });

  it("does not send before the digest hour, or when nothing needs a person", async () => {
    seedEverything();
    vi.setSystemTime(new Date("2027-02-01T06:30:00Z"));
    expect(await sendDailyDigest()).toBe("too_early");
    expect(delivered).toHaveLength(0);
    for (const t of ["deliverables", "engagement_deposits", "watches", "customer_notifications", "watch_note_notices"]) db.rows(t).length = 0;
    vi.setSystemTime(new Date(NOW));
    expect(await sendDailyDigest()).toBe("nothing");
    expect(delivered).toHaveLength(0);
  });

  it("a provider outage is retried by the next run until it is accepted, then sent once", async () => {
    seedEverything();
    provider = "down";
    expect(await sendDailyDigest()).toBe("failed");
    vi.setSystemTime(new Date("2027-02-01T08:30:00Z"));
    expect(await sendDailyDigest()).toBe("failed");
    provider = "up";
    vi.setSystemTime(new Date("2027-02-01T09:00:00Z"));
    expect(await sendDailyDigest()).toBe("sent");
    expect(await sendDailyDigest()).toBe("sent");
    expect(delivered).toHaveLength(1);
  });

  it("an unreadable list is reported as unreadable, never as 'nothing needs attention'; no operator address is 'not_configured'", async () => {
    seedEverything();
    db.dropTable("engagement_deposits");
    expect(await sendDailyDigest()).toBe("unreadable");
    expect(delivered).toHaveLength(0);
    db.createTable("engagement_deposits");
    delete process.env.LEAD_TO_EMAIL;
    expect(await sendDailyDigest()).toBe("not_configured");
  });

  it("is deterministic for a given list (the text carries no clock), and caps a very long list", () => {
    const items = classify({ deliverables: [], watches: [], notices: [], deposits: Array.from({ length: 80 }, (_, i) => ({ id: `d${i}`, kind: "envelope_study_deposit", status: "paid", paid_at: ago(5), email: `b${i}@x.example` })) }, Date.parse(NOW));
    const a = digestText(items, "2027-02-01"), b = digestText(items, "2027-02-01");
    expect(a).toEqual(b);
    expect(a.text).toContain("(20 more not listed");
    expect(a.text.split("\n").filter((l) => l.startsWith("  - ")).length).toBe(60);
  });
});
