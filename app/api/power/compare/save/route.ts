import { recordFunnelEvent } from "@/lib/funnel";
import { NextResponse } from "next/server";
import { z } from "zod";
import { compareRequestSchema } from "@/lib/ttp-compare";
import { runCompare } from "@/lib/ttp-compare-server";
import { guardRequest } from "@/lib/rate-limit";
import { readBoundedJson } from "@/lib/http-body";
import { saveComparison, type SaveTarget } from "@/lib/project-comparisons";
import { getProjectByToken } from "@/lib/projects";
import { acceptedQuotations, quotationEvidenceReady } from "@/lib/project-quotations";
import { backingLines } from "@/lib/comparison-evidence";

export const runtime = "nodejs";
export const maxDuration = 60;

// Save a Time-to-Power comparison to a project.
//
// The browser sends the REQUEST, never a result: the engine is asked again here and what is stored is its answer, so a
// saved comparison is always something the engine said. With `project.project_token` the comparison is added to that
// project; without it a new project is created in the same transaction (a failure leaves neither), and the response
// carries the new project's token, the only time the server hands it out.
//
// With `use_accepted_quotations` the comparison is priced on the project's own accepted supplier quotations. The browser
// does not say which: the server reads the lines that a named reviewer accepted, for engagements linked to THIS project
// (lib/project-quotations.ts), hands them to the engine, and stores only the ones the engine reports it applied. If there
// are none, or the engine applies none, nothing is saved: a request for a quotation-backed comparison is never answered
// with a library-priced one.
//
// Public and unauthenticated like the comparison itself, and it spends the platform engine key, so the rate limit runs
// before the engine and fails closed (lib/rate-limit.ts).
const MAX_BODY_BYTES = 64 * 1024;

const saveSchema = z
  .object({
    compare: compareRequestSchema,
    project: z
      .object({
        project_name: z.string().trim().min(1).max(200).optional(),
        company: z.string().trim().max(200).optional(),
        project_token: z.string().min(1).max(200).optional(),
      })
      .strict(),
    use_accepted_quotations: z.boolean().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (!b.project.project_token && !b.project.project_name) {
      ctx.addIssue({ code: "custom", path: ["project", "project_name"], message: "Name the project, or give the token of an existing one." });
    }
    if (b.use_accepted_quotations && !b.project.project_token) {
      ctx.addIssue({
        code: "custom",
        path: ["use_accepted_quotations"],
        message: "Quotations belong to an existing project: give its project token, or save without them.",
      });
    }
  });

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  const body = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!body.ok) return NextResponse.json({ ok: false, error: body.error }, { status: body.status, headers: NO_STORE });
  const raw = body.value;
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Validation failed",
        problems: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 422, headers: NO_STORE }
    );
  }

  // Authorise first: the project token is resolved before any limit is spent or any provider is touched.
  let target: SaveTarget;
  if (parsed.data.project.project_token) {
    const found = await getProjectByToken(parsed.data.project.project_token);
    if (!found.ok) {
      return NextResponse.json(
        { ok: false, error: found.status === 404 ? "That project was not found." : found.error },
        { status: found.status, headers: NO_STORE }
      );
    }
    target = { kind: "existing", project: found.project };
  } else {
    target = { kind: "new", project_name: parsed.data.project.project_name!, company: parsed.data.project.company || null };
  }

  // Quotations are resolved here too, before any limit is spent or any provider is touched: a request that cannot be
  // answered with the evidence it asked for costs the caller nothing.
  let offered: Record<string, unknown>[] | undefined;
  if (parsed.data.use_accepted_quotations && target.kind === "existing") {
    const ready = await quotationEvidenceReady();
    if (!ready.ok) return NextResponse.json({ ok: false, error: ready.error }, { status: ready.status, headers: NO_STORE });
    const got = await acceptedQuotations(target.project);
    if (!got.ok) return NextResponse.json({ ok: false, error: got.error }, { status: got.status, headers: NO_STORE });
    if (got.set.entries.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "This project has no accepted supplier quotation to price the comparison on, so nothing was saved. " +
            "A quotation counts only after a named reviewer accepts it for an engagement linked to this project.",
          ...(got.set.excluded.length ? { not_usable: got.set.excluded.length } : {}),
        },
        { status: 409, headers: NO_STORE }
      );
    }
    offered = got.set.entries;
  }

  const g = await guardRequest(req, "ttp_compare_save");
  if (g.denied) return g.denied;
  return g.run(async () => {
    const out = await runCompare(parsed.data.compare, offered);
    if (!out.ok) {
      return NextResponse.json(
        { ok: false, error: out.error, ...(out.detail ? { detail: out.detail } : {}) },
        { status: out.status, headers: NO_STORE }
      );
    }

    // Only a line the engine APPLIED and that repriced a step of some scenario backs this comparison. Lines that were
    // ignored (expired, replaced) or that no scenario of this hall buys do not make it quotation-backed, so the request
    // is refused rather than stored under a claim its numbers do not support.
    let applied: string[] = [];
    if (offered) {
      applied = backingLines(out.result).map((l) => l.evidence_id);
      if (applied.length === 0) {
        const ignored = (out.result.cost_evidence?.ignored ?? []).map((i) => i.reason);
        const heldNone = (out.result.cost_evidence?.used ?? []).length === 0;
        return NextResponse.json(
          {
            ok: false,
            error: heldNone
              ? "None of the project's accepted quotations could be applied, so nothing was saved."
              : "None of the project's accepted quotations prices anything this hall's scenarios buy, so the comparison would not rest on them. Nothing was saved.",
            ...(ignored.length ? { ignored } : {}),
          },
          { status: 409, headers: NO_STORE }
        );
      }
    }

    const saved = await saveComparison(target, out.engineBody, out.result, applied);
    if (!saved.ok) {
      return NextResponse.json({ ok: false, error: saved.error }, { status: saved.status, headers: NO_STORE });
    }
    const token = saved.project_token ?? (target.kind === "existing" ? target.project.project_token : null);
    // Adoption funnel: counted, never described (no project name, token, hall or result goes into the event).
    if (saved.project_token) await recordFunnelEvent("project_created");
    if (saved.created) await recordFunnelEvent("project_saved_result", { kind: "comparison" });
    return NextResponse.json(
      {
        ok: true,
        created: saved.created,
        comparison_id: saved.comparison_id,
        request_digest: out.result.request_digest,
        ...(offered ? { quotations: { offered: offered.length, applied: applied.length } } : {}),
        project_name: target.kind === "existing" ? target.project.project_name : target.project_name,
        // Only a project created by this call hands its token back; an existing project's holder already has it.
        ...(saved.project_token ? { project_token: saved.project_token } : {}),
        workspace_path: token ? `/workspace?project=${encodeURIComponent(token)}` : null,
      },
      { status: saved.created ? 201 : 200, headers: NO_STORE }
    );
  });
}
