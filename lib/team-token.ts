// Server-only: the secret in a team-invitation link, and the hash the database keeps of it.
//
// The durable email outbox (lib/notifications.ts, migration 0021) deliberately stores no token: a message is rebuilt from the
// business row at send time, so a capability link is never copied into a queue or a log. An invitation therefore cannot carry a
// random secret that only exists in memory at creation. It carries one DERIVED from the invitation's id under a server key:
//
//   token      = base64url(HMAC-SHA256(key, "team-invitation:" + invitation id))     what the invitee is emailed
//   token_hash = hex(SHA-256(token))                                                 the only thing the database stores
//
// A database reader has the hash and the id but not the key, so cannot open a link; the key holder can rebuild the message for a
// retry, which is the whole point of the outbox. The key is INTELLIGENCE_INVITE_SECRET when set (32+ characters), else derived
// from SUPABASE_SERVICE_ROLE_KEY with its own label, as lib/rate-limit.ts does for its pseudonyms. Changing either orphans the
// invitations that are open at that moment (their links stop matching their hash): the owner revokes and invites again. Nothing
// already accepted is affected, because membership does not depend on the token.

import crypto from "node:crypto";

/** A token as this module mints it: 32 bytes, base64url. Anything else is not one, and is never hashed or looked up. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function key(): Buffer | null {
  const dedicated = process.env.INTELLIGENCE_INVITE_SECRET;
  if (dedicated && dedicated.length >= 32) {
    return crypto.createHash("sha256").update(`gf-team-invite-key-v2:${dedicated}`).digest();
  }
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return service ? crypto.createHash("sha256").update(`gf-team-invite-v1:${service}`).digest() : null;
}

/** The secret for one invitation, or null when this deployment has no key to derive it from (invitations then fail closed). */
export function inviteToken(invitationId: string): string | null {
  const k = key();
  if (!k || !invitationId) return null;
  return crypto.createHmac("sha256", k).update(`team-invitation:${invitationId}`).digest("base64url");
}

export function isInviteToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN.test(v);
}

export function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
