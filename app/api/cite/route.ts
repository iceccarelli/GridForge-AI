import { NextResponse } from "next/server";
import { constraintReference } from "@/lib/constraints";
import { siteUrl } from "@/lib/site";

export const dynamic = "force-static";

/**
 * Citation metadata, so quoting us is easy and attributed.
 *
 * Becoming the reference a niche cites is worth more than any single engagement,
 * and the friction that stops it is usually clerical: nobody knows what to write in
 * the footnote. So we write it for them — and the citation carries the caveat, so a
 * modelled figure cannot travel without its label.
 */
export async function GET() {
  const ref = await constraintReference();
  const year = new Date().getUTCFullYear();
  return NextResponse.json(
    {
      title: "GridForge AI — capacity and density constraint reference",
      author: "GridForge AI",
      year,
      url: siteUrl("/constraints"),
      machine_readable: siteUrl("/reference/constraints.json"),
      constraints: ref?.count ?? 0,
      how_to_cite:
        `GridForge AI (${year}). Capacity and density constraint reference for existing ` +
        `data halls. ${siteUrl("/constraints")}`,
      bibtex:
        `@misc{gridforge_constraints_${year},\n` +
        `  author = {{GridForge AI}},\n` +
        `  title  = {Capacity and density constraint reference for existing data halls},\n` +
        `  year   = {${year}},\n` +
        `  url    = {${siteUrl("/constraints")}}\n}`,
      required_caveat:
        "Figures are modelled from published design values and vendor specifications. " +
        "No figure here is a measurement of any customer's asset. Each carries an " +
        "evidence class " +
        "E0-E7; a computed value is never stronger than its weakest input. The model has " +
        "not yet been reconciled against instrumented sites, and the engine reports that " +
        "on every response.",
      licence:
        "Quote freely with attribution. The numbers are published so they can be checked, " +
        "not so they can be repackaged without their evidence class.",
    },
    { headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" } }
  );
}
