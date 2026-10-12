// Server-only: the customer emails that carry a buyer's only way in (migration 0021).
//
// The business record (deliverable / API account / watch) is the system of record and is written first,
// idempotently. A `customer_notifications` row is the durable obligation to tell the buyer about it. The
// row holds NO recipient, token or body: the message is rebuilt from the business row at send time, so a
// capability link is never copied into a queue, a log, or an operator email.
//
//   pending --attempt--> accepted     the provider ACCEPTED it (that is all "accepted" claims)
//   pending --attempt--> pending      temporary failure: bounded backoff, retried by the next webhook
//                                     redelivery, the cron sweep, or an operator
//   pending ---------->  abandoned    attempts exhausted or a permanent refusal: an operator is told once
//
// Concurrency: an attempt first takes a lease with a compare-and-set PATCH (attempts must still equal
// the value we read), so two runs cannot both send. Resend's Idempotency-Key (the dedupe key, 24h) covers
// the remaining case where a response was lost after the provider accepted.
//
// Until migration 0021 is applied the table is absent; callers then get `unavailable` and fall back to one
// direct, safely-logged attempt (the previous behaviour), so release order does not matter.

import { sendMail, notifyOperator, type MailResult } from "@/lib/mail";
import { SITE_URL } from "@/lib/site";
import { keyLife } from "@/lib/api-access";
import { creds } from "@/lib/projects";

export const NOTIFICATION_KINDS = ["intake_link", "api_access_link", "watch_link", "key_rotation"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
type SubjectTable = "deliverables" | "api_accounts" | "watches";

const SUBJECT: Record<NotificationKind, SubjectTable> = {
  intake_link: "deliverables",
  api_access_link: "api_accounts",
  watch_link: "watches",
  key_rotation: "api_accounts",
};

const LEASE_MS = 2 * 60_000;
/** After attempt N fails, wait this long. Index = attempts made. */
const BACKOFF_MIN = [0, 5, 15, 60, 240, 720];
const NOT_CONFIGURED_RETRY_MIN = 60;

export interface NotificationRow {
  id: string;
  dedupe_key: string;
  kind: NotificationKind;
  subject_table: SubjectTable;
  subject_id: string;
  status: "pending" | "accepted" | "abandoned";
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

export type Outcome =
  | { state: "accepted"; id: string }
  | { state: "pending"; id: string; category: string }
  | { state: "abandoned"; id: string; category: string }
  | { state: "skipped"; id: string; why: "not_due" | "leased" | "already_done" }
  | { state: "unavailable" };

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
      // PGRST205 / 404 on this table = migration 0021 not applied yet. The body is not logged.
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

async function build(n: Pick<NotificationRow, "kind" | "subject_table" | "subject_id">, c: Db): Promise<Built | "gone"> {
  const r = await db<Record<string, unknown>[]>(c, "GET", `${n.subject_table}?id=eq.${enc(n.subject_id)}&select=*&limit=1`);
  if (!r.ok) throw new Error(`subject lookup ${r.status}`);
  const row = r.data?.[0];
  if (!row) return "gone";
  const to = typeof row.email === "string" ? row.email : "";

  if (n.kind === "intake_link") {
    const token = String(row.intake_token ?? row.token ?? "");
    return {
      to,
      subject: "Your GridForge engagement — the numbers we need",
      text:
        "Thank you. The engagement is open.\n\n" +
        "The next step is the hall's own numbers. Everything you do not supply is filled " +
        "from a library default and named as an assumption in the deliverable, so the more " +
        "of it you complete, the fewer of your conclusions rest on our guesses.\n\n" +
        `${SITE_URL}/intake/${token}` +
        "\n\nThe link is unguessable and specific to this engagement. Do not forward it to " +
        "anyone who should not read the result.",
    };
  }
  if (n.kind === "watch_link") {
    return {
      to,
      subject: "Your hall is now watched",
      text:
        "The model stays live from here.\n\n" +
        "Give it the hall's current numbers once, and from then on it is re-solved every " +
        "quarter and whenever you change an input. You get a change note naming what moved " +
        "and which input moved it — including when the movement came from our side because a " +
        "library or the constraint set was revised.\n\n" +
        `${SITE_URL}/watch/${String(row.token)}` +
        "\n\nIf nothing material changes, we will tell you that in three lines rather than " +
        "send you a document to justify the fee.",
    };
  }
  if (n.kind === "api_access_link") {
    const units = Number(row.monthly_units ?? 0);
    return {
      to,
      subject: "Your GridForge API access is live",
      text:
        "Your key is waiting here:\n\n" +
        `${SITE_URL}/api-access/${String(row.token)}` +
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
  // key_rotation
  const life = keyLife({ key_id: (row.key_id as string | null) ?? null, key_expires_at: (row.key_expires_at as string | null) ?? null });
  const when = life.expired ? `expired on ${life.expires}` : `expires on ${life.expires} — ${life.days_left} day(s) from now`;
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
      `${SITE_URL}/api-access/${String(row.token)}` +
      "\n\n" +
      (life.expired
        ? "The old key is dead, so the new one replaces it immediately."
        : "Your current key keeps working until it expires, so you can deploy the new " +
          "one first and let the old one lapse. Nothing stops in between.") +
      "\n\nYour allowance and account are unchanged.",
  };
}

// ---------------------------------------------------------------- the obligation

/** The unique key for "tell THIS subject about THIS thing". */
export function dedupeKey(kind: NotificationKind, subjectId: string, discriminator = ""): string {
  return `${kind}:${subjectId}${discriminator ? `:${discriminator}` : ""}`;
}

/**
 * Record the obligation (once) and make one attempt now if it is due. Safe to call on every webhook
 * delivery: an accepted notification is a no-op, a pending one that is due is retried, a leased one is left.
 */
export async function ensureNotification(
  kind: NotificationKind,
  subjectId: string,
  discriminator = ""
): Promise<Outcome> {
  const c = creds();
  if (!c) return { state: "unavailable" };
  const key = dedupeKey(kind, subjectId, discriminator);
  const ins = await db<NotificationRow[]>(
    c, "POST", "customer_notifications?on_conflict=dedupe_key",
    { dedupe_key: key, kind, subject_table: SUBJECT[kind], subject_id: subjectId },
    "resolution=ignore-duplicates,return=representation"
  );
  if (!ins.ok) {
    if (ins.missingTable) return { state: "unavailable" };
    console.error(`[GridForge] notification NOT recorded (kind ${kind}, subject ${subjectId}, store ${ins.status}); falling back to a direct send`);
    return { state: "unavailable" };
  }
  let row: NotificationRow | undefined = ins.data?.[0];
  if (!row) {
    const got = await db<NotificationRow[]>(c, "GET", `customer_notifications?dedupe_key=eq.${enc(key)}&select=*&limit=1`);
    row = got.ok ? got.data?.[0] : undefined;
  }
  if (!row) return { state: "unavailable" };
  return attempt(c, row);
}

/** One bounded, leased attempt. */
async function attempt(c: Db, row: NotificationRow, opts: { force?: boolean } = {}): Promise<Outcome> {
  if (row.status !== "pending") return { state: "skipped", id: row.id, why: "already_done" };
  const now = Date.now();
  if (!opts.force && new Date(row.next_attempt_at).getTime() > now) return { state: "skipped", id: row.id, why: "not_due" };
  if (row.claimed_until && new Date(row.claimed_until).getTime() > now) return { state: "skipped", id: row.id, why: "leased" };

  // Take the lease. The filter makes this a compare-and-set: if another run advanced `attempts` first,
  // nothing matches and we stand down.
  const nowIso = new Date(now).toISOString();
  const lease = await db<NotificationRow[]>(
    c, "PATCH",
    `customer_notifications?id=eq.${enc(row.id)}&status=eq.pending&attempts=eq.${row.attempts}`,
    { attempts: row.attempts + 1, claimed_until: new Date(now + LEASE_MS).toISOString(), last_attempt_at: nowIso },
    "return=representation"
  );
  if (!lease.ok) return { state: "unavailable" };
  const mine = lease.data?.[0];
  if (!mine) return { state: "skipped", id: row.id, why: "leased" };

  let result: MailResult;
  let gone = false;
  try {
    const built = await build(mine, c);
    if (built === "gone") {
      gone = true;
      result = { sent: false, category: "no_recipient", reason: "The record this notification was for no longer exists." };
    } else {
      result = await sendMail({ ...built, idempotencyKey: mine.dedupe_key });
    }
  } catch {
    result = { sent: false, category: "unreachable", reason: "The record could not be read." };
  }

  if (result.sent) {
    await db(c, "PATCH", `customer_notifications?id=eq.${enc(mine.id)}`, {
      status: "accepted", accepted_at: new Date().toISOString(), provider_message_id: result.id,
      claimed_until: null, last_error: null, last_http_status: null,
    });
    return { state: "accepted", id: mine.id };
  }

  const category = result.category;
  const permanent = gone || category === "no_recipient" || category === "rejected" || category === "idempotency_conflict";
  const exhausted = mine.attempts >= mine.max_attempts;
  const notConfigured = category === "not_configured";

  if ((permanent || exhausted) && !notConfigured) {
    await db(c, "PATCH", `customer_notifications?id=eq.${enc(mine.id)}`, {
      status: "abandoned", claimed_until: null, last_error: category, last_http_status: result.status ?? null,
    });
    // An operator is told ONCE, with ids and a category only -- never a link, token or address.
    await notifyOperator(
      "A customer email could not be delivered and needs a person",
      `Notification ${mine.id} (${mine.kind}) was abandoned after ${mine.attempts} attempt(s): ${category}` +
        `${result.status ? ` (HTTP ${result.status})` : ""}. The purchase itself is recorded and fulfilled; only the ` +
        "email is outstanding. Resend it from the admin notifications endpoint after fixing the cause."
    );
    return { state: "abandoned", id: mine.id, category };
  }

  // Temporary: stay pending, bounded backoff. A missing sender/credential does not burn an attempt --
  // it is an operator-config problem and the obligation must survive until it is fixed.
  const wait = notConfigured ? NOT_CONFIGURED_RETRY_MIN : BACKOFF_MIN[Math.min(mine.attempts, BACKOFF_MIN.length - 1)] || 5;
  await db(c, "PATCH", `customer_notifications?id=eq.${enc(mine.id)}`, {
    attempts: notConfigured ? row.attempts : mine.attempts,
    claimed_until: null,
    next_attempt_at: new Date(Date.now() + wait * 60_000).toISOString(),
    last_error: result.ambiguous ? `${category}_maybe_accepted` : category,
    last_http_status: result.status ?? null,
  });
  console.error(`[GridForge] customer email pending: notification ${mine.id} (${mine.kind}) ${category}${result.ambiguous ? " (may have been accepted)" : ""}; attempt ${mine.attempts}, next in ${wait} min`);
  if (notConfigured && row.attempts === 0) {
    await notifyOperator(
      "Customer email is not configured",
      `Notification ${mine.id} (${mine.kind}) is waiting because no mail sender/credential is configured. It will send ` +
        "automatically once RESEND_API_KEY and RESEND_FROM (or LEAD_FROM_EMAIL) are set."
    );
  }
  return { state: "pending", id: mine.id, category };
}

/** Work through due pending notifications (cron / operator). Bounded per run. */
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

/** Operator: retry one now, ignoring its backoff (not an active lease). An abandoned one is reopened first. */
export async function retryNotification(id: string): Promise<Outcome> {
  const c = creds();
  if (!c) return { state: "unavailable" };
  const got = await db<NotificationRow[]>(c, "GET", `customer_notifications?id=eq.${enc(id)}&select=*&limit=1`);
  if (!got.ok) return { state: "unavailable" };
  const found = got.data?.[0];
  if (!found) return { state: "skipped", id, why: "already_done" };
  let row: NotificationRow = found;
  if (row.status === "abandoned") {
    const re = await db<NotificationRow[]>(
      c, "PATCH", `customer_notifications?id=eq.${enc(id)}&status=eq.abandoned`,
      { status: "pending", attempts: 0, next_attempt_at: new Date().toISOString(), claimed_until: null, last_error: null },
      "return=representation"
    );
    const reopened = re.ok ? re.data?.[0] : undefined;
    if (!reopened) return { state: "skipped", id, why: "leased" };
    row = reopened;
  }
  return attempt(c, row, { force: true });
}

/** The operator's list: ids, kinds, states and categories only. Never a recipient, token or body. */
export async function listNotifications(state: "open" | "all" = "open"): Promise<{ available: boolean; items: Omit<NotificationRow, "dedupe_key">[] }> {
  const c = creds();
  if (!c) return { available: false, items: [] };
  const filter = state === "open" ? "status=neq.accepted&" : "";
  const r = await db<NotificationRow[]>(c, "GET", `customer_notifications?${filter}order=created_at.desc&limit=200&select=*`);
  if (!r.ok) return { available: false, items: [] };
  return { available: true, items: (r.data ?? []).map(({ dedupe_key: _k, ...rest }) => rest) };
}

/**
 * The fallback when migration 0021 is not applied yet: one direct send from the business row, with a log
 * line that names the record and the category and carries no link, address or body.
 */
export async function sendDirect(kind: NotificationKind, subjectId: string): Promise<boolean> {
  const c = creds();
  if (!c) return false;
  try {
    const built = await build({ kind, subject_table: SUBJECT[kind], subject_id: subjectId }, c);
    if (built === "gone") return false;
    const r = await sendMail({ ...built, idempotencyKey: dedupeKey(kind, subjectId) });
    if (!r.sent) console.error(`[GridForge] ${kind} email NOT sent for record ${subjectId}: ${r.category}${r.status ? ` (HTTP ${r.status})` : ""}; the durable outbox (migration 0021) is not available to retry it`);
    return r.sent;
  } catch {
    console.error(`[GridForge] ${kind} email NOT sent for record ${subjectId}: record unreadable`);
    return false;
  }
}

/** The route-facing entry: durable when 0021 is present, direct otherwise. Never throws. */
export async function notifyCustomer(
  kind: NotificationKind,
  subjectId: string,
  discriminator = "",
  opts: { replay?: boolean } = {}
): Promise<void> {
  try {
    const o = await ensureNotification(kind, subjectId, discriminator);
    // Without the outbox there is no record of whether the first send happened, so a REPLAY (the record
    // already existed) must not guess and send a second email; only the first delivery sends directly.
    if (o.state === "unavailable" && !opts.replay) await sendDirect(kind, subjectId);
  } catch {
    console.error(`[GridForge] ${kind} notification failed unexpectedly for record ${subjectId}`);
  }
}
