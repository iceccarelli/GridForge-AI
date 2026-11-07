/**
 * A stored contact enquiry must not be silent. After a SUCCESSFUL store the route calls the once-per-day operator-notice helper with the
 * category `contact_enquiry` and a body that names nothing the visitor wrote. The notice is best effort: it can never turn a stored lead into
 * an error, and nothing about the lead reaches a log. A failed store keeps its existing 503 and sends no "stored" notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { newPaygDb } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

const notify = vi.hoisted(() => ({ calls: [] as unknown[][], impl: null as null | ((...a: unknown[]) => Promise<string>) }));
vi.mock("@/lib/payg-operator", async (orig) => {
  const real = await orig<typeof import("@/lib/payg-operator")>();
  return { ...real, notifyOperatorOnce: async (...a: unknown[]) => { notify.calls.push(a); return notify.impl ? notify.impl(...a) : "sent"; } };
});

const PII = { name: "Ada Quillfeather", email: "ada.quillfeather@hallco-private.example", company: "Hallco Private Holdings", message: "Secret plan: our 48 MW hall in Frankfurt" };
let db: PostgrestFake;
let restoreDb: () => void;
let logs: string[];
let realFetch: typeof fetch;
let failStore = false;

beforeEach(() => {
  Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" });
  resetMemoryLimiter();
  notify.calls = []; notify.impl = null; failStore = false;
  db = newPaygDb();
  restoreDb = db.install();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (failStore && url.includes("/rest/v1/leads") && init?.method === "POST") return new Response("{}", { status: 500 });
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  logs = [];
  for (const m of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
});
afterEach(() => { globalThis.fetch = realFetch; restoreDb(); vi.restoreAllMocks(); });

let n = 0;
const post = () => new Request(siteUrl("/api/contact"), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.6.${Math.floor(++n / 250)}.${(n % 250) + 1}` }, body: JSON.stringify({ ...PII, mw: "48", urgency: "exploratory", hp_contact_ref: "" }) });
const route = () => import("@/app/api/contact/route");
const leaked = (s: string) => /Quillfeather|hallco-private|Hallco|Frankfurt|Secret plan/.test(s);

describe("the operator is told when an enquiry is stored", () => {
  it("a successful store makes exactly one notice call: the contact_enquiry category, the leads view, an opaque reference, and none of the enquiry", async () => {
    const res = await (await route()).POST(post());
    expect(res.status).toBe(200);
    expect(notify.calls).toHaveLength(1);
    const [key, subject, text] = notify.calls[0] as string[];
    expect(key).toMatch(/^contact_enquiry:\d{4}-\d{2}-\d{2}$/);
    expect(subject).toBe("A contact enquiry was stored");
    expect(text).toMatch(/admin leads view/);
    expect(text).toMatch(/reference [a-f0-9]{8}\b/);
    expect(leaked(JSON.stringify(notify.calls))).toBe(false);
  });
  it("a second enquiry the same day still calls the helper (it dedupes internally), and nothing breaks", async () => {
    const { POST } = await route();
    expect((await POST(post())).status).toBe(200);
    expect((await POST(post())).status).toBe(200);
    expect(notify.calls).toHaveLength(2);
    expect(notify.calls[0][0]).toBe(notify.calls[1][0]);
    expect((db.rows("leads") as unknown[]).length).toBe(2);
  });
  it("the helper throwing, or reporting the mail unsent, leaves the stored lead a success and logs nothing about it", async () => {
    for (const impl of [async () => { throw new Error(`boom for ${PII.email}`); }, async () => "unsent"]) {
      notify.impl = impl as never;
      const res = await (await route()).POST(post());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(leaked(logs.join("\n"))).toBe(false);
    expect(logs.join("\n")).not.toContain(PII.email);
    expect((db.rows("leads") as unknown[]).length).toBe(2);
  });
  it("a failed store keeps its 503 and sends no 'stored' notice (only the existing lost-lead one, which has a different key)", async () => {
    failStore = true;
    const res = await (await route()).POST(post());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not saved/);
    expect(notify.calls.some((c) => String(c[0]).startsWith("contact_enquiry"))).toBe(false);
    expect(notify.calls.every((c) => String(c[0]).startsWith("lead_store_fault:contact-form:"))).toBe(true);
    expect(leaked(JSON.stringify(notify.calls) + logs.join("\n"))).toBe(false);
  });
});
