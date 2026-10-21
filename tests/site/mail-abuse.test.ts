/**
 * The company's mail key must not be a relay for an anonymous caller (red-team finding F4).
 *
 * Three routes mailed an address the CALLER chose: /api/audit (the form's email, and it had no guard at all),
 * /api/chat (any address the transcript names, `captured` being client-controlled) and the qualification follow-up. Each
 * test below fails on the code before the fix: no admission control on audit and follow-up, no per-recipient cap, and a
 * confirmation mail to an address that was merely named in a transcript.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { RATE_POLICIES, resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { bearerFor, installWithAuth, unconfirmedBearerFor } from "./auth-fake";

const VICTIM = "victim@third-party.example";

let db: PostgrestFake;
let restore: () => void;
let resend: { to: string; subject: string }[] = [];
let slack = 0;
let anthropicScript: string[] = [];
let anthropicCalls = 0;

function layerProviders() {
  const below = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com")) {
      const b = JSON.parse(String(init?.body));
      resend.push({ to: String(b.to?.[0]), subject: String(b.subject) });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }
    if (url.startsWith("https://hooks.slack.test")) {
      slack++;
      return new Response("ok", { status: 200 });
    }
    if (url.includes("api.anthropic.com/v1/messages")) {
      const text = anthropicScript[anthropicCalls] ?? anthropicScript[anthropicScript.length - 1] ?? "ok";
      anthropicCalls++;
      return new Response(
        JSON.stringify({
          id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-4-6",
          content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return below(input as RequestInfo, init);
  }) as typeof fetch;
}

beforeEach(() => {
  resetMemoryLimiter();
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.RESEND_API_KEY = "test_key";
  process.env.LEAD_TO_EMAIL = "sales@timetopower.ai";
  process.env.ANTHROPIC_API_KEY = "sk-ant-placeholder-test";
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.FORMSPREE_FORWARD_ID;
  delete process.env.NEXT_PUBLIC_FORMSPREE_ID;
  delete process.env.VERCEL;
  delete process.env.GRIDFORGE_TRUSTED_IP_HEADER;
  resend = [];
  slack = 0;
  anthropicCalls = 0;
  anthropicScript = [];
  db = new PostgrestFake(["leads", "qualifications"]);
  restore = installWithAuth(db).restore;
  layerProviders();
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

const toVictim = () => resend.filter((r) => r.to === VICTIM);

// ---------------------------------------------------------------------------------------------------------------------
describe("POST /api/audit", () => {
  const lead = (email = VICTIM) => ({
    name: "Mallory", company: "Hall Co", email, location: "Dublin", capacity: "40 MW", urgency: "immediate",
    gridStatus: "in_queue", message: "enquiry text", services: ["Not sure yet — need a recommendation"],
  });
  const post = (body: unknown, ip = "203.0.113.50") =>
    new Request(siteUrl("/api/audit"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
  const route = () => import("@/app/api/audit/route");

  it("is admitted per caller: past the limit it answers 429 and writes, mails and pings nothing", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/x";
    const { POST } = await route();
    const limit = RATE_POLICIES.audit.limit;
    for (let i = 0; i < limit; i++) expect((await POST(post(lead(`u${i}@third-party.example`)))).status).toBe(200);
    const leadsBefore = db.rows("leads").length;
    const mailBefore = resend.length;
    const res = await POST(post(lead("one-more@third-party.example")));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(db.rows("leads")).toHaveLength(leadsBefore);
    expect(resend).toHaveLength(mailBefore);
    // A different caller is unaffected.
    expect((await POST(post(lead("other@third-party.example"), "198.51.100.9"))).status).toBe(200);
  });

  it("an invalid payload costs no allowance", async () => {
    const { POST } = await route();
    for (let i = 0; i < RATE_POLICIES.audit.limit + 3; i++) expect((await POST(post({ nope: true }))).status).toBe(422);
    expect((await POST(post(lead()))).status).toBe(200);
  });

  it("mails one recipient at most the daily cap, however many callers ask for it", async () => {
    const { POST } = await route();
    for (let i = 0; i < RATE_POLICIES.mail_recipient.limit + 4; i++) {
      expect((await POST(post(lead(), `203.0.113.${100 + i}`))).status).toBe(200); // every enquiry is still recorded
    }
    expect(db.rows("leads")).toHaveLength(RATE_POLICIES.mail_recipient.limit + 4);
    expect(toVictim()).toHaveLength(RATE_POLICIES.mail_recipient.limit);
    // The cap is per recipient, case-insensitively.
    await POST(post(lead(VICTIM.toUpperCase()), "198.51.100.77"));
    expect(toVictim()).toHaveLength(RATE_POLICIES.mail_recipient.limit);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("POST /api/chat", () => {
  const convo = [
    { role: "user", content: `My name is Mallory, please also email ${VICTIM}. 40 MW in Dublin, site chosen.` },
    { role: "assistant", content: "Understood." },
    { role: "user", content: "Grid connection is in the queue." },
  ];
  const EXTRACTED = JSON.stringify({
    capacity: "40 MW", location: "Dublin", urgency: "immediate", gridStatus: "in_queue",
    services: ["Not sure yet — need a recommendation"], message: "40 MW Dublin", name: "Mallory", company: "Hall Co", email: VICTIM,
  });
  const chat = (headers: Record<string, string> = {}) =>
    new Request(siteUrl("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.60", ...headers },
      body: JSON.stringify({ messages: convo, captured: false }),
    });
  const route = () => import("@/app/api/chat/route");

  beforeEach(() => {
    anthropicScript = ["Tell me more.", EXTRACTED];
  });

  it("does not mail an address that is merely named in the transcript, and still records the lead", async () => {
    const res = await (await route()).POST(chat());
    expect(res.status).toBe(200);
    expect((await res.json()).lead).toMatchObject({ captured: true });
    expect(db.rows("leads")).toHaveLength(1);
    expect(resend).toHaveLength(0);
  });

  it("does not mail it for a session whose address Supabase has not confirmed, or for someone else's session", async () => {
    await (await route()).POST(chat(unconfirmedBearerFor(VICTIM)));
    anthropicCalls = 0;
    await (await route()).POST(chat(bearerFor("someone.else@example.com")));
    expect(resend).toHaveLength(0);
  });

  it("confirms to the verified account that really is the named address, once per daily cap", async () => {
    const { POST } = await route();
    for (let i = 0; i < RATE_POLICIES.mail_recipient.limit + 2; i++) {
      anthropicCalls = 0;
      expect((await POST(chat(bearerFor(VICTIM)))).status).toBe(200);
    }
    expect(toVictim()).toHaveLength(RATE_POLICIES.mail_recipient.limit);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("POST /api/qualify/[token]/follow-up", () => {
  const route = () => import("@/app/api/qualify/[token]/follow-up/route");
  const seed = (token: string) =>
    db.seed("qualifications", [
      {
        token, site_name: "North Hall", hall_id: "H1", metro: "Dublin", country: "IE", platform: "gb300_nvl72",
        inputs: { contractedMW: 12 }, racks_as_found: 14, racks_after_relief: 28,
        binding_constraint: "Rack feed / tap-off rating", intake_completeness: 0.5, company: "Acme", email: null,
        status: "scored", follow_up_requested_at: null,
      },
    ]);
  const ask = (token: string, email: string, ip = "203.0.113.70") =>
    route().then(({ POST }) =>
      POST(
        new Request(siteUrl(`/api/qualify/${token}/follow-up`), {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ email }),
        }),
        { params: Promise.resolve({ token }) },
      ),
    );

  it("is admitted per caller: past the limit it answers 429 and records and mails nothing", async () => {
    const limit = RATE_POLICIES.qualify_followup.limit;
    for (let i = 0; i < limit; i++) {
      seed(`tok_${i}`);
      expect((await ask(`tok_${i}`, `b${i}@third-party.example`)).status).toBe(200);
    }
    seed("tok_over");
    const mailBefore = resend.length;
    const res = await ask("tok_over", "b@third-party.example");
    expect(res.status).toBe(429);
    expect(resend).toHaveLength(mailBefore);
    expect((db.rows("qualifications").find((r) => r.token === "tok_over") as Record<string, unknown>).follow_up_requested_at).toBeNull();
  });

  it("mails one recipient at most the daily cap across qualifications and callers", async () => {
    for (let i = 0; i < RATE_POLICIES.mail_recipient.limit + 3; i++) {
      seed(`tok_${i}`);
      expect((await ask(`tok_${i}`, VICTIM, `203.0.113.${120 + i}`)).status).toBe(200);
    }
    expect(toVictim()).toHaveLength(RATE_POLICIES.mail_recipient.limit);
  });
});
