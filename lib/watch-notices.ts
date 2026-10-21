// Server-only: the durable obligation to email a Hall Watch change note (migration 0030, watch_note_notices).
//
// The change note itself is stored (watch_notes) and readable on the buyer's watch page, so the email is a pointer to it,
// not the only copy. It used to be ONE best-effort send whose failure was a log line: a provider blip at the moment the
// weekly cron ran meant the buyer never heard that their answer had moved, and nothing could retry it.
//
//   pending --attempt--> sent        the provider ACCEPTED it (not "the inbox received it")
//   pending --attempt--> pending     a retryable failure: bounded backoff, retried by the engagements sweep
//   pending ------------> abandoned  attempts exhausted, or a permanent refusal: an operator is told once
//
// The row stores no recipient, token or body; the message is rebuilt from the watch row at send time. The Idempotency-Key is
// per note, so a retry inside the provider's 24 h window cannot send a second copy; past that window a retry of an attempt
// whose outcome was unknown could, which is why attempts are bounded and the email is only a pointer.
//
// Without the table (migration 0030 not applied) the first attempt is made directly, once, and a failure is logged: exactly
// the previous behaviour, so the cron works before and after the migration.

import { sendMail, notifyOperator, type MailFailure } from "@/lib/mail";
import { SITE_URL } from "@/lib/site";
import { creds, rest } from "@/lib/pgrest";

const q = encodeURIComponent;
const MINUTE = 60_000;
/** After attempt N fails, wait this long (minutes). Index = attempts made so far. */
const BACKOFF_MIN = [0, 30, 120, 720, 1440];
export const NOTICE_MAX_ATTEMPTS = BACKOFF_MIN.length;
const LEASE_MS = 10 * MINUTE;
const PERMANENT: ReadonlySet<MailFailure> = new Set<MailFailure>(["no_recipient", "rejected", "idempotency_conflict"]);

interface NoticeRow {
  id: string;
  watch_note_id: string;
  watch_id: string;
  status: "pending" | "sent" | "abandoned";
  attempts: number;
  next_attempt_at: string;
  created_at?: string;
}

type Outcome = "sent" | "retry" | "abandoned" | "skipped";

async function build(n: Pick<NoticeRow, "watch_note_id" | "watch_id">): Promise<{ to: string; subject: string; text: string; key: string } | "gone"> {
  const [w, note] = await Promise.all([
    rest<Record<string, unknown>[]>("GET", `watches?id=eq.${q(n.watch_id)}&select=token,email,site_name,hall_id,status&limit=1`),
    rest<Record<string, unknown>[]>("GET", `watch_notes?id=eq.${q(n.watch_note_id)}&select=headline,material&limit=1`),
  ]);
  if (!w.ok || !note.ok) throw new Error("read failed");
  const watch = w.data?.[0];
  const row = note.data?.[0];
  if (!watch || !row) return "gone";
  const email = typeof watch.email === "string" ? watch.email : "";
  return {
    to: email,
    subject: `${watch.site_name ?? "Your hall"} ${watch.hall_id ?? ""} — the answer moved`.trim(),
    text: `${row.headline ?? "Your hall's answer moved."}\n\nThe change note, with the input that moved it:\n${SITE_URL}/watch/${watch.token}\n`,
    key: `watch-note-${n.watch_note_id}`,
  };
}

/**
 * Record the obligation for a stored note. "queued": the row exists (now or already). "unavailable": the table is absent or
 * the write failed, and the caller falls back to a single direct send.
 */
export async function queueNotice(noteId: string, watchId: string): Promise<"queued" | "unavailable"> {
  const c = creds();
  if (!c) return "unavailable";
  try {
    const res = await fetch(`${c.url}/rest/v1/watch_note_notices?on_conflict=watch_note_id`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({ watch_note_id: noteId, watch_id: watchId }),
      cache: "no-store",
    });
    return res.ok ? "queued" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Make one attempt for one pending notice. Safe to call from overlapping sweeps: the attempt is claimed first. */
export async function attemptNotice(n: NoticeRow, now: Date = new Date()): Promise<Outcome> {
  if (n.status !== "pending") return "skipped";
  const c = creds();
  if (!c) return "skipped";
  // Claim: only one invocation moves attempts from N to N+1 (and pushes the row behind a lease while it works).
  const claimed = await rest<NoticeRow[]>(
    "PATCH",
    `watch_note_notices?id=eq.${q(n.id)}&status=eq.pending&attempts=eq.${n.attempts}`,
    { attempts: n.attempts + 1, next_attempt_at: new Date(now.getTime() + LEASE_MS).toISOString() }
  );
  if (!claimed.ok || (claimed.data ?? []).length === 0) return "skipped";
  const attempts = n.attempts + 1;

  const settle = (patch: Record<string, unknown>) => rest("PATCH", `watch_note_notices?id=eq.${q(n.id)}`, patch);
  let built: Awaited<ReturnType<typeof build>>;
  try {
    built = await build(n);
  } catch {
    // Could not read what to send: not the buyer's fault and not a send failure; leave it for the next sweep.
    await settle({ last_error: "read_failed", next_attempt_at: new Date(now.getTime() + BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)] * MINUTE).toISOString() });
    return "retry";
  }
  if (built === "gone") {
    await settle({ status: "abandoned", last_error: "watch_or_note_gone" });
    return "abandoned";
  }
  const sent = await sendMail({ to: built.to, subject: built.subject, text: built.text, idempotencyKey: built.key });
  if (sent.sent) {
    await settle({ status: "sent", sent_at: now.toISOString(), last_error: null });
    return "sent";
  }
  if (PERMANENT.has(sent.category) || attempts >= NOTICE_MAX_ATTEMPTS) {
    await settle({ status: "abandoned", last_error: sent.category });
    await notifyOperator(
      "A Hall Watch change note could not be emailed",
      `The change note is stored and is on the buyer's watch page, but its email was ${PERMANENT.has(sent.category) ? "refused" : `not accepted after ${attempts} attempts`} (${sent.category}). ` +
        `Tell the buyer the answer moved. Notice ${n.id}; it is listed in GET /api/admin/deliverables.`
    );
    return "abandoned";
  }
  const wait = Math.max(BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)] * MINUTE, (sent.retryAfterSeconds ?? 0) * 1000);
  await settle({ last_error: sent.category, next_attempt_at: new Date(now.getTime() + wait).toISOString() });
  return "retry";
}

/** Retry every pending notice that is due. Returns counts by outcome; "unavailable" when the table is absent. */
export async function sweepNotices(now: Date = new Date(), limit = 50): Promise<{ available: boolean; outcomes: Record<Outcome, number> }> {
  const outcomes: Record<Outcome, number> = { sent: 0, retry: 0, abandoned: 0, skipped: 0 };
  const due = await rest<NoticeRow[]>(
    "GET",
    `watch_note_notices?status=eq.pending&next_attempt_at=lte.${q(now.toISOString())}&select=*&order=next_attempt_at.asc&limit=${limit}`
  );
  if (!due.ok) return { available: false, outcomes };
  for (const n of due.data ?? []) outcomes[await attemptNotice(n, now)] += 1;
  return { available: true, outcomes };
}

/**
 * Tell the buyer a stored change note exists: record the obligation and make the first attempt now. If the store cannot
 * hold the obligation, make one direct attempt and log a failure (the previous behaviour).
 */
export async function announceNote(note: { id: string; watch_id: string }, watch: { email: string | null; site_name: string | null; hall_id: string | null; token: string }, headline: string): Promise<void> {
  const queued = await queueNotice(note.id, note.watch_id);
  if (queued === "queued") {
    const row = await rest<NoticeRow[]>("GET", `watch_note_notices?watch_note_id=eq.${q(note.id)}&select=*&limit=1`);
    if (row.ok && row.data?.[0]) await attemptNotice(row.data[0]);
    return;
  }
  if (!watch.email) {
    console.error(`[GridForge] watch change NOT emailed: no address on record (watch ${note.watch_id})`);
    return;
  }
  const r = await sendMail({
    to: watch.email,
    subject: `${watch.site_name ?? "Your hall"} ${watch.hall_id ?? ""} — the answer moved`.trim(),
    text: `${headline}\n\nThe change note, with the input that moved it:\n${SITE_URL}/watch/${watch.token}\n`,
    idempotencyKey: `watch-note-${note.id}`,
  });
  if (!r.sent) console.error(`[GridForge] watch change NOT emailed (watch ${note.watch_id}): ${r.category}${r.status ? ` (HTTP ${r.status})` : ""}; the retry record is unavailable (migration 0030)`);
}
