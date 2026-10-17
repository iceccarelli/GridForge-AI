// Server-only: the smallest outbound-mail helper for the two hand-offs of a paid deliverable
// (operator "a draft is waiting", buyer "your document is released"). Email is best-effort delivery
// and NEVER the system of record: every caller keeps the work in the database and reports, truthfully,
// whether the message was actually accepted by the mail provider.

/** Why a message did not go. `ambiguous` = the provider may nevertheless have accepted it (timeout / lost response). */
export type MailFailure =
  | "not_configured"        // no key / sender here: an operator-config problem, retry once fixed
  | "provider_auth"         // the provider refused OUR credential (401/403): operator-config, retry once fixed
  | "no_recipient"
  | "rejected"              // 400/422/other 4xx: the request itself is invalid -- permanent, a person must look
  | "idempotency_conflict"  // same key, DIFFERENT payload (409 invalid_idempotent_request)
  | "rate_limited"          // 429, or 409 concurrent_idempotent_requests: safe to retry later
  | "provider_error"        // 5xx / 408: retryable
  | "timeout"               // no answer: the provider may have accepted it (ambiguous)
  | "unreachable";          // could not connect: nothing was sent
export type MailResult =
  | { sent: true; id: string | null }
  | { sent: false; reason: string; category: MailFailure; status?: number; ambiguous?: boolean; retryAfterSeconds?: number };

/** Strip what must never reach a log: addresses and any long URL-safe path segment (a capability token). */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/(\/(?:intake|watch|api-access|deliverable|qualify|project|account\/invite)\/)[A-Za-z0-9_-]{8,}/g, "$1[redacted]");
}

/**
 * THE sender policy, for every outbound message: RESEND_FROM, then LEAD_FROM_EMAIL, then the caller's
 * fallback (none by default, which means "not configured"). Production carries LEAD_FROM_EMAIL and not
 * RESEND_FROM, and for a while the customer mail in the Stripe webhook read RESEND_FROM alone -- so a
 * EUR 4,500 buyer's intake link was silently never sent while the operator mail (which used this helper)
 * went out fine. One resolver, so a path cannot quietly disagree with the others again.
 */
export function mailSender(fallback: string | null = null): string | null {
  return process.env.RESEND_FROM || process.env.LEAD_FROM_EMAIL || fallback;
}

/**
 * Send one message. Never throws, never logs a link, an address or a provider body.
 *
 * `idempotencyKey` is passed to Resend as `Idempotency-Key` (1-256 chars, remembered 24h; the same key with the
 * same payload returns the original result without sending again, a different payload is a 409
 * invalid_idempotent_request). That makes a retry after a lost response safe INSIDE that window; after it, a
 * retry of a message the provider had in fact accepted would send twice. "Accepted" is also all `sent` means:
 * whether the inbox received it is the provider's separate delivery event, which nothing here consumes.
 */
export async function sendMail(m: {
  to: string; subject: string; text: string; idempotencyKey?: string;
  /** Reply-To for a lead/enquiry message. */
  replyTo?: string;
  /** Sender override for flows with a documented test-domain fallback (lead capture); default is the one policy. */
  from?: string | null;
}): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY;
  const from = m.from ?? mailSender();
  if (!key || !from) {
    return { sent: false, category: "not_configured", reason: "Email is not configured on this deployment (RESEND_API_KEY and RESEND_FROM or LEAD_FROM_EMAIL)." };
  }
  if (!m.to || !m.to.includes("@")) return { sent: false, category: "no_recipient", reason: "There is no email address on record." };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey.slice(0, 256) } : {}),
      },
      body: JSON.stringify({ from, to: [m.to], ...(m.replyTo ? { reply_to: m.replyTo } : {}), subject: m.subject, text: m.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      let name = "";
      try { name = String(((await res.json()) as { name?: unknown }).name ?? "").slice(0, 60); } catch { /* body is not logged */ }
      console.error(`[GridForge] mail refused by the provider: HTTP ${res.status}${name ? ` (${name})` : ""}`);
      // Documented Resend semantics (idempotency keys): 409 invalid_idempotent_request = same key, different
      // payload; 409 concurrent_idempotent_requests = the first request is still in flight (retry later);
      // 400 invalid_idempotency_key / validation = our request is wrong. 429 = rate limit.
      const category: MailFailure =
        name === "invalid_idempotent_request" ? "idempotency_conflict"
        : res.status === 429 || name === "concurrent_idempotent_requests" ? "rate_limited"
        : res.status === 401 || res.status === 403 ? "provider_auth"
        : res.status >= 500 || res.status === 408 ? "provider_error"
        : "rejected";
      const ra = Number(res.headers.get("retry-after"));
      return {
        sent: false, category, status: res.status,
        ...(Number.isFinite(ra) && ra > 0 ? { retryAfterSeconds: Math.min(ra, 86_400) } : {}),
        reason: `The email provider refused the message (HTTP ${res.status}).`,
      };
    }
    let id: string | null = null;
    try { const j = (await res.json()) as { id?: unknown }; id = typeof j.id === "string" ? j.id : null; } catch { /* accepted regardless */ }
    return { sent: true, id };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    console.error(`[GridForge] mail ${timedOut ? "timed out (the provider may still have accepted it)" : "could not reach the provider"}`);
    return timedOut
      ? { sent: false, category: "timeout", ambiguous: true, reason: "The email provider did not answer in time; the message may or may not have been accepted." }
      : { sent: false, category: "unreachable", reason: "The email provider could not be reached." };
  }
}

/** A notice to the operator (LEAD_TO_EMAIL). Always logs loudly, so it is findable even without email. */
export async function notifyOperator(subject: string, text: string): Promise<MailResult> {
  console.error(`[GridForge] OPERATOR ACTION NEEDED: ${redact(subject)} — ${redact(text.replace(/\s+/g, " ")).slice(0, 400)}`);
  const to = process.env.LEAD_TO_EMAIL;
  if (!to) return { sent: false, category: "not_configured", reason: "LEAD_TO_EMAIL is not set." };
  // Operator mail may fall back to Resend's sandbox sender, which can reach only the account owner -- i.e. the operator.
  return sendMail({ to, subject, text, from: mailSender("Time to Power <onboarding@resend.dev>") });
}
