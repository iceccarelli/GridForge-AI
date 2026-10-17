/**
 * The seat and membership invariants of GridForge Intelligence (migration 0027, lib/team.ts, app/api/team/*), written once and run
 * against two backends:
 *
 *   tests/site/team-seats.test.ts          an in-memory PostgREST that mirrors the SQL (runs anywhere; SUPPLEMENTAL)
 *   tests/site/team-seats.realdb.test.ts   REAL PostgreSQL through REAL PostgREST (the proof of atomicity and of the constraints)
 *
 * Everything goes through the route handlers and the real data layer (recordSubscription, updateSubscription, the outbox). The
 * only things stubbed are the three outside the repository: Supabase Auth's /auth/v1/user, Resend, and Anthropic. Seeding a
 * subscription uses recordSubscription, the function the Stripe webhook uses, so the owner path under test is the shipped one.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { rest, rpc } from "@/lib/pgrest";
import { recordSubscription, updateSubscription } from "@/lib/subscribers";
import { sweepNotifications } from "@/lib/notifications";
import { hashInviteToken, inviteToken } from "@/lib/team-token";
import { installAuth, tokenFor, unconfirmedBearerFor } from "./auth-fake";

export type Mail = { to: string[] | string; subject: string; text: string };

const uid = () => crypto.randomBytes(5).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Harness {
  mail: Mail[];
  /** While true every request to the store fails at the transport (503). Auth, mail and the model are unaffected. */
  outage: boolean;
  /** Fail the outbox write only, so a message can be accepted by the database but not queued. */
  failOutbox: boolean;
  /** The mail provider answers 503: the message cannot be sent now, and the outbox must keep the obligation. */
  mailDown: boolean;
}

/** Layered over whatever fetch the backend installed: Auth, Resend, Anthropic, and the outage switch. */
function installHarness(): { h: Harness; restore: () => void } {
  const h: Harness = { mail: [], outage: false, failOutbox: false, mailDown: false };
  const auth = installAuth();
  const below = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com")) {
      if (h.mailDown) return new Response("{}", { status: 503 });
      h.mail.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: `em_${uid()}` }), { status: 200 });
    }
    if (url.includes("api.anthropic.com/v1/messages")) {
      return new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/auth/v1/user")) return below(input, init);
    if (h.outage) return new Response("{}", { status: 503 });
    if (h.failOutbox && url.includes("/customer_notifications") && String(init?.method ?? "GET") !== "GET") return new Response("{}", { status: 500 });
    return below(input, init);
  }) as typeof fetch;
  return { h, restore: () => { globalThis.fetch = below; auth.restore(); } };
}

export interface Backend {
  /** Install the store under test (as globalThis.fetch) and the env it needs. Returns its restore. */
  install(): Promise<() => void>;
}

type Res = { status: number; body: any };

export function defineTeamScenarios(backend: Backend): void {
  let h: Harness;
  let restore: () => void;
  let ip: string;

  beforeEach(async () => {
    Object.assign(process.env, {
      RESEND_API_KEY: "re_test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>", ANTHROPIC_API_KEY: "sk-ant-test",
    });
    delete process.env.RESEND_FROM;
    delete process.env.INTELLIGENCE_INVITE_SECRET;
    const undoBackend = await backend.install();
    const layered = installHarness();
    h = layered.h;
    restore = () => { layered.restore(); undoBackend(); };
    // A caller address of its own per test, so rate-limit counters on a shared database never bleed between tests.
    ip = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  });
  afterEach(() => restore());

  // ------------------------------------------------------------------------------------------------- helpers

  const owner = () => `owner-${uid()}@team.example`;
  const person = (n = "p") => `${n}-${uid()}@guest.example`;

  async function call(handler: "team" | "invitations" | "members" | "invitation" | "scenarios" | "status" | "siting", method: string, as: string | { raw: Record<string, string> } | undefined, opts: { query?: string; body?: unknown } = {}): Promise<Res> {
    const headers: Record<string, string> = { "x-forwarded-for": ip };
    if (typeof as === "string") headers.authorization = `Bearer ${tokenFor(as)}`;
    else if (as) Object.assign(headers, as.raw);
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const path = { team: "/api/team", invitations: "/api/team/invitations", members: "/api/team/members", invitation: "/api/team/invitation", scenarios: "/api/scenarios", status: "/api/subscription-status", siting: "/api/siting-analysis" }[handler];
    const mod = await {
      team: () => import("@/app/api/team/route"),
      invitations: () => import("@/app/api/team/invitations/route"),
      members: () => import("@/app/api/team/members/route"),
      invitation: () => import("@/app/api/team/invitation/route"),
      scenarios: () => import("@/app/api/scenarios/route"),
      status: () => import("@/app/api/subscription-status/route"),
      siting: () => import("@/app/api/siting-analysis/route"),
    }[handler]();
    const fn = (mod as unknown as Record<string, (r: Request) => Promise<Response>>)[method];
    const res = await fn(new Request(siteUrl(path + (opts.query ?? "")), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const getTeam = (as?: string) => call("team", "GET", as);
  const invite = (as: string | undefined, email: unknown) => call("invitations", "POST", as, { body: { email } });
  const revoke = (as: string | undefined, id: string) => call("invitations", "DELETE", as, { query: `?id=${encodeURIComponent(id)}` });
  const removeMember = (as: string | undefined, id: string) => call("members", "DELETE", as, { query: `?id=${encodeURIComponent(id)}` });
  const redeem = (as: string | undefined, action: string, token: unknown) => call("invitation", "POST", as, { body: { action, token } });
  const scenariosOf = (as: string) => call("scenarios", "GET", as);
  const saveScenario = (as: string) => call("scenarios", "POST", as, { body: { name: "Hall", mw: 10, regionId: "de-eu", valuePerMwMonth: 1, monthsSaved: 1, avoidedEur: 1 } });
  const siting = (as: string) => call("siting", "POST", as, { body: { brief: "80 MW AI training site" } });
  const status = (as?: string) => call("status", "POST", as, { body: {} });

  /** The link's secret as the invitee received it: from the email the outbox sent. */
  function tokenSentTo(email: string): string {
    const mails = h.mail.filter((m) => ([] as string[]).concat(m.to).includes(email));
    expect(mails.length, `an invitation email to ${email}`).toBeGreaterThan(0);
    const m = /\/account\/invite\/([A-Za-z0-9_-]{43})\b/.exec(mails[mails.length - 1].text);
    expect(m, "the email carries the invitation link").not.toBeNull();
    return m![1];
  }

  async function subscribe(email: string, plan: "developer" | "team" | "enterprise", state?: "past_due" | "cancelled") {
    const row = await recordSubscription({ email, plan, sessionId: `cs_${uid()}` });
    expect(row, "subscription recorded").not.toBeNull();
    if (state) expect(await updateSubscription(row!.id, { status: state })).toBe(true);
    return row!;
  }

  /** Invite and accept in one go; returns the member's seat id. */
  async function seat(o: string, who: string): Promise<string> {
    const r = await invite(o, who);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = await redeem(who, "accept", tokenSentTo(who));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const t = await getTeam(o);
    return t.body.team.members.find((m: any) => m.email === who).id;
  }

  const table = async (name: string) => {
    const r = await rest<Record<string, any>[]>("GET", `${name}?select=*`);
    expect(r.ok).toBe(true);
    return (r.ok ? r.data : []) as Record<string, any>[];
  };

  /** An invitation with a short life, made through the same database function the route calls. */
  async function inviteWithTtl(o: string, who: string, ttlMs: number): Promise<string> {
    const id = crypto.randomUUID();
    const secret = inviteToken(id)!;
    const r = await rpc<{ ok: boolean }>("gf_invite_member", {
      p_owner: o, p_invitee: who, p_id: id, p_token_hash: hashInviteToken(secret), p_expires_at: new Date(Date.now() + ttlMs).toISOString(),
    });
    expect(r.ok && r.data.ok).toBe(true);
    return secret;
  }

  // ------------------------------------------------------------------------------------------------- 1-4: seat limits

  describe("seat limits", () => {
    it("Developer allows the owner only: one total seat", async () => {
      const o = owner();
      await subscribe(o, "developer");
      const t = await getTeam(o);
      expect(t.status).toBe(200);
      expect(t.body.team).toMatchObject({ plan: "developer", seats: 1, used: 1, reserved: 0, available: 0, members: [], invitations: [] });

      const r = await invite(o, person());
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe("no_seats");
      expect(h.mail).toHaveLength(0);
      expect((await table("subscription_invitations")).filter((i) => i.owner_email === o)).toHaveLength(0);
    });

    it("Team allows five total seats including the owner, counting an open invitation as a held seat", async () => {
      const o = owner();
      await subscribe(o, "team");
      expect((await getTeam(o)).body.team).toMatchObject({ seats: 5, used: 1, reserved: 0, available: 4 });

      const guests = [person(), person(), person(), person()];
      for (const g of guests) expect((await invite(o, g)).status).toBe(201);
      expect((await getTeam(o)).body.team).toMatchObject({ used: 1, reserved: 4, available: 0 });
      const fifth = await invite(o, person());
      expect(fifth.status).toBe(409);
      expect(fifth.body.reason).toBe("no_seats");

      for (const g of guests) expect((await redeem(g, "accept", tokenSentTo(g))).status).toBe(200);
      const t = (await getTeam(o)).body.team;
      expect(t).toMatchObject({ seats: 5, used: 5, reserved: 0, available: 0 });
      expect(t.members).toHaveLength(4);                 // four members + the owner = five
      expect((await invite(o, person())).status).toBe(409);
    });

    it("Enterprise has no seat cap: thirteen seats and no limit reported", async () => {
      const o = owner();
      await subscribe(o, "enterprise");
      const guests = Array.from({ length: 12 }, () => person());
      for (const g of guests) expect((await invite(o, g)).status).toBe(201);
      for (const g of guests) expect((await redeem(g, "accept", tokenSentTo(g))).status).toBe(200);
      const t = (await getTeam(o)).body.team;
      expect(t).toMatchObject({ plan: "enterprise", seats: null, used: 13, available: null });
      expect(t.members.every((m: any) => m.seatActive)).toBe(true);
      expect((await invite(o, person())).status).toBe(201);
    });

    it("the owner always counts: removing every member leaves exactly the owner's seat, never zero", async () => {
      const o = owner();
      await subscribe(o, "team");
      const id = await seat(o, person());
      expect((await getTeam(o)).body.team.used).toBe(2);
      expect((await removeMember(o, id)).status).toBe(200);
      expect((await getTeam(o)).body.team).toMatchObject({ used: 1, available: 4 });
    });

    it("a client cannot raise the limit: plan, seats and owner in the body are ignored", async () => {
      const o = owner();
      await subscribe(o, "developer");
      const r = await call("invitations", "POST", o, { body: { email: person(), plan: "enterprise", seats: 99, owner: "someone@else.example", ownerEmail: "someone@else.example", active: true } });
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe("no_seats");
    });

    it("sends the email through the durable outbox, and the secret is never stored", async () => {
      const o = owner();
      await subscribe(o, "team");
      const g = person();
      const r = await invite(o, g);
      expect(r.status).toBe(201);
      const secret = tokenSentTo(g);

      const inv = (await table("subscription_invitations")).find((i) => i.email === g)!;
      expect(inv.token_hash).toBe(hashInviteToken(secret));
      expect(inv.token_hash).not.toBe(secret);
      const everything = JSON.stringify({ i: await table("subscription_invitations"), m: await table("subscription_members"), n: await table("customer_notifications") });
      expect(everything).not.toContain(secret);
      const note = (await table("customer_notifications")).find((n) => n.subject_id === inv.id)!;
      expect(note).toMatchObject({ kind: "team_invitation", subject_table: "subscription_invitations", status: "accepted" });
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  // ------------------------------------------------------------------------------------------------- 5-6: identity

  describe("who may redeem an invitation", () => {
    it("an unauthenticated caller can neither manage nor redeem anything", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      expect((await invite(o, g)).status).toBe(201);
      const secret = tokenSentTo(g);
      const id = (await getTeam(o)).body.team.invitations[0].id;

      for (const as of [undefined, { raw: { authorization: "Bearer not-a-real-session" } }] as const) {
        expect((await call("team", "GET", as)).status).toBe(401);
        expect((await call("invitations", "POST", as, { body: { email: person() } })).status).toBe(401);
        expect((await call("invitations", "DELETE", as, { query: `?id=${id}` })).status).toBe(401);
        expect((await call("members", "DELETE", as, { query: `?id=${id}` })).status).toBe(401);
        for (const action of ["preview", "accept", "decline"]) {
          expect((await call("invitation", "POST", as, { body: { action, token: secret } })).status).toBe(401);
        }
      }
      expect((await getTeam(o)).body.team).toMatchObject({ reserved: 1, members: [] });
    });

    it("a session whose address is not confirmed cannot accept an invitation or manage seats", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      expect((await invite(o, g)).status).toBe(201);
      const secret = tokenSentTo(g);
      const a = await call("invitation", "POST", { raw: unconfirmedBearerFor(g) }, { body: { action: "accept", token: secret } });
      expect(a.status).toBe(403);
      expect((await call("team", "GET", { raw: unconfirmedBearerFor(o) })).status).toBe(403);
      expect((await getTeam(o)).body.team.members).toEqual([]);
      expect((await scenariosOf(g)).status).toBe(402);
    });

    it("a different email cannot redeem somebody else's invitation, and learns nothing about it", async () => {
      const o = owner(), a = person("alice"), b = person("bob");
      await subscribe(o, "team");
      expect((await invite(o, a)).status).toBe(201);
      const secret = tokenSentTo(a);

      const wrong = await redeem(b, "accept", secret);
      const unknown = await redeem(b, "accept", "A".repeat(43));
      expect(wrong.status).toBe(404);
      expect(wrong.body).toEqual(unknown.body);           // a stranger's secret and a made-up one are indistinguishable
      expect((await redeem(b, "preview", secret)).status).toBe(404);
      expect((await redeem(b, "decline", secret)).status).toBe(404);
      expect(JSON.stringify(wrong.body)).not.toContain(a);
      expect((await scenariosOf(b)).status).toBe(402);

      // the invitation is untouched: the right person still accepts
      expect((await redeem(a, "accept", secret)).status).toBe(200);
      expect((await scenariosOf(a)).status).toBe(200);
      expect((await scenariosOf(b)).status).toBe(402);
    });

    it("the address is matched case-insensitively and a malformed secret is refused before the database", async () => {
      const o = owner(), g = person("Mixed.Case");
      await subscribe(o, "team");
      expect((await invite(o, g.toUpperCase())).status).toBe(201);
      for (const bad of ["", "short", 42, null, "A".repeat(44), "../etc/passwd"]) {
        expect((await redeem(g, "accept", bad)).status).toBe(404);
      }
      expect((await redeem(g, "accept", tokenSentTo(g.toLowerCase()))).status).toBe(200);
      expect((await call("invitation", "POST", g, { body: { token: "x" } })).status).toBe(400);   // no action
    });

    it("a member cannot be granted access by a body that claims it", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      const r = await call("invitation", "POST", g, { body: { action: "accept", token: "B".repeat(43), email: g, active: true, plan: "enterprise", ownerEmail: o } });
      expect(r.status).toBe(404);
      expect((await scenariosOf(g)).status).toBe(402);
      expect((await status(g)).body).toMatchObject({ active: false });
    });
  });

  // ------------------------------------------------------------------------------------------------- 7: invitation states

  describe("an invitation that is no longer valid", () => {
    it("an expired invitation cannot be previewed or accepted, holds no seat, and the person can be invited again", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      const secret = await inviteWithTtl(o, g, 1500);
      expect((await redeem(g, "preview", secret)).status).toBe(200);
      await sleep(1800);
      for (const action of ["preview", "accept", "decline"]) {
        const r = await redeem(g, action, secret);
        expect(r.status).toBe(410);
        expect(r.body.reason).toBe("expired");
      }
      expect((await scenariosOf(g)).status).toBe(402);
      expect((await getTeam(o)).body.team).toMatchObject({ reserved: 0, available: 4, invitations: [] });
      expect((await invite(o, g)).status).toBe(201);        // the lapsed offer neither holds a seat nor blocks a new one
      expect((await redeem(g, "accept", tokenSentTo(g))).status).toBe(200);
      expect((await redeem(g, "accept", secret)).status).toBe(410);   // the old link stays dead
    });

    it("a revoked invitation cannot be redeemed, and revoking frees the seat", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      expect((await invite(o, g)).status).toBe(201);
      const secret = tokenSentTo(g);
      const id = (await getTeam(o)).body.team.invitations[0].id;
      expect((await revoke(o, id)).status).toBe(200);
      for (const action of ["preview", "accept", "decline"]) {
        const r = await redeem(g, action, secret);
        expect(r.status).toBe(410);
        expect(r.body.reason).toBe("revoked");
      }
      expect((await revoke(o, id)).status).toBe(404);               // already gone
      expect((await getTeam(o)).body.team).toMatchObject({ reserved: 0, members: [] });
      expect((await scenariosOf(g)).status).toBe(402);
    });

    it("an accepted invitation is single-use, and cannot be replayed once the member is removed", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      expect((await invite(o, g)).status).toBe(201);
      const secret = tokenSentTo(g);
      expect((await redeem(g, "accept", secret)).status).toBe(200);
      const again = await redeem(g, "accept", secret);
      expect(again.status).toBe(409);
      expect(again.body.reason).toBe("used");
      expect((await redeem(g, "decline", secret)).status).toBe(409);
      const members = (await getTeam(o)).body.team.members;
      expect(members).toHaveLength(1);

      expect((await removeMember(o, members[0].id)).status).toBe(200);
      expect((await redeem(g, "accept", secret)).status).toBe(409);   // removal does not reopen the link
      expect((await scenariosOf(g)).status).toBe(402);
    });

    it("a declined invitation cannot be accepted, and frees its seat", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      expect((await invite(o, g)).status).toBe(201);
      const secret = tokenSentTo(g);
      expect((await redeem(g, "decline", secret)).status).toBe(200);
      const r = await redeem(g, "accept", secret);
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe("declined");
      expect((await getTeam(o)).body.team).toMatchObject({ reserved: 0, available: 4 });
      expect((await invite(o, g)).status).toBe(201);
    });

    it("duplicate invitations, existing members and the owner's own address are refused", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      expect((await invite(o, g)).status).toBe(201);
      expect((await invite(o, g)).body.reason).toBe("already_invited");
      expect((await invite(o, o.toUpperCase())).body.reason).toBe("is_owner");
      expect((await invite(o, "not-an-email")).status).toBe(400);
      expect((await invite(o, "")).status).toBe(400);
      expect((await invite(o, { $ne: 1 })).status).toBe(400);
      expect((await redeem(g, "accept", tokenSentTo(g))).status).toBe(200);
      expect((await invite(o, g)).body.reason).toBe("already_member");
    });
  });

  // ------------------------------------------------------------------------------------------------- 8-9: authorization

  describe("authorization of seat management", () => {
    it("a signed-in non-subscriber cannot read or manage anything (402), and learns nothing", async () => {
      const stranger = person("stranger");
      expect((await getTeam(stranger)).status).toBe(402);
      expect((await invite(stranger, person())).status).toBe(402);
      expect((await revoke(stranger, crypto.randomUUID())).status).toBe(402);
      expect((await removeMember(stranger, crypto.randomUUID())).status).toBe(402);
    });

    it("another subscription's owner cannot enumerate, revoke or remove across subscriptions", async () => {
      const o1 = owner(), o2 = owner(), m1 = person(), g1 = person();
      await subscribe(o1, "team");
      await subscribe(o2, "team");
      const memberId = await seat(o1, m1);
      expect((await invite(o1, g1)).status).toBe(201);
      const invId = (await getTeam(o1)).body.team.invitations[0].id;

      const theirs = await getTeam(o2);
      expect(theirs.status).toBe(200);
      expect(JSON.stringify(theirs.body)).not.toContain(m1);          // no roster, no pending address from the other subscription
      expect(JSON.stringify(theirs.body)).not.toContain(g1);
      expect(theirs.body.team.members).toEqual([]);

      expect((await revoke(o2, invId)).status).toBe(404);
      expect((await removeMember(o2, memberId)).status).toBe(404);
      expect((await getTeam(o1)).body.team).toMatchObject({ reserved: 1 });
      expect((await getTeam(o1)).body.team.members).toHaveLength(1);
      expect((await scenariosOf(m1)).status).toBe(200);                 // the member's seat is intact
    });

    it("a member can use the dashboard but cannot invite, revoke, remove or read the roster", async () => {
      const o = owner(), m = person("member"), friend = person("friend"), other = person("other");
      await subscribe(o, "team");
      const otherSeat = await seat(o, other);
      const memberSeat = await seat(o, m);
      expect((await invite(o, friend)).status).toBe(201);
      const invId = (await getTeam(o)).body.team.invitations[0].id;

      expect((await scenariosOf(m)).status).toBe(200);
      for (const r of [
        await getTeam(m),
        await invite(m, person()),
        await revoke(m, invId),
        await removeMember(m, otherSeat),
        await removeMember(m, memberSeat),       // not even their own seat through this route
      ]) {
        expect(r.status).toBe(403);
        expect(r.body.ok).toBe(false);
      }
      const t = (await getTeam(o)).body.team;
      expect(t.members).toHaveLength(2);
      expect(t.invitations).toHaveLength(1);
      expect((await scenariosOf(m)).status).toBe(200);
      expect((await scenariosOf(other)).status).toBe(200);
    });

    it("the billing owner cannot be removed or locked out through the member routes", async () => {
      const o = owner(), m = person();
      const sub = await subscribe(o, "team");
      await seat(o, m);
      expect((await removeMember(o, sub.id)).status).toBe(404);          // the subscription id is not a seat
      expect((await removeMember(o, "not-a-uuid")).status).toBe(400);
      expect((await invite(o, o)).body.reason).toBe("is_owner");
      expect((await getTeam(o)).status).toBe(200);
      expect((await scenariosOf(o)).status).toBe(200);
      // a member cannot take control by being an "owner" of someone else's id either
      expect((await getTeam(m)).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------------- 11-13: entitlement

  describe("entitlement on every protected route", () => {
    it("an accepted member gets the dashboard routes, and the status says whose subscription it is", async () => {
      const o = owner(), m = person();
      await subscribe(o, "team");
      expect((await scenariosOf(m)).status).toBe(402);
      expect((await status(m)).body).toMatchObject({ active: false });
      await seat(o, m);
      expect((await scenariosOf(m)).status).toBe(200);
      expect((await saveScenario(m)).status).toBe(200);
      expect((await scenariosOf(m)).body.scenarios).toHaveLength(1);
      expect((await siting(m)).status).toBe(200);
      expect((await status(m)).body).toMatchObject({ ok: true, active: true, plan: "team", role: "member", ownerEmail: o });
      expect((await scenariosOf(o)).body.scenarios).toHaveLength(0);     // a member's saved work is theirs, not shared with the owner
    });

    it("removing a member ends their access on the very next request, on every route, with the same session", async () => {
      const o = owner(), m = person();
      await subscribe(o, "team");
      const id = await seat(o, m);
      expect((await scenariosOf(m)).status).toBe(200);
      expect((await removeMember(o, id)).status).toBe(200);
      expect((await scenariosOf(m)).status).toBe(402);
      expect((await saveScenario(m)).status).toBe(402);
      expect((await siting(m)).status).toBe(402);
      expect((await status(m)).body).toMatchObject({ active: false });
      expect((await getTeam(m)).status).toBe(402);
      // and the freed seat is real
      expect((await getTeam(o)).body.team).toMatchObject({ used: 1, available: 4 });
    });

    it("existing single-subscriber behaviour is unchanged for an owner", async () => {
      const o = owner();
      await subscribe(o, "developer");
      expect((await status(o)).body).toEqual({ ok: true, active: true, plan: "developer", role: "owner" });
      expect((await saveScenario(o)).status).toBe(200);
      expect((await scenariosOf(o)).body.scenarios).toHaveLength(1);
      expect((await siting(o)).status).toBe(200);
      expect((await status(person())).body).toEqual({ ok: true, active: false });
    });

    it("past_due keeps the owner's and the members' access; cancelled takes all of it away", async () => {
      const o = owner(), m = person();
      const sub = await subscribe(o, "team");
      await seat(o, m);

      expect(await updateSubscription(sub.id, { status: "past_due" })).toBe(true);
      expect((await scenariosOf(o)).status).toBe(200);
      expect((await scenariosOf(m)).status).toBe(200);
      expect((await getTeam(o)).status).toBe(200);

      expect(await updateSubscription(sub.id, { status: "cancelled" })).toBe(true);
      expect((await scenariosOf(o)).status).toBe(402);
      expect((await scenariosOf(m)).status).toBe(402);
      expect((await siting(m)).status).toBe(402);
      expect((await status(m)).body).toMatchObject({ active: false });
      expect((await getTeam(o)).status).toBe(402);               // a cancelled owner cannot manage seats
      expect((await invite(o, person())).status).toBe(402);

      expect(await updateSubscription(sub.id, { status: "active" })).toBe(true);   // reinstated: the seats were never destroyed
      expect((await scenariosOf(m)).status).toBe(200);
    });

    it("an invitation to a cancelled subscription grants nothing and stays unredeemed", async () => {
      const o = owner(), g = person();
      const sub = await subscribe(o, "team");
      expect((await invite(o, g)).status).toBe(201);
      const secret = tokenSentTo(g);
      await updateSubscription(sub.id, { status: "cancelled" });
      const r = await redeem(g, "accept", secret);
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe("inactive");
      expect((await redeem(g, "preview", secret)).body.reason).toBe("inactive");
      expect((await scenariosOf(g)).status).toBe(402);
      expect((await table("subscription_members")).filter((x) => x.owner_email === o)).toHaveLength(0);
    });

    it("an upgrade keeps the team: the superseded row's members follow the owner to the new subscription", async () => {
      const o = owner(), m = person();
      await subscribe(o, "team");
      await seat(o, m);
      await subscribe(o, "enterprise");                           // recordSubscription supersedes the old row and inserts a new one
      expect((await scenariosOf(m)).status).toBe(200);
      expect((await status(m)).body).toMatchObject({ plan: "enterprise", role: "member" });
      expect((await getTeam(o)).body.team).toMatchObject({ plan: "enterprise", seats: null, used: 2 });
    });

    it("a downgrade honours seats oldest first and suspends the rest; the roster says which", async () => {
      const o = owner();
      const sub = await subscribe(o, "enterprise");
      const people = Array.from({ length: 6 }, () => person());
      for (const p of people) await seat(o, p);                   // sequential: each seat is taken after the previous commits
      for (const p of people) expect((await scenariosOf(p)).status).toBe(200);

      expect(await updateSubscription(sub.id, { plan: "team" })).toBe(true);
      const t = (await getTeam(o)).body.team;
      expect(t).toMatchObject({ seats: 5, used: 7, available: 0 });
      expect(t.members.map((x: any) => x.seatActive)).toEqual([true, true, true, true, false, false]);
      const statuses = await Promise.all(people.map(async (p) => (await scenariosOf(p)).status));
      expect(statuses).toEqual([200, 200, 200, 200, 402, 402]);

      expect(await updateSubscription(sub.id, { plan: "developer" })).toBe(true);
      for (const p of people) expect((await scenariosOf(p)).status).toBe(402);   // developer is the owner alone
      expect((await scenariosOf(o)).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------------------------------------- 10: concurrency

  describe("concurrency", () => {
    it("parallel acceptances cannot oversubscribe a Team plan", async () => {
      const o = owner();
      const sub = await subscribe(o, "enterprise");
      const guests = Array.from({ length: 8 }, () => person());
      for (const g of guests) expect((await invite(o, g)).status).toBe(201);   // eight open offers: legal on an uncapped plan
      expect(await updateSubscription(sub.id, { plan: "team" })).toBe(true);   // the plan now holds five seats, owner included
      const tokens = guests.map(tokenSentTo);

      const results = await Promise.all(guests.map((g, i) => redeem(g, "accept", tokens[i])));
      const ok = results.filter((r) => r.status === 200);
      const refused = results.filter((r) => r.status === 409);
      expect(ok).toHaveLength(4);
      expect(refused).toHaveLength(4);
      expect(refused.every((r) => r.body.reason === "no_seats")).toBe(true);

      const members = (await table("subscription_members")).filter((x) => x.owner_email === o && !x.removed_at);
      expect(members).toHaveLength(4);                                          // owner + 4 = 5, never 6+
      expect((await getTeam(o)).body.team).toMatchObject({ seats: 5, used: 5 });
      const entitled = await Promise.all(guests.map(async (g) => (await scenariosOf(g)).status));
      expect(entitled.filter((s) => s === 200)).toHaveLength(4);
    });

    it("parallel acceptances on a Developer plan seat nobody", async () => {
      const o = owner();
      const sub = await subscribe(o, "enterprise");
      const guests = [person(), person(), person()];
      for (const g of guests) expect((await invite(o, g)).status).toBe(201);
      expect(await updateSubscription(sub.id, { plan: "developer" })).toBe(true);
      const results = await Promise.all(guests.map((g) => redeem(g, "accept", tokenSentTo(g))));
      expect(results.every((r) => r.status === 409 && r.body.reason === "no_seats")).toBe(true);
      expect((await table("subscription_members")).filter((x) => x.owner_email === o)).toHaveLength(0);
    });

    it("parallel invitations cannot promise more seats than the plan has", async () => {
      const o = owner();
      await subscribe(o, "team");
      const results = await Promise.all(Array.from({ length: 12 }, () => invite(o, person())));
      expect(results.filter((r) => r.status === 201)).toHaveLength(4);
      expect(results.filter((r) => r.status === 409 && r.body.reason === "no_seats")).toHaveLength(8);
      expect((await getTeam(o)).body.team).toMatchObject({ reserved: 4, available: 0 });
      expect((await table("subscription_invitations")).filter((i) => i.owner_email === o && i.status === "pending")).toHaveLength(4);
    });

    it("the same invitation accepted twice at once seats one person once", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      expect((await invite(o, g)).status).toBe(201);
      const secret = tokenSentTo(g);
      const results = await Promise.all(Array.from({ length: 6 }, () => redeem(g, "accept", secret)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409 && r.body.reason === "used")).toHaveLength(5);
      expect((await getTeam(o)).body.team.members).toHaveLength(1);
    });

    it("the same address invited twice at once holds one offer", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      const results = await Promise.all([invite(o, g), invite(o, g), invite(o, g)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.body.reason === "already_invited")).toHaveLength(2);
    });

    it("accepting while the owner revokes ends in exactly one consistent state", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      expect((await invite(o, g)).status).toBe(201);
      const secret = tokenSentTo(g);
      const id = (await getTeam(o)).body.team.invitations[0].id;
      const [a, r] = await Promise.all([redeem(g, "accept", secret), revoke(o, id)]);
      const member = (await table("subscription_members")).filter((x) => x.owner_email === o && !x.removed_at).length;
      // either the accept won (member exists, revoke finds nothing pending) or the revoke won (no member, accept refused)
      expect([a.status, r.status]).toEqual(member === 1 ? [200, 404] : [410, 200]);
      expect((await scenariosOf(g)).status).toBe(member === 1 ? 200 : 402);
    });
  });

  // ------------------------------------------------------------------------------------------------- the durable email

  describe("the invitation email is a durable obligation", () => {
    const makeDue = async (invitationId: string) => {
      const r = await rest("PATCH", `customer_notifications?subject_id=eq.${invitationId}`, { next_attempt_at: new Date(0).toISOString(), claimed_until: null });
      expect(r.ok).toBe(true);
    };

    it("a provider outage at invite time does not lose it: the sweep sends the same link once the provider is back", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      h.mailDown = true;
      const r = await invite(o, g);
      expect(r.status).toBe(201);                                  // the invitation exists; the email is queued, not lost
      expect(h.mail).toHaveLength(0);
      const note = (await table("customer_notifications")).find((n) => n.subject_id === r.body.invitationId)!;
      expect(note).toMatchObject({ kind: "team_invitation", status: "pending" });

      h.mailDown = false;
      await makeDue(r.body.invitationId);
      await sweepNotifications(50);
      const secret = tokenSentTo(g);
      expect((await redeem(g, "accept", secret)).status).toBe(200);
      expect(h.mail.filter((m) => ([] as string[]).concat(m.to).includes(g))).toHaveLength(1);
    });

    it("an invitation revoked before its email went out is cancelled, never mailed", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      h.mailDown = true;
      const r = await invite(o, g);
      expect(r.status).toBe(201);
      expect((await revoke(o, r.body.invitationId)).status).toBe(200);
      h.mailDown = false;
      await makeDue(r.body.invitationId);
      await sweepNotifications(50);
      expect(h.mail.filter((m) => ([] as string[]).concat(m.to).includes(g))).toHaveLength(0);
      const note = (await table("customer_notifications")).find((n) => n.subject_id === r.body.invitationId)!;
      expect(note.status).toBe("cancelled");
    });
  });

  // ------------------------------------------------------------------------------------------------- 14: failure

  describe("an unavailable store fails safely", () => {
    it("never answers 'no members', 'not a subscriber' or 'accepted' for a store it could not ask", async () => {
      const o = owner(), m = person(), g = person();
      await subscribe(o, "team");
      await seat(o, m);
      expect((await invite(o, g)).status).toBe(201);
      const secret = tokenSentTo(g);
      const id = (await getTeam(o)).body.team.invitations[0].id;

      h.outage = true;
      for (const r of [
        await getTeam(o),
        await invite(o, person()),
        await revoke(o, id),
        await removeMember(o, id),
        await redeem(g, "accept", secret),
        await redeem(g, "preview", secret),
        await scenariosOf(m),
        await saveScenario(m),
        await siting(m),
        await status(m),
        await status(o),
      ]) {
        expect(r.status, JSON.stringify(r.body)).toBe(503);
        expect(r.body.ok).toBe(false);
      }
      h.outage = false;

      // nothing was granted, nothing was lost
      expect((await scenariosOf(g)).status).toBe(402);
      expect((await scenariosOf(m)).status).toBe(200);
      expect((await getTeam(o)).body.team).toMatchObject({ reserved: 1 });
      expect((await redeem(g, "accept", secret)).status).toBe(200);
    });

    it("an invitation whose first email attempt cannot be recorded still exists with its obligation, says the email is only queued, and is sent by the sweep", async () => {
      const o = owner(), g = person();
      await subscribe(o, "team");
      h.failOutbox = true;                                         // the application's own outbox writes fail; the obligation was written with the invitation
      const r = await invite(o, g);
      h.failOutbox = false;
      expect(r.status).toBe(201);
      expect(r.body.delivery).toBe("queued");                      // not "sent": nothing went out
      expect(h.mail.filter((m) => ([] as string[]).concat(m.to).includes(g))).toHaveLength(0);
      const note = (await table("customer_notifications")).find((n) => n.subject_id === r.body.invitationId)!;
      expect(note).toMatchObject({ kind: "team_invitation", status: "pending" });
      await sweepNotifications(50);
      expect((await redeem(g, "accept", tokenSentTo(g))).status).toBe(200);
    });

    it("reports 'sent' only when the provider accepted the message", async () => {
      const o = owner();
      await subscribe(o, "team");
      expect((await invite(o, person())).body.delivery).toBe("sent");
      h.mailDown = true;
      expect((await invite(o, person())).body.delivery).toBe("queued");
    });
  });
}
