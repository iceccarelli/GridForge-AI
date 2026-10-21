// Server-only: the customer emails that carry a buyer's only way in (migration 0021).
//
// The business record (deliverable / API account / watch / subscription) is the system of record and is
// written first, idempotently. A `customer_notifications` row is the durable obligation to tell the buyer
// about it. The row holds NO recipient, token or body: the message is rebuilt from the CURRENT business row
// at send time, so a capability link is never copied into a queue, a log, or an operator email, and a stale
// obligation (key already rotated, subscription replaced) is cancelled instead of sent.
//
//   pending ──attempt──> accepted    the provider ACCEPTED it, and we durably recorded that. It is NOT
//                                    "the inbox received it": no delivery/bounce event is consumed.
//   pending ──attempt──> pending     temporary failure: bounded backoff; retried by a webhook redelivery,
//                                    the cron sweep, or an operator
//   pending ───────────> ambiguous   an attempt's outcome is unknown and the provider's 24 h idempotency
//                                    window has passed: a person decides (confirm sent / send again)
//   pending ───────────> abandoned   attempts exhausted, or a permanent refusal: an operator is told once
//   pending ───────────> cancelled   the obligation no longer applies
//
// Provider vs database: an attempt first stamps `last_error='in_flight'` under a lease. If the provider
// accepts but the database write that records it fails, the row stays pending/in_flight, the outcome is
// reported as `accepted_unrecorded` (never as accepted), and the retry reuses the same Idempotency-Key so the
// provider returns the original result without sending again -- inside its window. Past the window it
// becomes `ambiguous`. Exactly-once is NOT claimed.
//
// Until migration 0021 is applied the table is absent. The first delivery then falls back to one direct send
// (not recoverable: there is no obligation to retry), and a REPLAY does nothing -- it must not guess.

import { sendMail, notifyOperator, type MailResult } from "@/lib/mail";
import { SITE_URL } from "@/lib/site";
import { keyLife } from "@/lib/api-access";
import { creds } from "@/lib/projects";
import { inviteToken } from "@/lib/team-token";
import { PAYG, eurText, utcMonth } from "@/lib/payg";
import { usageNet } from "@/lib/payg-usage";

export const NOTIFICATION_KINDS = ["intake_link", "api_access_link", "watch_link", "key_rotation", "subscription_welcome", "team_invitation", "usage_alert"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
type SubjectTable = "deliverables" | "api_accounts" | "watches" | "subscriptions" | "subscription_invitations";
export type NotificationStatus = "pending" | "accepted" | "ambiguous" | "abandoned" | "cancelled";

const SUBJECT: Record<NotificationKind, SubjectTable> = {
  intake_link: "deliverables",
  api_access_link: "api_accounts",
  watch_link: "watches",
  key_rotation: "api_accounts",
  subscription_welcome: "subscriptions",
  team_invitation: "subscription_invitations",
  usage_alert: "api_accounts",
};

const LEASE_MS = 2 * 60_000;
/**
 * Resend remembers an Idempotency-Key for 24 h. A retry inside that window with the same key and payload is
 * answered with the ORIGINAL result and sends nothing. After it, a retry of an attempt whose outcome we never
 * learned could send a second copy, so past this margin such a notification becomes `ambiguous`.
 */
const IDEMPOTENCY_WINDOW_MS = 23 * 3_600_000;
/** After attempt N fails, wait this long (minutes). Index = attempts made. */
const BACKOFF_MIN = [0, 5, 15, 60, 240, 720];
const CONFIG_RETRY_MIN = 60;

export interface NotificationRow {
  id: string;
  dedupe_key: string;
  kind: NotificationKind;
  subject_table: SubjectTable;
  subject_id: string;
  status: NotificationStatus;
  origin: "webhook" | "operator_reconcile";
  reopened_count: number;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  claimed_until: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  last_http_status: number | null;
  provider_message_id: string | null;
  accepted_at: string | null;
  created_at: string;
}

/** What one attempt did. `accepted` = provider accepted AND we durably recorded it. */
export type Outcome =
  | { state: "accepted"; id: string }
  | { state: "accepted_unrecorded"; id: string }
  | { state: "pending"; id: string; category: string }
  | { state: "ambiguous"; id: string }
  | { state: "abandoned"; id: string; category: string }
  | { state: "cancelled"; id: string; why: string }
  | { state: "skipped"; id: string; why: "not_due" | "leased" | "not_pending" }
  | { state: "unavailable"; reason: "no_table" | "store_error" };

const enc = encodeURIComponent;
type Db = { url: string; headers: Record<string, string> };

async function db<T>(
  c: Db,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  prefer?: string
): Promise<{ ok: true; data: T } | { ok: false; status: number; missingTable: boolean }> {
  try {
    const res = await fetch(`${c.url}/rest/v1/${path}`, {
      method,
      headers: { ...c.headers, ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      // PGRST205 / 404 on this table = migration 0021 not applied yet. The body is never logged.
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, missingTable: res.status === 404 || text.includes("PGRST205") };
    }
    const text = await res.text();
    return { ok: true, data: (text ? JSON.parse(text) : null) as T };
  } catch {
    return { ok: false, status: 502, missingTable: false };
  }
}

// ---------------------------------------------------------------- messages (rebuilt from the business row)

interface Built { to: string; subject: string; text: string }

/** Raised when an obligation cannot be honoured YET: the record exists but something authoritative is missing. */
class Blocked extends Error {
  constructor(public category: "credential_missing") { super(category); }
}
/** The obligation no longer applies to the record's current state. */
class NotApplicable extends Error {
  constructor(public why: string) { super(why); }
}

/** A bearer token as this system mints it (24 random bytes, base64url). Anything else is not a credential. */
const TOKEN = /^[A-Za-z0-9_-]{16,}$/;
const credential = (v: unknown): string | null => (typeof v === "string" && TOKEN.test(v) ? v : null);

async function build(n: Pick<NotificationRow, "kind" | "subject_table" | "subject_id" | "dedupe_key">, c: Db): Promise<Built | "gone"> {
  const r = await db<Record<string, unknown>[]>(c, "GET", `${n.subject_table}?id=eq.${enc(n.subject_id)}&select=*&limit=1`);
  if (!r.ok) throw new Error(`subject lookup ${r.status}`);
  const row = r.data?.[0];
  if (!row) return "gone";
  const to = typeof row.email === "string" ? row.email : "";

  if (n.kind === "intake_link") {
    // The INTAKE credential only. There is deliberately no fallback to the document token: the document
    // token reads the released engineering document, the intake token only submits the hall's numbers
    // (migration 0012). A row without a valid, distinct intake token waits to be repaired; it never sends
    // the other credential.
    const intake = credential(row.intake_token);
    if (!intake || intake === row.token) throw new Blocked("credential_missing");
    if (row.status !== "awaiting_intake") throw new NotApplicable("intake already submitted");
    return {
      to,
      subject: "Your GridForge engagement — the numbers we need",
      text:
        "Thank you. The engagement is open.\n\n" +
        "The next step is the hall's own numbers. Everything you do not supply is filled " +
        "from a library default and named as an assumption in the deliverable, so the more " +
        "of it you complete, the fewer of your conclusions rest on our guesses.\n\n" +
        `${SITE_URL}/intake/${intake}` +
        "\n\nThe link is unguessable and specific to this engagement. Do not forward it to " +
        "anyone who should not read the result.",
    };
  }
  if (n.kind === "watch_link") {
    const token = credential(row.token);
    if (!token) throw new Blocked("credential_missing");
    if (row.status === "cancelled") throw new NotApplicable("watch cancelled");
    return {
      to,
      subject: "Your hall is now watched",
      text:
        "The model stays live from here.\n\n" +
        "Give it the hall's current numbers once, and from then on it is re-solved every " +
        "quarter and whenever you change an input. You get a change note naming what moved " +
        "and which input moved it — including when the movement came from our side because a " +
        "library or the constraint set was revised.\n\n" +
        `${SITE_URL}/watch/${token}` +
        "\n\nIf nothing material changes, we will tell you that in three lines rather than " +
        "send you a document to justify the fee.",
    };
  }
  if (n.kind === "api_access_link") {
    const token = credential(row.token);
    if (!token) throw new Blocked("credential_missing");
    if (row.status === "cancelled") throw new NotApplicable("subscription cancelled");
    const units = Number(row.monthly_units ?? 0);
    if (row.plan === "api_free") {
      return {
        to,
        subject: "Your free GridForge API allowance",
        text:
          "Your free allowance is ready. Open the link below to create your key:\n\n" +
          `${SITE_URL}/api-access/${token}` +
          "\n\nThis link is the email verification: the key is only ever issued from it, and it is shown once. We do not store it.\n\n" +
          `The allowance is ${PAYG.freeAllowanceUnits} units a month and is never invoiced. A constraint screen is 1 unit, a full solve ` +
          "is 5 and a portfolio run is 1 per hall; the free qualifier does not use the allowance. When the allowance is used up, requests " +
          "are refused with HTTP 402 (never silently charged). To go beyond it you choose to enable pay-as-you-go from the same page: " +
          `you set a hard monthly cap, a card is saved but nothing is charged when you save it, and usage is invoiced in arrears at ${eurText(PAYG.unitPriceCents)} per unit.\n\n` +
          "Screening-mode output is not an issued engineering opinion: it has no named signatory and no indemnity behind it. Every number " +
          "carries an evidence class and a provenance digest.\n\n" +
          "If you did not ask for this, ignore this message: nothing is created until you open the link.",
      };
    }
    return {
      to,
      subject: "Your GridForge API access is live",
      text:
        "Your key is waiting here:\n\n" +
        `${SITE_URL}/api-access/${token}` +
        "\n\nIt is shown once. We do not store it — the engine verifies it by its " +
        "signature, so there is no copy anywhere for anyone to take.\n\n" +
        `Your allowance is ${units.toLocaleString("en-IE")} units a month. A constraint ` +
        "screen is 1 unit, a full solve is 5, and a portfolio run is 1 per hall. The free " +
        "qualifier stays free and never touches the allowance. Rates are published at " +
        "/v1/version so you can price a job before you run it.\n\n" +
        "One thing worth reading before you integrate: every number we return carries an " +
        "evidence class and a provenance digest, and every response carries our calibration " +
        "state. Screening-mode output is not an issued engineering opinion — it has no named " +
        "signatory and no indemnity behind it. That distinction matters more inside an agent " +
        "loop than it does in a board pack, because nobody downstream reads the footnote.\n\n" +
        "Schemas: https://gridforge-engine.fly.dev/v1/tools\n" +
        "MCP:     https://gridforge-engine.fly.dev/mcp",
    };
  }
  if (n.kind === "subscription_welcome") {
    if (row.status === "superseded" || row.status === "cancelled") throw new NotApplicable(`subscription ${String(row.status)}`);
    return {
      to,
      subject: "Welcome to GridForge Intelligence",
      text:
        `Your ${String(row.plan ?? "")} subscription is active.\n\n` +
        `Sign in to your live dashboard: ${SITE_URL}/account/login\n\n` +
        "— Time to Power",
    };
  }
  if (n.kind === "team_invitation") {
    // The invitation is the system of record; an offer that is no longer open is not mailed (a stale obligation is cancelled).
    if (row.status !== "pending") throw new NotApplicable(`invitation ${String(row.status)}`);
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) throw new NotApplicable("invitation expired");
    // The link's secret is derived from the invitation's id under a server key (lib/team-token.ts), so it is rebuilt here
    // for every attempt and never stored in the queue, a log or an operator email.
    const secret = inviteToken(String(row.id));
    if (!secret) throw new Blocked("credential_missing");
    const owner = String(row.owner_email ?? "");
    return {
      to,
      subject: "You have been invited to GridForge Intelligence",
      text:
        `${owner} has given you a seat on their GridForge Intelligence subscription.\n\n` +
        "Open the link below, sign in with this email address, and accept the invitation. " +
        "The seat gives you the same live siting dashboard the subscription already includes.\n\n" +
        `${SITE_URL}/account/invite/${secret}` +
        "\n\nThe link works only for this address, once, and expires " +
        `${new Date(String(row.expires_at)).toISOString().slice(0, 10)}. If you were not expecting it, ignore this message and nothing changes.`,
    };
  }
  if (n.kind === "usage_alert") {
    // dedupe key: usage_alert:{account id}:{YYYY-MM}:{percent}. The numbers are read NOW, at send time, from the ledger copy.
    const m = /:(\d{4}-\d{2}):(\d{1,3})$/.exec(n.dedupe_key);
    if (!m) throw new NotApplicable("malformed alert");
    const [, month, pctText] = m;
    const percent = Number(pctText);
    const plan = String(row.plan ?? "");
    if (row.status !== "active") throw new NotApplicable("account not active");
    if (plan !== "api_free" && plan !== "api_payg") throw new NotApplicable("plan has no usage alert");
    const cap = plan === "api_free" ? PAYG.freeAllowanceUnits : Number(row.cap_units ?? 0);
    const token = credential(row.token);
    if (!token) throw new Blocked("credential_missing");
    if (!(cap > 0)) throw new NotApplicable("no cap on record");
    if (month !== utcMonth(new Date())) throw new NotApplicable("alert is for a month that has ended");
    const net = await usageNet(String(row.account), month);
    if (!net) throw new Error("usage unreadable");
    const used = net.net;
    const portal = `${SITE_URL}/api-access/${token}`;
    const stopLine =
      plan === "api_payg"
        ? `Your cap is a hard stop: at ${cap} units a request is refused with HTTP 402 and nothing beyond the cap is ever charged. ` +
          "The count restarts at the start of the next UTC month, or you can raise the cap from the portal (raising it issues a new key and revokes the current one)."
        : "When the free allowance is used up, requests are refused with HTTP 402 and nothing is charged. " +
          "The count restarts at the start of the next UTC month, or you can enable pay-as-you-go from the portal.";
    const money =
      plan === "api_payg"
        ? `\nAccrued this month so far: ${eurText(used * PAYG.unitPriceCents)} (${used} units at ${eurText(PAYG.unitPriceCents)}, net of refunds), invoiced in arrears. A month below ${eurText(PAYG.minInvoiceCents)} is carried into the next.`
        : "\nFree-allowance usage is never invoiced.";
    return {
      to,
      subject: percent >= 100 ? `GridForge: you have reached ${percent}% of your monthly ${plan === "api_free" ? "free allowance" : "cap"}` : `GridForge: ${percent}% of your monthly ${plan === "api_free" ? "free allowance" : "cap"} used`,
      text:
        `You have used ${used} of ${cap} units in ${month} (${Math.floor((used / cap) * 100)}%).${money}\n\n${stopLine}\n\n${portal}\n\n` +
        "Counts are net of refunds: a rejected or failed request is refunded and does not count.",
    };
  }
  // key_rotation -- rebuilt from the account's CURRENT key. The dedupe key carries the expiry the obligation
  // was created for; if the account has moved on (rotated, renewed, key removed) the warning is stale and is
  // cancelled rather than sent.
  const token = credential(row.token);
  if (!token) throw new Blocked("credential_missing");
  const keyId = (row.key_id as string | null) ?? null;
  const expiresAt = (row.key_expires_at as string | null) ?? null;
  if (row.status === "cancelled") throw new NotApplicable("subscription cancelled");
  if (!keyId || !expiresAt) throw new NotApplicable("no key to rotate");
  if (!n.dedupe_key.endsWith(`:${expiresAt}`)) throw new NotApplicable("key already replaced or renewed");
  const life = keyLife({ key_id: keyId, key_expires_at: expiresAt });
  if (!life.has_key || life.days_left === null || !life.needs_rotation) throw new NotApplicable("key no longer near expiry");
  const when = life.expired ? `expired on ${expiresAt}` : `expires on ${expiresAt} — ${life.days_left} day(s) from now`;
  return {
    to,
    subject: life.expired ? "Your GridForge API key has expired — mint a new one" : "Your GridForge API key expires shortly",
    text:
      `Your subscription has renewed. Your API key ${when}.\n\n` +
      "Keys carry their own expiry so the engine can verify them offline, with no " +
      "database and no call home. The price of that is that a key cannot be extended " +
      "in place — a new expiry means a new key, and only you can put it into your " +
      "deployment.\n\n" +
      "Mint the replacement here:\n\n" +
      `${SITE_URL}/api-access/${token}` +
      "\n\n" +
      (life.expired
        ? "The old key is dead, so the new one replaces it immediately."
        : "Your current key keeps working until it expires, so you can deploy the new " +
          "one first and let the old one lapse. Nothing stops in between.") +
      "\n\nYour allowance and account are unchanged.",
  };
}

// ---------------------------------------------------------------- the obligation

/** The unique key for "tell THIS subject about THIS thing". For a rotation the discriminator is the key expiry. */
export function dedupeKey(kind: NotificationKind, subjectId: string, discriminator = ""): string {
  return `${kind}:${subjectId}${discriminator ? `:${discriminator}` : ""}`;
}

async function insertRow(c: Db, kind: NotificationKind, subjectId: string, discriminator: string, origin: NotificationRow["origin"]) {
  const key = dedupeKey(kind, subjectId, discriminator);
  const ins = await db<NotificationRow[]>(
    c, "POST", "customer_notifications?on_conflict=dedupe_key",
    { dedupe_key: key, kind, subject_table: SUBJECT[kind], subject_id: subjectId, origin },
    "resolution=ignore-duplicates,return=representation"
  );
  if (!ins.ok) return ins.missingTable ? ("no_table" as const) : ("store_error" as const);
  let row: NotificationRow | undefined = ins.data?.[0];
  let created = Boolean(row);
  if (!row) {
    const got = await db<NotificationRow[]>(c, "GET", `customer_notifications?dedupe_key=eq.${enc(key)}&select=*&limit=1`);
    row = got.ok ? got.data?.[0] : undefined;
    created = false;
  }
  return row ? { row, created } : ("store_error" as const);
}

/**
 * Record the obligation (once) and make one attempt now if it is due. Safe to call on every webhook
 * delivery: an accepted notification is a no-op, a pending one that is due is retried, a leased one is left.
 */
export async function ensureNotification(kind: NotificationKind, subjectId: string, discriminator = ""): Promise<Outcome> {
  const c = creds();
  if (!c) return { state: "unavailable", reason: "store_error" };
  const r = await insertRow(c, kind, subjectId, discriminator, "webhook");
  if (r === "no_table" || r === "store_error") return { state: "unavailable", reason: r };
  return attempt(c, r.row);
}

const retryDelayMin = (attempts: number) => BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)] || 5;
const unknownOutcome = (e: string | null) => e === "in_flight" || (e?.endsWith("_maybe_accepted") ?? false);

/** Record the provider's acceptance. Retried briefly; true only if the row really changed. */
async function recordAccepted(c: Db, id: string, providerId: string | null): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const r = await db<NotificationRow[]>(c, "PATCH", `customer_notifications?id=eq.${enc(id)}&status=eq.pending`, {
      status: "accepted", accepted_at: new Date().toISOString(), provider_message_id: providerId,
      claimed_until: null, last_error: null, last_http_status: null,
    }, "return=representation");
    if (r.ok && (r.data?.length ?? 0) === 1) return true;
    if (r.ok) return false;                                  // nothing matched: it is no longer pending
    await new Promise((res) => setTimeout(res, 150 * (i + 1)));
  }
  return false;
}

/** One bounded, leased attempt. */
async function attempt(c: Db, row: NotificationRow, opts: { force?: boolean } = {}): Promise<Outcome> {
  if (row.status !== "pending") return { state: "skipped", id: row.id, why: "not_pending" };
  const now = Date.now();
  if (!opts.force && new Date(row.next_attempt_at).getTime() > now) return { state: "skipped", id: row.id, why: "not_due" };
  if (row.claimed_until && new Date(row.claimed_until).getTime() > now) return { state: "skipped", id: row.id, why: "leased" };

  // An earlier attempt whose outcome we never learned, and which the provider can no longer deduplicate,
  // is not ours to repeat. A person decides.
  if (
    unknownOutcome(row.last_error) && row.last_attempt_at &&
    now - new Date(row.last_attempt_at).getTime() > IDEMPOTENCY_WINDOW_MS && !opts.force
  ) {
    const r = await db<NotificationRow[]>(c, "PATCH", `customer_notifications?id=eq.${enc(row.id)}&status=eq.pending&attempts=eq.${row.attempts}`,
      { status: "ambiguous", claimed_until: null }, "return=representation");
    if (r.ok && r.data?.[0]) {
      await notifyOperator(
        "A customer email may or may not have been sent — a person must decide",
        `Notification ${row.id} (${row.kind}): an attempt's outcome was never confirmed and the provider can no longer ` +
          "deduplicate a retry, so it was not retried automatically. In the admin notifications list choose confirm_sent or retry."
      );
      return { state: "ambiguous", id: row.id };
    }
    return { state: "skipped", id: row.id, why: "leased" };
  }

  // Take the lease with a compare-and-set: if another run advanced `attempts` first, nothing matches.
  const nowIso = new Date(now).toISOString();
  const lease = await db<NotificationRow[]>(
    c, "PATCH",
    `customer_notifications?id=eq.${enc(row.id)}&status=eq.pending&attempts=eq.${row.attempts}`,
    { attempts: row.attempts + 1, claimed_until: new Date(now + LEASE_MS).toISOString(), last_attempt_at: nowIso, last_error: "in_flight" },
    "return=representation"
  );
  if (!lease.ok) return { state: "unavailable", reason: lease.missingTable ? "no_table" : "store_error" };
  const mine = lease.data?.[0];
  if (!mine) return { state: "skipped", id: row.id, why: "leased" };

  // The idempotency key is stable for the logical message. Only a provider-reported payload CONFLICT
  // (the rebuilt message legitimately differs from the earlier one) takes a new version.
  const idemKey = row.last_error === "idempotency_conflict" ? `${mine.dedupe_key}:v${mine.attempts}` : mine.dedupe_key;

  let result: MailResult;
  try {
    const built = await build(mine, c);
    if (built === "gone") {
      await db(c, "PATCH", `customer_notifications?id=eq.${enc(mine.id)}`, { status: "cancelled", claimed_until: null, last_error: "record_gone" });
      return { state: "cancelled", id: mine.id, why: "record_gone" };
    }
    result = await sendMail({ ...built, idempotencyKey: idemKey });
  } catch (e) {
    if (e instanceof NotApplicable) {
      await db(c, "PATCH", `customer_notifications?id=eq.${enc(mine.id)}`, { status: "cancelled", claimed_until: null, last_error: "not_applicable" });
      return { state: "cancelled", id: mine.id, why: e.why };
    }
    if (e instanceof Blocked) {
      // Waiting for an authoritative value to exist: keep the obligation, do not burn an attempt, say so once.
      await db(c, "PATCH", `customer_notifications?id=eq.${enc(mine.id)}`, {
        attempts: row.attempts, claimed_until: null, last_error: e.category,
        next_attempt_at: new Date(Date.now() + CONFIG_RETRY_MIN * 60_000).toISOString(),
      });
      console.error(`[GridForge] customer email blocked: notification ${mine.id} (${mine.kind}) ${e.category}`);
      if (row.last_error !== e.category) {
        await notifyOperator(
          "A customer email is blocked on a missing credential",
          `Notification ${mine.id} (${mine.kind}) cannot be sent because the record it is for has no valid access credential. ` +
            "It is kept, not sent, and will go out once the record is repaired (or retry it from the admin notifications list)."
        );
      }
      return { state: "pending", id: mine.id, category: e.category };
    }
    result = { sent: false, category: "unreachable", reason: "The record could not be read." };
  }

  if (result.sent) {
    if (await recordAccepted(c, mine.id, result.id)) return { state: "accepted", id: mine.id };
    // The provider accepted it, but we could not durably say so. Never report accepted. The row stays
    // pending/in_flight: the retry reuses the same key (the provider returns the original, sending nothing).
    console.error(`[GridForge] provider ACCEPTED notification ${mine.id} (${mine.kind}) but the outbox write failed; it will be reconciled by a same-key retry`);
    return { state: "accepted_unrecorded", id: mine.id };
  }

  const category = result.category;
  const config = category === "not_configured" || category === "provider_auth";
  const permanent = category === "no_recipient" || category === "rejected";
  const exhausted = mine.attempts >= mine.max_attempts;

  if (!config && (permanent || exhausted)) {
    // Exhausted while the last attempt may have been accepted -> a person decides, rather than "failed".
    const status = !permanent && result.ambiguous ? "ambiguous" : "abandoned";
    await db(c, "PATCH", `customer_notifications?id=eq.${enc(mine.id)}`, {
      status, claimed_until: null, last_error: result.ambiguous ? `${category}_maybe_accepted` : category, last_http_status: result.status ?? null,
    });
    await notifyOperator(
      status === "ambiguous" ? "A customer email may or may not have been sent — a person must decide" : "A customer email could not be delivered and needs a person",
      `Notification ${mine.id} (${mine.kind}) is ${status} after ${mine.attempts} attempt(s): ${category}` +
        `${result.status ? ` (HTTP ${result.status})` : ""}. The purchase itself is recorded and fulfilled; only the email is outstanding. ` +
        "Decide from the admin notifications list after fixing the cause."
    );
    return status === "ambiguous" ? { state: "ambiguous", id: mine.id } : { state: "abandoned", id: mine.id, category };
  }

  // Temporary. A missing sender/credential, or the provider refusing OUR credential, is an operator-config
  // problem: it does not burn an attempt and the obligation survives until it is fixed.
  const wait = config ? CONFIG_RETRY_MIN : Math.max(retryDelayMin(mine.attempts), Math.ceil((result.retryAfterSeconds ?? 0) / 60));
  await db(c, "PATCH", `customer_notifications?id=eq.${enc(mine.id)}`, {
    attempts: config ? row.attempts : mine.attempts,
    claimed_until: null,
    next_attempt_at: new Date(Date.now() + wait * 60_000).toISOString(),
    last_error: result.ambiguous ? `${category}_maybe_accepted` : category,
    last_http_status: result.status ?? null,
  });
  console.error(`[GridForge] customer email pending: notification ${mine.id} (${mine.kind}) ${category}${result.ambiguous ? " (may have been accepted)" : ""}; attempt ${mine.attempts}, next in ${wait} min`);
  if (config && row.last_error !== category) {
    await notifyOperator(
      category === "provider_auth" ? "The email provider is refusing our credential" : "Customer email is not configured",
      `Notification ${mine.id} (${mine.kind}) is waiting: ${category}. It will send automatically once the mail credential and sender ` +
        "(RESEND_API_KEY and RESEND_FROM or LEAD_FROM_EMAIL) are valid."
    );
  }
  return { state: "pending", id: mine.id, category };
}

// ---------------------------------------------------------------- sweeps and operator actions

export interface SweepSummary {
  available: boolean;
  attempted: number;
  /** Provider accepted AND durably recorded. Not "delivered to an inbox". */
  accepted: number;
  /** Provider accepted but the outbox write failed: reconciled by a same-key retry, never counted as accepted. */
  acceptedUnrecorded: number;
  pending: number;
  ambiguous: number;
  abandoned: number;
  cancelled: number;
  skipped: number;
}

export function summarise(outcomes: Outcome[], available: boolean): SweepSummary {
  const n = (s: string) => outcomes.filter((o) => o.state === s).length;
  const skipped = n("skipped") + n("unavailable");
  return {
    available, attempted: outcomes.length - skipped, accepted: n("accepted"), acceptedUnrecorded: n("accepted_unrecorded"),
    pending: n("pending"), ambiguous: n("ambiguous"), abandoned: n("abandoned"), cancelled: n("cancelled"), skipped,
  };
}

/** Work through due pending notifications (cron / operator). Bounded per run; concurrent runs are safe (leases). */
export async function sweepNotifications(limit = 25): Promise<{ available: boolean; outcomes: Outcome[] }> {
  const c = creds();
  if (!c) return { available: false, outcomes: [] };
  const due = await db<NotificationRow[]>(
    c, "GET",
    `customer_notifications?status=eq.pending&next_attempt_at=lte.${enc(new Date().toISOString())}&order=next_attempt_at.asc&limit=${Math.max(1, Math.min(limit, 100))}&select=*`
  );
  if (!due.ok) return { available: false, outcomes: [] };
  const outcomes: Outcome[] = [];
  for (const row of due.data ?? []) outcomes.push(await attempt(c, row));
  return { available: true, outcomes };
}

/**
 * Operator: act on one notification.
 *  - retry: send again now ignoring backoff. An abandoned or ambiguous one is reopened first (counted).
 *    For an ambiguous one this may produce a second copy if the first was in fact accepted -- that is the
 *    operator's explicit choice.
 *  - confirm_sent: the operator has verified the customer got it; record it as accepted without sending.
 */
export async function actOnNotification(id: string, action: "retry" | "confirm_sent"): Promise<Outcome> {
  const c = creds();
  if (!c) return { state: "unavailable", reason: "store_error" };
  const got = await db<NotificationRow[]>(c, "GET", `customer_notifications?id=eq.${enc(id)}&select=*&limit=1`);
  if (!got.ok) return { state: "unavailable", reason: got.missingTable ? "no_table" : "store_error" };
  const found = got.data?.[0];
  if (!found) return { state: "skipped", id, why: "not_pending" };

  if (action === "confirm_sent") {
    if (found.status !== "ambiguous" && found.status !== "abandoned" && found.status !== "pending") return { state: "skipped", id, why: "not_pending" };
    const r = await db<NotificationRow[]>(c, "PATCH", `customer_notifications?id=eq.${enc(id)}&status=eq.${found.status}`, {
      status: "accepted", accepted_at: new Date().toISOString(), claimed_until: null, last_error: "operator_confirmed",
    }, "return=representation");
    return r.ok && r.data?.[0] ? { state: "accepted", id } : { state: "skipped", id, why: "leased" };
  }

  let row: NotificationRow = found;
  if (row.status === "abandoned" || row.status === "ambiguous") {
    const re = await db<NotificationRow[]>(
      c, "PATCH", `customer_notifications?id=eq.${enc(id)}&status=eq.${row.status}`,
      { status: "pending", attempts: 0, reopened_count: row.reopened_count + 1, next_attempt_at: new Date().toISOString(), claimed_until: null, last_error: null },
      "return=representation"
    );
    const reopened = re.ok ? re.data?.[0] : undefined;
    if (!reopened) return { state: "skipped", id, why: "leased" };
    row = reopened;
  }
  return attempt(c, row, { force: true });
}

/** Kept for callers that only retry. */
export const retryNotification = (id: string) => actOnNotification(id, "retry");

/** The operator's list: ids, kinds, states and categories only. Never a recipient, token, body or dedupe key. */
export async function listNotifications(state: "open" | "all" = "open"): Promise<{ available: boolean; items: Omit<NotificationRow, "dedupe_key">[] }> {
  const c = creds();
  if (!c) return { available: false, items: [] };
  const filter = state === "open" ? "status=not.in.(accepted,cancelled)&" : "";
  const r = await db<NotificationRow[]>(c, "GET", `customer_notifications?${filter}order=created_at.desc&limit=200&select=*`);
  if (!r.ok) return { available: false, items: [] };
  return { available: true, items: (r.data ?? []).map(({ dedupe_key: _k, ...rest }) => rest) };
}

// ---------------------------------------------------------------- reconciling purchases made before the outbox

export interface ReconcileCandidate { kind: NotificationKind; subject_id: string; created_at: string | null; eligible: boolean; reason: string }

/** Obligations that are not a purchase: nothing to reconcile after the fact (a rotation warning, a seat invitation). */
const NOT_RECONCILABLE: ReadonlySet<NotificationKind> = new Set(["key_rotation", "team_invitation", "usage_alert"]);

const SELECT: Record<Exclude<NotificationKind, "key_rotation" | "team_invitation" | "usage_alert">, { table: SubjectTable; filter: string }> = {
  intake_link: { table: "deliverables", filter: "status=eq.awaiting_intake&email=not.is.null" },
  api_access_link: { table: "api_accounts", filter: "status=eq.active&key_id=is.null&email=not.is.null" },
  watch_link: { table: "watches", filter: "status=eq.active&email=not.is.null" },
  subscription_welcome: { table: "subscriptions", filter: "status=eq.active&email=not.is.null" },
};

/**
 * DRY RUN. Paid records that have no notification obligation. Returns ids, kinds and a reason -- never an
 * address, link or token -- and sends nothing. Eligibility is re-checked at enqueue time.
 */
export async function inventoryUnnotified(): Promise<{ available: boolean; candidates: ReconcileCandidate[] }> {
  const c = creds();
  if (!c) return { available: false, candidates: [] };
  const probe = await db<unknown[]>(c, "GET", "customer_notifications?select=id&limit=1");
  if (!probe.ok) return { available: false, candidates: [] };
  const out: ReconcileCandidate[] = [];
  for (const kind of NOTIFICATION_KINDS) {
    if (kind === "key_rotation" || kind === "team_invitation" || kind === "usage_alert") continue;
    const { table, filter } = SELECT[kind];
    const cols = `id,created_at${kind === "intake_link" ? ",token,intake_token" : ""}`;
    const rows = await db<{ id: string; created_at?: string; token?: unknown; intake_token?: unknown }[]>(
      c, "GET", `${table}?${filter}&select=${cols}&order=created_at.asc&limit=500`);
    if (!rows.ok) return { available: false, candidates: [] };
    const have = await db<{ subject_id: string }[]>(c, "GET", `customer_notifications?kind=eq.${kind}&select=subject_id&limit=5000`);
    if (!have.ok) return { available: false, candidates: [] };
    const covered = new Set((have.data ?? []).map((h) => h.subject_id));
    for (const r of rows.data ?? []) {
      if (covered.has(r.id)) continue;
      const bad = kind === "intake_link" && (!credential(r.intake_token) || r.intake_token === r.token);
      out.push({ kind, subject_id: r.id, created_at: r.created_at ?? null, eligible: !bad, reason: bad ? "no valid intake credential on the record" : "paid record with no notification obligation" });
    }
  }
  return { available: true, candidates: out };
}

/**
 * Enqueue explicitly selected records (max 50 per call). Rechecks eligibility against the current
 * inventory, deduplicates by the unique key, creates no purchase/account/deliverable, and does NOT send:
 * delivery happens through the normal sweep or an explicit retry.
 */
export async function enqueueSelected(selection: { kind: string; subject_id: string }[]): Promise<{
  available: boolean; enqueued: number; alreadyPresent: number; rejected: { subject_id: string; reason: string }[];
}> {
  const none = { available: false, enqueued: 0, alreadyPresent: 0, rejected: [] as { subject_id: string; reason: string }[] };
  const c = creds();
  if (!c) return none;
  const inv = await inventoryUnnotified();
  if (!inv.available) return none;
  const eligible = new Set(inv.candidates.filter((x) => x.eligible).map((x) => `${x.kind}:${x.subject_id}`));
  const res = { available: true, enqueued: 0, alreadyPresent: 0, rejected: [] as { subject_id: string; reason: string }[] };
  for (const sel of selection.slice(0, 50)) {
    const kind = NOTIFICATION_KINDS.find((k) => k === sel.kind);
    if (!kind || NOT_RECONCILABLE.has(kind)) { res.rejected.push({ subject_id: String(sel.subject_id), reason: "unsupported kind" }); continue; }
    if (!eligible.has(`${kind}:${sel.subject_id}`)) {
      // Either already covered (a concurrent or earlier enqueue) or genuinely ineligible.
      const exists = await db<unknown[]>(c, "GET", `customer_notifications?dedupe_key=eq.${enc(dedupeKey(kind, sel.subject_id))}&select=id&limit=1`);
      if (exists.ok && (exists.data?.length ?? 0) > 0) { res.alreadyPresent++; continue; }
      res.rejected.push({ subject_id: String(sel.subject_id), reason: "not eligible (wrong state or no valid credential)" });
      continue;
    }
    const r = await insertRow(c, kind, sel.subject_id, "", "operator_reconcile");
    if (r === "no_table" || r === "store_error") return { ...res, available: false };
    if (r.created) res.enqueued++; else res.alreadyPresent++;
  }
  return res;
}

// ---------------------------------------------------------------- route-facing entry

/**
 * The webhook entry. Returns "ok" when the obligation is durably recorded (or, before migration 0021, a single
 * direct send was made), and "retry_webhook" when the obligation could not be recorded and the caller should
 * ask Stripe to redeliver -- the business record is idempotent, so the redelivery only repeats this step.
 */
export async function notifyCustomer(
  kind: NotificationKind,
  subjectId: string,
  discriminator = "",
  opts: { replay?: boolean } = {}
): Promise<"ok" | "retry_webhook"> {
  try {
    const o = await ensureNotification(kind, subjectId, discriminator);
    if (o.state === "unavailable") {
      if (o.reason === "store_error") {
        console.error(`[GridForge] ${kind} notification could not be recorded for record ${subjectId}; asking for a redelivery`);
        return "retry_webhook";
      }
      // Migration 0021 not applied: nothing durable exists to retry. A first delivery gets ONE direct send;
      // a replay must not guess whether the first one went out.
      if (!opts.replay) await sendDirect(kind, subjectId, discriminator);
    }
    return "ok";
  } catch {
    console.error(`[GridForge] ${kind} notification failed unexpectedly for record ${subjectId}`);
    return "retry_webhook";
  }
}

/** Fallback before 0021: one direct send from the business row; logs record id + category only. */
async function sendDirect(kind: NotificationKind, subjectId: string, discriminator: string): Promise<void> {
  const c = creds();
  if (!c) return;
  try {
    const key = dedupeKey(kind, subjectId, discriminator);
    const built = await build({ kind, subject_table: SUBJECT[kind], subject_id: subjectId, dedupe_key: key }, c);
    if (built === "gone") return;
    const r = await sendMail({ ...built, idempotencyKey: key });
    if (!r.sent) {
      console.error(`[GridForge] ${kind} email NOT sent for record ${subjectId}: ${r.category}${r.status ? ` (HTTP ${r.status})` : ""}; it is NOT recoverable until migration 0021 (the durable outbox) is applied`);
    }
  } catch (e) {
    const why = e instanceof Blocked ? e.category : e instanceof NotApplicable ? "not_applicable" : "record unreadable";
    console.error(`[GridForge] ${kind} email NOT sent for record ${subjectId}: ${why}`);
  }
}
