import { NextResponse } from "next/server";
import { notifyOperator } from "@/lib/mail";
import { SITE_URL } from "@/lib/site";
import { generateAndStore, getByIntakeToken, updateByToken } from "@/lib/deliverables";
import { PRODUCT_BY_KIND, deliverableEndpoint } from "@/lib/products";
import { intakePrefill, qualificationById } from "@/lib/qualify";
import {
  assumedFields,
  intakeSchemaFor,
  toIntakeDocument,
  ASSUMABLE_SOURCE,
} from "@/lib/engagement-intake";

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
  const row = await getByIntakeToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  const product = PRODUCT_BY_KIND[row.kind];

  // The numbers they already gave us follow them into the thing they paid for.
  //
  // A customer types seven numbers into the free qualifier, sees a real read, and
  // buys. Asking for the same seven again is friction at the worst moment there
  // is: after the money is taken and before the document exists, which is exactly
  // where an abandoned intake becomes revenue collected for something nobody ever
  // receives. The join was in the database — deliverables.qualification_id, set by
  // our own webhook — and nothing read it.
  //
  // Carried through an allowlist, never a spread: the qualification row also holds
  // the name, company and email of whoever ran it, and the person holding this
  // engagement link may be somebody else entirely.
  const prefill = row.qualification_id
    ? intakePrefill(await qualificationById(row.qualification_id))
    : {};

  return NextResponse.json({
    ok: true,
    kind: row.kind,
    product: product ? { name: product.name, turnaroundDays: product.turnaroundDays } : null,
    status: row.status,
    company: row.company,
    submitted: Boolean(row.intake),
    prefill,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByIntakeToken(token);
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
  // The schema is the product's, not one shape for everything. A Density Screen
  // asks for what the free qualifier asks for; a Procurement Specification asks
  // for all of it, because its duties end up on a purchase order.
  const parsed = intakeSchemaFor(row.kind).safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Validation failed", issues: parsed.error.flatten() },
      { status: 422 }
    );
  }

  // What the customer left to us. The engine names every assumption in the
  // document itself; this is so the confirmation they see on submit says the same
  // thing, rather than the first they hear of it being a document footnote.
  const assumed = assumedFields(parsed.data as Record<string, unknown>);

  const doc = toIntakeDocument(parsed.data, row.company ?? undefined);
  await updateByToken(row.token, { intake: doc, status: "generating" });

  // From the catalogue, not from a conditional here. Branching on the kind inline
  // is how a EUR 18,000 Procurement Specification purchase generated a Density
  // Screen: the client paid for one document and the system produced another,
  // and nothing objected.
  const endpoint = deliverableEndpoint(row.kind);
  if (!endpoint) {
    await updateByToken(row.token, {
      status: "awaiting_intake",
      title: null,
    });
    return NextResponse.json(
      {
        ok: false,
        error:
          `No generation path is configured for '${row.kind}'. This is our problem, ` +
          `not yours — your intake is saved and we have been told.`,
      },
      { status: 500 }
    );
  }
  // One fulfilment path, shared with the operator's "regenerate": it renders the pack, stores it in a single row
  // update, and only reports `draft` when every artefact the product promises exists.
  const stored = await generateAndStore(row, doc, endpoint);

  if (!stored.ok) {
    const persist = stored.stage === "persist";
    // The buyer is told "we will pick this up"; nothing else tells anyone, so say it to the operator.
    await notifyOperator(
      `${persist ? "Documents could not be stored" : "Engine could not produce a document"} — ${row.email ?? "unknown buyer"} (${row.kind})`,
      `The buyer's numbers are saved (status engine_unavailable) but ${persist ? "the generated documents could not be stored" : `the engine could not generate the ${row.kind} just now`}: ${stored.error}\n\n` +
        `Buyer: ${row.email ?? "no email on record"}\n` +
        `Open ${SITE_URL}/admin/pipeline and use Regenerate once it is back. The buyer was told you will come back to them.`
    );
    return NextResponse.json(
      {
        ok: false,
        error:
          "Your numbers were saved, but the document could not be produced just now. " +
          "Nothing is lost and nothing was invented — we will pick this up and come back to you.",
        detail: stored.error,
      },
      { status: 502 }
    );
  }

  if (!stored.complete) {
    // Part of the pack exists, part does not. It is not a draft: nothing can be released until it is whole.
    await notifyOperator(
      `Pack incomplete — ${row.email ?? "unknown buyer"} (${stored.title})`,
      `A paid ${row.kind} was generated without: ${stored.missing.join(", ")}. What exists is saved and the ` +
        `engagement is held (engine_unavailable) so it cannot be released as complete.\n\n` +
        `Buyer: ${row.email ?? "no email on record"}\nUse Regenerate at ${SITE_URL}/admin/pipeline once the engine is back.`
    );
    return NextResponse.json({
      ok: true,
      status: "engine_unavailable",
      title: stored.title,
      message:
        "Received. Part of your pack is still being produced; we will complete it, have a senior engineer " +
        "review it and come back to you. Nothing has been published.",
      assumed: assumed.map((f) => ({ field: f, source: ASSUMABLE_SOURCE[f] })),
    });
  }

  // A draft waits for a person. Nothing else announces it, and the buyer has just been told it is with
  // a senior engineer: tell the engineer. (The document token is never put in an email.)
  await notifyOperator(
    `Draft ready for review — ${row.email ?? "unknown buyer"} (${stored.title})`,
    `A paid ${row.kind} has been generated and is waiting for your review and release.\n\n` +
      `Buyer: ${row.email ?? "no email on record"}${row.company ? ` · ${row.company}` : ""}\n` +
      `Review and release it at ${SITE_URL}/admin/pipeline\n\n` +
      `Releasing it emails the buyer their private link.`
  );

  return NextResponse.json({
    ok: true,
    status: "draft",
    title: stored.title,
    message:
      "Received. The document is generated and now sits with a senior engineer for review. " +
      "You will get the link once it is released — we do not publish an engineering opinion " +
      "nobody has read.",
    // Said here as well as in the document. A customer who left three numbers
    // blank should hear what we assumed at the moment they submitted, not
    // discover it in a footnote a week later.
    assumed: assumed.map((f) => ({ field: f, source: ASSUMABLE_SOURCE[f] })),
  });
}
