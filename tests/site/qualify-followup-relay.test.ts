/**
 * The follow-up route mails an address the CALLER typed, from the company's sender. Whatever else is in that mail
 * must therefore not be text the caller chose: the qualification's `site_name` and `hall_id` are free text the same
 * anonymous caller wrote through /api/qualify (max 120 / 60 characters), so echoing them made the company's domain
 * a relay for a stranger's words and links. The buyer's mail is fixed wording; the desk's mail may quote the caller,
 * but only as inert plain text.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";

const PHISH = "URGENT - your Time to Power account is suspended; verify at https://evil.example/login";
const MENTION_NOTE = "<!channel> <https://evil.example/pay|Approve invoice>\nRead: https://evil.example/fake";

let db: PostgrestFake;
let restoreFake: () => void;
let sent: { to: string[]; subject: string; text: string; html?: string; reply_to?: string }[] = [];

beforeEach(() => {
  resetMemoryLimiter();
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.RESEND_API_KEY = "test_key";
  process.env.LEAD_TO_EMAIL = "sales@timetopower.ai";
  sent = [];
  db = new PostgrestFake(["qualifications"]);
  restoreFake = db.install();
  const below = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com")) {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "e1" }), { status: 200 });
    }
    return below(input as RequestInfo, init);
  }) as typeof fetch;
});
afterEach(() => restoreFake());

function seed(overrides: Record<string, unknown> = {}) {
  db.seed("qualifications", [
    {
      token: "tok_attacker_1", site_name: PHISH, hall_id: "call +1-555-0100", metro: "Dublin <b>x</b>", country: "IE",
      platform: "gb300_nvl72", inputs: {}, racks_as_found: 3, racks_after_relief: 9, binding_constraint: "Transformer",
      intake_completeness: 0.5, company: "Acme <!channel>", email: null, status: "scored", follow_up_requested_at: null,
      ...overrides,
    },
  ]);
}

async function request(email: string, note?: string) {
  const { POST } = await import("@/app/api/qualify/[token]/follow-up/route");
  return POST(
    new Request(siteUrl("/api/qualify/tok_attacker_1/follow-up"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, ...(note ? { note } : {}) }),
    }),
    { params: Promise.resolve({ token: "tok_attacker_1" }) },
  );
}

describe("the follow-up mail to the address the caller typed", () => {
  it("is fixed wording: nothing the caller typed into the qualification or the note appears in it", async () => {
    seed();
    const res = await request("victim@third-party.example", MENTION_NOTE);
    expect(res.status).toBe(200);
    const toVictim = sent.find((m) => m.to[0] === "victim@third-party.example");
    expect(toVictim).toBeTruthy();
    const all = `${toVictim!.subject}\n${toVictim!.text}`;
    for (const typed of ["evil.example", "URGENT", "suspended", "555-0100", "Dublin", "Acme", "<!channel>", "Approve invoice"]) {
      expect(all, `the buyer mail echoed caller text: ${typed}`).not.toContain(typed);
    }
    // What it may carry is what the system itself derived, plus our own links.
    expect(all).toMatch(/your read/i);
    expect(all).toContain("Transformer");
    expect(all).toContain("/q/tok_attacker_1");
    expect(toVictim!.html).toBeUndefined();
    // The count is an upper bound (a free read evaluates no transformer or UPS bank) and the mail says so, as the live page and the shared page do.
    expect(all).toMatch(/at most \S+ racks/);
    expect(all).toContain("upper bound");
  });

  it("still tells the desk who asked and what they typed, as one inert plain-text line each", async () => {
    seed();
    await request("victim@third-party.example", MENTION_NOTE);
    const toDesk = sent.find((m) => m.to[0] === "sales@timetopower.ai");
    expect(toDesk).toBeTruthy();
    expect(toDesk!.html).toBeUndefined();
    const body = toDesk!.text;
    // The typed text is there for the person who must follow up, but not as a clickable link and not as a fake line.
    expect(body).toContain("evil.example");
    expect(body).not.toMatch(/https?:\/\/evil/i);
    // The message is text/plain only (no HTML part), so angle brackets are inert characters there; a line break is not, so there is none to forge a line with.
    expect(body).toContain("https[://]evil.example/pay");
    expect(body.split("\n").filter((l) => l.startsWith("Read:"))).toHaveLength(1);
    expect(toDesk!.subject).not.toMatch(/https?:\/\//i);
    expect(toDesk!.subject).not.toMatch(/[\r\n]/);
  });

  it("a stored name with a line break cannot forge a second subject line or extra header text", async () => {
    seed({ site_name: "Hall A\r\nBcc: someone@else.example", hall_id: "H1" });
    await request("victim@third-party.example");
    const toDesk = sent.find((m) => m.to[0] === "sales@timetopower.ai");
    expect(toDesk!.subject).not.toMatch(/[\r\n]/);
  });
});
