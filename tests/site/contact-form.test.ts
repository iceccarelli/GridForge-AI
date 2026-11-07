/**
 * POST /api/contact and the form on /contact. A visitor who would rather not open a mail client writes name, work address, company and what
 * the hall/problem is (and, optionally, megawatts). The enquiry is stored through the SAME path the scoping assistant's lead capture uses
 * (lib/lead-store.ts: the existing `leads` table and columns, no migration), and:
 *   - the body is capped and validated, the caller rate-limited, a hidden honeypot field silently swallows bots;
 *   - the visitor is told plainly whether it was saved, and the mailto stays as the fallback;
 *   - nothing the visitor wrote reaches a log line, and NO email is sent to them (the operator notice: tests/site/contact-operator-notice.test.ts).
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl, SITE } from "@/lib/site";
import { RATE_POLICIES, resetMemoryLimiter } from "@/lib/rate-limit";
import { newPaygDb } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

const PII = { name: "Ada Quillfeather", email: "ada.quillfeather@hallco-private.example", company: "Hallco Private Holdings", message: "We have a 48 MW hall in Frankfurt and the tap-offs are the problem" };
let db: PostgrestFake;
let restoreDb: () => void;
let logs: string[];
let outbound: string[];
let leadsMode: "pass" | "reject" | "throw";
let realFetch: typeof fetch;

beforeEach(() => {
  Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" });
  process.env.RESEND_API_KEY = "re_test";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  resetMemoryLimiter();
  db = newPaygDb();
  restoreDb = db.install();
  realFetch = globalThis.fetch;
  leadsMode = "pass";
  outbound = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    outbound.push(url);
    if (url.includes("/rest/v1/leads") && init?.method === "POST") {
      if (leadsMode === "throw") throw new TypeError(`fetch failed ${String(init.body)}`);
      if (leadsMode === "reject") return new Response(JSON.stringify({ code: "23505", details: `Key (email)=(${PII.email}) ${String(init.body)}` }), { status: 409, headers: { "content-type": "application/json" } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  logs = [];
  for (const m of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? `${x.name}:${x.message}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
});
afterEach(() => { globalThis.fetch = realFetch; restoreDb(); vi.restoreAllMocks(); });

let n = 0;
const post = (body: unknown, ip = `10.8.${Math.floor(++n / 250)}.${(n % 250) + 1}`, raw = false) =>
  new Request(siteUrl("/api/contact"), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: raw ? String(body) : JSON.stringify(body) });
const valid = (over: Record<string, unknown> = {}) => ({ ...PII, mw: "48", urgency: "90days", hp_contact_ref: "", ...over });
const route = () => import("@/app/api/contact/route");
const leads = () => db.rows("leads") as Record<string, unknown>[];

describe("a valid enquiry", () => {
  it("is stored in the existing leads table with the existing columns, and the visitor is told so without their own details being echoed", async () => {
    const res = await (await route()).POST(post(valid()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(leads()).toHaveLength(1);
    expect(leads()[0]).toMatchObject({
      name: PII.name, company: PII.company, email: PII.email, message: PII.message, capacity_mw: 48,
      context: "contact-form", source: "contact-form", status: "new", location: "Not specified",
    });
    // only columns that exist in supabase/migrations/0001_leads.sql
    const allowed = new Set(["id", "created_at", "name", "company", "email", "location", "capacity_mw", "urgency", "grid_status", "services", "message", "context", "source", "score", "tier", "reasons", "status"]);
    for (const k of Object.keys(leads()[0])) expect(allowed.has(k), k).toBe(true);
    expect(JSON.stringify(body)).not.toContain(PII.email);
  });
  it("the megawatts are optional, and an unreadable figure is refused rather than guessed", async () => {
    const { POST } = await route();
    expect((await POST(post(valid({ mw: "" })))).status).toBe(200);
    expect(leads()[0].capacity_mw).toBeNull();
    for (const mw of ["lots", "-5", "0", "100000", "NaN", "1e999"]) expect((await POST(post(valid({ mw })))).status, mw).toBe(422);
    expect((await POST(post(valid({ mw: 12.5 })))).status).toBe(200);
  });
  it("sends nothing to the visitor: the only mail is the operator's, to the owner's own address, with none of the enquiry in it", async () => {
    const sent: { to: string[]; text: string; subject: string }[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.resend.com")) { sent.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: "m1" }), { status: 200 }); }
      return inner(input as RequestInfo, init);
    }) as typeof fetch;
    await (await route()).POST(post(valid()));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["ops@example.test"]);
    expect(JSON.stringify(sent[0])).not.toMatch(/Quillfeather|hallco-private|Hallco|48 MW|Frankfurt/);
  });
  it("logs nothing about the visitor", async () => {
    await (await route()).POST(post(valid()));
    const out = logs.join("\n");
    for (const s of [PII.name, PII.email, PII.company, PII.message, "Quillfeather", "hallco-private"]) expect(out, s).not.toContain(s);
  });
});

describe("validation", () => {
  it("refuses missing or malformed fields with 422 and field-level messages, stores nothing and echoes no value back", async () => {
    const { POST } = await route();
    for (const bad of [{ name: "" }, { name: "A" }, { email: "not-an-address" }, { email: "" }, { company: "" }, { message: "short" }, { message: "x".repeat(2001) }, { name: "n".repeat(121) }, { email: `${"a".repeat(250)}@b.co` }]) {
      const res = await POST(post(valid(bad)));
      expect(res.status, JSON.stringify(bad).slice(0, 40)).toBe(422);
      const j = await res.json();
      expect(j.ok).toBe(false);
      expect(Object.keys(j.fields).length).toBeGreaterThan(0);
      expect(JSON.stringify(j)).not.toContain(PII.company);
    }
    expect(leads()).toHaveLength(0);
  });
  it("refuses a body that is not a JSON object (400), and an oversized one (413), before touching the store", async () => {
    const { POST } = await route();
    expect((await POST(post("not json", undefined, true))).status).toBe(400);
    expect((await POST(post("[1,2]", undefined, true))).status).toBe(422);
    expect((await POST(post(valid({ message: "x".repeat(20_000) })))).status).toBe(413);
    expect(leads()).toHaveLength(0);
  });
  it("ignores fields it does not know: a caller cannot set a tier, a status or a score", async () => {
    await (await route()).POST(post(valid({ tier: "hot", score: 100, status: "won", context: "x", source: "y", id: "forced" })));
    expect(leads()[0]).toMatchObject({ status: "new", context: "contact-form", source: "contact-form" });
    expect(leads()[0].id).not.toBe("forced");
    expect(leads()[0].tier).not.toBe("hot");
  });
});

describe("urgency is the visitor's own answer, one of exactly the three the table allows", () => {
  it("is stored as chosen", async () => {
    const { POST } = await route();
    for (const u of ["immediate", "90days", "exploratory"]) expect((await POST(post(valid({ urgency: u })))).status, u).toBe(200);
    expect(leads().map((l) => l.urgency)).toEqual(["immediate", "90days", "exploratory"]);
  });
  it("is required and refused when it is anything else: nothing is defaulted or invented for the visitor", async () => {
    const { POST } = await route();
    for (const u of [undefined, "", "not stated", "ASAP", "Immediate", 1, null, ["immediate"]]) {
      const res = await POST(post(valid({ urgency: u })));
      expect(res.status, JSON.stringify(u)).toBe(422);
      expect((await res.json()).fields.urgency).toBeTruthy();
    }
    expect(leads()).toHaveLength(0);
  });
});

describe("abuse", () => {
  it("a filled honeypot, whatever its type, looks like success to the bot, stores nothing and leaves ONE PII-free log line", async () => {
    const { POST } = await route();
    for (const v of ["https://spam.example", " x ", 7, 0, true, false, ["a"], { a: 1 }]) {
      logs.length = 0;
      const res = await POST(post(valid({ hp_contact_ref: v })));
      expect(res.status, JSON.stringify(v)).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(logs.filter((l) => l === "[GridForge] contact honeypot hit"), JSON.stringify(v)).toHaveLength(1);
      expect(logs.join("\n")).not.toMatch(/spam\.example|Quillfeather|hallco/);
    }
    expect(leads()).toHaveLength(0);
  });
  it("an empty honeypot (absent, null, empty or blank) is a person; the old `website` name is no longer special", async () => {
    const { POST } = await route();
    for (const v of [undefined, null, "", "   "]) expect((await POST(post(valid({ hp_contact_ref: v })))).status).toBe(200);
    expect(leads()).toHaveLength(4);
    expect((await POST(post(valid({ website: "https://x.example" })))).status).toBe(200);
    expect(leads()).toHaveLength(5);
  });
  it("is rate-limited per caller by the repo's guard: the limit+1th enquiry from one address is a 429 with Retry-After, another address is unaffected", async () => {
    const { POST } = await route();
    for (let i = 0; i < RATE_POLICIES.contact.limit; i++) expect((await POST(post(valid(), "10.99.0.1"))).status).toBe(200);
    const denied = await POST(post(valid(), "10.99.0.1"));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    expect((await POST(post(valid(), "10.99.0.2"))).status).toBe(200);
  });
  it("invalid requests do not use up the caller's allowance", async () => {
    const { POST } = await route();
    for (let i = 0; i < RATE_POLICIES.contact.limit + 3; i++) expect((await POST(post(valid({ email: "bad" }), "10.99.1.1"))).status).toBe(422);
    expect((await POST(post(valid(), "10.99.1.1"))).status).toBe(200);
  });
});

describe("when the store fails", () => {
  for (const mode of ["reject", "throw"] as const) {
    it(`store ${mode}: the visitor is told it was NOT saved (never a false success), is pointed at the email address, and nothing they wrote is logged`, async () => {
      leadsMode = mode;
      const res = await (await route()).POST(post(valid()));
      expect(res.status).toBe(503);
      const j = await res.json();
      expect(j.ok).toBe(false);
      expect(j.error).toMatch(/not (?:saved|sent)/i);
      expect(j.error).toContain(SITE.email);
      expect(j.ref).toMatch(/^[a-f0-9]{8}$/);
      expect(JSON.stringify(j)).not.toContain(PII.email);
      const out = logs.join("\n");
      for (const s of [PII.name, PII.email, PII.company, PII.message, "Quillfeather", "hallco-private"]) expect(out, s).not.toContain(s);
      expect(out).toMatch(new RegExp(`contact-form lead NOT persisted \\(ref ${j.ref}\\)`));
    });
  }
  it("a deployment with no store configured says so (503) instead of pretending", async () => {
    delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await (await route()).POST(post(valid()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain(SITE.email);
  });
});

describe("the page", () => {
  it("renders an accessible form with labelled fields, a hidden honeypot, and keeps the mailto as the visible fallback", async () => {
    const { default: Contact } = await import("@/app/contact/page");
    const html = renderToStaticMarkup(React.createElement(Contact));
    for (const id of ["contact-name", "contact-email", "contact-company", "contact-message", "contact-mw"]) {
      expect(html, id).toMatch(new RegExp(`<label[^>]*for="${id}"`));
      expect(html, id).toMatch(new RegExp(`id="${id}"`));
    }
    expect(html).toMatch(/id="contact-email"[^>]*type="email"|type="email"[^>]*id="contact-email"/);
    expect(html).toMatch(/autoComplete="email"|autocomplete="email"/i);
    expect((html.match(/required=""/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(html).toMatch(/name="hp_contact_ref"[^>]*tabindex="-1"|tabindex="-1"[^>]*name="hp_contact_ref"/);
    expect(html).toMatch(/autoComplete="off"|autocomplete="off"/i);
    expect(html).not.toMatch(/name="website"/);
    // the urgency question: a labelled select, the three allowed values with plain labels, "Just exploring" selected by default
    expect(html).toMatch(/<label[^>]*for="contact-urgency"[^>]*>How soon do you need an answer\?/);
    const sel = /<select[^>]*id="contact-urgency"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? "";
    expect([...sel.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]])).toEqual([["immediate", "As soon as possible"], ["90days", "Within about 90 days"], ["exploratory", "Just exploring"]]);
    expect(sel).toMatch(/<option value="exploratory" selected="">Just exploring/);
    expect(html).toContain(`mailto:${SITE.email}`);
    expect(html).toMatch(/<form[^>]*aria-labelledby=/);
  });
});
