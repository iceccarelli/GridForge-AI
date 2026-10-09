// Server-only: the smallest outbound-mail helper for the two hand-offs of a paid deliverable
// (operator "a draft is waiting", buyer "your document is released"). Email is best-effort delivery
// and NEVER the system of record: every caller keeps the work in the database and reports, truthfully,
// whether the message was actually accepted by the mail provider.

export type MailResult = { sent: true } | { sent: false; reason: string };

/** The sender both customer and operator mail use; RESEND_FROM first (the existing customer mail), then LEAD_FROM_EMAIL. */
function sender(): string | null {
  return process.env.RESEND_FROM || process.env.LEAD_FROM_EMAIL || null;
}

export async function sendMail(m: { to: string; subject: string; text: string }): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY;
  const from = sender();
  if (!key || !from) return { sent: false, reason: "Email is not configured on this deployment (RESEND_API_KEY and RESEND_FROM)." };
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
