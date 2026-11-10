/**
 * Review finding 4: the free allowance's monthly ceiling (200 VERIFIED accounts site-wide) was a shared denial-of-service lever. Anyone who
 * controls a catch-all domain owns unlimited inboxes (u1@evil.example, u2@evil.example, ...) and, because `normaliseFreeEmail` only folds Gmail dots and
 * "+tag", each is a distinct "person": a script could verify 200 of them and leave every real visitor with "the free allowance is full this month".
 *
 * Now a NON-free-mail domain (and its sub-domains) may have at most freeAccountsMaxPerDomain() VERIFIED free accounts in a UTC month; a named list of common
 * free-mail providers is exempt (one provider hosts millions of unrelated people). Enforced atomically with the site-wide ceiling at the moment the key is
 * first minted (gf_free_account_verify_capped, migration 0055; SQL proven on PostgreSQL in free-domain-cap.realdb.test.ts), refused with the honest
 * 'capacity'-style 429, and the operator is told when a domain passes 80% of its cap.
 *
 * LIMITS, stated honestly: this bounds what ONE domain (and its sub-domains) can take; it does not stop an attacker who owns MANY domains (each costs them
 * money, and the site-wide ceiling still bounds the total), nor one who uses disposable-mail domains (each its own domain). A free-mail address is not
 * limited per provider. The sub-domain grouping is a heuristic (the last two labels, three under a short list of two-part suffixes such as co.uk), not the
 * Public Suffix List.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import {
  FREE_MAIL_DOMAINS,
  FREE_ACCOUNTS_MAX_PER_DOMAIN_DEFAULT,
  freeAccountsMax,
  freeAccountsMaxPerDomain,
  freeDomainCap,
  freeDomainKey,
} from "@/lib/payg";
import { MockStripe, mockEngine, newPaygDb, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder",
    GRIDFORGE_KEY_SECRET: "test-signing-secret", RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test",
    LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>",
  });
  delete process.env.GRIDFORGE_FREE_ACCOUNTS_MAX;
  delete process.env.GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetMemoryLimiter();
  db = newPaygDb();
  restore = db.install();
  mail = [];
  engine = mockEngine(mail);
  setPaygStripeForTests(new MockStripe());
});
afterEach(() => { setPaygStripeForTests(null); engine.restore(); restore(); vi.restoreAllMocks(); delete process.env.GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN; });

let ipn = 0;
const post = (path: string, body: unknown) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.3.${Math.floor(++ipn / 250)}.${(ipn % 250) + 1}` }, body: JSON.stringify(body) });
const accounts = () => db.rows("api_accounts") as any[];
const signUp = async (email: string) => (await import("@/app/api/free-account/route")).POST(post("/api/free-account", { email }));
const accountOf = (email: string) => accounts().find((a) => a.email === email.toLowerCase());
const mint = async (email: string, extra: Record<string, unknown> = {}) => (await import("@/app/api/keys/route")).POST(post("/api/keys", { token: accountOf(email).token, ...extra }));
const warnings = () => warn.mock.calls.map((c) => c.map(String).join(" "));

describe("the policy", () => {
  it("the default per-domain cap is stated, and the env var overrides it only with a sensible integer", () => {
    expect(FREE_ACCOUNTS_MAX_PER_DOMAIN_DEFAULT).toBe(25);
    expect(freeAccountsMaxPerDomain({} as NodeJS.ProcessEnv)).toBe(25);
    expect(freeAccountsMaxPerDomain({ GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN: "3" } as unknown as NodeJS.ProcessEnv)).toBe(3);
    for (const bad of ["0", "-1", "lots", "", "1.5", "1000000", " "]) {
      expect(freeAccountsMaxPerDomain({ GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN: bad } as unknown as NodeJS.ProcessEnv), bad).toBe(25);
    }
    expect(FREE_ACCOUNTS_MAX_PER_DOMAIN_DEFAULT).toBeLessThan(freeAccountsMax({} as NodeJS.ProcessEnv)); // a domain can never be the whole site ceiling
  });

  it("the free-mail list is named and covers the common providers", () => {
    for (const d of ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com", "gmx.de", "web.de", "aol.com", "mail.ru", "qq.com", "yahoo.co.uk"]) {
      expect(FREE_MAIL_DOMAINS.has(d), d).toBe(true);
    }
    expect(FREE_MAIL_DOMAINS.has("evil.example")).toBe(false);
  });

  it("a domain's key groups its sub-domains (a wildcard catch-all cannot mint a fresh domain per account) and respects two-part suffixes", () => {
    expect(freeDomainKey("evil.example")).toBe("evil.example");
    expect(freeDomainKey("a.evil.example")).toBe("evil.example");
    expect(freeDomainKey("x.y.z.evil.example")).toBe("evil.example");
    expect(freeDomainKey("evil.co.uk")).toBe("evil.co.uk");
    expect(freeDomainKey("mail.evil.co.uk")).toBe("evil.co.uk");
    expect(freeDomainKey("evil.com.au")).toBe("evil.com.au");
    expect(freeDomainKey("sub.evil.com.au")).toBe("evil.com.au");
  });

  it("freeDomainCap: free-mail (any spelling of the address) is exempt; everything else gets the cap and the domain key", () => {
    for (const e of ["a@gmail.com", "A.B+tag@Gmail.com", "x@googlemail.com", "y@outlook.com", "z@yahoo.co.uk"]) expect(freeDomainCap(e), e).toBeNull();
    expect(freeDomainCap("u1@evil.example")).toEqual({ key: "evil.example", max: 25 });
    expect(freeDomainCap("u1@a.b.evil.example")).toEqual({ key: "evil.example", max: 25 });
    expect(freeDomainCap("u1@evil.example", { GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN: "2" } as unknown as NodeJS.ProcessEnv)).toEqual({ key: "evil.example", max: 2 });
    expect(freeDomainCap("not an email")).toBeNull(); // nothing to key on; the address is refused elsewhere
    expect(freeDomainCap(null)).toBeNull();
  });
});

describe("the free-mail exemption is the EXACT domain only", () => {
  it("a sub-domain of a listed provider is capped (x@y.fastmail.com, x@anything.gmail.com); the provider's own address is exempt", () => {
    for (const e of ["x@y.fastmail.com", "x@anything.gmail.com", "x@a.b.outlook.com", "x@mail.yahoo.co.uk", "x@evil.protonmail.ch", "x@my.web.de"]) {
      const cap = freeDomainCap(e);
      expect(cap, e).not.toBeNull();
      expect(cap!.max).toBe(25);
    }
    expect(freeDomainCap("x@y.fastmail.com")!.key).toBe("fastmail.com");
    expect(freeDomainCap("x@anything.gmail.com")!.key).toBe("gmail.com");
    for (const e of ["a@gmail.com", "a@fastmail.com", "a@outlook.com", "a@yahoo.co.uk", "a@protonmail.ch", "a@web.de"]) expect(freeDomainCap(e), e).toBeNull();
  });

  it("through the route: a catch-all at <anything>.gmail.com is capped, while real gmail.com users keep minting past the cap", async () => {
    process.env.GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN = "2";
    for (const e of ["a@x.gmail.com", "b@y.gmail.com", "c@z.gmail.com", "r1@gmail.com", "r2@gmail.com", "r3@gmail.com"]) await signUp(e);
    expect((await mint("a@x.gmail.com")).status).toBe(200);
    expect((await mint("b@y.gmail.com")).status).toBe(200);
    expect(await (await mint("c@z.gmail.com")).json()).toMatchObject({ reason: "domain_capacity" }); // one cap for gmail.com and every sub-domain of it
    for (const e of ["r1@gmail.com", "r2@gmail.com", "r3@gmail.com"]) expect((await mint(e)).status, e).toBe(200);
  });
});

describe("country variants of large providers are on the list (exact entries)", () => {
  it("yahoo.in, yahoo.com.au, outlook.com.br, protonmail.ch, mailbox.org and the other named families are exempt; there are no wildcards", () => {
    for (const d of ["yahoo.in", "yahoo.com.au", "outlook.com.br", "protonmail.ch", "mailbox.org", "hotmail.com.br", "live.com.au", "msn.co.uk", "gmx.co.uk", "zoho.eu",
                     "icloud.com", "me.com", "mac.com", "yandex.by", "mail.ru", "qq.com", "163.com", "126.com"]) {
      expect(FREE_MAIL_DOMAINS.has(d), d).toBe(true);
      expect(freeDomainCap(`someone@${d}`), d).toBeNull();
    }
    for (const d of FREE_MAIL_DOMAINS) expect(d, d).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/); // exact names: no "*", no leading dot
  });
});

describe("the catch-all-domain attack", () => {
  const CAP = 3;
  beforeEach(() => { process.env.GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN = String(CAP); });

  it("a catch-all domain verifies at most CAP accounts in a month, however many inboxes it controls; real visitors elsewhere still get theirs", async () => {
    const attacker = Array.from({ length: 8 }, (_, i) => `u${i + 1}@evil.example`);
    for (const e of [...attacker, "w1@wild.evil.example", "w2@other.evil.example"]) expect((await signUp(e)).status).toBe(200); // sign-up never reveals a cap
    for (const e of ["real.person@acme-corp.example", "other.person@university.example", "g1@gmail.com", "g2@gmail.com", "g3@gmail.com", "g4@gmail.com", "g5@gmail.com"]) await signUp(e);

    const results: number[] = [];
    for (const e of [...attacker, "w1@wild.evil.example", "w2@other.evil.example"]) results.push((await mint(e)).status);
    expect(results.filter((s) => s === 200)).toHaveLength(CAP); // the first CAP only; sub-domains of evil.example count towards the same cap
    expect(new Set(results.filter((s) => s !== 200))).toEqual(new Set([429]));
    expect(accounts().filter((a) => /evil\.example$/.test(a.email) && a.free_verified_at)).toHaveLength(CAP);

    // everyone else is unaffected -- including FIVE gmail users, more than the per-domain cap, because free-mail is exempt
    for (const e of ["real.person@acme-corp.example", "other.person@university.example", "g1@gmail.com", "g2@gmail.com", "g3@gmail.com", "g4@gmail.com", "g5@gmail.com"]) {
      expect((await mint(e)).status, e).toBe(200);
    }
  });

  it("the refusal is the honest 'capacity' style: 429, names the DOMAIN-level limit, says nothing was created or charged, and leaks nobody else", async () => {
    for (let i = 1; i <= CAP + 1; i++) await signUp(`u${i}@evil.example`);
    for (let i = 1; i <= CAP; i++) expect((await mint(`u${i}@evil.example`)).status).toBe(200);
    const res = await mint(`u${CAP + 1}@evil.example`);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: "domain_capacity" });
    expect(body.error).toMatch(/email domain/i);
    expect(body.error).toMatch(new RegExp(`${CAP} `));
    expect(body.error).toMatch(/nothing was created for you and nothing is charged/);
    expect(body.error).toMatch(/next month \(UTC\)/);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/u[1-3]@|@evil|evil\.example/); // no other user's address, and no count of how many exist
    expect(text).not.toMatch(/gfk1/); // no key
    const refused = accountOf(`u${CAP + 1}@evil.example`);
    expect(refused.key_id).toBeNull();
    expect(refused.free_verified_at).toBeNull();
  });

  it("an account that was already verified is never turned away, and rotating its key does not count it twice", async () => {
    for (let i = 1; i <= CAP + 1; i++) await signUp(`u${i}@evil.example`);
    for (let i = 1; i <= CAP; i++) await mint(`u${i}@evil.example`);
    expect((await mint("u1@evil.example", { rotate: true })).status).toBe(200);
    expect(accounts().filter((a) => a.free_verified_at && /evil/.test(a.email))).toHaveLength(CAP);
    expect((await mint(`u${CAP + 1}@evil.example`)).status).toBe(429); // still full
  });

  it("the cap is per UTC month, like the site ceiling: it reopens when the month turns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
    for (let i = 1; i <= CAP + 1; i++) await signUp(`u${i}@evil.example`);
    for (let i = 1; i <= CAP; i++) await mint(`u${i}@evil.example`);
    expect((await mint(`u${CAP + 1}@evil.example`)).status).toBe(429);
    vi.setSystemTime(new Date("2026-12-01T00:30:00Z"));
    expect((await mint(`u${CAP + 1}@evil.example`)).status).toBe(200);
  });

  it("when BOTH the site ceiling and the domain cap are used up, the answer is the site-wide 'capacity' (the broader truth)", async () => {
    process.env.GRIDFORGE_FREE_ACCOUNTS_MAX = "1";
    await signUp("u1@evil.example");
    await signUp("u2@evil.example");
    process.env.GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN = "1";
    expect((await mint("u1@evil.example")).status).toBe(200);
    expect(await (await mint("u2@evil.example")).json()).toMatchObject({ reason: "capacity" });
  });

  it("the site-wide ceiling still applies to free-mail and to every domain (unchanged)", async () => {
    process.env.GRIDFORGE_FREE_ACCOUNTS_MAX = "2";
    for (const e of ["a@gmail.com", "b@gmail.com", "c@gmail.com"]) await signUp(e);
    expect((await mint("a@gmail.com")).status).toBe(200);
    expect((await mint("b@gmail.com")).status).toBe(200);
    expect(await (await mint("c@gmail.com")).json()).toMatchObject({ reason: "capacity" });
  });
});

describe("the 80% warning", () => {
  it("is one console.warn line when a domain's verifications reach 80% of its cap -- the domain only, never an address -- and not again", async () => {
    process.env.GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN = "10";
    for (let i = 1; i <= 10; i++) await signUp(`secret.person${i}@evil.example`);
    for (let i = 1; i <= 7; i++) await mint(`secret.person${i}@evil.example`);
    expect(warnings().filter((w) => /evil\.example/.test(w))).toHaveLength(0); // 7 of 10: below 80%
    await mint("secret.person8@evil.example"); // the 8th = 80%
    const lines = warnings().filter((w) => /evil\.example/.test(w));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[GridForge\]/);
    expect(lines[0]).toMatch(/80%/);
    expect(lines[0]).toMatch(/8 of 10/);
    expect(lines[0]).not.toMatch(/@|secret\.person/); // no address, no local part
    await mint("secret.person9@evil.example");
    await mint("secret.person10@evil.example");
    expect(warnings().filter((w) => /evil\.example/.test(w))).toHaveLength(1); // once per crossing, not per account
  });

  it("is silent for free-mail domains, and for a domain under 80%", async () => {
    process.env.GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN = "2";
    for (const e of ["a@gmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com"]) { await signUp(e); await mint(e); }
    expect(warnings().filter((w) => /gmail/.test(w))).toHaveLength(0);
  });
});
