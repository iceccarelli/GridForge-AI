import { NextResponse } from "next/server";
import { mailSender, sendMail } from "@/lib/mail";
import { z } from "zod";
import { getQualification, requestFollowUp, type StoredQualification } from "@/lib/qualify";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { siteUrl } from "@/lib/site";
import { guardRequest, mailRecipientAllowed } from "@/lib/rate-limit";
import { readBoundedJson } from "@/lib/http-body";
import { plainLine } from "@/lib/untrusted-text";

export const runtime = "nodejs";

// Ask for a human, once.
//
// The share link (/q/<token>) carries a real engineering answer out of the
// browser tab. It did not give the person holding it a way to say "come and talk
// to me" without either re-typing seven numbers into a fresh qualifier or buying a
// EUR 4,500 engagement cold. This route is that missing step, and deliberately the
// only one: one request, one acknowledgment to the buyer, one notice to the desk
// that follows up. Not a drip sequence — a qualified prospect who has already
// shown interest should get a person, not a mailing list.
//
// Idempotent by construction: `requestFollowUp` only flips the row the first time
// it is called for a given token, so retries, double submits and two open tabs
// all resolve to the same outcome and never produce a second email.
const MAX_BODY_BYTES = 8 * 1024;
const bodySchema = z.object({
  email: z.string().trim().email().max(200),
  note: z.string().trim().max(500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  // An email and a 500-character note: a few hundred bytes. Capped before it is parsed, like the other open routes.
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) {
    return NextResponse.json({ ok: false, error: read.status === 413 ? "That request is too large." : "Invalid payload" }, { status: read.status });
  }
  const raw: unknown = read.value;
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Validation failed", issues: parsed.error.flatten() },
      { status: 422 }
    );
  }

  // Addressed by token, exactly as /q/<token> is. Nothing about this route can be
  // asked to act on any qualification other than the one the caller already holds
  // the unguessable link for.
  const q = await getQualification(token);
  if (!q) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  if (q.status !== "scored" || !q.binding_constraint) {
    return NextResponse.json(
      { ok: false, error: "This qualification produced no result to follow up on." },
      { status: 422 }
    );
  }

  // Each first request on a qualification mails the desk and an address the caller typed, and qualifications are free to
  // create, so the request is admitted (and counted) per caller before it is recorded.
  const g = await guardRequest(req, "qualify_followup");
  if (g.denied) return g.denied;

  const { email, note } = parsed.data;
  const outcome = await requestFollowUp(token, email, note ?? null);
  if (!outcome.ok) {
    return NextResponse.json(
      { ok: false, error: "Could not record the request. Try again." },
      { status: 502 }
    );
  }

  if (!outcome.already) {
    await Promise.allSettled([notifyDesk(q, token, email, note), acknowledgeBuyer(q, token, email)]);
  }

  return NextResponse.json({ ok: true, alreadyRequested: outcome.already });
}

// --- Notification (Resend; same pattern as app/api/audit/route.ts) -----------

/** Internal notice, so a qualified prospect lands in front of a person, not a queue nobody watches. */
async function notifyDesk(
  q: StoredQualification,
  token: string,
  email: string,
  note: string | undefined
): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_TO_EMAIL;
  const from = mailSender("Time to Power <onboarding@resend.dev>");
  if (!key || !to) {
    // The qualification row holds the request; the log carries no bearer token, address or note.
    console.log("[GridForge] follow-up requested (no email provider set); see the stored qualification");
    return;
  }
  // Everything below that the visitor typed (hall name, metro, company, the note) is quoted as one inert plain-text line:
  // no control characters (a line break could forge a header or a second "Read:" line), and no clickable link.
  const where = plainLine([q.site_name, q.hall_id].filter(Boolean).join(" · "), 160) || "Unnamed hall";
  const lines = [
    `A qualified read asked for a follow-up.`,
    "",
    `Hall:      ${where}${q.metro ? ` (${plainLine(q.metro, 80)})` : ""}`,
    `Company:   ${q.company ? plainLine(q.company, 160) : "not given"}`,
    `As found:  ${q.racks_as_found ?? "?"} racks, bound by ${plainLine(q.binding_constraint, 120)}`,
    `Contact:   ${plainLine(email, 200)}`,
    note ? `Note:      ${plainLine(note, 500)}` : null,
    "",
    `Read: ${siteUrl(`/q/${token}`)}`,
  ].filter((l): l is string => l !== null);
  try {
    await sendMail({
        from,
        to: to,
        replyTo: email,
        subject: `Follow-up requested — ${where}`,
        text: lines.join("\n"),
      });
  } catch (err) {
    console.error("[GridForge] follow-up desk notification error:", err);
  }
}

/**
 * Acknowledgment to the buyer. Transactional: it is the direct response to an
 * action they just took, not a marketing send, and it fires once. Every fact in
 * it comes from the stored qualification row or the product catalogue — nothing
 * here is invented, and no savings, urgency or customer status is claimed.
 */
async function acknowledgeBuyer(q: StoredQualification, token: string, email: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = mailSender("Time to Power <onboarding@resend.dev>");
  if (!key) return;
  // The address is whatever the caller typed: it is mailed only while that recipient is under its daily cap.
  if (!(await mailRecipientAllowed(email))) return;
  const screen = PRODUCTS.density_screen;
  // Fixed wording. This mail goes to whatever address the caller typed, from the company's own sender, so it must not carry
  // a word the caller chose: the hall's name and id are free text typed by whoever created the qualification, and quoting them
  // here let anyone send a stranger text and links of their own. The racks figure and the binding constraint come from the
  // engine's answer, not from the caller.
  const text =
    `Thank you — we have your request.\n\n` +
    `Your read showed ${q.racks_as_found ?? "an unspecified number of"} racks ` +
    `deployable as found, bound first by ${q.binding_constraint}. ` +
    `We will look at that read ourselves; we make no promise about when we will reply.\n\n` +
    `That read is a free, directional indication. The next engineering step is the ` +
    `${screen.name}: ${screen.description}\n\n` +
    `${eurFromCents(screen.amountCents)}, ${screen.turnaroundDays} working days, and it credits ` +
    `in full against the full Envelope Study if you go further.\n\n` +
    `Your read: ${siteUrl(`/q/${token}`)}\n` +
    `Commission the ${screen.name}: ${siteUrl("/pricing")}\n\n` +
    `— Time to Power\nIndependent power-and-thermal engineering for existing AI sites`;
  try {
    await sendMail({
        from,
        to: email,
        replyTo: process.env.LEAD_TO_EMAIL || "power@timetopower.ai",
        subject: `Time to Power — we have your follow-up request`,
        text,
      });
  } catch (err) {
    console.error("[GridForge] follow-up acknowledgment error:", err);
  }
}
