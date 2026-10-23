import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import {
  BOARD_HTML,
  claimForGeneration,
  claimStamp,
  generateAndStore,
  getByToken,
  packState,
  reviewHash,
  recoverStaleGenerating,
  updateByTokenIf,
} from "@/lib/deliverables";
import { attentionList } from "@/lib/attention";
import { deliverableEndpoint } from "@/lib/products";
import { sendMail } from "@/lib/mail";
import { ensureNotification, notificationState, type Outcome } from "@/lib/notifications";
import { SITE_URL } from "@/lib/site";
import { runTrusted } from "@/lib/spend-scope";
import { paymentStanding } from "@/lib/payment-standing";

export const runtime = "nodejs";

// The operator's list of paid work that needs a person: stuck, overdue, held or ambiguous. Read-only.
export async function GET() {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const r = await attentionList();
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, items: r.items, checked_at: r.checked_at }, { headers: { "Cache-Control": "no-store" } });
}

// Release a generated deliverable to the client. Auth-gated, and deliberately a
// separate human act from generating it: an engineering opinion gets a name
// against it before a client reads it.
export async function PATCH(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { token?: string; action?: string; reviewed_hash?: string; reviewed_by?: string; acknowledge_payment_issue?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const action =
    body.action === "unrelease"
      ? "unrelease"
      : body.action === "reopen"
        ? "reopen"
        : body.action === "regenerate"
          ? "regenerate"
          : "release";
  if (!token) return NextResponse.json({ ok: false, error: "token required" }, { status: 422 });

  let row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  // Recovery actions apply to a `generating` row whose request has died. A fresh one may still be running, so it is
  // refused (with its age) rather than raced.
  if ((action === "regenerate" || action === "reopen") && row.status === "generating") {
    const rec = await recoverStaleGenerating(row);
    if (rec === "recovered") row = { ...row, status: "engine_unavailable" };
    else if (rec === "fresh") {
      return NextResponse.json(
        { ok: false, error: "This engagement is still generating and its request may be running. It becomes recoverable here once it has been generating for longer than a request can live." },
        { status: 409 }
      );
    } else if (rec === "error") {
      return NextResponse.json({ ok: false, error: "Could not update this engagement." }, { status: 503 });
    }
  }

  if (action === "regenerate") {
    // Recovery for a pack that is incomplete or whose engine run failed. Re-solves from the stored intake through
    // the same shared function as the customer's submission, replacing every generated artefact together. Only an
    // `engine_unavailable` engagement is eligible: a released one is never regenerated over, and a draft a reviewer
    // may be reading is not silently rewritten (reopen it instead).
    if (row.status === "released") {
      return NextResponse.json({ ok: false, error: "Already released; pull it back first." }, { status: 409 });
    }
    if (row.status !== "engine_unavailable") {
      return NextResponse.json(
        { ok: false, error: `Only an engagement held as engine_unavailable can be regenerated (this one is '${row.status}').` },
        { status: 409 }
      );
    }
    const endpoint = deliverableEndpoint(row.kind);
    const stored = (row.intake ?? null) as Record<string, unknown> | null;
    if (!stored || !endpoint) {
      return NextResponse.json({ ok: false, error: "There is no intake to regenerate from." }, { status: 409 });
    }
    // Claim it, so a release, a customer resubmission or a second regenerate cannot interleave.
    const claimedAt = new Date();
    const claim = await claimForGeneration(token, stored, ["engine_unavailable"], claimedAt);
    if (claim !== "claimed") {
      return NextResponse.json(
        { ok: false, error: claim === "error" ? "Could not update this engagement." : "This engagement is no longer held; reload and check it." },
        { status: claim === "error" ? 503 : 409 }
      );
    }
    const { _gridforge: _ours, ...doc } = stored;
    // The operator's session authenticates this regeneration; it is not metered per caller.
    const out = await runTrusted("admin-session", () => generateAndStore({ ...row, claim: claimStamp(claimedAt) }, doc, endpoint));
    if (!out.ok) return NextResponse.json({ ok: false, error: out.error, stage: out.stage }, { status: 502 });
    // The reviewer must echo the hash of the pack as it now stands, so hand it back rather than leave the UI stale.
    const fresh = await getByToken(token);
    return NextResponse.json({
      ok: true,
      status: out.complete ? "draft" : "engine_unavailable",
      ...(fresh?.document_html ? { has_document: true, document_hash: reviewHash(fresh) } : {}),
      ...(out.complete ? {} : { missing: out.missing }),
    });
  }

  if (action === "release") {
    // Idempotent re-click: already released, nothing written. What it says about the buyer's email is what the outbox says: a
    // release email that is still queued (or was refused, or had no address) is NOT "already sent", and a click while it is
    // pending makes the attempt again if it is due.
    if (row.status === "released") {
      const link = `${SITE_URL}/deliverable/${token}`;
      const disc = String((row.intake as { _gridforge?: { review?: { pack_sha256?: unknown } } } | null)?._gridforge?.review?.pack_sha256 ?? reviewHash(row)).slice(0, 16);
      const n = await releaseNotice(row.id, disc);
      if (n.state === "unavailable") {
        return NextResponse.json({ ok: true, status: "released", customer_notified: false, notify_error: "Already released; the buyer was not emailed again.", link });
      }
      if (n.state === "accepted") {
        return NextResponse.json({ ok: true, status: "released", customer_notified: false, buyer_email: "accepted", notify_error: "Already released; the buyer was emailed and the provider accepted it.", link });
      }
      return NextResponse.json({ ok: true, status: "released", customer_notified: false, buyer_email: n.state, notify_error: n.message, link });
    }
    // Only a draft can be released. `generating`, `awaiting_intake` and
    // `engine_unavailable` rows may hold a stale or half-written document_html.
    if (row.status !== "draft") {
      return NextResponse.json(
        { ok: false, error: `Only a draft can be released (this engagement is '${row.status}').` },
        { status: 409 }
      );
    }
    if (!row.document_html) {
      return NextResponse.json(
        { ok: false, error: "Nothing generated yet — there is no document to release." },
        { status: 409 }
      );
    }
    // A pack is released whole or not at all. Rows generated before packs existed carry no manifest and release
    // as the study-only document they always were.
    const pack = packState(row);
    if (!pack.complete) {
      return NextResponse.json(
        { ok: false, error: `The pack is incomplete (missing: ${pack.missing.join(", ")}). Regenerate it before release.` },
        { status: 409 }
      );
    }
    // What is released must be exactly what was reviewed: the caller names the
    // sha256 of the draft (the whole pack) they read (AdminDeliverable.document_hash), and it must
    // still match the stored document — and the hash recorded at generation.
    const current = reviewHash(row);
    const reviewed = typeof body.reviewed_hash === "string" ? body.reviewed_hash : "";
    if (!reviewed) {
      return NextResponse.json(
        { ok: false, error: "reviewed_hash is required: release names the exact draft that was reviewed." },
        { status: 422 }
      );
    }
    // The buyer is emailed that "a senior engineer" reviewed it: a release without a name on the record makes that sentence
    // uncheckable, so the name is required.
    const reviewerName = typeof body.reviewed_by === "string" ? body.reviewed_by.trim() : "";
    if (!reviewerName) {
      return NextResponse.json(
        { ok: false, error: "reviewed_by is required: the name of the engineer who reviewed this draft. It is recorded with the release and shown to the buyer." },
        { status: 422 }
      );
    }
    const generated = (row.intake as { _gridforge?: { document_sha256?: unknown } } | null)?._gridforge?.document_sha256;
    if (reviewed !== current || (typeof generated === "string" && generated !== current)) {
      return NextResponse.json(
        { ok: false, error: "The draft changed since you reviewed it. Reload, re-read it, and release again." },
        { status: 409 }
      );
    }
    // Release hands the buyer the work and cannot be taken back. Stripe is asked now, not at checkout: a payment refunded or
    // disputed since is not released without a person saying so (acknowledge_payment_issue), and a payment whose standing
    // Stripe could not report is not guessed at.
    const standing = await paymentStanding(row.stripe_session_id);
    const overrode = (standing.state === "refunded" || standing.state === "disputed" || standing.state === "unavailable") && body.acknowledge_payment_issue === true;
    if ((standing.state === "refunded" || standing.state === "disputed" || standing.state === "unavailable") && body.acknowledge_payment_issue !== true) {
      const reason =
        standing.state === "unavailable"
          ? "Stripe could not be asked whether this payment still stands, so nothing was released."
          : `Not released: ${standing.detail}.`;
      return NextResponse.json(
        {
          ok: false,
          error: `${reason} Check the payment in Stripe; to release anyway (a goodwill delivery, a dispute you have decided to contest), send acknowledge_payment_issue: true.`,
          payment_standing: standing.state,
        },
        { status: standing.state === "unavailable" ? 503 : 409 }
      );
    }
    // Compare-and-set on status=draft, and trust only the store's answer: the buyer
    // is emailed only after the release is durably recorded.
    // Who put their name to it, recorded WITH the release (one compare-and-set): the buyer is emailed that "a senior
    // engineer" reviewed it, and without a name on the record that sentence cannot be checked. The API accepts a release
    // without a name (older callers) and says so in its answer; the pipeline asks for one.
    const reviewer = reviewerName.slice(0, 120);
    const releasedAt = new Date().toISOString();
    const priorMeta = (row.intake as { _gridforge?: Record<string, unknown> } | null)?._gridforge ?? {};
    const written = await updateByTokenIf(
      token,
      {
        status: "released",
        released_at: releasedAt,
        intake: {
          ...((row.intake as Record<string, unknown> | null) ?? {}),
          _gridforge: { ...priorMeta, review: { by: reviewer || null, at: releasedAt, pack_sha256: current, ...(overrode ? { payment_override: standing.state } : {}) } },
        },
      },
      ["draft"],
      undefined,
      // The version of the row that was HASHED and reviewed (migration 0037's row_version, bumped by every UPDATE): a document
      // changed between the hash check above and this write cannot be released under the stale approval. Without the column
      // (migration not applied) the status compare-and-set alone applies, as before.
      typeof row.row_version === "number" ? row.row_version : undefined
    );
    if (written === "error") {
      return NextResponse.json(
        { ok: false, error: "Could not record the release; nothing was changed and the buyer was not emailed." },
        { status: 503 }
      );
    }
    if (written === "lost") {
      return NextResponse.json(
        { ok: false, error: "This engagement changed since you reviewed it (it is no longer the draft you hashed). Nothing was released and the buyer was not emailed: reload, re-read it, and release again." },
        { status: 409 }
      );
    }
    const link = `${SITE_URL}/deliverable/${token}`;
    // Releasing is the moment the buyer is owed their document: the intake page promised "You will get
    // the link once it is released". Report what actually happened so a failed send is handed to the
    // operator instead of being assumed.
    // The release email is a durable obligation of its own (lib/notifications.ts, kind deliverable_release): attempted now,
    // retried by the sweep when the provider fails, observable when it cannot be delivered. Without the outbox (migration
    // 0021/0036 not applied) it is one direct attempt, as it always was.
    const disc = current.slice(0, 16);
    const queued = await releaseNotice(row.id, disc);
    let notifiedNow = queued.state === "accepted";
    let notifyError: string | undefined = queued.state === "accepted" ? undefined : queued.message;
    if (queued.state === "unavailable") {
      const hasBoard = Boolean(row.working_files?.[BOARD_HTML]);
      const sent = await sendMail({
        to: row.email ?? "",
        subject: "Your GridForge document is ready",
        // Same row, same pack, same payload: a retry after a lost response returns the first result instead of sending
        // twice. The pack hash is in the key so a re-release of a changed pack is a new mail, not a replay.
        idempotencyKey: `deliverable-release-${row.id}-${current.slice(0, 16)}`,
        text:
          (hasBoard
            ? "Your study and its one-page board summary have been reviewed by a senior engineer and released.\n\n"
            : "Your document has been reviewed by a senior engineer and released.\n\n") +
          `${link}\n\n` +
          "The link is private to this engagement and is the only way to open the document — keep it, and do not " +
          "forward it to anyone who should not read the result. It is a screening-mode document: it carries its " +
          "own evidence classes and assumptions, and it is not an issued engineering opinion.",
      });
      notifiedNow = sent.sent;
      notifyError = sent.sent ? undefined : sent.reason;
    }
    const sent = { sent: notifiedNow, reason: notifyError ?? "" };
    return NextResponse.json({
      ok: true,
      status: "released",
      customer_notified: sent.sent,
      ...(sent.sent ? {} : { notify_error: sent.reason }),
      ...(queued.state === "unavailable" ? {} : { buyer_email: queued.state }),
      reviewer_recorded: Boolean(reviewer),
      // Which engine build the document was read against at generation; false = it could not be read and the page says so.
      provenance_recorded: Boolean((priorMeta as { provenance?: unknown }).provenance),
      link,
    });
  }

  if (action === "reopen") {
    // Operator-only way to let the customer correct their numbers: a draft goes
    // back to awaiting_intake (intake POST is refused while a draft exists).
    const r = await updateByTokenIf(token, { status: "awaiting_intake" }, ["draft", "engine_unavailable"]);
    if (r !== "claimed") {
      return NextResponse.json(
        { ok: false, error: r === "error" ? "Could not update this engagement." : "Only a draft can be reopened." },
        { status: r === "error" ? 503 : 409 }
      );
    }
    return NextResponse.json({ ok: true, status: "awaiting_intake" });
  }

  const back = await updateByTokenIf(token, { status: "draft", released_at: null }, ["released"]);
  if (back !== "claimed") {
    return NextResponse.json(
      { ok: false, error: back === "error" ? "Could not update this engagement." : "Only a released engagement can be pulled back." },
      { status: back === "error" ? 503 : 409 }
    );
  }
  return NextResponse.json({ ok: true, status: "draft" });
}

/**
 * Queue the release email through the outbox and report where it stands. "unavailable": the outbox cannot hold it (the caller
 * falls back to one direct send). Every other state is the outbox's own, with a message an operator can act on.
 */
async function releaseNotice(id: string, discriminator: string): Promise<{ state: "accepted" | "pending" | "abandoned" | "ambiguous" | "cancelled" | "unavailable"; message: string }> {
  const out: Outcome = await ensureNotification("deliverable_release", id, discriminator);
  if (out.state === "unavailable") return { state: "unavailable", message: "" };
  let status: string = out.state;
  let category = "category" in out ? out.category : "";
  if (out.state === "skipped" || out.state === "accepted_unrecorded") {
    const n = await notificationState("deliverable_release", id, discriminator);
    status = n?.status ?? (out.state === "accepted_unrecorded" ? "pending" : "pending");
    category = n?.last_error ?? category;
  }
  if (status === "accepted") return { state: "accepted", message: "" };
  if (status === "abandoned") {
    return {
      state: "abandoned",
      message: (category === "no_recipient" ? "There is no email address on record for this buyer" : `The release email could not be delivered (${category || "refused"})`) + ", and it will not be retried. Send them the link yourself.",
    };
  }
  if (status === "ambiguous") return { state: "ambiguous", message: "The release email may or may not have been accepted; an operator must confirm it in /api/admin/notifications." };
  if (status === "cancelled") return { state: "cancelled", message: "The release email no longer applies (the engagement is not released)." };
  return { state: "pending", message: `The release email has not been delivered yet${category ? ` (${category})` : ""}. It is queued and retried automatically, and listed in /api/admin/notifications until it is accepted.` };
}
