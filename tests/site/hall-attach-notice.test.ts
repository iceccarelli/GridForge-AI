/**
 * The operator notice when a project is attached from a different email domain than its buyer's (lib/notifications.ts
 * noticeCrossDomainAttach, sent by attachProject in lib/sites.ts).
 *
 * What it must be: a SIGNAL for the operator only (never a customer), carrying two DOMAINS, the project id, the hall id and the time - never an
 * address and never the link token; best effort (it can never block or fail the attach); silent when LEAD_TO_EMAIL is not configured; sent at most
 * once per project per day; and no signal at all when either domain is a free-mail domain or they are the same organisation.
 *
 * In-memory PostgREST that mirrors migrations 0049-0051; the buyer's address comes from the project's own records (engagement_deposits.email,
 * and deliverables.email through project_links). SUPPLEMENTAL to the registry scenarios, which run the attach itself against real PostgreSQL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { installWithAuth, bearerFor } from "./auth-fake";
import { installRegistryRpcs } from "./site-registry-rpc-fake";
import { installProjectRpcs } from "./project-rpc-fake";
import {
  FREE_MAIL_DOMAINS, crossDomainSignal, emailDomain, isFreeMailDomain, noticeCrossDomainAttach, resetAttachNoticeMemory,
} from "@/lib/notifications";

const sent: { subject: string; text: string }[] = [];
const customerMail: unknown[] = [];
let mailThrows = false;
vi.mock("@/lib/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/mail")>()),
  sendMail: async (m: unknown) => { customerMail.push(m); return { sent: true, id: "c1" }; },
  notifyOperator: async (subject: string, text: string) => {
    if (mailThrows) throw new Error("mail provider exploded");
    sent.push({ subject, text });
    return { sent: true, id: "m1" };
  },
}));

let db: PostgrestFake;
let restore: () => void;
let errors: string[];
let ipSeq = 0;
const TOKEN = "LINK-TOKEN-SECRET-0123456789";

beforeEach(() => {
  sent.length = 0; customerMail.length = 0; errors = []; mailThrows = false; resetAttachNoticeMemory();
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", LEAD_TO_EMAIL: "ops@operator.example" });
  db = new PostgrestFake();
  installProjectRpcs(db);
  db.createTable("project_evidence_reviews");
  installRegistryRpcs(db);
  for (const t of ["engagement_deposits", "project_links", "deliverables"]) db.createTable(t);
  ({ restore } = installWithAuth(db));
});
afterEach(() => { restore(); vi.restoreAllMocks(); delete process.env.LEAD_TO_EMAIL; });

async function api(route: "orgs" | "sites" | "halls" | "projects", method: string, who: string, opts: { id?: string; body?: unknown; query?: string } = {}) {
  const paths = { orgs: "/api/orgs", sites: "/api/sites", halls: `/api/sites/${opts.id}/halls`, projects: `/api/halls/${opts.id}/projects` };
  const mod = (await (route === "orgs" ? import("@/app/api/orgs/route") : route === "sites" ? import("@/app/api/sites/route") : route === "halls" ? import("@/app/api/sites/[id]/halls/route") : import("@/app/api/halls/[id]/projects/route"))) as any;
  const res = await mod[method](
    new Request(siteUrl(paths[route] + (opts.query ?? "")), { method, headers: { ...bearerFor(who), "x-forwarded-for": `10.9.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`, "content-type": "application/json" }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
    { params: Promise.resolve({ id: opts.id ?? "" }) }
  );
  return { status: res.status, body: await res.json() };
}

/** An organisation whose editor is on `domain`, with a hall on a site of the given origin, and a project whose buyer is `buyer` (an address, or none). */
async function setup(opts: { editorDomain?: string; buyer?: string | null; origin?: string; via?: "deposit" | "deliverable" } = {}) {
  const owner = "owner@acme.example";
  const editor = `consultant@${opts.editorDomain ?? "consultancy.example"}`;
  const org = (await api("orgs", "POST", owner, { body: { name: "Acme" } })).body.org.id;
  const { POST: addMember } = await import("@/app/api/orgs/[id]/members/route");
  const add = await addMember(new Request(siteUrl(`/api/orgs/${org}/members`), { method: "POST", headers: { ...bearerFor(owner), "x-forwarded-for": "10.8.0.1", "content-type": "application/json" }, body: JSON.stringify({ email: editor, role: "editor" }) }), { params: Promise.resolve({ id: org }) });
  expect(add.status).toBe(201);
  const site = (await api("sites", "POST", editor, { body: { orgId: org, name: "Campus", dataOrigin: opts.origin ?? "production" } })).body.site.id;
  const hall = (await api("halls", "POST", editor, { id: site, body: { label: "H1" } })).body.hall.id;
  const project = db.insertRow("projects", { project_token: TOKEN, project_name: "North hall" });
  if (opts.buyer) {
    if ((opts.via ?? "deposit") === "deposit") db.insertRow("engagement_deposits", { project_id: project.id, email: opts.buyer, stripe_session_id: "cs_1" });
    else {
      const d = db.insertRow("deliverables", { email: opts.buyer, token: "dtok" });
      db.insertRow("project_links", { project_id: project.id, object_type: "deliverable", object_id: d.id });
    }
  }
  const attach = (who = editor, token = TOKEN) => api("projects", "POST", who, { id: hall, body: { projectToken: token, confirmNonProductionSite: true } });
  return { owner, editor, org, site, hall, project, attach };
}

describe("the pure parts", () => {
  it("emailDomain keeps only a lower-cased domain, and nothing at all for something that is not an address", () => {
    expect(emailDomain("Someone@Acme.Example")).toBe("acme.example");
    expect(emailDomain("a@b@c.example")).toBe("c.example");
    for (const bad of ["", "no-at-sign", "@x.example", "a@", "a@localhost", "a@-bad-.example", "a@exa mple.com", null, undefined, 5, {}, "a@" + "x".repeat(300) + ".com"]) expect(emailDomain(bad), String(bad)).toBeNull();
  });

  it("free-mail domains: the typed list and the country variants of the big providers", () => {
    for (const d of ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com", "hotmail.co.uk", "outlook.de", "live.nl", "yahoo.co.uk", "web.de"]) expect(isFreeMailDomain(d), d).toBe(true);
    for (const d of ["acme.example", "gmail.com.evil.example", "notgmail.com", "outlook.example.com", "yahoo.corp.example"]) expect(isFreeMailDomain(d), d).toBe(false);
    expect(new Set(FREE_MAIL_DOMAINS).size).toBe(FREE_MAIL_DOMAINS.length);
    expect(FREE_MAIL_DOMAINS.every((d) => d === d.toLowerCase() && emailDomain(`x@${d}`) === d)).toBe(true);
  });

  it("a differing domain is a signal only when neither side is free-mail and they are not the same organisation", () => {
    expect(crossDomainSignal("a@consultancy.example", ["b@acme.example"])).toEqual({ actorDomain: "consultancy.example", buyerDomain: "acme.example" });
    expect(crossDomainSignal("a@consultancy.example", ["x@gmail.com", "b@acme.example"])).toEqual({ actorDomain: "consultancy.example", buyerDomain: "acme.example" });   // a free-mail buyer is skipped, a real one still counts
    expect(crossDomainSignal("a@gmail.com", ["b@acme.example"])).toBeNull();
    expect(crossDomainSignal("a@consultancy.example", ["b@gmail.com"])).toBeNull();
    expect(crossDomainSignal("a@consultancy.example", ["b@outlook.com", "c@proton.me"])).toBeNull();
    expect(crossDomainSignal("a@acme.example", ["b@ACME.example"])).toBeNull();
    expect(crossDomainSignal("a@eu.acme.example", ["b@acme.example"])).toBeNull();
    expect(crossDomainSignal("a@acme.example", ["b@eu.acme.example"])).toBeNull();
    expect(crossDomainSignal("a@evilacme.example", ["b@acme.example"])).not.toBeNull();         // a suffix is not a subdomain
    expect(crossDomainSignal("a@consultancy.example", [])).toBeNull();
    expect(crossDomainSignal("a@consultancy.example", [null, 5, "junk", undefined])).toBeNull();
    expect(crossDomainSignal("not an address", ["b@acme.example"])).toBeNull();
  });
});

describe("attaching a project", () => {
  it("tells the operator once - the two domains, the project id, the hall id and the time; never an address, never the link token", async () => {
    const s = await setup({ buyer: "buyer@acme.example" });
    const r = await s.attach();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(sent).toHaveLength(1);
    const mail = `${sent[0].subject}\n${sent[0].text}`;
    expect(mail).toContain("consultancy.example");
    expect(mail).toContain("acme.example");
    expect(mail).toContain(s.project.id as string);
    expect(mail).toContain(s.hall);
    expect(mail).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(mail).not.toMatch(/@/);                                    // no address, not even a half of one
    expect(mail).not.toContain("buyer");
    expect(mail).not.toContain("consultant");
    expect(mail).not.toContain(TOKEN);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    expect(errors.join("\n")).not.toContain(TOKEN);
  });

  it("finds the buyer on a purchased deliverable linked to the project, too", async () => {
    const s = await setup({ buyer: "buyer@acme.example", via: "deliverable" });
    expect((await s.attach()).status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("acme.example");
  });

  it("is sent for a test or synthetic site too (the domain mismatch is about who attaches, not where)", async () => {
    const s = await setup({ buyer: "buyer@acme.example", origin: "test" });
    expect((await s.attach()).status).toBe(201);
    expect(sent).toHaveLength(1);
  });

  it("at most one per project per day: detaching and attaching again, by anyone, sends no second notice", async () => {
    const s = await setup({ buyer: "buyer@acme.example" });
    expect((await s.attach()).status).toBe(201);
    expect((await api("projects", "DELETE", s.owner, { id: s.hall, query: `?project=${s.project.id}` })).status).toBe(200);
    expect((await s.attach()).status).toBe(201);
    expect((await s.attach()).status).toBe(200);                      // already attached: nothing new, nothing sent
    expect(sent).toHaveLength(1);
  });

  it("the durable check holds across processes: with the in-process memory empty, a second attachment the same day still sends nothing", async () => {
    const s = await setup({ buyer: "buyer@acme.example" });
    expect((await s.attach()).status).toBe(201);
    expect(sent).toHaveLength(1);
    expect((await api("projects", "DELETE", s.owner, { id: s.hall, query: `?project=${s.project.id}` })).status).toBe(200);
    resetAttachNoticeMemory();                                        // a new serverless instance remembers nothing
    expect((await s.attach()).status).toBe(201);
    expect(sent).toHaveLength(1);
  });

  it("a day later it may be sent again (the memory and the log window are one day)", async () => {
    const s = await setup({ buyer: "buyer@acme.example" });
    expect((await s.attach()).status).toBe(201);
    expect(sent).toHaveLength(1);
    const tomorrow = new Date(Date.now() + 26 * 3_600_000);
    // The attach events are older than a day by then; only this one (written "now") is in the window.
    for (const e of db.rows("project_events")) if (e.event_type === "project_attached_to_hall") e.occurred_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    db.insertRow("project_events", { project_id: s.project.id, event_type: "project_attached_to_hall", actor: "hall_registry", occurred_at: tomorrow.toISOString(), payload: {} });
    expect(await noticeCrossDomainAttach({ projectId: s.project.id as string, hallId: s.hall, actorEmail: s.editor, now: tomorrow })).toBe("sent");
    expect(sent).toHaveLength(2);
  });

  it.each([
    ["the same domain", "consultant@consultancy.example", "buyer@consultancy.example"],
    ["a subdomain of the buyer's", "consultant@eu.acme.example", "buyer@acme.example"],
    ["a free-mail buyer", "consultant@consultancy.example", "buyer@gmail.com"],
    ["a free-mail attacher", "consultant@outlook.com", "buyer@acme.example"],
    ["both free-mail", "consultant@proton.me", "buyer@yahoo.com"],
  ])("no notice for %s", async (_name, editor, buyer) => {
    const s = await setup({ editorDomain: editor.split("@")[1], buyer });
    expect((await s.attach()).status).toBe(201);
    expect(sent).toHaveLength(0);
  });

  it("no notice when the project has no buyer on record", async () => {
    const s = await setup({ buyer: null });
    expect((await s.attach()).status).toBe(201);
    expect(sent).toHaveLength(0);
  });

  it("silent when the operator address is not configured: no notice, no lookup, no log line - and the attach is unaffected", async () => {
    delete process.env.LEAD_TO_EMAIL;
    const s = await setup({ buyer: "buyer@acme.example" });
    errors.length = 0;
    const urls: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = ((i: RequestInfo | URL, init?: RequestInit) => { urls.push(typeof i === "string" ? i : i instanceof URL ? i.href : i.url); return inner(i, init); }) as typeof fetch;
    try {
      expect((await s.attach()).status).toBe(201);
    } finally { globalThis.fetch = inner; }
    expect(sent).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => /engagement_deposits|deliverables|project_links|project_events/.test(u))).toBe(false);
  });

  it("never blocks or fails the attach: a mail provider that throws, or a store that cannot be read for the lookup, still gives 201 and the attachment stands", async () => {
    mailThrows = true;
    const a = await setup({ buyer: "buyer@acme.example" });
    errors.length = 0;
    const r = await a.attach();
    expect(r.status).toBe(201);
    expect(db.rows("hall_project_attachments")).toHaveLength(1);
    expect(errors.join("\n")).toMatch(/attach notice failed unexpectedly/);
    expect(errors.join("\n")).not.toContain(TOKEN);
  });

  it("a lookup that cannot be read says nothing rather than guess, logs a category, and the attach stands", async () => {
    const s = await setup({ buyer: "buyer@acme.example" });
    errors.length = 0;
    db.rpcs.set("gf_attach_project_to_hall", ((orig) => (a: any, d: any) => {
      const r = orig(a, d);
      db.failMethod = { method: "GET", status: 500, body: "{}" };      // the store goes away right after the write
      return r;
    })(db.rpcs.get("gf_attach_project_to_hall")!));
    const r = await s.attach();
    db.failMethod = null;
    expect(r.status).toBe(201);
    expect(sent).toHaveLength(0);
    expect(errors.join("\n")).toMatch(/purchase record could not be read/);
  });

  it("works when the purchase tables do not exist on this deployment (nothing to compare is not an error)", async () => {
    const s = await setup({ buyer: null });
    db.dropTable("engagement_deposits");
    db.dropTable("deliverables");
    db.dropTable("project_links");
    errors.length = 0;
    expect((await s.attach()).status).toBe(201);
    expect(sent).toHaveLength(0);
    expect(errors.join("\n")).not.toMatch(/attach notice/);
  });

  it("a refused attach (no confirmation, no role, unknown token) sends nothing", async () => {
    const s = await setup({ buyer: "buyer@acme.example", origin: "test" });
    expect((await api("projects", "POST", s.editor, { id: s.hall, body: { projectToken: TOKEN } })).status).toBe(422);
    expect((await s.attach(s.editor, "no-such-token-at-all")).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("is directed at the operator address only: nothing is mailed to a customer", async () => {
    const s = await setup({ buyer: "buyer@acme.example" });
    expect((await s.attach()).status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(customerMail).toEqual([]);                                  // the only mail path used is notifyOperator
  });
});
