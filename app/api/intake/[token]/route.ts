import { NextResponse } from "next/server";
import { getByToken, renderDeliverable, updateByToken } from "@/lib/deliverables";
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
  const row = await getByToken(token);
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
  await updateByToken(token, { intake: doc, status: "generating" });

  // From the catalogue, not from a conditional here. Branching on the kind inline
  // is how a EUR 18,000 Procurement Specification purchase generated a Density
  // Screen: the client paid for one document and the system produced another,
  // and nothing objected.
  const endpoint = deliverableEndpoint(row.kind);
  if (!endpoint) {
    await updateByToken(token, {
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

  // What bound, as the engine reported it. Stored
  // under a namespaced key so the client's own intake stays exactly as they
  // entered it — the follow-on offer names their constraint rather than a generic
  // one, and an unreadable bundle simply means it does not.
  // Prefer the engine's own field; fall back to the working-file bundle, which is
  // all the Study used to have and all a Screen never had.
  const binding = rendered.binding ?? bindingFrom(rendered.working);

  await updateByToken(token, {
    status: "draft",
    title: rendered.title,
    intake: binding ? { ...doc, _gridforge: { binding } } : doc,
    document_html: rendered.html,
    document_md: rendered.md,
    ...(rendered.deck ? { deck_html: rendered.deck } : {}),
    ...(rendered.working ? { working_files: rendered.working } : {}),
  });

  return NextResponse.json({
    ok: true,
    status: "draft",
    title: rendered.title,
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

/**
 * The constraint that binds, from scenarios.csv.
 *
 * Deliberately tolerant: a missing or reshaped bundle returns null and the page
 * falls back to a generic sentence. Guessing a constraint would be worse than not
 * naming one — this is a document about what physically limits a client's hall.
 */
function bindingFrom(working: Record<string, string> | null): string | null {
  const csv = working?.["scenarios.csv"];
  if (!csv) return null;
  try {
    const [header, ...rows] = csv.split("\n").filter((l) => l.trim());
    const cols = header.split(",");
    const i = cols.indexOf("binds_first");
    if (i < 0 || !rows.length) return null;
    // Split respecting quoted fields — scenario names contain commas.
    const cells = rows[0].match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [];
    const raw = (cells[i] ?? "").replace(/,$/, "").replace(/^"|"$/g, "").trim();
    return raw || null;
  } catch {
    return null;
  }
}
