// Server-only: the smallest outbound-mail helper for the two hand-offs of a paid deliverable
// (operator "a draft is waiting", buyer "your document is released"). Email is best-effort delivery
// and NEVER the system of record: every caller keeps the work in the database and reports, truthfully,
// whether the message was actually accepted by the mail provider.

export type MailResult = { sent: true } | { sent: false; reason: string };

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

export async function sendMail(m: { to: string; subject: string; text: string }): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY;
  const from = mailSender();
  if (!key || !from) return { sent: false, reason: "Email is not configured on this deployment (RESEND_API_KEY and RESEND_FROM or LEAD_FROM_EMAIL)." };
  if (!m.to || !m.to.includes("@")) return { sent: false, reason: "There is no email address on record." };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
    });
    if (!res.ok) {
      console.error("[GridForge] mail refused by the provider:", res.status, await res.text().catch(() => ""));
      return { sent: false, reason: `The email provider refused the message (HTTP ${res.status}).` };
    }
    return { sent: true };
  } catch (err) {
    console.error("[GridForge] mail send failed:", err);
    return { sent: false, reason: "The email provider could not be reached." };
  }
}

/** A notice to the operator (LEAD_TO_EMAIL). Always logs loudly, so it is findable even without email. */
export async function notifyOperator(subject: string, text: string): Promise<MailResult> {
  console.error(`[GridForge] OPERATOR ACTION NEEDED: ${subject} — ${text.replace(/\s+/g, " ").slice(0, 400)}`);
  const to = process.env.LEAD_TO_EMAIL;
  if (!to) return { sent: false, reason: "LEAD_TO_EMAIL is not set." };
  return sendMail({ to, subject, text });
}
