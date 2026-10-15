import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { documentHash, getByToken, updateByTokenIf } from "@/lib/deliverables";
import { sendMail } from "@/lib/mail";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";

// Release a generated deliverable to the client. Auth-gated, and deliberately a
// separate human act from generating it: an engineering opinion gets a name
// against it before a client reads it.
export async function PATCH(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { token?: string; action?: string; reviewed_hash?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const action =
    body.action === "unrelease" ? "unrelease" : body.action === "reopen" ? "reopen" : "release";
  if (!token) return NextResponse.json({ ok: false, error: "token required" }, { status: 422 });

  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  if (action === "release") {
    // Idempotent re-click: already released, nothing written, nobody emailed.
    if (row.status === "released") {
      const link = `${SITE_URL}/deliverable/${token}`;
      return NextResponse.json({ ok: true, status: "released", customer_notified: false, notify_error: "Already released; the buyer was not emailed again.", link });
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
    // What is released must be exactly what was reviewed: the caller names the
    // sha256 of the draft they read (AdminDeliverable.document_hash), and it must
    // still match the stored document — and the hash recorded at generation.
    const current = documentHash(row.document_html);
    const reviewed = typeof body.reviewed_hash === "string" ? body.reviewed_hash : "";
    if (!reviewed) {
      return NextResponse.json(
        { ok: false, error: "reviewed_hash is required: release names the exact draft that was reviewed." },
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
    // Compare-and-set on status=draft, and trust only the store's answer: the buyer
    // is emailed only after the release is durably recorded.
    const written = await updateByTokenIf(
      token,
      { status: "released", released_at: new Date().toISOString() },
      ["draft"]
    );
    if (written === "error") {
      return NextResponse.json(
        { ok: false, error: "Could not record the release; nothing was changed and the buyer was not emailed." },
        { status: 503 }
      );
    }
    if (written === "lost") {
      return NextResponse.json(
        { ok: false, error: "This engagement is no longer a draft; reload and check it." },
        { status: 409 }
      );
    }
    const link = `${SITE_URL}/deliverable/${token}`;
    // Releasing is the moment the buyer is owed their document: the intake page promised "You will get
    // the link once it is released". Report what actually happened so a failed send is handed to the
    // operator instead of being assumed.
    const sent = await sendMail({
      to: row.email ?? "",
      subject: "Your GridForge document is ready",
      text:
        "Your document has been reviewed by a senior engineer and released.\n\n" +
        `${link}\n\n` +
        "The link is private to this engagement and is the only way to open the document — keep it, and do not " +
        "forward it to anyone who should not read the result. It is a screening-mode document: it carries its " +
        "own evidence classes and assumptions, and it is not an issued engineering opinion.",
    });
    return NextResponse.json({
      ok: true,
      status: "released",
      customer_notified: sent.sent,
      ...(sent.sent ? {} : { notify_error: sent.reason }),
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
