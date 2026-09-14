import { NextResponse } from "next/server";
import { getByToken, renderDeliverable, updateByToken } from "@/lib/deliverables";
import { PRODUCT_BY_KIND } from "@/lib/products";
import { engagementIntakeSchema, toIntakeDocument } from "@/lib/engagement-intake";

export const runtime = "nodejs";
export const maxDuration = 120;

// The client's own numbers for a purchased engagement.
//
// GET  -> what this engagement is and whether it still wants an intake.
// POST -> store the intake, ask the engine for the document, leave it as a DRAFT.
//         Generation is automated. Release is not: a human puts their name to an
//         engineering opinion before a client reads it.

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  const product = PRODUCT_BY_KIND[row.kind];
  return NextResponse.json({
    ok: true,
    kind: row.kind,
    product: product ? { name: product.name, turnaroundDays: product.turnaroundDays } : null,
    status: row.status,
    company: row.company,
    submitted: Boolean(row.intake),
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  if (row.status === "released") {
    return NextResponse.json(
      { ok: false, error: "This engagement has already been delivered." },
      { status: 409 }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  const parsed = engagementIntakeSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Validation failed", issues: parsed.error.flatten() },
      { status: 422 }
    );
  }

  const doc = toIntakeDocument(parsed.data, row.company ?? undefined);
  await updateByToken(token, { intake: doc, status: "generating" });

  const endpoint = row.kind === "envelope_study_deposit" ? "study" : "screen";
  const rendered = await renderDeliverable(doc, endpoint);

  if (!rendered.ok) {
    await updateByToken(token, { status: "engine_unavailable" });
    return NextResponse.json(
      {
        ok: false,
        error:
          "Your numbers were saved, but the engine could not produce the document just now. " +
          "Nothing is lost and nothing was invented — we will pick this up and come back to you.",
        detail: rendered.error,
      },
      { status: 502 }
    );
  }

  await updateByToken(token, {
    status: "draft",
    title: rendered.title,
    document_html: rendered.html,
    document_md: rendered.md,
  });

  return NextResponse.json({
    ok: true,
    status: "draft",
    title: rendered.title,
    message:
      "Received. The document is generated and now sits with a senior engineer for review. " +
      "You will get the link once it is released — we do not publish an engineering opinion " +
      "nobody has read.",
  });
}
