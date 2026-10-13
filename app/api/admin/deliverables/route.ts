import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import {
  BOARD_HTML,
  generateAndStore,
  getByToken,
  packState,
  updateByToken,
} from "@/lib/deliverables";
import { deliverableEndpoint } from "@/lib/products";
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

  let body: { token?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const action =
    body.action === "unrelease" ? "unrelease" : body.action === "regenerate" ? "regenerate" : "release";
  if (!token) return NextResponse.json({ ok: false, error: "token required" }, { status: 422 });

  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  if (action === "regenerate") {
    // Recovery for a pack that is incomplete or whose engine run failed. Re-solves from the stored intake and
    // replaces every generated artefact together; never touches a released engagement.
    const endpoint = deliverableEndpoint(row.kind);
    const stored = (row.intake ?? null) as Record<string, unknown> | null;
    if (row.status === "released") {
      return NextResponse.json({ ok: false, error: "Already released; pull it back first." }, { status: 409 });
    }
    if (!stored || !endpoint) {
      return NextResponse.json({ ok: false, error: "There is no intake to regenerate from." }, { status: 409 });
    }
    const { _gridforge: _ours, ...doc } = stored;
    const out = await generateAndStore(row, doc, endpoint);
    if (!out.ok) return NextResponse.json({ ok: false, error: out.error, stage: out.stage }, { status: 502 });
    return NextResponse.json({
      ok: true,
      status: out.complete ? "draft" : "engine_unavailable",
      ...(out.complete ? {} : { missing: out.missing }),
    });
  }

  if (action === "release") {
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
    const first = row.status !== "released";
    await updateByToken(token, { status: "released", released_at: new Date().toISOString() });
    const link = `${SITE_URL}/deliverable/${token}`;
    // Releasing is the moment the buyer is owed their document: the intake page promised "You will get
    // the link once it is released". Email it once (never on an idempotent re-click), and report what
    // actually happened so a failed send is handed to the operator instead of being assumed.
    if (!first) {
      return NextResponse.json({ ok: true, status: "released", customer_notified: false, notify_error: "Already released; the buyer was not emailed again.", link });
    }
    const hasBoard = Boolean(row.working_files?.[BOARD_HTML]);
    const sent = await sendMail({
      to: row.email ?? "",
      subject: "Your GridForge document is ready",
      // Same row, same payload: a retry after a lost response returns the first result instead of sending twice.
      idempotencyKey: `deliverable-release-${row.id}`,
      text:
        (hasBoard
          ? "Your study and its one-page board summary have been reviewed by a senior engineer and released.\n\n"
          : "Your document has been reviewed by a senior engineer and released.\n\n") +
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

  await updateByToken(token, { status: "draft", released_at: null });
  return NextResponse.json({ ok: true, status: "draft" });
}
