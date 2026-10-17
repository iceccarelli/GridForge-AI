/**
 * The gf_* functions of 0027_team_seats.sql, restated against the in-memory fake.
 *
 * SUPPLEMENTAL, not verification: this lets the route tests run where there is no database. That the REAL functions are atomic,
 * that two people racing for the last seat cannot both get it, and that single-use / immutability are enforced by PostgreSQL
 * is proven against a real PostgreSQL in tests/test_team_seats_migration.py and tests/site/team-seats.realdb.test.ts, which run
 * the same scenarios (tests/site/team-scenarios.ts) through PostgREST.
 */
import { PgError, type PostgrestFake, type Row } from "./postgrest-fake";

export const PLAN_SEATS: Record<string, number | null> = { developer: 1, team: 5, enterprise: null };
export const planSeats = (plan: unknown): number | null => (typeof plan === "string" && plan in PLAN_SEATS ? PLAN_SEATS[plan] : 1);

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
const ENTITLING = new Set(["active", "past_due"]);

export function installTeamRpcs(db: PostgrestFake): void {
  db.createTable("subscriptions");
  db.createTable("subscription_invitations");
  db.createTable("subscription_members");
  db.uniqueKeys.set("subscription_invitations", [["token_hash"]]);

  const entitling = (owner: string): Row | undefined =>
    db.rows("subscriptions")
      .filter((s) => s.email === owner && ENTITLING.has(String(s.status)))
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
  const members = (owner: string) => db.rows("subscription_members").filter((m) => m.owner_email === owner && !m.removed_at);
  const pending = (owner: string) => db.rows("subscription_invitations").filter((i) => i.owner_email === owner && i.status === "pending");
  const expired = (i: Row) => i.status === "expired" || new Date(String(i.expires_at)).getTime() <= Date.now();
  const stateReason = (i: Row): string | null =>
    i.status === "accepted" ? "used" : i.status === "declined" ? "declined" : i.status === "revoked" ? "revoked" : expired(i) ? "expired" : null;

  db.rpcs.set("gf_invite_member", ({ p_owner, p_invitee, p_id, p_token_hash, p_expires_at }) => {
    const o = lower(p_owner), e = lower(p_invitee);
    const exp = new Date(p_expires_at).getTime();
    if (!(exp > Date.now()) || exp > Date.now() + 30 * 86_400_000) throw new PgError("22023", "p_expires_at must be within the next 30 days", 400);
    if (e.indexOf("@") <= 0 || e.length > 254 || /\s/.test(e)) return { ok: false, reason: "invalid_email" };
    const s = entitling(o);
    if (!s) return { ok: false, reason: "no_subscription" };
    if (e === o) return { ok: false, reason: "is_owner" };
    for (const i of pending(o)) if (new Date(String(i.expires_at)).getTime() <= Date.now()) i.status = "expired";
    if (members(o).some((m) => m.email === e)) return { ok: false, reason: "already_member" };
    if (pending(o).some((i) => i.email === e)) return { ok: false, reason: "already_invited" };
    const seats = planSeats(s.plan);
    const m = members(o).length, p = pending(o).length;
    if (seats !== null && 1 + m + p >= seats) return { ok: false, reason: "no_seats", seats, used: 1 + m, reserved: p };
    const row = db.insertRow("subscription_invitations", {
      id: p_id, owner_email: o, email: e, token_hash: p_token_hash, status: "pending", expires_at: new Date(exp).toISOString(),
      accepted_at: null, revoked_at: null, declined_at: null,
    });
    // The obligation to email it is written in the same transaction (rolled back with it if anything above throws).
    if (db.tables.has("customer_notifications") && !db.rows("customer_notifications").some((n) => n.dedupe_key === `team_invitation:${row.id}`)) {
      db.insertRow("customer_notifications", { dedupe_key: `team_invitation:${row.id}`, kind: "team_invitation", subject_table: "subscription_invitations", subject_id: row.id });
    }
    return { ok: true, invitation_id: row.id, expires_at: row.expires_at };
  });

  const find = (hash: string, email: string): Row | null => {
    const inv = db.rows("subscription_invitations").find((i) => i.token_hash === hash);
    return inv && inv.email === lower(email) ? inv : null;
  };

  db.rpcs.set("gf_invitation_preview", ({ p_token_hash, p_email }) => {
    const inv = find(p_token_hash, p_email);
    if (!inv) return { ok: false, reason: "invalid" };
    const why = stateReason(inv);
    if (why) return { ok: false, reason: why };
    const s = entitling(String(inv.owner_email));
    if (!s) return { ok: false, reason: "inactive" };
    return { ok: true, owner_email: inv.owner_email, plan: s.plan, expires_at: inv.expires_at };
  });

  db.rpcs.set("gf_accept_invitation", ({ p_token_hash, p_email }) => {
    const inv = find(p_token_hash, p_email);
    if (!inv) return { ok: false, reason: "invalid" };
    const s = entitling(String(inv.owner_email));
    const why = stateReason(inv);
    if (why === "expired") { if (inv.status === "pending") inv.status = "expired"; return { ok: false, reason: why }; }
    if (why) return { ok: false, reason: why };
    if (!s) return { ok: false, reason: "inactive" };
    const owner = String(inv.owner_email), e = lower(p_email);
    const seats = planSeats(s.plan);
    const already = members(owner).some((m) => m.email === e);
    if (!already && seats !== null && 1 + members(owner).length + 1 > seats) return { ok: false, reason: "no_seats", seats, used: 1 + members(owner).length };
    if (!already) db.insertRow("subscription_members", { owner_email: owner, email: e, invitation_id: inv.id, added_at: new Date().toISOString(), removed_at: null });
    inv.status = "accepted"; inv.accepted_at = new Date().toISOString();
    return { ok: true, owner_email: owner, plan: s.plan, invitation_id: inv.id };
  });

  db.rpcs.set("gf_decline_invitation", ({ p_token_hash, p_email }) => {
    const inv = find(p_token_hash, p_email);
    if (!inv) return { ok: false, reason: "invalid" };
    const why = stateReason(inv);
    if (why === "expired") { if (inv.status === "pending") inv.status = "expired"; return { ok: false, reason: why }; }
    if (why) return { ok: false, reason: why };
    inv.status = "declined"; inv.declined_at = new Date().toISOString();
    return { ok: true };
  });

  db.rpcs.set("gf_revoke_invitation", ({ p_owner, p_invitation }) => {
    const inv = db.rows("subscription_invitations").find((i) => i.id === p_invitation && i.owner_email === lower(p_owner) && i.status === "pending");
    if (!inv) return { ok: false, reason: "not_pending" };
    inv.status = "revoked"; inv.revoked_at = new Date().toISOString();
    return { ok: true, reason: null };
  });

  db.rpcs.set("gf_remove_member", ({ p_owner, p_member }) => {
    const m = db.rows("subscription_members").find((x) => x.id === p_member && x.owner_email === lower(p_owner) && !x.removed_at);
    if (!m) return { ok: false, reason: "not_a_member" };
    m.removed_at = new Date().toISOString();
    return { ok: true, reason: null };
  });

  db.rpcs.set("gf_team_overview", ({ p_owner }) => {
    const o = lower(p_owner);
    const s = entitling(o);
    if (!s) return null;
    const seats = planSeats(s.plan);
    const ms = members(o).sort((a, b) => String(a.added_at).localeCompare(String(b.added_at)) || String(a.id).localeCompare(String(b.id)));
    return {
      subscription: { id: s.id, plan: s.plan, status: s.status },
      seats,
      members: ms.map((m, i) => ({ id: m.id, email: m.email, added_at: m.added_at, seat_active: seats === null || i + 1 <= seats - 1 })),
      invitations: pending(o).filter((i) => new Date(String(i.expires_at)).getTime() > Date.now())
        .map((i) => ({ id: i.id, email: i.email, created_at: i.created_at, expires_at: i.expires_at })),
    };
  });

  db.rpcs.set("gf_member_entitlement", ({ p_email }) => {
    const e = lower(p_email);
    if (!e) return null;
    let best: Row | null = null;
    for (const m of db.rows("subscription_members").filter((x) => x.email === e && !x.removed_at)) {
      const s = entitling(String(m.owner_email));
      if (!s) continue;
      const seats = planSeats(s.plan);
      const order = members(String(m.owner_email)).sort((a, b) => String(a.added_at).localeCompare(String(b.added_at)) || String(a.id).localeCompare(String(b.id)));
      const rn = order.findIndex((x) => x.id === m.id) + 1;
      if (seats !== null && rn > seats - 1) continue;
      if (!best || String(s.created_at) > String(best.created_at)) best = s;
    }
    return best ? { owner_email: best.email, subscription: best } : null;
  });
}
