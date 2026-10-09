import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { getByToken, updateByToken } from "@/lib/deliverables";
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
  const action = body.action === "unrelease" ? "unrelease" : "release";
  if (!token) return NextResponse.json({ ok: false, error: "token required" }, { status: 422 });

  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  if (action === "release") {
    if (!row.document_html) {
      return NextResponse.json(
        { ok: false, error: "Nothing generated yet — there is no document to release." },
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

  await updateByToken(token, { status: "draft", released_at: null });
  return NextResponse.json({ ok: true, status: "draft" });
}
