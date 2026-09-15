import { NextResponse } from "next/server";
import { fetchQualifications, summariseQualifications } from "@/lib/admin";

export const runtime = "nodejs";
export const revalidate = 900;

// What actually binds in real European halls — published, anonymised.
//
// This is the growth loop and the moat in one. Anyone competent can rebuild the
// constraint physics from ASHRAE, OCP and a month of work. Nobody else is
// accumulating a record of what actually stops real halls, and every free
// qualifier run adds a row. Publishing the distribution is what turns that record
// from a private asset into the reason this practice is the one people call.
//
// Two rules, both non-negotiable:
//   * nothing identifying leaves this route — no company, site, hall, email;
//   * nothing is published below MIN_HALLS, because a distribution over four halls
//     is noise wearing the clothes of evidence, and a small sample can point at
//     the individual who filled it in.
const MIN_HALLS = 8;

export async function GET() {
  const rows = await fetchQualifications(1000);
  const scored = rows.filter((r) => r.binding_constraint);

  if (scored.length < MIN_HALLS) {
    return NextResponse.json({
      ok: true,
      published: false,
      halls: scored.length,
      threshold: MIN_HALLS,
      reason:
        `Not enough halls yet. We publish this once ${MIN_HALLS} have been through the engine — ` +
        "a distribution over a handful of sites is noise dressed as evidence, and a small sample " +
        "can point at whoever filled it in.",
    });
  }

  // Summarise the SCORED halls, not every row.
  //
  // The gate above counts halls that produced a result; the medians and the metro
  // list were computed over all rows, which put two things into a published
  // document that do not belong there. An enquiry the engine could not answer
  // still stored its metro, so a hall that never got a read was published in a
  // distribution its owner was never part of. And the medians were drawn from a
  // different population than the basis statement below describes.
  //
  // The second one matters more than it looks. This practice sells numbers that
  // carry their evidence, and a published figure whose stated basis does not match
  // its own arithmetic is the one claim that would cost more than it earns.
  //
  // The admin view still calls this with every row — internally, "how many came in
  // and how many did we answer" is exactly the question worth asking.
  const s = summariseQualifications(scored);
  return NextResponse.json({
    ok: true,
    published: true,
    halls: s.withResult,
    blocked_as_found: s.blockedAsFound,
    constraints: s.constraints.map((c) => ({
      constraint: c.constraint,
      halls: c.halls,
      share: Math.round(c.share * 1000) / 1000,
    })),
    medians: {
      contracted_headroom_pct:
        s.medianHeadroomPct === null ? null : Math.round(s.medianHeadroomPct),
      tapoff_A: s.medianTapoffA,
      busway_A: s.medianBuswayA,
      plant_supply_C: s.medianPlantSupplyC,
    },
    metros: s.metros.map((m) => m.metro),
    basis:
      "Halls submitted to the public capacity qualifier. Each was solved with the same " +
      "constraint set; figures not supplied were filled from library defaults and are named as " +
      "assumptions in that hall's own read. Self-selected sample — people run this because they " +
      "suspect a problem — so read it as what binds among halls someone was worried about, not " +
      "as a survey of the European estate.",
  });
}
