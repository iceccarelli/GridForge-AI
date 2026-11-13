// Capacity qualifier — the bridge between the website and the engine.
//
// The physics lives in ONE place: the Python envelope engine (gridforge/). This
// module validates the form, calls the engine over HTTP and shapes the answer for
// the UI. There is deliberately no TypeScript reimplementation of the constraints;
// two versions of the truth is exactly what a provenance-first product cannot
// survive.
//
// If GRIDFORGE_API_URL is unset the route degrades to lead capture and says so
// plainly, rather than inventing a number.

import { z } from "zod";
import { storeFault } from "@/lib/safe-log";
import { engineFetch } from "@/lib/rate-limit";

import { QUALIFY_ASSUMABLE, type QualifyAssumable } from "@/lib/qualify-assumed";
import { typedNumber } from "@/lib/qualify-number";
import { CHECK_INPUTS_NOTE, hasInputProblem, rackCountIsUpperBound, rackNoun } from "@/lib/qualify-readout";
export { QUALIFY_ASSUMABLE, type QualifyAssumable };
const QUALIFY_ASSUMABLE_KEYS = Object.keys(QUALIFY_ASSUMABLE) as [QualifyAssumable, ...QualifyAssumable[]];

export const qualifySchema = z.object({
  // --- the seven questions that decide the answer for almost any hall --------
  // typedNumber, not z.coerce: Number(null), Number(""), Number(false) and Number([]) are all 0, so a figure nobody gave would be zero free positions,
  // a 0 degC plant supply or a peak of zero, sent to the engine as the visitor's own (lib/qualify-number.ts).
  contractedMW: typedNumber(z.number().positive().max(2000)),
  currentPeakMW: typedNumber(z.number().nonnegative().max(2000)),
  currentItLoadMW: typedNumber(z.number().nonnegative().max(2000)),
  buswayAmpacityA: typedNumber(z.number().positive().max(6300)),
  tapoffMaxA: typedNumber(z.number().positive().max(1600)),
  plantSupplyC: typedNumber(z.number().min(-5).max(45)),
  positionsAvailable: typedNumber(z.number().int().nonnegative().max(20000)),
  // --- context --------------------------------------------------------------
  siteName: z.string().trim().max(120).optional(),
  hallId: z.string().trim().max(60).optional(),
  metro: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
  platform: z.enum(["gb300_nvl72", "gb200_nvl72", "generic_dlc_50"]).default("gb300_nvl72"),
  // --- figures that still hold a reference template's value: declared assumed (E0) to the engine, never sent as the visitor's own -------
  // Each name once; a repeated name is refused here, as the engine refuses it. Only the deployed engine's own capability decides whether
  // this is honoured (app/api/qualify/route.ts refuses it when the engine does not advertise it).
  assumedFields: z
    .array(z.enum(QUALIFY_ASSUMABLE_KEYS))
    .max(QUALIFY_ASSUMABLE_KEYS.length)
    .refine((a) => new Set(a).size === a.length, { message: "name each assumed field once" })
    .optional(),
  // --- optional contact, so a good read can become a conversation -----------
  name: z.string().trim().max(120).optional(),
  company: z.string().trim().max(160).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
});

export type QualifyInput = z.infer<typeof qualifySchema>;

export interface QuantityDTO {
  value: number;
  low: number;
  high: number;
  unit: string;
  evidence: string;
  label: string;
}

export interface QualifyResult {
  platform: { id: string; name: string; rack_kW: QuantityDTO; gpus_per_rack: number };
  as_found: {
    racks: number;
    it_load_kW: QuantityDTO;
    binding_constraint: string;
    domain: string;
    basis: string;
  };
  after_relief: {
    racks: number;
    architecture: string;
    then_binds_on: string | null;
    /** The item that sets the date; null when there is no date (the engine names none rather than a lower bound: `sets_the_date_reason` says why). */
    sets_the_date: string | null;
    sets_the_date_reason?: string | null;
    /** What the date rests on (lib/date-basis.ts). Absent from an engine older than the date-basis keys. */
    date_basis?: "none" | "assumed" | "supported";
    date_evidence_class?: string | null;
    date_binding_item?: string | null;
    date_label?: string;
  };
  first_three_constraints: { name: string; domain: string; relief: string | null }[];
  intake: {
    completeness: number;
    required_inputs_missing: number;
    can_issue_a_study: boolean;
    gaps: {
      input: string;
      unit: string;
      required: boolean;
      assumed: string;
      why_it_binds: string;
      how_to_get_it: string;
    }[];
    warnings: string[];
    recommended_engagement: string;
  };
  notice: string;
  /** Present only when the request declared figures assumed (E0): each, with the class and note the engine recorded for it. Absent from an engine that predates it. */
  inputs_declared_assumed?: { path: string; input: string; unit: string; value: number; evidence: string; note: string | null }[];
}

/** The engine's names for the fields a request declares assumed, in the qualifier's order. Empty when it declares none. */
export function assumedEngineFields(input: Pick<QualifyInput, "assumedFields">): string[] {
  const named = new Set(input.assumedFields ?? []);
  return QUALIFY_ASSUMABLE_KEYS.filter((k) => named.has(k)).map((k) => QUALIFY_ASSUMABLE[k]);
}

/**
 * Map the form to the engine's /v1/qualify body.
 *
 * `assumed_fields` is in the body ONLY when the request declares at least one figure assumed: a plain request is the same body it always
 * was, so an engine that predates the field is never sent one it would silently ignore (and so classify a template's number as customer data).
 */
export function toEngineBody(input: QualifyInput) {
  const assumed = assumedEngineFields(input);
  return {
    client: input.company || "Website qualifier",
    site_name: input.siteName,
    hall_id: input.hallId,
    metro: input.metro,
    country: input.country,
    platform: input.platform,
    contracted_MW: input.contractedMW,
    current_site_peak_MW: input.currentPeakMW,
    current_it_load_MW: input.currentItLoadMW,
    busway_ampacity_A: input.buswayAmpacityA,
    tapoff_max_A: input.tapoffMaxA,
    plant_supply_C: input.plantSupplyC,
    positions_available: input.positionsAvailable,
    ...(assumed.length ? { assumed_fields: assumed } : {}),
  };
}

export type EngineOutcome =
  | { ok: true; result: QualifyResult }
  | { ok: false; reason: "busy"; detail: string; retryAfterSeconds: number }
  | { ok: false; reason: "unconfigured" | "unreachable" | "rejected"; detail: string };

/** What a visitor is told when the engine shed the request (503 + Retry-After): short and honest, never the engine's own sentence. */
export const ENGINE_BUSY_MESSAGE = "The capacity engine is busy; try again in a few seconds.";

/** The Retry-After header as whole seconds, kept within 1..60 so a visitor is never told to wait a minute-plus or zero; null when absent or unreadable. */
export function retryAfterSeconds(header: string | null): number | null {
  if (header === null || !/^\s*\d{1,6}\s*$/.test(header)) return null;
  return Math.min(60, Math.max(1, Number(header)));
}

/**
 * Whether this deployment can call the engine at all (the same test callEngine applies). A page that offers something only the engine can do
 * (the reference-template selector) asks this as well as the engine's capabilities, so it is never offered where /api/qualify answers 503.
 */
export function engineConfigured(): boolean {
  return Boolean(process.env.GRIDFORGE_API_URL);
}

/** Server-side only. Never expose GRIDFORGE_API_URL or the key to the browser. */
export async function callEngine(input: QualifyInput): Promise<EngineOutcome> {
  const base = process.env.GRIDFORGE_API_URL;
  if (!base || !engineConfigured()) {
    return {
      ok: false,
      reason: "unconfigured",
      detail: "The capacity engine is not connected to this deployment.",
    };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.GRIDFORGE_API_KEY) headers["X-API-Key"] = process.env.GRIDFORGE_API_KEY;

  try {
    const res = await engineFetch(`${base.replace(/\/$/, "")}/v1/qualify`, {
      method: "POST",
      headers,
      body: JSON.stringify(toEngineBody(input)),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The engine is at its limit of solves (or a metered key's usage could not be recorded): it said so with a 503 and a Retry-After. That is
      // "busy, retry", not a rejection of this request, and the engine's own wording stays on the server.
      const wait = res.status === 503 ? retryAfterSeconds(res.headers.get("Retry-After")) : null;
      if (wait !== null) return { ok: false, reason: "busy", detail: ENGINE_BUSY_MESSAGE, retryAfterSeconds: wait };
      return {
        ok: false,
        reason: "rejected",
        detail: typeof body?.error === "string" ? body.error : `engine returned ${res.status}`,
      };
    }
    return { ok: true, result: body as QualifyResult };
  } catch (err) {
    return {
      ok: false,
      reason: "unreachable",
      detail: err instanceof Error ? err.message : "engine unreachable",
    };
  }
}

/** One sentence a salesperson can say out loud. Built from the engine's answer,
 *  never from the form, so it cannot drift from the model.
 *
 *  A count is "about" only when nothing was left out of it. The engine treats an equipment bank nobody declared as "no limit" (the most
 *  favourable reading), which it states in the gap's own text: the count is then an upper bound and is said as "at most".
 *
 *  While the engine warns that the inputs disagree with each other or may be in the wrong unit (a peak below the IT load, a MW/MVA/kW slip), the
 *  verdict is not a finding about the hall: it opens with that, so a "cannot host" is never read as settled. */
export function headline(r: QualifyResult): string {
  const verdict = verdictSentence(r);
  return hasInputProblem(r) ? `${CHECK_INPUTS_NOTE} ${verdict}` : verdict;
}

function verdictSentence(r: QualifyResult): string {
  const { as_found: found, after_relief: after } = r;
  const atMost = rackCountIsUpperBound(r);
  if (found.racks === 0 && after.racks === 0) {
    return `This hall cannot host ${r.platform.name} racks on these inputs. ${found.binding_constraint} is what stops it.`;
  }
  if (found.racks === 0) {
    return `Nothing deployable today — ${found.binding_constraint.toLowerCase()} stops it. Clear the ladder and the hall carries ${atMost ? "at most" : "about"} ${after.racks} ${r.platform.name} ${rackNoun(after.racks)}.`;
  }
  return `${atMost ? "At most" : "About"} ${found.racks} ${r.platform.name} ${rackNoun(found.racks)} today, rising to ${atMost ? "at most" : "roughly"} ${after.racks} once ${found.binding_constraint.toLowerCase()} is relieved.`;
}


// --- the shareable result --------------------------------------------------

/**
 * A qualification, addressed by its token.
 *
 * The result page exists because an answer that cannot leave the browser tab does
 * not reach the person who can act on it. The engineer who types seven numbers in
 * is rarely the one who signs off a study; the link is what crosses that gap, and
 * it carries the engineering rather than a summary of it.
 */
export interface StoredQualification {
  id: string;
  created_at: string;
  token: string;
  site_name: string | null;
  hall_id: string | null;
  metro: string | null;
  country: string | null;
  platform: string | null;
  inputs: Record<string, unknown>;
  racks_as_found: number | null;
  racks_after_relief: number | null;
  binding_constraint: string | null;
  intake_completeness: number | null;
  company: string | null;
  email: string | null;
  status: string;
  follow_up_requested_at: string | null;
}

function sbAuth(): { url: string; headers: Record<string, string> } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const headers: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key, "Content-Type": "application/json" }
    : { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  return { url, headers };
}

export function newQualificationToken(): string {
  // Node's webcrypto, available in the Next runtime without an import.
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export async function getQualification(token: string): Promise<StoredQualification | null> {
  const c = sbAuth();
  if (!c || !token) return null;
  const cols =
    "id,created_at,token,site_name,hall_id,metro,country,platform,inputs," +
    "racks_as_found,racks_after_relief,binding_constraint,intake_completeness,company,email," +
    "status,follow_up_requested_at";
  try {
    const res = await fetch(
      `${c.url}/rest/v1/qualifications?select=${cols}&token=eq.${encodeURIComponent(token)}&limit=1`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as StoredQualification[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** A read can start a purchase for a day. After that the buyer is asked to run it again: the form is prefilled from it. */
export const CHECKOUT_QUALIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The qualification id a checkout may carry, or null.
 *
 * The id goes into Stripe metadata, then into `deliverables.qualification_id`, then seeds the engagement intake form (and
 * links it to the read). So it is accepted only from someone who PRESENTS the read's own q-token -- the secret in its
 * /q/<token> link -- and only while the read is under 24 hours old; a claimed id that is not the id behind that token is
 * dropped too. Anything else returns null and the purchase proceeds unattached: the id is a convenience, never a requirement.
 */
export async function qualificationForCheckout(
  token: unknown,
  claimedId: unknown,
  now: number = Date.now()
): Promise<string | null> {
  if (typeof token !== "string" || !token.trim() || token.length > 200) return null;
  const q = await getQualification(token.trim());
  if (!q || !q.id) return null;
  const created = Date.parse(q.created_at);
  if (!Number.isFinite(created) || now - created > CHECKOUT_QUALIFICATION_WINDOW_MS || created - now > 5 * 60 * 1000) return null;
  if (claimedId !== undefined && claimedId !== null && claimedId !== "") {
    if (typeof claimedId !== "string" || claimedId.trim().toLowerCase() !== q.id.toLowerCase()) return null;
  }
  return q.id;
}

/**
 * How this hall compares with every other hall the engine has seen.
 *
 * The only thing on the page a competitor cannot write, and the reason the link
 * gets forwarded. Respects the same privacy floor as /api/insights: below it, a
 * distribution is noise dressed as evidence and a small sample can point at
 * whoever filled it in.
 */
export const BENCHMARK_MIN_HALLS = 8;

export interface Benchmark {
  published: boolean;
  halls: number;
  sameConstraint: number;
  sharePct: number | null;
  blockedAsFound: number | null;
}

/**
 * The qualification a purchased engagement was bought from.
 *
 * The customer typed seven numbers into the free qualifier, saw a real read, and
 * paid. Asking them to type the same seven again before we will produce the thing
 * they paid for is friction applied at the worst possible moment — after the money
 * has been taken and before the product has been delivered, which is where an
 * abandoned intake becomes revenue collected for a document nobody ever gets.
 *
 * Addressed by id, which only reaches here from `deliverables.qualification_id` — a uuid foreign key written by our own
 * webhook from the checkout session's metadata. That metadata is NOT the caller's word: /api/checkout puts a qualification id
 * there only after `qualificationForCheckout` has seen the q-token that goes with it (below). An id alone is no credential --
 * ids are not secret (the /q/ page renders its own) -- so an id someone else supplies must never reach a stranger's intake,
 * which is seeded from the numbers behind it.
 */
export async function qualificationById(id: string): Promise<StoredQualification | null> {
  const c = sbAuth();
  if (!c || !id) return null;
  const cols =
    "id,created_at,token,site_name,hall_id,metro,country,platform,inputs," +
    "racks_as_found,racks_after_relief,binding_constraint,intake_completeness,company,status";
  try {
    const res = await fetch(
      `${c.url}/rest/v1/qualifications?select=${cols}&id=eq.${encodeURIComponent(id)}&limit=1`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) {
      console.error("[GridForge] qualification by id failed:", await storeFault(res));
      return null;
    }
    const rows = (await res.json()) as StoredQualification[];
    return rows[0] ?? null;
  } catch (err) {
    // Seeding the intake is a convenience. A store that cannot be reached (a thrown fetch, not just a 5xx) must leave the buyer an
    // intake they can fill in, not turn the link they paid for into a 500.
    console.error("[GridForge] qualification by id unreachable:", err instanceof Error ? err.name : "error");
    return null;
  }
}

/**
 * The fields of a stored qualification that may be carried into the engagement
 * intake, by name.
 *
 * An allowlist, not a spread. The qualification row also holds the name, company
 * and email of whoever ran it, and those are not intake fields — copying the whole
 * object into a form would put one person's contact details in front of whoever
 * holds the engagement link, which may be a different person entirely.
 */
const CARRIED_INTO_INTAKE = [
  "siteName",
  "hallId",
  "metro",
  "country",
  "platform",
  "contractedMW",
  "currentPeakMW",
  "currentItLoadMW",
  "buswayAmpacityA",
  "tapoffMaxA",
  "plantSupplyC",
  "positionsAvailable",
] as const;

/** What the buyer already told us, ready to seed the intake form. */
export function intakePrefill(q: StoredQualification | null): Record<string, string> {
  if (!q?.inputs || typeof q.inputs !== "object") return {};
  const out: Record<string, string> = {};
  // A figure the read declared assumed is a reference template's, not the buyer's: carrying it into the intake would present it as their
  // own customer data (the carried-over panel says "treated as your measured data"). Such a read is not stored (app/api/qualify/route.ts),
  // so this is a second lock, not the first.
  const assumed = (q.inputs as Record<string, unknown>).assumedFields;
  const skip = new Set(Array.isArray(assumed) ? assumed.filter((x): x is string => typeof x === "string") : []);
  for (const k of CARRIED_INTO_INTAKE) {
    if (skip.has(k)) continue;
    const v = (q.inputs as Record<string, unknown>)[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[k] = String(v);
  }
  return out;
}

export async function benchmark(constraint: string | null): Promise<Benchmark> {
  const c = sbAuth();
  if (!c || !constraint) {
    return { published: false, halls: 0, sameConstraint: 0, sharePct: null, blockedAsFound: null };
  }
  try {
    const res = await fetch(
      `${c.url}/rest/v1/qualifications?select=binding_constraint,racks_as_found&binding_constraint=not.is.null&limit=2000`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) throw new Error("unreachable");
    const rows = (await res.json()) as {
      binding_constraint: string;
      racks_as_found: number | null;
    }[];
    const halls = rows.length;
    if (halls < BENCHMARK_MIN_HALLS) {
      return { published: false, halls, sameConstraint: 0, sharePct: null, blockedAsFound: null };
    }
    const same = rows.filter((r) => r.binding_constraint === constraint).length;
    return {
      published: true,
      halls,
      sameConstraint: same,
      sharePct: Math.round((same / halls) * 100),
      blockedAsFound: rows.filter((r) => (r.racks_as_found ?? 0) === 0).length,
    };
  } catch {
    return { published: false, halls: 0, sameConstraint: 0, sharePct: null, blockedAsFound: null };
  }
}

// --- follow-up: the read asking for a human, once --------------------------

export type FollowUpOutcome =
  | { ok: true; already: false }
  | { ok: true; already: true }
  | { ok: false; reason: "unconfigured" | "store_error" };

/**
 * Record a follow-up request against a qualification, exactly once.
 *
 * The `follow_up_requested_at is.null` filter on the PATCH is the whole
 * idempotency mechanism: a second click, a retried fetch, or two tabs racing each
 * other all land on the same row, and only the write that actually finds it still
 * null flips it. Everyone else gets `already: true` and no second email goes out
 * — see the route for why that matters (one honest message beats a sequence).
 */
export async function requestFollowUp(
  token: string,
  email: string,
  note: string | null
): Promise<FollowUpOutcome> {
  const c = sbAuth();
  if (!c || !token) return { ok: false, reason: "unconfigured" };
  try {
    const res = await fetch(
      `${c.url}/rest/v1/qualifications?token=eq.${encodeURIComponent(token)}` +
        "&follow_up_requested_at=is.null",
      {
        method: "PATCH",
        headers: { ...c.headers, Prefer: "return=representation" },
        body: JSON.stringify({
          follow_up_requested_at: new Date().toISOString(),
          follow_up_email: email,
          follow_up_note: note,
        }),
      }
    );
    if (!res.ok) {
      console.error("[GridForge] follow-up update failed:", await storeFault(res));
      return { ok: false, reason: "store_error" };
    }
    const rows = (await res.json().catch(() => [])) as unknown[];
    return { ok: true, already: rows.length === 0 };
  } catch (err) {
    console.error("[GridForge] follow-up update error:", err);
    return { ok: false, reason: "store_error" };
  }
}
