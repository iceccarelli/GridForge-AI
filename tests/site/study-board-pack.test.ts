/**
 * The Envelope Study pack: the full study and its one-page board summary, delivered as one engagement.
 *
 *   intake -> one engine call renders study + board -> one row update -> [human release] -> the buyer reads both
 *
 * The pack goes through the SAME engagement row, release gate and token-gated routes as every other deliverable;
 * there is no second fulfilment system. The engine is the REAL Python engine (so the board really is rendered in the
 * same solve as the study); email is intercepted; the store is the PostgREST fake.
 *
 * Context worth knowing: the live Envelope Study DEPOSIT is bespoke (producesDeliverable: false) and opens no
 * engagement, so these tests open a `study`-endpoint engagement directly. See docs/07_DELIVERY_RUNBOOK.md.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { BOARD_HTML, BOARD_MD, BUNDLE_MANIFEST, isPackFile, packState } from "@/lib/deliverables";
import { PostgrestFake } from "./postgrest-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const ENGINE_KEY = "study-pack-key";
const KIND = "envelope_study_deposit";   // endpoint: "study"
let engine: ChildProcess | null = null;
let ENGINE = "";
let db: PostgrestFake;
let undo: () => void;
let mail: { to: string[] | string; subject: string; text: string; headers: Record<string, string> }[];
let engineMode: { dropBoard?: boolean; failBoardCalls?: boolean; failStoreWrite?: boolean };
const realFetch = globalThis.fetch;

async function startEngine(): Promise<string> {
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${ENGINE_KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  engine = spawn("python3", ["-c", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}
beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => engine?.kill());

beforeEach(() => {
  mail = [];
  jar.length = 0;
  engineMode = {};
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = ENGINE_KEY;
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM = "Time to Power <power@timetopower.ai>";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  db = new PostgrestFake(["deliverables"]);
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) {
      mail.push({ ...JSON.parse(String(init?.body)), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("{}", { status: 200 });
    }
    if (ENGINE && url.startsWith(ENGINE)) {
      const wantsBoard = String(init?.body ?? "").includes('"bundle":"board"');
      if (wantsBoard && engineMode.failBoardCalls) return new Response(JSON.stringify({ error: "gate refused" }), { status: 500 });
      const res = await realFetch(i as RequestInfo, init);
      if (wantsBoard && engineMode.dropBoard) {   // an engine from before packs: ignores the flag
        const body = await res.json();
        delete body.board;
        return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json" } });
      }
      return res;
    }
    if (engineMode.failStoreWrite && init?.method === "PATCH" && String(init.body).includes("document_html")) {
      return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = dbFetch; restoreDb(); };
});
afterEach(() => undo());

const INTAKE = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const json = (b: unknown, method = "POST") => new Request(siteUrl("/x"), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const signIn = () => jar.push({ name: "gf_admin", value: createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex") });
const admin = async (token: string, action?: string) =>
  (await import("@/app/api/admin/deliverables/route")).PATCH(json({ token, ...(action ? { action } : {}) }, "PATCH"));
const row = () => db.rows("deliverables")[0] as any;
const submit = async (token = "intake-tok") => (await import("@/app/api/intake/[token]/route")).POST(json(INTAKE), ctx(token));
const read = async (token: string, qs = "") =>
  (await import("@/app/api/deliverable/[token]/route")).GET(new Request(siteUrl(`/api/deliverable/${token}${qs}`)), ctx(token));
const toOps = () => mail.filter((m) => ([] as string[]).concat(m.to).join(",").includes("ops@example.test"));
const toBuyer = () => mail.filter((m) => ([] as string[]).concat(m.to).join(",").includes("buyer@hall.example"));

function openStudy(over: Record<string, unknown> = {}) {
  db.seed("deliverables", [{
    id: "d1", token: "doc-tok", intake_token: "intake-tok", kind: KIND, status: "awaiting_intake",
    email: "buyer@hall.example", company: "Hall Co", stripe_session_id: "cs_study", ...over,
  }]);
}

describe.runIf(hasPython)("the pack is generated whole, from one solve, behind the existing gates", () => {
  it("stores the study AND the board summary on the same engagement and holds both as a draft", async () => {
    openStudy();
    expect((await submit()).status).toBe(200);
    const r = row();
    expect(r.status).toBe("draft");
    expect(r.document_html).toContain("Capacity");
    expect(r.working_files[BOARD_HTML]).toContain("<");
    expect(r.working_files[BOARD_MD]).toContain("Appendix A");     // the provenance appendix travels with it
    expect(packState(r)).toEqual({ complete: true, missing: [], legacy: false });
    expect(JSON.parse(r.working_files[BUNDLE_MANIFEST]).expected).toEqual(["study", "board_summary"]);
    expect(r.working_files[BOARD_MD]).not.toEqual(r.document_md);
  });

  it("a real client's pack is not stamped SYNTHETIC on either document, and both carry the same screening stamp", async () => {
    openStudy();
    await submit();
    const r = row();
    for (const d of [r.document_md, r.working_files[BOARD_MD]]) {
      expect(d).not.toContain("SYNTHETIC REFERENCE DATA");
      expect(d).toContain("SCREENING OPINION");
    }
  });

  it("nothing is readable before release, and the board is readable after it", async () => {
    openStudy();
    await submit();
    expect((await read("doc-tok", "?format=board")).status).toBe(409);
    expect((await read("doc-tok", "?format=board_md")).status).toBe(409);
    expect((await read("doc-tok")).status).toBe(409);

    expect((await admin("doc-tok")).status).toBe(401);          // no admin cookie, no release
    expect(row().status).toBe("draft");

    signIn();
    const out = await (await admin("doc-tok")).json();
    expect(out).toMatchObject({ ok: true, status: "released", customer_notified: true });
    const html = await read("doc-tok", "?format=board");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toBe(row().working_files[BOARD_HTML]);
    const md = await read("doc-tok", "?format=board_md");
    expect(md.headers.get("content-disposition")).toContain("board_summary.md");
    expect(await read("doc-tok", "?format=md")).toHaveProperty("status", 200);   // the study is still served as before
  });

  it("the release email names the pack and carries an idempotency key; a second release sends nothing", async () => {
    openStudy();
    await submit();
    signIn();
    mail.length = 0;
    await admin("doc-tok");
    const m = toBuyer();
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain("board summary");
    expect(m[0].headers["Idempotency-Key"]).toBe("deliverable-release-d1");
    expect(m[0].text).not.toContain(row().intake_token);        // the intake credential never goes in a mail
    const again = await (await admin("doc-tok")).json();
    expect(again.customer_notified).toBe(false);
    expect(toBuyer()).toHaveLength(1);
  });

  it("an authorised pull-back and re-release keeps both artefacts", async () => {
    openStudy();
    await submit();
    signIn();
    await admin("doc-tok");
    await admin("doc-tok", "unrelease");
    expect(row().status).toBe("draft");
    expect(packState(row()).complete).toBe(true);
    expect((await read("doc-tok", "?format=board")).status).toBe(409);
  });
});

describe.runIf(hasPython)("a partial pack is never presented as complete, and can be recovered", () => {
  it("an engine that returns no board leaves the study saved, the engagement held, and the operator told", async () => {
    engineMode.dropBoard = true;
    openStudy();
    const res = await submit();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("engine_unavailable");
    const r = row();
    expect(r.status).toBe("engine_unavailable");           // NOT draft
    expect(r.document_html).toBeTruthy();                  // what was produced is kept
    expect(r.working_files[BOARD_HTML]).toBeUndefined();
    expect(packState(r)).toMatchObject({ complete: false, missing: ["board_summary"] });
    expect(toOps().some((m) => m.subject.includes("Pack incomplete") && m.text.includes("board_summary"))).toBe(true);

    signIn();
    const rel = await admin("doc-tok");                    // even a forced release attempt is refused
    expect(rel.status).toBe(409);
    expect((await rel.json()).error).toContain("incomplete");
    expect(row().status).toBe("engine_unavailable");
    expect((await read("doc-tok")).status).toBe(409);
  });

  it("an engine failure while rendering the pack is a recoverable state, not a half-written one", async () => {
    engineMode.failBoardCalls = true;
    openStudy();
    const res = await submit();
    expect(res.status).toBe(502);
    expect(row().status).toBe("engine_unavailable");
    expect(row().document_html ?? null).toBeNull();
    expect(row().intake).toBeTruthy();                     // the buyer's numbers are kept
    expect(toOps().some((m) => m.subject.includes("Engine could not produce"))).toBe(true);
  });

  it("regenerate completes the pack from the stored intake, after which it releases whole", async () => {
    engineMode.dropBoard = true;
    openStudy();
    await submit();
    signIn();
    engineMode.dropBoard = false;
    const out = await (await admin("doc-tok", "regenerate")).json();
    expect(out).toMatchObject({ ok: true, status: "draft" });
    expect(packState(row()).complete).toBe(true);
    expect(row().status).toBe("draft");
    expect((await (await admin("doc-tok")).json()).status).toBe("released");
    expect((await read("doc-tok", "?format=board")).status).toBe(200);
  });

  it("regenerate replaces a stale board with the new one, and keeps files it does not own", async () => {
    openStudy({
      status: "engine_unavailable", intake: { ...{ _gridforge: { binding: "x" } } },
      working_files: { [BOARD_HTML]: "STALE", [BOARD_MD]: "STALE", "bid_comparison.json": "{\"kept\":true}" },
    });
    // a real stored intake, as the intake route would have written it
    const doc = (await import("@/lib/engagement-intake")).toIntakeDocument(INTAKE as any, "Hall Co");
    db.rows("deliverables")[0].intake = { ...doc, _gridforge: { binding: "x" } };
    signIn();
    expect((await admin("doc-tok", "regenerate")).status).toBe(200);
    const r = row();
    expect(r.working_files[BOARD_HTML]).not.toBe("STALE");
    expect(r.working_files[BOARD_MD]).not.toBe("STALE");
    expect(r.working_files["bid_comparison.json"]).toBe("{\"kept\":true}");
    expect(r.intake._gridforge).toBeTruthy();
  });

  it("regenerate refuses a released engagement, a missing intake, and an unauthenticated caller", async () => {
    openStudy({ status: "released", document_html: "<p>x</p>", intake: { a: 1 } });
    expect((await admin("doc-tok", "regenerate")).status).toBe(401);
    signIn();
    expect((await admin("doc-tok", "regenerate")).status).toBe(409);
    db.rows("deliverables")[0].status = "engine_unavailable";
    db.rows("deliverables")[0].intake = null;
    expect((await admin("doc-tok", "regenerate")).status).toBe(409);
  });

  it("a store write that fails after generation is reported and never leaves the row looking finished", async () => {
    engineMode.failStoreWrite = true;
    openStudy();
    const res = await submit();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("could not be produced");
    expect(row().status).not.toBe("draft");
    expect(row().document_html ?? null).toBeNull();
    expect(toOps().some((m) => m.subject.includes("could not be stored"))).toBe(true);
  });

  it("a retried submission after a failure produces a pack, and re-releasing never double-sends", async () => {
    engineMode.dropBoard = true;
    openStudy();
    await submit();
    engineMode.dropBoard = false;
    expect((await submit()).status).toBe(200);              // the customer (or a retry) submits again
    expect(row().status).toBe("draft");
    signIn();
    mail.length = 0;
    await admin("doc-tok");
    await admin("doc-tok");
    expect(toBuyer()).toHaveLength(1);
  });
});

describe.runIf(hasPython)("everything that existed before packs behaves as it did", () => {
  it("a study generated before packs (no manifest) releases as the study-only document it always was", async () => {
    openStudy({ status: "draft", document_html: "<p>old study</p>", document_md: "old", working_files: { "scenarios.csv": "a,b" } });
    expect(packState(row())).toEqual({ complete: true, missing: [], legacy: true });
    signIn();
    expect((await (await admin("doc-tok")).json()).status).toBe("released");
    expect(toBuyer()[0].text).not.toContain("board summary");
    expect((await read("doc-tok", "?format=board")).status).toBe(404);   // truthful: none was produced
    expect((await read("doc-tok")).status).toBe(200);
  });

  it("a Density Screen gets no board summary and no manifest", async () => {
    openStudy({ kind: "density_screen" });
    expect((await submit()).status).toBe(200);
    const r = row();
    expect(r.status).toBe("draft");
    expect(r.working_files?.[BOARD_HTML]).toBeUndefined();
    expect(r.working_files?.[BUNDLE_MANIFEST]).toBeUndefined();
    expect(packState(r).complete).toBe(true);
  });

  it("a document that was never generated cannot be released", async () => {
    openStudy({ status: "draft" });
    signIn();
    expect((await admin("doc-tok")).status).toBe(409);
  });

  it("pack files are documents, not 'working files' to download, and are still behind the same file-name check", async () => {
    expect([BOARD_HTML, BOARD_MD, BUNDLE_MANIFEST].every(isPackFile)).toBe(true);
    expect(isPackFile("scenarios.csv")).toBe(false);
    expect(isPackFile("bid_comparison.json")).toBe(false);
  });

  it("the price and catalogue entry of the Study are untouched by the pack", async () => {
    const { PRODUCTS } = await import("@/lib/products");
    expect(PRODUCTS.envelope_study_deposit.amountCents).toBe(900_000);
    expect(PRODUCTS.density_screen.amountCents).toBe(450_000);
    expect(PRODUCTS.envelope_study_deposit.endpoint).toBe("study");
  });
});
