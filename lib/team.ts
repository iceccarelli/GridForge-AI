// Server-only: GridForge Intelligence seats — who the billing owner has let in (migration 0027).
//
// lib/products.ts declares how many seats each plan has. This module is where that number stops being a label:
//
//   - The owner is the subscription's billing address and is always one seat. Developer 1, Team 5, Enterprise unlimited.
//   - Inviting reserves a seat; accepting claims it; removing or revoking frees it. All of it runs inside the database
//     (gf_invite_member / gf_accept_invitation) under a row lock on the owner's subscription, so two people racing for
//     the last seat cannot both get it. Nothing here counts seats in TypeScript and then writes: a check-then-write in
//     this layer would be exactly the race the database closes.
//   - The seat limit is never read from the request. The caller is the verified Supabase identity; the subscription is
//     looked up for that identity; the plan comes from that row.
//
// Every function answers "could not ask" (`ok: false, status: 503`) apart from "asked and refused", and none returns an
// empty success for an unreachable store.

import { NextResponse } from "next/server";
import { identify } from "@/lib/portal";
import { rpc } from "@/lib/pgrest";
import { ensureNotification } from "@/lib/notifications";
import { inviteToken, hashInviteToken, isInviteToken } from "@/lib/team-token";
import {
  lookupEntitlement,
  normaliseEmail,
  subscriptionsConfigured,
  type SubscriptionRecord,
} from "@/lib/subscribers";

/** How long an invitation stays open. The database refuses anything beyond 30 days whatever this says. */
export const INVITATION_TTL_DAYS = 7;

const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export function validEmail(v: string): boolean {
  return v.length <= MAX_EMAIL && EMAIL.test(v);
}

export interface TeamMember {
  id: string;
  email: string;
  addedAt: string;
  /** false when the owner moved to a smaller plan and this seat is beyond it: listed, but not entitled. */
  seatActive: boolean;
}

export interface TeamInvitation {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

export interface TeamOverview {
  owner: string;
  plan: string;
  status: string;
  /** null = unlimited. */
  seats: number | null;
  /** The owner plus every member. */
  used: number;
  /** Open invitations: each holds a seat until it is accepted, revoked or expires. */
  reserved: number;
  /** null = unlimited. */
  available: number | null;
  members: TeamMember[];
  invitations: TeamInvitation[];
}

export type Fail = { ok: false; status: number; error: string; reason?: string };
type Done<T> = ({ ok: true } & T) | Fail;

const UNAVAILABLE: Fail = { ok: false, status: 503, error: "Team membership is unavailable just now. Nothing was changed." };

function fail(status: number, error: string, reason?: string): Fail {
  return { ok: false, status, error, reason };
}

// --------------------------------------------------------------------------------------------------- the owner's door

export type OwnerContext =
  | { ok: true; email: string; subscription: SubscriptionRecord }
  | { ok: false; response: NextResponse };

const deny = (status: number, error: string): { ok: false; response: NextResponse } => ({
  ok: false,
  response: NextResponse.json({ ok: false, error }, { status }),
});

/**
 * Who is asking, and are they the billing owner of an entitling subscription?
 *
 * Identity is the verified bearer token and nothing else: no owner id, email or plan is read from the request. A member
 * of someone else's subscription is refused (403), so a seat never confers any control over seats; a non-subscriber is a
 * 402; a store we could not ask is a 503 and never a claim about the customer.
 */
export async function ownerContext(req: Request): Promise<OwnerContext> {
  const who = await identify(req);
  if (!who.ok) return deny(who.status, who.error);
  if (!who.verified) return deny(403, "Confirm your email address by signing in with the emailed link, then try again.");
  if (!subscriptionsConfigured()) return deny(503, "Team membership is unavailable just now.");
  const found = await lookupEntitlement(who.email);
  if (!found.reachable) return deny(503, "Team membership is unavailable just now.");
  if (!found.entitlement) return deny(402, "An active GridForge Intelligence subscription is required.");
  if (found.entitlement.role !== "owner") return deny(403, "Only the billing owner can manage seats.");
  return { ok: true, email: who.email, subscription: found.entitlement.subscription };
}

// --------------------------------------------------------------------------------------------------- the owner's view

interface OverviewRow {
  subscription: { id: string; plan: string; status: string };
  seats: number | null;
  members: { id: string; email: string; added_at: string; seat_active: boolean }[];
  invitations: { id: string; email: string; created_at: string; expires_at: string }[];
}

export async function teamOverview(owner: string): Promise<Done<{ overview: TeamOverview }>> {
  const o = normaliseEmail(owner);
  const r = await rpc<OverviewRow | null>("gf_team_overview", { p_owner: o });
  if (!r.ok) return UNAVAILABLE;
  if (!r.data) return fail(402, "An active GridForge Intelligence subscription is required.");
  const d = r.data;
  const used = 1 + d.members.length;
  const reserved = d.invitations.length;
  return {
    ok: true,
    overview: {
      owner: o,
      plan: d.subscription.plan,
      status: d.subscription.status,
      seats: d.seats,
      used,
      reserved,
      available: d.seats === null ? null : Math.max(0, d.seats - used - reserved),
      members: d.members.map((m) => ({ id: m.id, email: m.email, addedAt: m.added_at, seatActive: m.seat_active })),
      invitations: d.invitations.map((i) => ({ id: i.id, email: i.email, createdAt: i.created_at, expiresAt: i.expires_at })),
    },
  };
}

// --------------------------------------------------------------------------------------------------- invite / revoke / remove

const INVITE_REFUSALS: Record<string, [number, string]> = {
  invalid_email: [400, "Enter a valid email address."],
  no_subscription: [402, "An active GridForge Intelligence subscription is required."],
  is_owner: [400, "That is the billing owner's own address; the owner already holds a seat."],
  already_member: [409, "That person already has a seat."],
  already_invited: [409, "That person already has an open invitation. Revoke it first if you want to send a new one."],
  no_seats: [409, "Every seat on this plan is taken or reserved by an open invitation. Remove a member or revoke an invitation first."],
};

export async function inviteMember(owner: string, rawEmail: unknown): Promise<Done<{ invitationId: string; expiresAt: string; delivery: "sent" | "queued" }>> {
  const email = normaliseEmail(rawEmail);
  if (!email || !validEmail(email)) return fail(400, "Enter a valid email address.", "invalid_email");

  const id = crypto.randomUUID();
  const secret = inviteToken(id);
  if (!secret) return fail(503, "Invitations are not configured on this deployment. Nothing was sent.");

  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000).toISOString();
  const r = await rpc<{ ok: boolean; reason?: string; invitation_id?: string; expires_at?: string }>("gf_invite_member", {
    p_owner: normaliseEmail(owner),
    p_invitee: email,
    p_id: id,
    p_token_hash: hashInviteToken(secret),
    p_expires_at: expiresAt,
  });
  if (!r.ok) return UNAVAILABLE;
  if (!r.data?.ok) {
    const [status, message] = INVITE_REFUSALS[r.data?.reason ?? ""] ?? [409, "The invitation could not be created."];
    return fail(status, message, r.data?.reason);
  }

  // The invitation and the obligation to email it were written in one transaction (gf_invite_member), so there is nothing to
  // compensate if the first attempt cannot be made: the cron sweep retries it. What the owner is told must be true, so the
  // outcome of the first attempt is reported rather than assumed.
  const attempt = await ensureNotification("team_invitation", id).catch(() => null);
  const delivery: "sent" | "queued" = attempt?.state === "accepted" ? "sent" : "queued";
  return { ok: true, invitationId: id, expiresAt: r.data.expires_at ?? expiresAt, delivery };
}

export async function revokeInvitation(owner: string, invitationId: string): Promise<Done<object>> {
  if (!isUuid(invitationId)) return fail(400, "A valid invitation id is required.");
  const r = await rpc<{ ok: boolean }>("gf_revoke_invitation", { p_owner: normaliseEmail(owner), p_invitation: invitationId });
  if (!r.ok) return UNAVAILABLE;
  // Somebody else's invitation, one already used, one that never existed: the same answer.
  if (!r.data?.ok) return fail(404, "No such open invitation.");
  return { ok: true };
}

export async function removeMember(owner: string, memberId: string): Promise<Done<object>> {
  if (!isUuid(memberId)) return fail(400, "A valid member id is required.");
  const r = await rpc<{ ok: boolean }>("gf_remove_member", { p_owner: normaliseEmail(owner), p_member: memberId });
  if (!r.ok) return UNAVAILABLE;
  if (!r.data?.ok) return fail(404, "No such member.");
  return { ok: true };
}

// --------------------------------------------------------------------------------------------------- the invitee's side

export type RedeemAction = "preview" | "accept" | "decline";

const REDEEM_REFUSALS: Record<string, [number, string]> = {
  invalid: [404, "This invitation is not valid for the account you are signed in with."],
  used: [409, "This invitation has already been accepted."],
  declined: [409, "This invitation was declined."],
  revoked: [410, "The owner withdrew this invitation."],
  expired: [410, "This invitation has expired. Ask the owner to send a new one."],
  inactive: [409, "The subscription this invitation belongs to is not active, so it grants no access."],
  no_seats: [409, "Every seat on this subscription is taken. Ask the owner to free one."],
};

const REDEEM_RPC: Record<RedeemAction, string> = {
  preview: "gf_invitation_preview",
  accept: "gf_accept_invitation",
  decline: "gf_decline_invitation",
};

/**
 * Preview, accept or decline an invitation as the person signed in.
 *
 * `email` is the VERIFIED address from the bearer token. The database requires it to equal the invited address, and answers a
 * wrong address exactly as it answers an unknown secret, so a stranger learns nothing about who was invited.
 */
export async function redeemInvitation(
  action: RedeemAction,
  verifiedEmail: string,
  token: unknown
): Promise<Done<{ ownerEmail?: string; plan?: string; expiresAt?: string }>> {
  if (!isInviteToken(token)) return fail(404, REDEEM_REFUSALS.invalid[1], "invalid");
  const r = await rpc<{ ok: boolean; reason?: string; owner_email?: string; plan?: string; expires_at?: string }>(
    REDEEM_RPC[action],
    { p_token_hash: hashInviteToken(token), p_email: normaliseEmail(verifiedEmail) }
  );
  if (!r.ok) return UNAVAILABLE;
  if (!r.data?.ok) {
    const [status, message] = REDEEM_REFUSALS[r.data?.reason ?? ""] ?? [409, "This invitation cannot be used."];
    return fail(status, message, r.data?.reason);
  }
  return { ok: true, ownerEmail: r.data.owner_email, plan: r.data.plan, expiresAt: r.data.expires_at };
}
