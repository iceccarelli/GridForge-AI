/**
 * The purchase -> delivery lifecycle of the two deliverable products, against the REAL Python engine:
 *
 *   Density Screen:  payment -> /commissioned -> intake -> /v1/screen -> draft -> human release -> customer retrieval, provenance
 *   Procurement Spec: payment -> intake -> /v1/spec (never a screen) -> draft that HAS its response schedule -> release
 *
 * MOCKS: the database is the in-memory PostgREST fake and email is intercepted (Resend is not contacted). The engine is real.
 * What is NOT proven here: Stripe delivering a webhook, a Supabase deployment, or an engine on Fly (the real engine build
 * is read from a local process, so the recorded "engine build" is this checkout's, not production's).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Stripe from "stripe";
import { adminToken } from "@/lib/admin";
import { reviewHash } from "@/lib/deliverables";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

(globalThis as { React?: unknown }).React = React;
const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const WH = "whsec_delivery_lifecycle_secret";
const ENGINE_KEY = "delivery-lifecycle-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
let db: PostgrestFake;
let undo: () => void;
let mail: { to: string[] | string; subject: string; text: string }[];
let engineUrls: string[];
let stripTemplate = false;
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
  mail = []; engineUrls = []; stripTemplate = false;
  jar.length = 0;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = ENGINE_KEY;
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM = "Time to Power <power@timetopower.ai>";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  db = new PostgrestFake(["deliverables", "leads", "qualifications", "customer_notifications"]);
  db.uniqueKeys.set("deliverables", [["stripe_session_id"]]);
  db.uniqueKeys.set("customer_notifications", [["dedupe_key"]]);
  db.rowDefaults.set("customer_notifications", () => ({
    status: "pending", attempts: 0, max_attempts: 6, next_attempt_at: new Date(0).toISOString(),
    claimed_until: null, last_error: null, last_http_status: null, provider_message_id: null, accepted_at: null,
  }));
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) { mail.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); }
    if (ENGINE && url.startsWith(ENGINE)) {
      engineUrls.push(new URL(url).pathname);
      const res = await realFetch(i as RequestInfo, init);
      if (stripTemplate && url.endsWith("/v1/spec")) {
        const body = await res.json();
        delete body.response_template;
        return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json" } });
      }
      return res;
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
const THIN = (() => { const t: Record<string, unknown> = { ...INTAKE }; delete t.firmCapacityMVA; delete t.floorLoadingKPa; delete t.plantCapacityKW; return t; })();
const json = (b: unknown, method = "POST") => new Request(siteUrl("/x"), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const stripe = new Stripe("sk_test_placeholder");
let n = 0;
async function buy(kind: string, amount: number, email = "buyer@hall.example", session = `cs_${kind}_${++n}`) {
  const payload = JSON.stringify({ id: `evt_${session}`, type: "checkout.session.completed", data: { object: {
    id: session, object: "checkout_session", customer_email: email, customer: "cus_1", amount_total: amount, metadata: { kind, company: "Hall Co" } } } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  const res = await POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
  return { res, session };
}
const rowOf = (kind: string) => db.rows("deliverables").find((r: any) => r.kind === kind) as any;
const submit = async (d: any, body: unknown = INTAKE) => (await import("@/app/api/intake/[token]/route")).POST(json(body), ctx(d.intake_token));
const signIn = () => jar.push({ name: "gf_admin", value: adminToken()! });
const releaseWith = async (token: string, hash: string | undefined, by?: string) =>
  (await import("@/app/api/admin/deliverables/route")).PATCH(json({ token, ...(hash ? { reviewed_hash: hash } : {}), ...(by ? { reviewed_by: by } : {}) }, "PATCH"));
const to = (m: { to: string[] | string }) => ([] as string[]).concat(m.to).join(",");
async function deliverablePage(token: string) {
  const { default: Page } = await import("@/app/deliverable/[token]/page");
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
}

describe.runIf(hasPython)("Density Screen: payment -> intake -> screen -> draft -> human release -> retrieval", () => {
  it("runs the whole chain, calls the SCREEN endpoint only, and records where the document came from", async () => {
    // payment, and a redelivery of the same payment
    expect((await buy("density_screen", 450_000, "buyer@hall.example", "cs_ds")).res.status).toBe(200);
    expect((await buy("density_screen", 450_000, "buyer@hall.example", "cs_ds")).res.status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
    const d = rowOf("density_screen");
    expect(d).toMatchObject({ status: "awaiting_intake", amount_cents: 450_000 });

    // /commissioned hands the buyer the intake link (never the document token)
    const { default: Commissioned } = await import("@/app/commissioned/page");
    const landing = renderToStaticMarkup(await Commissioned({ searchParams: Promise.resolve({ session_id: "cs_ds" }) }));
    expect(landing).toContain(`/intake/${d.intake_token}`);
    expect(landing).not.toContain(d.token);

    // a thin intake is accepted and what was assumed is said at submission
    const res = await submit(d, THIN);
    const body: any = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("draft");
    expect(body.assumed.map((a: any) => a.field).sort()).toEqual(["firmCapacityMVA", "floorLoadingKPa", "plantCapacityKW"]);

    // the document is the SCREEN, from the screen endpoint, and carries provenance
    const draft = rowOf("density_screen");
    expect(draft.status).toBe("draft");
    expect(String(draft.title)).toMatch(/density screen/i);
    expect(engineUrls).toContain("/v1/screen");
    expect(engineUrls).not.toContain("/v1/spec");
    expect(engineUrls).not.toContain("/v1/study");
    const meta = draft.intake._gridforge;
    expect(meta).toMatchObject({ endpoint: "screen" });
    expect(meta.generated_at).toBeTruthy();
    expect(meta.document_sha256).toBe(reviewHash(draft));
    expect(meta.provenance.engine_version).toMatch(/\d/);
    expect(meta.provenance.code_sha256).toMatch(/^[0-9a-f]{16,}$/);

    // human release: a draft is not served, release needs the hash that was reviewed, and it records who reviewed it
    const read = await import("@/app/api/deliverable/[token]/route");
    expect((await read.GET(new Request(siteUrl("/x")), ctx(draft.token))).status).toBe(409);
    signIn();
    expect((await releaseWith(draft.token, undefined)).status).toBe(422);
    expect((await releaseWith(draft.token, "0".repeat(64), "A. Rivera")).status).toBe(409);
    // the right hash but no named reviewer: refused (the buyer is told an engineer reviewed it)
    const noName = await releaseWith(draft.token, reviewHash(draft));
    expect(noName.status).toBe(422);
    expect(((await noName.json()) as any).error).toMatch(/reviewed_by is required/);
    expect((await releaseWith(draft.token, reviewHash(draft), "   ")).status).toBe(422);
    expect(rowOf("density_screen").status).toBe("draft");
    mail.length = 0;
    const rel = await releaseWith(draft.token, reviewHash(draft), "A. Rivera, P.Eng.");
    const relBody: any = await rel.json();
    expect(rel.status, JSON.stringify(relBody)).toBe(200);
    expect(relBody).toMatchObject({ status: "released", customer_notified: true, reviewer_recorded: true, provenance_recorded: true });
    const sent = mail.filter((m) => to(m).includes("buyer@hall.example"));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`/deliverable/${draft.token}`);
    expect(sent[0].text).not.toContain(draft.intake_token);

    // customer retrieval, by the document token only
    expect((await read.GET(new Request(siteUrl("/x")), ctx(draft.token))).status).toBe(200);
    expect((await read.GET(new Request(siteUrl("/x")), ctx(draft.intake_token))).status).toBe(404);
    const page = await deliverablePage(draft.token);
    expect(page).toContain("Provenance");
    expect(page).toContain(`version ${meta.provenance.engine_version}`);
    expect(page).toContain("by A. Rivera, P.Eng.");
    expect(page).toContain("the text above is the text that was reviewed");
    expect(page).toContain(meta.document_sha256.slice(0, 12));

    // a late redelivery of the payment changes nothing about a released document
    expect((await buy("density_screen", 450_000, "buyer@hall.example", "cs_ds")).res.status).toBe(200);
    expect(rowOf("density_screen")).toMatchObject({ status: "released", token: draft.token });
  }, 120_000);

  it("nothing but a draft can be released: not awaiting_intake, generating or engine_unavailable", async () => {
    await buy("density_screen", 450_000);
    const d = rowOf("density_screen");
    signIn();
    for (const status of ["awaiting_intake", "generating", "engine_unavailable"]) {
      d.status = status;
      d.document_html = "<p>half written</p>";
      expect((await releaseWith(d.token, reviewHash(d), "x")).status, status).toBe(409);
      expect(d.status).toBe(status);
    }
  });

  it("a page with no engine identity recorded says so instead of showing one", async () => {
    await buy("density_screen", 450_000);
    const d = rowOf("density_screen");
    Object.assign(d, { status: "released", document_html: "<p>doc</p>", released_at: new Date().toISOString(), intake: { _gridforge: { endpoint: "screen" } } });
    const page = await deliverablePage(d.token);
    expect(page).toContain("not recorded for this document");
    expect(page).toContain("the reviewer&#x27;s name was not recorded");
  });
});

describe.runIf(hasPython)("Procurement Specification: it generates the SPEC, with its response schedule, stating its site conditions", () => {
  const SPEC_INTAKE = { ...INTAKE, designDrybulbC: 38 };

  it("payment -> intake -> /v1/spec ONLY -> a specification draft that holds the response schedule and the relief", async () => {
    await buy("procurement_spec", 1_800_000, "buyer@hall.example", "cs_spec");
    const d = rowOf("procurement_spec");
    const res = await submit(d, SPEC_INTAKE);
    const body: any = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("draft");
    expect(body.assumed).toEqual([]);                      // they gave the site's design dry bulb: nothing about their site is assumed

    // the right endpoint: a specification purchase never calls the screen (the EUR 18,000 wrong-document regression)
    expect(engineUrls).toContain("/v1/spec");
    expect(engineUrls).not.toContain("/v1/screen");
    expect(engineUrls).not.toContain("/v1/study");
    const row = rowOf("procurement_spec");
    expect(String(row.title)).toMatch(/specification/i);
    expect(String(row.title)).not.toMatch(/density screen/i);
    expect(row.intake._gridforge.endpoint).toBe("spec");

    // the three things the catalogue promises for the spec are all stored: the document, the schedule and the relief
    expect(Object.keys(row.working_files).sort()).toEqual(["bundle.json", "response_template.json", "specification.json"]);
    expect(JSON.parse(row.working_files["specification.json"]).constraint_id).toBeTruthy();
    expect(row.intake._gridforge.spec.constraint_id).toBe(JSON.parse(row.working_files["specification.json"]).constraint_id);
    expect(JSON.parse(row.working_files["bundle.json"]).expected).toEqual(["study", "response_schedule"]);

    // the numbers trace to the capacity model and the site conditions are stated in the document
    expect(row.document_html).toContain("From constraint");
    expect(row.document_html).toContain("Technical requirements");
    // the engine's document states its site conditions and assumptions itself (section 2A)
    expect(row.document_html).toContain("Site conditions and assumptions");
    expect(row.document_html).toMatch(/site conditions/i);

    // released: the page states the site conditions it was derived from and where each came from
    signIn();
    expect((await releaseWith(row.token, reviewHash(row), "A. Rivera")).status).toBe(200);
    const page = await deliverablePage(row.token);
    expect(page).toContain("Basis of this specification");
    // the engine's own basis is carried onto the page now that /v1/spec returns it (section 2A of the document)
    expect(page).toContain("Design ambient dry bulb (summer)");
    expect(page).toMatch(/38 degC \(evidence E3\): supplied/);
    expect(page).toContain("Every numeric requirement in it names the constraint of the capacity model it came from");
  }, 120_000);

  it("when the buyer gave no site design dry bulb, the page says the specification rests on a default, not on THEIR site conditions", async () => {
    await buy("procurement_spec", 1_800_000);
    const d = rowOf("procurement_spec");
    const res = await submit(d, INTAKE);
    expect(res.status).toBe(200);
    // and the buyer is told at SUBMISSION, not first on the released page
    expect(((await res.json()) as any).assumed).toEqual([expect.objectContaining({ field: "designDrybulbC" })]);
    const row = rowOf("procurement_spec");
    signIn();
    await releaseWith(row.token, reviewHash(row), "A. Rivera");
    const page = await deliverablePage(row.token);
    expect(page).toContain("Design ambient dry bulb (summer)");
    expect(page).toMatch(/32 degC \(evidence E0\): assumed/);
    expect(page).toContain("Inputs that were assumed rather than supplied");
    expect(page).toMatch(/dry bulb[^<]*: not supplied, assumed 32/i);
  }, 120_000);

  it("a specification the engine could not complete is HELD, announced, and cannot be released — then regenerates and releases", async () => {
    await buy("procurement_spec", 1_800_000);
    const d = rowOf("procurement_spec");
    stripTemplate = true;                                  // the engine answers, but without the response schedule
    mail.length = 0;
    const res = await submit(d, SPEC_INTAKE);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("engine_unavailable");
    const held = rowOf("procurement_spec");
    expect(held.status).toBe("engine_unavailable");
    expect(held.document_html).toBeTruthy();               // what exists is kept
    expect(mail.some((m) => to(m).includes("ops@example.test") && /incomplete/i.test(m.subject) && /response_schedule/.test(m.text))).toBe(true);

    signIn();
    const blocked = await releaseWith(held.token, reviewHash(held), "A. Rivera");
    expect(blocked.status).toBe(409);
    held.status = "draft";                                   // even forced to a draft, the pack gate holds it
    const gate = await releaseWith(held.token, reviewHash(held), "A. Rivera");
    expect(gate.status).toBe(409);
    expect(((await gate.json()) as any).error).toMatch(/pack is incomplete.*response_schedule/);
    held.status = "engine_unavailable";

    stripTemplate = false;
    const regen = await (await import("@/app/api/admin/deliverables/route")).PATCH(json({ token: held.token, action: "regenerate" }, "PATCH"));
    expect(regen.status, await regen.clone().text()).toBe(200);
    const fixed = rowOf("procurement_spec");
    expect(fixed.status).toBe("draft");
    expect((await releaseWith(fixed.token, reviewHash(fixed), "A. Rivera")).status).toBe(200);
  }, 120_000);
});

describe("the spec's site conditions, as the ENGINE reports them with the result", () => {
  it("the page lists them (and the assumed inputs) when specification.json carries them, and does not reconstruct them when it does not", async () => {
    await buy("procurement_spec", 1_800_000);
    const d = rowOf("procurement_spec");
    Object.assign(d, {
      status: "released", document_html: "<p>spec</p>", released_at: new Date().toISOString(),
      intake: { site: { design_drybulb_C: 38 }, _gridforge: { endpoint: "spec" } },
      working_files: {
        "specification.json": JSON.stringify({
          constraint_id: "cdu_capacity",
          site_conditions: [
            { id: "SC-1", label: "Summer design dry bulb", value: 38, unit: "degC", evidence: "E5", status: "supplied" },
            { id: "SC-2", label: "Altitude", value: null, text: "not modelled", status: "not_modelled" },
          ],
          assumed_inputs: [{ path: "grid.firm_capacity_MVA", label: "Firm connection capacity", unit: "MVA", assumed: "15.0 MVA (E0)" }],
        }),
      },
    });
    let page = await deliverablePage(d.token);
    expect(page).toContain("Summer design dry bulb");
    expect(page).toContain("38 degC (evidence E5): supplied");
    expect(page).toContain("Altitude");
    expect(page).toContain("Firm connection capacity: not supplied, assumed 15.0 MVA (E0)");
    // without them, only what the buyer supplied is shown, labelled as theirs
    d.working_files = { "specification.json": JSON.stringify({ constraint_id: "cdu_capacity" }) };
    page = await deliverablePage(d.token);
    expect(page).toContain("38 °C (supplied by you)");
    expect(page).not.toContain("assumed 15.0 MVA");
  });
});
