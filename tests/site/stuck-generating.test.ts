/**
 * A paid engagement must never be stuck in `generating` with no way out.
 *
 * Generation runs inside ONE request (app/api/intake/[token], maxDuration 120 s) that makes several engine calls. If the
 * invocation dies (the engine cold-starts on Fly and the platform kills the function), the row stays `generating`. Before
 * this change: the customer got a permanent 409 "already being processed", admin Regenerate accepted only
 * `engine_unavailable`, Reopen only `draft`/`engine_unavailable`, and nothing swept it. A paid deliverable with no recovery.
 *
 * MOCKS: the PostgREST fake is the database and a scripted stand-in is the engine. The row is put into the state a dead
 * request leaves behind directly (status `generating`, a claim stamp that is old); what cannot be shown here is the platform
 * actually killing a function.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminToken } from "@/lib/admin";
import { siteUrl } from "@/lib/site";
import { ENGINE_CALL_TIMEOUT_MS, GENERATING_STALE_MS } from "@/lib/engagement-state";
import { PostgrestFake } from "./postgrest-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));
const operator: { subject: string; text: string }[] = [];
vi.mock("@/lib/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/mail")>()),
  notifyOperator: async (subject: string, text: string) => { operator.push({ subject, text }); return { sent: true, id: "m" }; },
  sendMail: async () => ({ sent: true, id: "m" }),
}));

const ENGINE = "http://engine.test";
let db: PostgrestFake;
let restore: () => void;
let restoreEngine: () => void;
let engineUp = true;

function installEngine() {
  const pg = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (!url.startsWith(ENGINE)) return pg(i as RequestInfo, init);
    if (!engineUp) return new Response(JSON.stringify({ error: "down" }), { status: 502 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.format === "html" || body.format === "md") {
      return new Response(JSON.stringify({ format: body.format, title: "Density Screen — North Hall", document: "<p>doc</p>" }), { status: 200 });
    }
    return new Response(JSON.stringify({ scenarios: [{ as_found: { binding_name: "Tap-off" } }] }), { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = pg; };
}

const INTAKE = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const row = (token = "doc-tok") => db.rows("deliverables").find((r: any) => r.token === token) as any;
const submit = async () => (await import("@/app/api/intake/[token]/route")).POST(
  new Request(siteUrl("/x"), { method: "POST", body: JSON.stringify(INTAKE) }), ctx("intake-tok"));
const admin = async (action: string) => (await import("@/app/api/admin/deliverables/route")).PATCH(
  new Request(siteUrl("/x"), { method: "PATCH", body: JSON.stringify({ token: "doc-tok", action }) }));
const sweep = async (auth = true) => (await import("@/app/api/cron/engagements/route")).GET(
  new Request(siteUrl("/api/cron/engagements"), { headers: auth ? { authorization: "Bearer cron-secret-value" } : {} }));

/** What a dead request leaves behind: claimed, intake stored, nothing generated. */
function dead(ageMinutes: number | null, over: Record<string, unknown> = {}) {
  const intake = { siteName: "North Hall", ...(ageMinutes === null ? {} : { _gridforge: { generating_since: minutesAgo(ageMinutes) } }) };
  db.seed("deliverables", [{ token: "doc-tok", intake_token: "intake-tok", kind: "density_screen", status: "generating", email: "buyer@hall.example",
    company: "Hall Co", stripe_session_id: "cs_1", created_at: minutesAgo(60 * 24 * 3), intake, ...over }]);
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "k";
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.CRON_SECRET = "cron-secret-value";
  jar.length = 0; operator.length = 0; engineUp = true;
  db = new PostgrestFake(["deliverables", "watch_notes", "watches", "engagement_deposits"]);
  restore = db.install();
  restoreEngine = installEngine();
});
afterEach(() => { restoreEngine(); restore(); vi.restoreAllMocks(); });

describe("the customer is never refused for ever", () => {
  it("a submission whose request died is recoverable by the customer's own resubmission — THE regression", async () => {
    dead(GENERATING_STALE_MS / 60_000 + 5);
    const res = await submit();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(row().status).toBe("draft");
  });

  it("a claim from before stamping existed (no timestamp) is treated as stale, not as eternal", async () => {
    dead(null);
    expect((await submit()).status).toBe(200);
    expect(row().status).toBe("draft");
  });

  it("a request that may still be running is NOT raced: 409, and nothing changes", async () => {
    dead(1);
    const res = await submit();
    expect(res.status).toBe(409);
    expect(row().status).toBe("generating");
  });

  it("the claim stamps the time, so a live request is recognisable as live", async () => {
    db.seed("deliverables", [{ token: "doc-tok", intake_token: "intake-tok", kind: "density_screen", status: "awaiting_intake", stripe_session_id: "cs_1" }]);
    engineUp = false;                                            // the claim is taken, then generation fails and holds the row
    await submit();
    const stamp = row().intake?._gridforge?.generating_since;
    expect(Date.now() - Date.parse(stamp)).toBeLessThan(60_000);
  });
});

describe("the operator can always recover it", () => {
  it("Regenerate works on a stale generating row and refuses a fresh one", async () => {
    jar.push({ name: "gf_admin", value: adminToken()! });
    dead(1);
    expect((await admin("regenerate")).status).toBe(409);
    expect(row().status).toBe("generating");
    row().intake._gridforge.generating_since = minutesAgo(30);
    const res = await admin("regenerate");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(row().status).toBe("draft");
  });

  it("Reopen works on a stale generating row", async () => {
    jar.push({ name: "gf_admin", value: adminToken()! });
    dead(30);
    const res = await admin("reopen");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(row().status).toBe("awaiting_intake");
  });
});

describe("the sweep (/api/cron/engagements)", () => {
  it("needs the cron secret", async () => {
    dead(30);
    expect((await sweep(false)).status).toBe(401);
    expect(row().status).toBe("generating");
  });

  it("moves a stale row to a recoverable state and tells the operator once; a fresh one is left alone", async () => {
    dead(30);
    db.seed("deliverables", [{ token: "fresh", intake_token: "f", kind: "density_screen", status: "generating", stripe_session_id: "cs_2",
      intake: { _gridforge: { generating_since: minutesAgo(1) } } }]);
    const first: any = await (await sweep()).json();
    expect(first).toMatchObject({ ok: true, stale_generating_recovered: 1 });
    expect(row().status).toBe("engine_unavailable");
    expect(row("fresh").status).toBe("generating");
    expect(operator).toHaveLength(1);
    expect(operator[0].subject).toMatch(/stuck generating/i);
    expect(JSON.stringify(operator)).not.toContain("doc-tok");   // a document token is a credential: never in an email
    const second: any = await (await sweep()).json();
    expect(second.stale_generating_recovered).toBe(0);
    expect(operator).toHaveLength(1);                             // one notice per row moved, not one per sweep
  });

  it("a store it cannot read is reported as a failed read, never as 'nothing stuck'", async () => {
    db.dropTable("deliverables");
    const body: any = await (await sweep()).json();
    expect(body.ok).toBe(false);
    expect(body.read_error).toBe(true);
  });

  it("is scheduled", async () => {
    const cfg = JSON.parse((await import("node:fs")).readFileSync("vercel.json", "utf8"));
    expect(cfg.crons.map((c: any) => c.path)).toContain("/api/cron/engagements");
  });
});

describe("one request cannot outlive its function", () => {
  it("every engine call of a generation is bounded below the route's maxDuration", async () => {
    const route = await import("@/app/api/intake/[token]/route");
    expect(route.maxDuration).toBe(120);
    expect(ENGINE_CALL_TIMEOUT_MS).toBeLessThan(route.maxDuration * 1000);
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { timeouts.push(ms); return real(ms); });
    db.seed("deliverables", [{ token: "doc-tok", intake_token: "intake-tok", kind: "density_screen", status: "awaiting_intake", stripe_session_id: "cs_1" }]);
    expect((await submit()).status).toBe(200);
    expect(timeouts.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(ENGINE_CALL_TIMEOUT_MS);
  });
});

describe("the operator can SEE stuck and overdue paid work", () => {
  it("lists a stuck generation with its age, never with a token", async () => {
    jar.push({ name: "gf_admin", value: adminToken()! });
    dead(60);
    const body: any = await (await (await import("@/app/api/admin/deliverables/route")).GET()).json();
    expect(body.ok).toBe(true);
    const item = body.items.find((i: any) => i.kind === "stuck_generating");
    expect(item).toBeTruthy();
    expect(item.age_days).toBe(0);                                // stamped an hour ago: under a day, and it says so
    expect(item.since).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("doc-tok");
    expect(JSON.stringify(body)).not.toContain("intake-tok");
  });

  it("needs the admin session", async () => {
    expect((await (await import("@/app/api/admin/deliverables/route")).GET()).status).toBe(401);
  });

  it("lists a paid engagement that never submitted its numbers, and a draft nobody reviewed", async () => {
    jar.push({ name: "gf_admin", value: adminToken()! });
    db.seed("deliverables", [
      { token: "a", intake_token: "ia", kind: "density_screen", status: "awaiting_intake", stripe_session_id: "cs_a", created_at: minutesAgo(60 * 24 * 5) },
      { token: "b", intake_token: "ib", kind: "procurement_spec", status: "draft", stripe_session_id: "cs_b", created_at: minutesAgo(60 * 24 * 5) },
      { token: "c", intake_token: "ic", kind: "density_screen", status: "awaiting_intake", stripe_session_id: "cs_c", created_at: minutesAgo(60) },
    ]);
    const body: any = await (await (await import("@/app/api/admin/deliverables/route")).GET()).json();
    expect(body.items.map((i: any) => i.kind).sort()).toEqual(["draft_unreviewed", "intake_not_submitted"]);
  });

  it("an unreadable store is an error, not an empty list", async () => {
    jar.push({ name: "gf_admin", value: adminToken()! });
    db.dropTable("deliverables");
    const res = await (await import("@/app/api/admin/deliverables/route")).GET();
    expect(res.status).toBe(502);
  });
});

describe("a stale reader cannot disturb a generation that was re-claimed since (the compare-and-set names the claim)", () => {
  it("a sweep holding a stale read does NOT flip the freshly re-claimed live generation", async () => {
    dead(30);
    const { recoverStaleGenerating } = await import("@/lib/deliverables");
    const staleRead = JSON.parse(JSON.stringify(row()));           // what the sweep read: stale claim S1
    // meanwhile the customer's resubmission recovered it and re-claimed it: generating again, a NEW stamp S2
    const fresh = minutesAgo(0);
    row().intake = { ...row().intake, _gridforge: { generating_since: fresh } };
    const out = await recoverStaleGenerating(staleRead);
    expect(out).toBe("lost");
    expect(row().status).toBe("generating");
    expect(row().intake._gridforge.generating_since).toBe(fresh);
  });

  it("the same for a read of a row that had NO stamp when it has been stamped since", async () => {
    dead(null);
    const { recoverStaleGenerating } = await import("@/lib/deliverables");
    const staleRead = JSON.parse(JSON.stringify(row()));
    row().intake = { ...row().intake, _gridforge: { generating_since: minutesAgo(0) } };
    expect(await recoverStaleGenerating(staleRead)).toBe("lost");
    expect(row().status).toBe("generating");
  });

  it("a generation that lost its claim persists NOTHING and does not move the new claim's row to engine_unavailable", async () => {
    const { generateAndStore, claimStamp } = await import("@/lib/deliverables");
    const first = new Date(Date.now() - 20 * 60_000);
    const second = new Date();
    db.seed("deliverables", [{ token: "doc-tok", intake_token: "intake-tok", kind: "density_screen", status: "generating", stripe_session_id: "cs_1",
      intake: { siteName: "North Hall", _gridforge: { generating_since: claimStamp(second) } } }]);
    // the OLD request (claim `first`) finishes rendering after the row was re-claimed by `second`
    const out = await generateAndStore({ token: "doc-tok", kind: "density_screen", working_files: null, claim: claimStamp(first) }, { siteName: "North Hall" }, "screen");
    expect(out.ok).toBe(false);
    expect(row().status).toBe("generating");
    expect(row().document_html ?? null).toBeNull();
    expect(row().intake._gridforge.generating_since).toBe(claimStamp(second));
  });

  it("an engine failure of the OLD request does not flip the new claim to engine_unavailable either", async () => {
    const { generateAndStore, claimStamp } = await import("@/lib/deliverables");
    const second = new Date();
    db.seed("deliverables", [{ token: "doc-tok", intake_token: "intake-tok", kind: "density_screen", status: "generating", stripe_session_id: "cs_1",
      intake: { siteName: "North Hall", _gridforge: { generating_since: claimStamp(second) } } }]);
    engineUp = false;
    const out = await generateAndStore({ token: "doc-tok", kind: "density_screen", working_files: null, claim: claimStamp(new Date(Date.now() - 20 * 60_000)) }, { siteName: "North Hall" }, "screen");
    expect(out.ok).toBe(false);
    expect(row().status).toBe("generating");
  });

  it("the live claim's own persist still works (its stamp matches)", async () => {
    const { generateAndStore, claimStamp } = await import("@/lib/deliverables");
    const at = new Date();
    db.seed("deliverables", [{ token: "doc-tok", intake_token: "intake-tok", kind: "density_screen", status: "generating", stripe_session_id: "cs_1",
      intake: { siteName: "North Hall", _gridforge: { generating_since: claimStamp(at) } } }]);
    const out = await generateAndStore({ token: "doc-tok", kind: "density_screen", working_files: null, claim: claimStamp(at) }, { siteName: "North Hall" }, "screen");
    expect(out.ok).toBe(true);
    expect(row().status).toBe("draft");
  });
});
