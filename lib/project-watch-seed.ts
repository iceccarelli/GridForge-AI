// Server-only. Offering a Hall Watch the hall the same buyer already gave us, without asking for it twice.
//
// WHAT AUTHORISES IT. Exactly one thing: a PROJECT that holds both the watch and the Density Screen / Procurement
// Specification (project_links, written by the Stripe webhook's gf_attach_purchase when a checkout was started FROM that
// project, so whoever made it held the project's bearer token). The chain is
//
//     watch (the bearer token on this page) -> its single project link -> that project's deliverable links -> intake
//
// and every hop is a row the payment path wrote. NOTHING ELSE links a watch to an engagement: the watch carries the Stripe
// checkout email and customer id, the deliverable carries the Stripe session id and a possibly different email, and neither
// carries the other's id. An email is typed at checkout and never verified as the buyer's, so matching on it would hand one
// customer another's hall (the same risk as crediting on an unverified typed email). It is deliberately NOT used here.
//
// A watch bought on its own, or from a different project, or by someone who never bought a screen through a project, has no
// link, gets no seed, and is asked for its numbers as before.

import { getById, type DeliverableRecord } from "@/lib/deliverables";
import { linksFor, projectLinks } from "@/lib/projects";
import { PRODUCT_BY_KIND } from "@/lib/products";
import type { WatchRecord } from "@/lib/watches";

/** The deliverable kinds whose intake is a whole hall in the engine's document shape. */
export const WATCH_SEED_KINDS = ["density_screen", "procurement_spec"] as const;

export interface SeedRow {
  id: string;
  rating: number | "";
  units: number | "";
  redundancy: string;
}

export interface WatchSeed {
  /** The engagement the numbers came from, named for the buyer. */
  source: { kind: string; product: string };
  /** Form values for the Hall Watch intake form (strings, as the inputs hold them). Only fields the engagement actually has. */
  fields: Record<string, string>;
  transformers: SeedRow[];
  ups: SeedRow[];
}

type Doc = Record<string, any>;

const isObj = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const put = (out: Record<string, string>, key: string, v: unknown) => {
  if (typeof v === "number" && Number.isFinite(v)) out[key] = String(v);
  else if (typeof v === "string" && v.trim() !== "") out[key] = v;
};

/**
 * The inverse of toIntakeDocument (lib/engagement-intake.ts): an engagement's stored intake document back into the form's
 * fields. A test round-trips it, so a field added to one side and not the other is caught. Reads known keys only: nothing
 * else of the stored document (including our own `_gridforge` block) is ever copied.
 */
export function intakeDocToForm(doc: unknown): Pick<WatchSeed, "fields" | "transformers" | "ups"> {
  const d: Doc = isObj(doc) ? doc : {};
  const site: Doc = isObj(d.site) ? d.site : {};
  const hall: Doc = isObj(d.hall) ? d.hall : {};
  const grid: Doc = isObj(d.grid) ? d.grid : {};
  const lv: Doc = isObj(d.lv) ? d.lv : {};
  const plant: Doc = isObj(d.thermal) && isObj(d.thermal.plant) ? d.thermal.plant : {};
  const compute: Doc = isObj(d.compute) ? d.compute : {};
  const f: Record<string, string> = {};

  put(f, "siteName", site.name);
  put(f, "metro", site.metro);
  put(f, "country", site.country);
  put(f, "designDrybulbC", site.design_drybulb_C);
  put(f, "hallId", hall.id);
  put(f, "buildYear", hall.build_year);
  put(f, "floorType", hall.floor_type);
  put(f, "floorLoadingKPa", hall.floor_loading_kPa);
  put(f, "positionsAvailable", hall.positions_available);
  // toIntakeDocument writes rack_positions = rackPositions ?? positionsAvailable: equal means "not given separately".
  if (hall.rack_positions !== hall.positions_available) put(f, "rackPositions", hall.rack_positions);
  put(f, "netWhiteSpaceM2", hall.net_white_space_m2);
  put(f, "clearHeightM", hall.clear_height_m);
  put(f, "aislePitchM", hall.aisle_pitch_m);
  put(f, "designDensityKWPerRack", hall.design_density_kW_per_rack);
  put(f, "dso", grid.dso);
  put(f, "firmCapacityMVA", grid.firm_capacity_MVA);
  put(f, "contractedMW", grid.contracted_MW);
  put(f, "currentPeakMW", grid.current_site_peak_MW);
  put(f, "currentItLoadMW", grid.current_it_load_MW);
  put(f, "powerFactor", grid.power_factor);
  put(f, "queueNote", grid.queue_note);
  put(f, "voltageV", lv.voltage_V);
  put(f, "buswayAmpacityA", lv.busway_ampacity_A);
  put(f, "buswayRuns", lv.busway_runs);
  put(f, "tapoffMaxA", lv.tapoff_max_A);
  put(f, "plantCapacityKW", plant.chilled_water_capacity_kW);
  put(f, "plantSupplyC", plant.design_supply_C);
  put(f, "plantReturnC", plant.design_return_C);
  put(f, "pumpFlowLPerMin", plant.pump_flow_capacity_l_per_min);
  put(f, "existingFlowLPerMin", plant.existing_flow_l_per_min);
  put(f, "existingNonItHeatKW", plant.existing_non_it_heat_kW);
  put(f, "residualAirKWPerRack", isObj(d.thermal) ? d.thermal.residual_air_capacity_kW_per_rack : undefined);
  put(f, "platform", compute.platform);
  put(f, "utilisation", compute.utilisation);

  const rowsOf = (list: unknown, ratingKey: string): SeedRow[] =>
    Array.isArray(list)
      ? list.filter(isObj).map((r) => ({
          id: typeof r.id === "string" ? r.id : "",
          rating: typeof r[ratingKey] === "number" ? (r[ratingKey] as number) : "",
          units: typeof r.units === "number" ? r.units : "",
          redundancy: typeof r.redundancy === "string" ? r.redundancy : "N+1",
        }))
      : [];
  return { fields: f, transformers: rowsOf(d.transformers, "unit_rating_MVA"), ups: rowsOf(d.ups, "unit_rating_kW") };
}

function eligible(r: DeliverableRecord | null): r is DeliverableRecord {
  return (
    r !== null &&
    (WATCH_SEED_KINDS as readonly string[]).includes(r.kind) &&
    isObj(r.intake) &&
    // A refunded or disputed purchase is withheld (lib/one-time-holds.ts): its numbers are not offered either.
    r.billing_hold !== "refunded" &&
    r.billing_hold !== "disputed" &&
    (r.status === "draft" || r.status === "released")
  );
}

/**
 * The seed for this watch, or null. Only for a watch that has no numbers yet and only through the project link (see the
 * header). The caller has already authenticated the watch by its bearer token; nothing here takes an email or a second token.
 */
export async function seedForWatch(w: Pick<WatchRecord, "id" | "intake" | "status">): Promise<WatchSeed | null> {
  if (w.id === "local" || w.status !== "active" || w.intake) return null;
  const own = await linksFor("watch", w.id);
  // A watch belongs to at most one project (a unique index); anything else is a state this code will not guess at.
  if (!own.ok || own.links.length !== 1) return null;
  const all = await projectLinks(own.links[0].project_id);
  if (!all.ok) return null;
  const rows = await Promise.all(all.links.filter((l) => l.object_type === "deliverable").map((l) => getById(l.object_id)));
  const best = rows
    .filter(eligible)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
  if (!best) return null;
  const mapped = intakeDocToForm(best.intake);
  // Without a site and a hall there is nothing worth offering.
  if (!mapped.fields.siteName || !mapped.fields.hallId) return null;
  return { source: { kind: best.kind, product: PRODUCT_BY_KIND[best.kind]?.name ?? best.kind }, ...mapped };
}
