/**
 * GET /api/engagements matches the buyer's purchases on the VERIFIED session address. The Stripe webhook stores the address exactly
 * as the buyer typed it at checkout (`Jane.Doe@Acme.com`), the column is plain text and a PostgREST `eq` is case-sensitive, so the
 * lower-cased session address never matched and a paying buyer saw "no purchases" on /dashboard.
 *
 * The fix narrows the fetch case-insensitively (the ilike lib/deliverables.ts uses for credits, wildcards neutralised) and then
 * decides identity in code on the exact normalised address, so a wildcard in an address can never widen what a buyer is shown.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { bearerFor, installWithAuth } from "./auth-fake";

let db: PostgrestFake;
let restore: () => void;

const deliverable = (token: string, email: string | null) => ({
  token, intake_token: `intake_${token}`, kind: "density_screen", status: "awaiting_intake", title: null, amount_cents: 450000,
  email, created_at: "2026-11-01T00:00:00Z", released_at: null,
});
const watch = (token: string, email: string | null) => ({
  token, status: "active", cadence: "quarterly", site_name: "North", hall_id: "H1", email, created_at: "2026-11-01T00:00:00Z",
  last_run_at: null, next_run_at: null,
});

beforeEach(() => {
  resetMemoryLimiter();
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["deliverables", "watches"]);
  restore = installWithAuth(db).restore;
});
afterEach(() => restore());

async function engagementsFor(sessionEmail: string) {
  const { GET } = await import("@/app/api/engagements/route");
  const res = await GET(new Request(siteUrl("/api/engagements"), { headers: bearerFor(sessionEmail) }));
  return { status: res.status, body: (await res.json()) as { engagements: { documentToken: string | null; intakeToken: string | null }[]; watches: { token: string | null }[] } };
}

describe("a purchase stored with the buyer's capitalised address", () => {
  beforeEach(() => {
    db.seed("deliverables", [deliverable("doc_jane", "Jane.Doe@Acme.com")]);
    db.seed("watches", [watch("watch_jane", "Jane.Doe@Acme.com")]);
  });

  it("is found by the verified session address in lower case", async () => {
    const { status, body } = await engagementsFor("jane.doe@acme.com");
    expect(status).toBe(200);
    expect(body.engagements).toHaveLength(1);
    expect(body.engagements[0].intakeToken).toBe("intake_doc_jane");
    expect(body.watches).toHaveLength(1);
    expect(body.watches[0].token).toBe("watch_jane");
  });

  it("is found by a session whose address is capitalised the same way", async () => {
    const { body } = await engagementsFor("Jane.Doe@Acme.com");
    expect(body.engagements).toHaveLength(1);
    expect(body.watches).toHaveLength(1);
  });

  it("does not return the stored address spelling", async () => {
    const { body } = await engagementsFor("jane.doe@acme.com");
    // (The response names the session's own normalised address; what must not appear is the row's stored spelling.)
    expect(JSON.stringify(body)).not.toContain("Jane.Doe@Acme.com");
  });
});

describe("every response of the route is private to the caller (it carries document, intake and watch tokens)", () => {
  const expectPrivate = (res: Response, what: string) => {
    expect(res.headers.get("cache-control"), what).toMatch(/no-store/);
    expect(res.headers.get("referrer-policy"), what).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag"), what).toMatch(/noindex/);
  };
  const get = async (headers: Record<string, string>) => (await import("@/app/api/engagements/route")).GET(new Request(siteUrl("/api/engagements"), { headers }));

  it("the answer that carries tokens: no-store, no-referrer, noindex", async () => {
    db.seed("deliverables", [deliverable("doc_jane", "Jane.Doe@Acme.com")]);
    const res = await get(bearerFor("jane.doe@acme.com"));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.clone().json())).toContain("intake_doc_jane");
    expectPrivate(res, "200");
  });

  it("an empty answer, a refusal and an outage carry them too (nothing about the account is cacheable)", async () => {
    expectPrivate(await get(bearerFor("nobody@acme.com")), "empty list");
    const noSession = await get({});
    expect(noSession.status).toBe(401);
    expectPrivate(noSession, "401");
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const down = await get(bearerFor("jane.doe@acme.com"));
    expect(down.status).toBe(503);
    expectPrivate(down, "503");
  });
});

/**
 * KNOWN LIMITATION, pinned in its safe direction. The fetch is narrowed with PostgREST `ilike`, whose case folding is the DATABASE's (its collation
 * or ICU rules, per character), while identity is decided in code with JavaScript's `toLowerCase()`. For ASCII addresses they agree. For some
 * non-ASCII letters they do not (a dotted capital İ, a capital ß, final sigma, Turkish and Lithuanian rules), and then:
 *
 *   - the database folds LESS than JS: the buyer's own row is not returned by the narrowing query, so it is never seen here, and the buyer sees
 *     "no purchases" for it (a false negative; /dashboard cannot tell this from an empty account, and the buyer is told to write in);
 *   - the database folds MORE than JS (it returns a look-alike address): the exact comparison below drops it.
 *
 * The first is a lost row; the second is nothing at all. Neither can show a row to a person whose normalised address is not the row's, which is
 * the only direction that matters (a leak would be another buyer's document and intake tokens). These tests fix that direction. They do not fix
 * the false negative: matching non-ASCII addresses exactly would need the address stored normalised (a migration), which is not done here.
 */
describe("non-ASCII addresses: the case-folding mismatch can lose a row, never leak one", () => {
  let wrapped: typeof fetch;
  let below: typeof fetch;
  const SESSION = "ünal.isik@acme.com"; // what Supabase Auth hands us, lower-cased in code (normalisedEmail)

  /** The database answers these rows to the deliverables / watches queries, whatever the query asked: a database that folds as it likes. */
  const databaseReturns = (deliverables: unknown[], watches: unknown[]) => {
    below = globalThis.fetch;
    wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/rest/v1/deliverables?")) return new Response(JSON.stringify(deliverables), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/rest/v1/watches?")) return new Response(JSON.stringify(watches), { status: 200, headers: { "content-type": "application/json" } });
      return below(input as RequestInfo, init);
    }) as typeof fetch;
    globalThis.fetch = wrapped;
  };
  afterEach(() => {
    if (below) globalThis.fetch = below;
  });

  it("JS and the database fold these differently (the premise: they really do)", () => {
    expect("İSTANBUL@acme.com".toLowerCase()).not.toBe("istanbul@acme.com"); // JS keeps the combining dot a Turkish collation would drop
    expect("STRASSE@acme.com".toLowerCase()).not.toBe("straße@acme.com"); // a collation with full case folding conflates them; JS does not
    expect("ÜNAL.İSIK@acme.com".toLowerCase()).not.toBe(SESSION); // the look-alike used below
    expect("ÜNAL.ISIK@ACME.COM".toLowerCase()).toBe(SESSION); // and where they agree, the exact comparison is satisfied
  });

  it("a database that folds MORE than JS and returns look-alikes: they are dropped, only exact normalised matches are shown", async () => {
    databaseReturns(
      [
        deliverable("doc_mine_upper", "ÜNAL.ISIK@ACME.COM"), // JS-normalises to the session address: shown
        deliverable("doc_mine_lower", "ünal.isik@acme.com"), // shown
        deliverable("doc_dotted_i", "ÜNAL.İSIK@acme.com"), // a look-alike a Turkish collation folds onto the session address (İ -> i): not the same address in JS
        deliverable("doc_other", "ünal.isak@acme.com"), // a neighbour: not shown
        deliverable("doc_null", null), // no address at all: not shown
      ],
      [watch("watch_mine", "ÜNAL.ISIK@Acme.com"), watch("watch_dotted", "ÜNAL.İSIK@acme.com"), watch("watch_other", "someone.else@acme.com")],
    );
    const { status, body } = await engagementsFor(SESSION);
    expect(status).toBe(200);
    expect(body.engagements.map((e) => e.intakeToken).sort()).toEqual(["intake_doc_mine_lower", "intake_doc_mine_upper"]);
    expect(body.watches.map((w) => w.token)).toEqual(["watch_mine"]);
    const all = JSON.stringify(body);
    for (const leaked of ["doc_dotted_i", "doc_other", "doc_null", "watch_dotted", "watch_other"]) expect(all, leaked).not.toContain(leaked);
  });

  it("a database that folds LESS than JS does not return the buyer's own capitalised row: the buyer sees nothing (the false negative), and no other buyer's row takes its place", async () => {
    // The narrowing query came back without the row stored as "ÜNAL.ISIK@Acme.com" (an ASCII-only fold), and with another buyer's row that it matched.
    databaseReturns([deliverable("doc_another_buyer", "another@acme.com")], [watch("watch_another_buyer", "another@acme.com")]);
    const { status, body } = await engagementsFor(SESSION);
    expect(status).toBe(200);
    expect(body.engagements).toEqual([]);
    expect(body.watches).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/doc_another_buyer|watch_another_buyer|intake_doc/);
  });

  it("the post-filter is the exact normalised comparison, and the route says why in a comment", async () => {
    const src = (await import("node:fs")).readFileSync("app/api/engagements/route.ts", "utf8");
    expect(src).toMatch(/normalisedEmail\(r\.email\) === mine/);
    expect(src).toMatch(/KNOWN LIMITATION[\s\S]{0,1200}non-ASCII/);
    expect(src).toMatch(/never a leak|never shows a row/i);
  });
});

describe("what a case-insensitive match must never widen to", () => {
  it("another buyer's rows never appear", async () => {
    db.seed("deliverables", [deliverable("doc_jane", "Jane.Doe@Acme.com"), deliverable("doc_other", "someone.else@acme.com")]);
    db.seed("watches", [watch("watch_jane", "Jane.Doe@Acme.com"), watch("watch_other", "someone.else@acme.com")]);
    const { body } = await engagementsFor("jane.doe@acme.com");
    expect(body.engagements.map((e) => e.intakeToken)).toEqual(["intake_doc_jane"]);
    expect(body.watches.map((w) => w.token)).toEqual(["watch_jane"]);
  });

  it("an address that differs only where the session address has `_` or `%` is not matched", async () => {
    db.seed("deliverables", [deliverable("doc_wild", "jane_doe@acme.com"), deliverable("doc_decoy", "janeXdoe@acme.com"), deliverable("doc_pct", "jane%doe@acme.com")]);
    db.seed("watches", [watch("watch_wild", "jane_doe@acme.com"), watch("watch_decoy", "janeXdoe@acme.com")]);
    // `_` in the buyer's own address: their row is found, the look-alike is not.
    const a = await engagementsFor("jane_doe@acme.com");
    expect(a.body.engagements.map((e) => e.intakeToken)).toEqual(["intake_doc_wild"]);
    expect(a.body.watches.map((w) => w.token)).toEqual(["watch_wild"]);
    // `%` in the session address must not behave as "anything".
    const b = await engagementsFor("jane%doe@acme.com");
    expect(b.body.engagements.map((e) => e.intakeToken)).toEqual(["intake_doc_pct"]);
    expect(b.body.watches).toHaveLength(0);
  });

  it("a `%` or `*` prefix in a session address cannot be used to list other buyers' purchases", async () => {
    db.seed("deliverables", [deliverable("doc_jane", "Jane.Doe@Acme.com"), deliverable("doc_other", "someone.else@acme.com")]);
    for (const attacker of ["%@acme.com", "*@acme.com", "_%@acme.com", "%"]) {
      const { body } = await engagementsFor(attacker);
      expect(body.engagements ?? []).toHaveLength(0);
    }
  });
});
