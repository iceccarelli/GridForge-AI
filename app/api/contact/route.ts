import { NextResponse } from "next/server";
import * as z from "zod";
import { SITE } from "@/lib/site";
import { readBoundedJson } from "@/lib/http-body";
import { guardRequest } from "@/lib/rate-limit";
import { noticeLeadLost, noticeLeadStored, storeLead } from "@/lib/lead-store";
import { scoreLead } from "@/lib/lead";

export const runtime = "nodejs";

/**
 * POST /api/contact: the form on /contact. A visitor writes their name, work address, company and what the hall or problem is (and,
 * optionally, megawatts). The enquiry is stored through the same path the scoping assistant uses (lib/lead-store.ts: the existing `leads`
 * table, no new table or column), so it appears in the same place for the operator.
 *
 * What this route deliberately does NOT do:
 *   - send any email to the visitor (an address a stranger typed is not proof its owner asked). The OPERATOR is told, through the repo's
 *     once-per-day notice helper, that an enquiry was stored and to look in the admin leads view; the notice carries an opaque reference
 *     and none of what the visitor wrote. A lost enquiry is told the same way (lib/lead-store.ts).
 *   - log anything the visitor wrote, or echo it back.
 *   - take a tier, score, status or source from the caller: those are set here.
 *
 * `message` carries "what is the hall, what is the problem"; the optional megawatts go in `capacity_mw`. The `leads` table has no column for
 * anything more, and `location` (NOT NULL) is "Not specified" because the form does not ask for it.
 */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MW = 5000;

const schema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(120, "That name is too long."),
  email: z.string().trim().max(254, "That address is too long.").email("Enter a valid work email address."),
  company: z.string().trim().min(2, "Enter your company or organisation.").max(160, "That is too long."),
  message: z.string().trim().min(10, "Say a little about the hall or the problem (at least a line).").max(2000, "Please keep this under 2,000 characters."),
});

/** Optional megawatts: a plain positive number (a string from a form field, or a number). Anything else is refused, never guessed. */
function parseMw(v: unknown): { ok: true; mw: number | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, mw: null };
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return { ok: true, mw: null };
    if (!/^\d{1,5}(\.\d{1,3})?$/.test(t)) return { ok: false };
    v = Number(t);
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_MW) return { ok: false };
  return { ok: true, mw: v };
}

const noStore = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => NextResponse.json(body, { status, headers: { ...noStore, ...headers } });

export async function POST(req: Request) {
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return json({ ok: false, error: read.status === 413 ? "That message is too long to send here." : "Invalid request." }, read.status);
  const raw = (read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : {}) as Record<string, unknown>;

  // Honeypot: a field no person sees or fills. A bot that fills it is told it worked, and nothing is stored or counted.
  if (typeof raw.website === "string" && raw.website.trim() !== "") return json({ ok: true });

  const parsed = schema.safeParse(raw);
  const mw = parseMw(raw.mw);
  if (!parsed.success || !mw.ok) {
    const fields: Record<string, string> = {};
    if (!parsed.success) for (const [k, msgs] of Object.entries(parsed.error.flatten().fieldErrors)) if (msgs?.[0]) fields[k] = msgs[0];
    if (!mw.ok) fields.mw = `Enter the capacity as a plain number of MW between 0 and ${MAX_MW}, or leave it blank.`;
    if (Object.keys(fields).length === 0) fields.form = "Check the form and try again.";
    return json({ ok: false, error: "Validation failed", fields }, 422);
  }

  // Admitted (and counted) per caller only after validation, so a malformed request never uses anyone's allowance.
  const g = await guardRequest(req, "contact");
  if (g.denied) return g.denied;

  const f = parsed.data;
  const { score, tier, reasons } = scoreLead({
    capacity: mw.mw === null ? "" : `${mw.mw} MW`, location: "Not specified", urgency: "exploratory", gridStatus: "unknown",
    services: [], message: f.message, name: f.name, company: f.company, email: f.email,
  });
  const stored = await storeLead(
    {
      name: f.name, company: f.company, email: f.email, location: "Not specified", capacity_mw: mw.mw,
      // The form asks neither timeline nor grid status: the record says so instead of carrying a default that reads like an answer.
      urgency: "not stated", grid_status: "unknown", services: [], message: f.message,
      context: "contact-form", source: "contact-form", score, tier,
      // scoreLead's timeline reason would claim something the visitor did not say; keep only the size reason.
      reasons: ["Contact form enquiry; timeline and grid status not asked", ...reasons.filter((r) => /load \(~/.test(r))],
      status: "new",
    },
    "contact-form"
  );
  if (!stored.ok) {
    await noticeLeadLost("contact-form", stored);
    return json(
      { ok: false, ref: stored.ref, error: `Your message was not saved, so nothing has been sent. Please email ${SITE.email} instead. It was a fault on our side${stored.category === "not_configured" ? ": enquiries cannot be taken here right now" : ""}.` },
      503
    );
  }
  // A stored enquiry nobody hears about is a lost sale: tell the operator. Best effort and carrying no enquiry data; it can never fail the request.
  await noticeLeadStored("contact_enquiry", stored.ref);
  return json({ ok: true });
}
