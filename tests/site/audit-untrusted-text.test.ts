/**
 * POST /api/audit is open (an IP limit, no account) and what it receives is text an anonymous caller typed.
 *
 *  - S6: the Slack ping for a hot lead put that text into Slack's `text` field unescaped, where `<!channel>` pings everyone and
 *    `<https://evil.example|Approve invoice>` renders as a link labelled by the caller. Slack documents `&`, `<` and `>` as the
 *    characters to escape; a mention that begins a word is neutralised too.
 *  - S4: the confirmation mail told the lead their information is "held in strict confidence" while the same submission is
 *    also read by the team, may be posted to Slack and, when form forwarding is enabled, goes to Formspree. It now says what is true.
 *  - The privacy page lists Formspree, conditionally, the way it describes Slack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { plainLine, slackSafe } from "@/lib/untrusted-text";

let slack: { text: string }[] = [];
let mail: { to: string[]; subject: string; text: string; html?: string }[] = [];
let formspree: Record<string, unknown>[] = [];
let original: typeof fetch;

beforeEach(() => {
  resetMemoryLimiter();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.FORMSPREE_FORWARD_ID;
  delete process.env.NEXT_PUBLIC_FORMSPREE_ID;
  delete process.env.VERCEL;
  delete process.env.GRIDFORGE_TRUSTED_IP_HEADER;
  process.env.RESEND_API_KEY = "test_key";
  process.env.LEAD_TO_EMAIL = "sales@timetopower.ai";
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/T/B/x";
  slack = [];
  mail = [];
  formspree = [];
  original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://hooks.slack.test")) {
      slack.push(JSON.parse(String(init?.body)));
      return new Response("ok");
    }
    if (url.startsWith("https://api.resend.com")) {
      mail.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "e1" }), { status: 200 });
    }
    if (url.startsWith("https://formspree.io")) {
      formspree.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

const HOT = {
  capacity: "150 MW", location: "Frankfurt", urgency: "immediate", gridStatus: "in_queue",
  services: ["Not sure yet — need a recommendation"], message: "ten chars minimum", name: "Mallory",
  company: "Acme", email: "m@evil.example",
};
async function post(over: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/audit/route");
  return POST(new Request(siteUrl("/api/audit"), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify({ ...HOT, ...over }) }));
}

describe("the Slack ping built from an anonymous submission", () => {
  it("does not let caller text become a Slack control sequence, a mention or a labelled link", async () => {
    const res = await post({
      company: "<!channel> <https://evil.example/pay|Approve invoice> @here @everyone",
      location: "<@U12345> & <!subteam^S1|admins>",
      capacity: "150 MW <!everyone>",
    });
    expect(res.status).toBe(200);
    expect(slack).toHaveLength(1);
    const text = slack[0].text;
    // Slack's own control characters appear only where WE put them: none of the caller's `<` or `>` survives unescaped.
    expect(text).not.toMatch(/<[!@#]/);
    expect(text).not.toContain("<https://");
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&amp;");
    // A word-initial @ cannot be a mention.
    expect(text).not.toMatch(/(^|[^\w.+-])@(here|channel|everyone)/i);
    // It is still a readable HOT-lead notice for the people who must act on it.
    expect(text).toContain("HOT lead");
    expect(text).toContain("m@evil.example");
  });

  it("a normal lead reads as it did: company, capacity, email and location", async () => {
    await post({ company: "Hall Co", location: "Dublin, IE" });
    expect(slack[0].text).toContain("Hall Co (150 MW)");
    expect(slack[0].text).toContain("m@evil.example · Dublin, IE");
  });

  it("slackSafe and plainLine are inert for ordinary text and strict for hostile text", () => {
    expect(slackSafe("Acme & Sons <Ltd>")).toBe("Acme &amp; Sons &lt;Ltd&gt;");
    expect(slackSafe("a@b.example")).toBe("a@b.example");
    expect(slackSafe("@channel hi")).not.toMatch(/^@/);
    expect(plainLine("line one\r\nBcc: x@y.example‮")).toBe("line one Bcc: x@y.example");
    expect(plainLine("see https://evil.example/x and www.evil.example")).toBe("see https[://]evil.example/x and www[.]evil.example");
    expect(plainLine("x".repeat(500), 50)).toHaveLength(50);
  });
});

describe("the confirmation mail to the address the form was submitted with", () => {
  it("echoes nothing the caller typed and makes no claim of strict confidence", async () => {
    await post({ company: "Zed Corp", location: "Zedville", message: "Please wire funds to https://evil.example/pay now" });
    const toLead = mail.find((m) => m.to[0] === "m@evil.example");
    expect(toLead).toBeTruthy();
    expect(toLead!.html).toBeUndefined();
    const all = `${toLead!.subject}\n${toLead!.text}`;
    for (const typed of ["Zed Corp", "Zedville", "evil.example/pay", "Mallory"]) expect(all).not.toContain(typed);
    expect(all.toLowerCase()).not.toContain("strict confidence");
    expect(all).not.toMatch(/confiden/i);
    // What is true: the team reads it, and it is shared only with the processors on the privacy page.
    expect(all).toMatch(/read by (the|our) team/i);
    expect(all).toContain(siteUrl("/legal/privacy"));
    expect(all).toMatch(/only with the (service providers|processors)/i);
  });

  it("the desk copy has a one-line subject even when the company name carries a line break", async () => {
    await post({ company: "Zed\r\nBcc: someone@else.example" });
    const toDesk = mail.find((m) => m.to[0] === "sales@timetopower.ai");
    expect(toDesk).toBeTruthy();
    expect(toDesk!.subject).not.toMatch(/[\r\n]/);
  });
});

describe("the privacy page", () => {
  const page = readFileSync(path.join(process.cwd(), "app/legal/privacy/page.tsx"), "utf8");

  it("lists Formspree as a processor of audit-form submissions, and only when forwarding is enabled", () => {
    expect(page).toMatch(/name:\s*"Formspree"/);
    expect(page).toMatch(/only when|if an operator|when an operator/i);
    const entry = page.slice(page.indexOf('name: "Formspree"'), page.indexOf('name: "Formspree"') + 900);
    for (const field of ["name", "company", "email", "message"]) expect(entry).toContain(field);
    // It states no retention period or storage location it cannot establish from the code.
    expect(entry).not.toMatch(/\b(retain|retention|deleted after|stored in|EU|US|GDPR)\b/);
  });

  it("the audit route forwards to Formspree only when an id is configured (so the conditional wording is accurate)", async () => {
    await post();
    expect(formspree).toHaveLength(0);
    process.env.FORMSPREE_FORWARD_ID = "abc123";
    await post({ email: "n2@evil.example" });
    expect(formspree).toHaveLength(1);
    expect(Object.keys(formspree[0])).toEqual(expect.arrayContaining(["name", "company", "email", "message"]));
  });
});
