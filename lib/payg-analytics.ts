// Server-only: what the adoption funnel and the unit economics actually are, measured, with what cannot be measured named.
//
// Two reports for the operator (app/api/admin/funnel, app/api/admin/economics), built from records this site already keeps:
//   * funnel_events (lib/funnel.ts: a closed, privacy-safe vocabulary) and the usage ledger copy (usage_events, 0028);
//   * the settlements, and the engine's own operator endpoint for compute.
//
// RULES, because a dashboard that flatters is worse than none:
//   - every step shows its COUNT, its DENOMINATOR and whether it is MEASURED from events or DERIVED from another record;
//   - a rate whose denominator is 0 is null, never 0% (0% would claim we saw nobody convert; we saw nobody);
//   - anything this site cannot measure is listed in `unmeasured` rather than implied;
//   - no margin is claimed: compute is measured in time, fixed infrastructure, Stripe fees and LLM cost are NOT in the numbers, and
//     the only ratio offered is revenue per measured compute second.
// Accounts appear only as the anonymous account_ref HMAC (lib/payg.ts accountRef); nothing here can name a person.

import { PAYG, accountRef, monthBounds, utcMonth, MONTH } from "@/lib/payg";
import { CHECKOUT_FAILURE_REASONS, CHECKOUT_STRIPE_STAGE_REASONS, recordFunnelEvent } from "@/lib/funnel";
import { enc, pg, rpc } from "@/lib/payg-store";

const DAY = 86_400_000;

/** null, never 0, when there is nothing to divide by. Rounded to 4 places (a fraction, not a percentage). */
export function rate(numerator: number, denominator: number | null): number | null {
  if (denominator === null || !(denominator > 0)) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/** The UTC Monday (YYYY-MM-DD) of the week containing an instant. */
export function weekStart(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

const addDays = (isoDate: string, n: number) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export type Activity = Record<string, { first: string; weeks: string[] }>;

/** Per account: when it first made a charge that stood, and the UTC weeks it had net usage (0035). Null when unreadable. */
export async function usageActivity(): Promise<Activity | null> {
  const r = await rpc<Activity>("gf_usage_activity", {});
  if (!r.ok || !r.data || typeof r.data !== "object") return null;
  return r.data;
}

/**
 * First engine use, derived from the ledger copy: the first charge that stood, per account. Once per account (the dedupe key), dated
 * when the use happened. Called by the daily cron after ingest.
 *
 * Bounded per run, and it PAGES: accounts that already have their event are skipped before the limit is counted, so each run records
 * the next `limit` accounts that do not, and a ledger with more accounts than the limit is covered over successive runs (before, the
 * same first `limit` accounts were re-tried forever and the rest were never recorded). Returns how many are still waiting.
 */
export async function deriveFirstUse(limit = 500): Promise<{ considered: number; recorded: number; remaining: number }> {
  const act = await usageActivity();
  if (!act) return { considered: 0, recorded: 0, remaining: 0 };
  const known = await rpc<{ refs?: Record<string, string[]> }>("gf_funnel_summary", { p_since: "2999-01-01T00:00:00Z" });
  if (!known.ok) return { considered: 0, recorded: 0, remaining: 0 }; // cannot tell who is done: do nothing rather than redo everyone
  const done = new Set(known.data?.refs?.first_engine_use ?? []);
  const todo = Object.entries(act).filter(([account]) => !done.has(accountRef(account))).sort(([, a], [, b]) => (a.first < b.first ? -1 : 1));
  let considered = 0;
  let recorded = 0;
  for (const [account, a] of todo.slice(0, Math.max(1, limit))) {
    considered++;
    const ref = accountRef(account);
    if (await recordFunnelEvent("first_engine_use", { account_ref: ref }, { dedupeKey: `first_engine_use:${ref}`, at: new Date(a.first) })) recorded++;
  }
  return { considered, recorded, remaining: Math.max(0, todo.length - considered) };
}

// ----------------------------------------------------------------------------------------------------------------- funnel

interface Summary {
  counts: Record<string, number>;
  cohort: { ref: string; at: string }[];
  refs: Record<string, string[]>;
  by_kind: Record<string, Record<string, number>>;
  cancel_reasons: Record<string, number>;
  evidence_classes: Record<string, number>;
}

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  /** The count this step is a fraction of (the previous step), or null for the first step / an unlinked transition. */
  denominator: number | null;
  /** count / denominator as a fraction, or null when there is no denominator (never 0 for "no data"). */
  rate: number | null;
  source: "events" | "derived";
  basis: string;
}

/** One derived value: never a bare number. `value` is null when `denominator` is 0 or not a positive number (never 0, never NaN). */
export interface DerivedRate {
  label: string;
  formula: string;
  numerator: number;
  denominator: number;
  value: number | null;
  source: "derived";
}

export interface CheckoutKindRow {
  attempted: number;
  session_created: number;
  failed: number;
  failed_by_reason: Record<string, number>;
  /** session_created / attempted for this kind, derived; null when the kind has no attempts. */
  session_creation_rate: DerivedRate;
}

export type CheckoutReport =
  | { available: false; reason: string; statement: string }
  | {
      available: true;
      statement: string;
      /** MEASURED: counts of recorded events in the window. Nothing in here is computed from anything else. */
      measured: {
        source: "events";
        attempted: number;
        session_created: number;
        failed: number;
        /** checkout_failed events by their fixed reason. Every reason in the closed list is present (0 means none recorded). */
        failed_by_reason: Record<string, number>;
        by_kind: Record<string, { attempted: number; session_created: number; failed: number }>;
        basis: string;
      };
      /** DERIVED: arithmetic on the measured counts, each with its explicit numerator and denominator. */
      derived: {
        source: "derived";
        refused_before_stripe: number;
        failed_at_stripe: number;
        session_creation_rate: DerivedRate;
        stripe_failure_rate: DerivedRate;
        refusal_rate: DerivedRate;
        unresolved_attempts: { label: string; formula: string; value: number; source: "derived"; note: string };
        by_kind: Record<string, CheckoutKindRow>;
        basis: string;
      };
    };

export interface FunnelReport {
  ok: true;
  days: number;
  since: string;
  generated_at: string;
  steps: FunnelStep[];
  /** How the account steps are counted: the cohort is the free accounts created in the window; later steps count THOSE accounts only. */
  cohort_definition: string;
  allowance_exhausted: { count: number; of_cohort: number; rate: number | null; source: "events"; basis: string };
  repeat_usage_any: { count: number; denominator: number; rate: number | null; source: "derived"; basis: string };
  subscriptions: {
    started: { total: number; by_kind: Record<string, number> };
    cancelled: { total: number; by_kind: Record<string, number>; stated_reasons: Record<string, number> };
    cancellations_per_start: number | null;
    source: "events";
    basis: string;
  };
  engagements: { commissioned: { total: number; by_kind: Record<string, number> }; source: "events"; basis: string };
  qualifier_to_engagement: {
    qualifications_scored: number;
    engagements_linked_to_those: number;
    rate: number | null;
    truncated: boolean;
    source: "derived";
    basis: string;
  };
  payments: { payment_failed: { total: number; by_kind: Record<string, number> }; refunds: number; disputes: number; source: "events"; basis: string };
  projects: { created: number; saved_results: { total: number; by_kind: Record<string, number> }; source: "events" };
  qualifier_evidence_classes: Record<string, number>;
  retention: {
    source: "derived";
    basis: string;
    cohorts: { cohort_week: string; size: number; weeks: { offset: number; week: string; active: number; rate: number | null; partial: boolean }[] }[];
  };
  checkout: CheckoutReport;
  unmeasured: string[];
}

const UNMEASURED = [
  "Anonymous qualifier -> free account linkage: qualify_started / qualify_completed carry no identity by design, so which qualifier session became which account cannot be known; the transition qualify_completed -> free_account_created is reported as counts only, with no rate.",
  "Visitors, sessions and page views: no analytics are recorded, so there is no top-of-funnel denominator before qualify_started.",
  "Qualifier -> engagement for purchases made without carrying a qualification id (a buyer who arrived from the pricing page, not from their own result): only linked purchases are visible.",
  "Refunds and disputes depend on the Stripe webhook endpoint being subscribed to charge.refunded and charge.dispute.created, which this site cannot verify: a count of 0 is not proof that none occurred.",
  "Cancellation reasons beyond Stripe's own fixed reason (cancellation_requested, payment_failed, payment_disputed) are not collected, and free-text cancellation comments are deliberately never read.",
  "Funnel events are only recorded from the day the instrumentation shipped; nothing earlier can be reconstructed except what the usage ledger itself holds (first use, repeat use).",
  "Payment: a created checkout session is not a payment. Whether the buyer opened Stripe's page, abandoned it or paid is not measured by the checkout events (returning from Stripe proves nothing); the only payment evidence is the engagement_commissioned and subscription_started events from the Stripe webhook.",
  "Checkout refusals of invalid, unknown or malformed product input are deliberately not recorded (no commercial activity), and a checkout event lost to a telemetry failure is a missing measurement, not a refusal.",
  "Time between steps is not reported: events are dated when recorded, and first use is dated when the charge happened.",
];

interface CheckoutSummary {
  counts?: Record<string, unknown>;
  by_kind?: Record<string, Record<string, unknown>>;
  failed_reasons?: Record<string, unknown>;
  failed_by_kind?: Record<string, Record<string, unknown>>;
}

/** A recorded count: a whole non-negative number, else 0 (a malformed value never becomes NaN downstream). */
const tally = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

function derivedRate(label: string, formula: string, numerator: number, denominator: number): DerivedRate {
  return { label, formula, numerator, denominator, value: rate(numerator, denominator), source: "derived" };
}

const CHECKOUT_STATEMENT =
  "A created checkout session is NOT a payment: it means Stripe returned a page address, nothing was charged, and the buyer may never have opened it. " +
  "The buyer returning from Stripe is not evidence of payment either. The only payment and commission evidence is the engagement_commissioned and subscription_started events recorded by the Stripe webhook (see Engagements and Subscriptions in this report).";

/** The checkout section: measured event counts, then values derived from them. Exported for tests. */
export function checkoutSection(c: CheckoutSummary | null): CheckoutReport {
  if (!c) {
    return {
      available: false,
      reason: "The checkout events could not be read (migration 0042 may not be applied yet). No checkout figure is shown, and none should be inferred.",
      statement: CHECKOUT_STATEMENT,
    };
  }
  const counts = c.counts ?? {};
  const attempted = tally(counts.checkout_attempted);
  const created = tally(counts.checkout_session_created);
  const failed = tally(counts.checkout_failed);
  const byReason: Record<string, number> = {};
  for (const r of CHECKOUT_FAILURE_REASONS) byReason[r] = tally(c.failed_reasons?.[r]);
  const atStripe = CHECKOUT_STRIPE_STAGE_REASONS.reduce((n, r) => n + byReason[r], 0);
  const classified = Object.values(byReason).reduce((n, v) => n + v, 0);
  const before = classified - atStripe;

  const kinds = new Set<string>();
  for (const name of ["checkout_attempted", "checkout_session_created", "checkout_failed"]) for (const k of Object.keys(c.by_kind?.[name] ?? {})) kinds.add(k);
  const kindMeasured: Record<string, { attempted: number; session_created: number; failed: number }> = {};
  const kindDerived: Record<string, CheckoutKindRow> = {};
  for (const k of [...kinds].sort()) {
    const a = tally(c.by_kind?.checkout_attempted?.[k]);
    const sc = tally(c.by_kind?.checkout_session_created?.[k]);
    const f = tally(c.by_kind?.checkout_failed?.[k]);
    kindMeasured[k] = { attempted: a, session_created: sc, failed: f };
    const reasons: Record<string, number> = {};
    for (const r of CHECKOUT_FAILURE_REASONS) reasons[r] = tally(c.failed_by_kind?.[k]?.[r]);
    kindDerived[k] = {
      attempted: a, session_created: sc, failed: f, failed_by_reason: reasons,
      session_creation_rate: derivedRate("Session creation rate", "session_created / attempted", sc, a),
    };
  }

  return {
    available: true,
    statement: CHECKOUT_STATEMENT,
    measured: {
      source: "events",
      attempted,
      session_created: created,
      failed,
      failed_by_reason: byReason,
      by_kind: kindMeasured,
      basis: "Recorded events in the window, by the checkout route only. attempted = a valid catalogue request handed to Stripe; session_created = Stripe returned a URL (not a payment); failed = a valid request refused or not turned into a session, by fixed reason. Invalid or unknown product input records nothing.",
    },
    derived: {
      source: "derived",
      refused_before_stripe: before,
      failed_at_stripe: atStripe,
      session_creation_rate: derivedRate("Session creation rate", "session_created / attempted", created, attempted),
      stripe_failure_rate: derivedRate("Stripe failure rate", "failed at Stripe (stripe_coupon_failed + stripe_session_failed) / attempted", atStripe, attempted),
      refusal_rate: derivedRate("Refusal rate before Stripe", "refused before Stripe / (attempted + refused before Stripe)", before, attempted + before),
      unresolved_attempts: {
        label: "Attempts with no recorded outcome",
        formula: "attempted - session_created - failed at Stripe",
        value: attempted - created - atStripe,
        source: "derived",
        note: "Expected to be about 0 for a closed window. A positive value is attempts whose outcome event was lost, still in flight, or whose process died; a negative value means an outcome was recorded without its attempt. It is arithmetic on measured counts, not a measured event.",
      },
      by_kind: kindDerived,
      basis: "Arithmetic on the measured counts above; every rate carries its numerator and denominator and is null (shown as n/a, never as 0%) when the denominator is 0. Refusals before Stripe are NOT attempts, so they are not in the denominator of the session creation rate.",
    },
  };
}

const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((n, v) => n + Number(v), 0);

export async function funnelReport(days: number, now: Date = new Date()): Promise<FunnelReport | { ok: false; error: string }> {
  const d = Math.max(1, Math.min(Math.trunc(days) || 30, 365));
  const since = new Date(now.getTime() - d * DAY);
  const s = await rpc<Summary>("gf_funnel_summary", { p_since: since.toISOString() });
  if (!s.ok || !s.data) return { ok: false, error: "The funnel events could not be read." };
  const act = await usageActivity();
  if (!act) return { ok: false, error: "The usage ledger could not be read." };
  // The checkout events have their own read (0042): a deployment without it still gets every other figure, with this section marked unavailable.
  const co = await rpc<CheckoutSummary>("gf_checkout_funnel_summary", { p_since: since.toISOString() });
  const checkout = checkoutSection(co.ok && co.data && typeof co.data === "object" ? co.data : null);
  const S: Summary = { ...{ counts: {}, cohort: [], refs: {}, by_kind: {}, cancel_reasons: {}, evidence_classes: {} }, ...(s.data as Partial<Summary>) } as Summary;

  // ---- the account funnel: a STRICT cohort. Accounts created in the window; each later step counts only accounts that also reached every earlier one.
  const cohort = new Map<string, string>();
  for (const c of S.cohort) if (c.ref) cohort.set(c.ref, c.at);
  const actByRef = new Map<string, { first: string; weeks: string[] }>();
  for (const [account, a] of Object.entries(act)) actByRef.set(accountRef(account), a);
  const reached = (name: string, from: Set<string>) => new Set((S.refs[name] ?? []).filter((r) => from.has(r)));
  const s0 = new Set(cohort.keys());
  const s1 = reached("key_minted", s0);
  const s2 = new Set([...s1].filter((r) => actByRef.has(r)));
  const s3 = reached("payg_enabled", s2);
  const s4 = reached("first_charge", s3);
  const s5 = new Set([...s4].filter((r) => (actByRef.get(r)?.weeks.length ?? 0) >= 2));

  const qs = S.counts.qualify_started ?? 0;
  const qc = S.counts.qualify_completed ?? 0;
  const step = (key: string, label: string, count: number, denominator: number | null, source: FunnelStep["source"], basis: string): FunnelStep => ({
    key, label, count, denominator, rate: rate(count, denominator), source, basis,
  });
  const steps: FunnelStep[] = [
    step("qualify_started", "Qualifier started", qs, null, "events", "Events in the window; anonymous, no identity or input recorded."),
    step("qualify_completed", "Qualifier completed (engine answered)", qc, qs, "events", "Events in the window. Each completion follows exactly one start, so completed / started is a true rate."),
    {
      ...step("free_account_created", "Free account created", s0.size, null, "events", "Cohort anchor: free accounts created in the window. NOT a conversion of qualify_completed: no identity links the two (see unmeasured)."),
      rate: null,
    },
    step("key_minted", "Key minted from the emailed link", s1.size, s0.size, "events", "Cohort accounts with at least one key_minted event (any time)."),
    step("first_engine_use", "First engine use", s2.size, s1.size, "derived", "Derived from the usage ledger: the account has at least one charge that stood (net of refunds). A key_minted account with no ledger activity has not used the engine."),
    step("payg_enabled", "Pay-as-you-go enabled", s3.size, s2.size, "events", "Cohort accounts that reached first use and have a payg_enabled event."),
    step("first_charge", "First invoice issued", s4.size, s3.size, "events", "Cohort accounts that reached pay-as-you-go and have a first_charge event (a settlement was invoiced)."),
    step("repeat_usage", "Repeat usage (2+ distinct active weeks)", s5.size, s4.size, "derived", "Derived from the ledger: net usage in at least two distinct UTC weeks. Counted among accounts that have been invoiced; the all-cohort figure is in repeat_usage_any."),
  ];

  const exhausted = reached("allowance_exhausted", s0).size;
  const anyRepeat = [...s2].filter((r) => (actByRef.get(r)?.weeks.length ?? 0) >= 2).length;

  // ---- retention by cohort week: of the accounts created in a week, how many had net usage k weeks later (derived from the ledger)
  const byWeek = new Map<string, string[]>();
  for (const [ref, at] of cohort) {
    const w = weekStart(new Date(at));
    byWeek.set(w, [...(byWeek.get(w) ?? []), ref]);
  }
  const thisWeek = weekStart(now);
  const cohorts = [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([cohort_week, refs]) => {
      const weeks: FunnelReport["retention"]["cohorts"][number]["weeks"] = [];
      for (let k = 0; k <= 12; k++) {
        const w = addDays(cohort_week, 7 * k);
        if (w > thisWeek) break;
        const active = refs.filter((r) => actByRef.get(r)?.weeks.includes(w)).length;
        weeks.push({ offset: k, week: w, active, rate: rate(active, refs.length), partial: w === thisWeek });
      }
      return { cohort_week, size: refs.length, weeks };
    });

  // ---- qualifier -> engagement, where a link exists: a purchase that carried its qualification id
  const quals = await pg<{ id: string }[]>("GET", `qualifications?status=eq.scored&created_at=gte.${enc(since.toISOString())}&select=id&limit=1000`);
  const linked = await pg<{ qualification_id: string }[]>("GET", "deliverables?qualification_id=not.is.null&select=qualification_id&limit=1000");
  const truncated = (quals.ok && (quals.data?.length ?? 0) >= 1000) || (linked.ok && (linked.data?.length ?? 0) >= 1000);
  const qIds = new Set((quals.ok ? quals.data ?? [] : []).map((q) => q.id));
  const linkedCount = (linked.ok ? linked.data ?? [] : []).filter((l) => qIds.has(l.qualification_id)).length;
  const q2eReadable = quals.ok && linked.ok;

  const started = S.by_kind.subscription_started ?? {};
  const cancelled = S.by_kind.subscription_cancelled ?? {};
  const failed = S.by_kind.payment_failed ?? {};

  return {
    ok: true,
    days: d,
    since: since.toISOString(),
    generated_at: now.toISOString(),
    steps,
    cohort_definition: "Strict cohort: accounts whose free_account_created event is in the window. Each later step counts only those accounts that also reached every earlier step (at any later time). Rates are fractions (0..1) of the previous step; null means the denominator is 0.",
    allowance_exhausted: { count: exhausted, of_cohort: s0.size, rate: rate(exhausted, s0.size), source: "events", basis: "Cohort accounts whose net usage reached the free allowance or their cap in a month (derived at ledger ingest from used >= cap; the engine records no refusals)." },
    repeat_usage_any: { count: anyRepeat, denominator: s2.size, rate: rate(anyRepeat, s2.size), source: "derived", basis: "Among cohort accounts that used the engine, those with net usage in 2+ distinct UTC weeks (free or paid)." },
    subscriptions: {
      started: { total: sum(started), by_kind: started },
      cancelled: { total: sum(cancelled), by_kind: cancelled, stated_reasons: S.cancel_reasons },
      cancellations_per_start: rate(sum(cancelled), sum(started) || null),
      source: "events",
      basis: "Events in the window. cancellations_per_start is cancellations in the window / starts in the window: an indication, NOT a cohort churn rate.",
    },
    engagements: { commissioned: { total: sum(S.by_kind.engagement_commissioned), by_kind: S.by_kind.engagement_commissioned ?? {} }, source: "events", basis: "Engagement and deposit purchases fulfilled in the window, by catalogue kind." },
    qualifier_to_engagement: {
      qualifications_scored: qIds.size,
      engagements_linked_to_those: linkedCount,
      rate: q2eReadable && !truncated ? rate(linkedCount, qIds.size) : null,
      truncated,
      source: "derived",
      basis: "Scored qualifications created in the window, and how many of them later became an engagement purchase that carried that qualification's id. Purchases without the id are invisible here.",
    },
    payments: { payment_failed: { total: sum(failed), by_kind: failed }, refunds: S.counts.refund_issued ?? 0, disputes: S.counts.dispute_opened ?? 0, source: "events", basis: "Events in the window; refunds and disputes only if the Stripe endpoint sends them (see unmeasured)." },
    projects: { created: S.counts.project_created ?? 0, saved_results: { total: S.counts.project_saved_result ?? 0, by_kind: S.by_kind.project_saved_result ?? {} }, source: "events" },
    qualifier_evidence_classes: S.evidence_classes,
    checkout,
    retention: { source: "derived", basis: "From the usage ledger: of the accounts created in a cohort week, the share with net usage in each later UTC week. The current week is partial.", cohorts },
    unmeasured: UNMEASURED,
  };
}

// ------------------------------------------------------------------------------------------------------------- economics

export interface EngineEconomics {
  month: string;
  endpoints: {
    endpoint: string;
    calls: number;
    units: number;
    wall_ms_total: number;
    wall_ms_p50: number | null;
    wall_ms_p95: number | null;
    units_per_call: number | null;
    revenue_cents_at_payg_price: number;
    free_units: number;
  }[];
  basis: string;
  durable: boolean;
}

export type EconomicsFetcher = (month: string) => Promise<{ ok: true; data: EngineEconomics } | { ok: false; reason: string }>;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The engine's operator-only GET /v1/admin/economics, with the operator key. Null when the engine is not configured. */
export function engineEconomicsFetcher(env: NodeJS.ProcessEnv = process.env): EconomicsFetcher | null {
  const base = (env.GRIDFORGE_API_URL ?? "").replace(/\/$/, "");
  const admin = env.GRIDFORGE_ADMIN_KEY ?? "";
  if (!base || !admin) return null;
  return async (month) => {
    try {
      const res = await fetch(`${base}/v1/admin/economics?month=${enc(month)}`, { headers: { "X-API-Key": admin }, signal: AbortSignal.timeout(20_000), cache: "no-store" });
      if (res.status === 404) return { ok: false, reason: "This engine does not provide /v1/admin/economics (an older engine). No compute figures are available." };
      if (!res.ok) return { ok: false, reason: `The engine answered ${res.status}.` };
      const j = (await res.json()) as Partial<EngineEconomics>;
      if (!Array.isArray(j.endpoints)) return { ok: false, reason: "The engine's economics answer was not understood." };
      const endpoints = j.endpoints.flatMap((e) => {
        const calls = num(e?.calls), units = num(e?.units), wall = num(e?.wall_ms_total), rev = num(e?.revenue_cents_at_payg_price), free = num(e?.free_units);
        if (typeof e?.endpoint !== "string" || calls === null || units === null || wall === null || rev === null || free === null) return [];
        return [{ endpoint: e.endpoint, calls, units, wall_ms_total: wall, wall_ms_p50: num(e.wall_ms_p50), wall_ms_p95: num(e.wall_ms_p95), units_per_call: num(e.units_per_call), revenue_cents_at_payg_price: rev, free_units: free }];
      });
      return { ok: true, data: { month: String(j.month ?? month), endpoints, basis: typeof j.basis === "string" ? j.basis : "", durable: j.durable === true } };
    } catch {
      return { ok: false, reason: "The engine could not be reached." };
    }
  };
}

interface SettlementRow { status: string; units: number; amount_cents: number; account: string }

const NOT_INCLUDED = [
  "Fixed infrastructure (engine hosting, database, site hosting, domains)",
  "Stripe fees and any payment-processing cost",
  "LLM / Anthropic usage and any other third-party provider cost",
  "Engineering and support time",
  "Tax, refunds of already-collected money, and disputes",
];

export async function economicsReport(month: string, fetcher: EconomicsFetcher | null) {
  if (!MONTH.test(month)) return { ok: false as const, error: "month must be YYYY-MM" };
  const { from, to } = monthBounds(month);

  const set = await pg<SettlementRow[]>("GET", `usage_settlements?month=eq.${enc(month)}&select=status,units,amount_cents,account&limit=1000`);
  const usage = await rpc<{ by_scope: Record<string, number>; accounts: number }>("gf_usage_month_summary", { p_from: from, p_to: to });
  if (!set.ok || !usage.ok || !usage.data) return { ok: false as const, error: "The settlements or the usage ledger could not be read." };

  const rows = set.data ?? [];
  const byStatus: Record<string, { count: number; units: number; amount_cents: number }> = {};
  for (const r of rows) {
    const b = (byStatus[r.status] ??= { count: 0, units: 0, amount_cents: 0 });
    b.count++;
    b.units += r.units;
    b.amount_cents += r.amount_cents;
  }
  const cents = (...st: string[]) => st.reduce((n, k) => n + (byStatus[k]?.amount_cents ?? 0), 0);
  const scope = usage.data.by_scope ?? {};
  const payg = Number(scope.payg ?? 0);

  let engine:
    | { available: true; month: string; endpoints: EngineEconomics["endpoints"]; basis: string; durable: boolean; totals: { calls: number; units: number; wall_ms_total: number; free_units: number; revenue_cents_at_payg_price: number } }
    | { available: false; reason: string };
  if (!fetcher) engine = { available: false, reason: "The engine is not configured on this deployment (GRIDFORGE_API_URL / GRIDFORGE_ADMIN_KEY). No compute figures are available." };
  else {
    const got = await fetcher(month);
    if (!got.ok) engine = { available: false, reason: got.reason };
    else {
      const t = got.data.endpoints.reduce(
        (a, e) => ({ calls: a.calls + e.calls, units: a.units + e.units, wall_ms_total: a.wall_ms_total + e.wall_ms_total, free_units: a.free_units + e.free_units, revenue_cents_at_payg_price: a.revenue_cents_at_payg_price + e.revenue_cents_at_payg_price }),
        { calls: 0, units: 0, wall_ms_total: 0, free_units: 0, revenue_cents_at_payg_price: 0 }
      );
      engine = { available: true, month: got.data.month, endpoints: got.data.endpoints, basis: got.data.basis, durable: got.data.durable, totals: t };
    }
  }

  const accrued = payg * PAYG.unitPriceCents;
  // EVERY scope the ledger holds (payg, trial, machine and the older `client`): leaving one out made a spurious "difference".
  const allScopes = Object.values(scope).reduce((n, v) => n + Number(v ?? 0), 0);
  const computeSeconds = engine.available ? engine.totals.wall_ms_total / 1000 : null;
  return {
    ok: true as const,
    month,
    current_month: month === utcMonth(new Date()),
    revenue: {
      currency: PAYG.currency,
      unit_price_cents: PAYG.unitPriceCents,
      accrued_payg_cents: accrued,
      payg_units: payg,
      free_units: Number(scope.trial ?? 0),
      subscription_units: Number(scope.machine ?? 0) + Number(scope.client ?? 0),
      active_accounts: Number(usage.data.accounts ?? 0),
      settlements: {
        by_status: byStatus,
        invoiced_cents: cents("invoiced", "paid", "failed"),
        collected_cents: cents("paid"),
        failed_cents: cents("failed"),
        carried_units: byStatus.carried?.units ?? 0,
        truncated: rows.length >= 1000,
        basis: "Settlements are written for a CLOSED month at the next daily run; for the current month only accrued_payg_cents (net payg units x the unit price, from the ledger copy) is meaningful.",
      },
      basis: "accrued_payg_cents is the net pay-as-you-go units in the ledger copy at the catalogue unit price. Subscription fees are not in it (they are billed by Stripe subscription, not by usage).",
    },
    compute: engine,
    reconciliation:
      engine.available && engine.durable
        ? { engine_units: engine.totals.units, ledger_units: allScopes, difference: engine.totals.units - allScopes, basis: "Units the engine metered vs the units in the website's ledger copy (ingest is daily, so a small gap on the current month is expected)." }
        : null,
    revenue_per_compute_second_cents: computeSeconds && computeSeconds > 0 ? Math.round((accrued / computeSeconds) * 100) / 100 : null,
    margin: {
      claimed: false,
      value: null,
      reason: "No margin is claimed. Compute is measured in wall-clock time, not money; converting it needs a cost per second this site does not know. The only ratio offered is revenue per measured compute second.",
    },
    included: ["Revenue: net pay-as-you-go units at the catalogue price, and the settlements Stripe was asked to collect", "Compute: wall-clock milliseconds the engine measured per endpoint (when the engine provides them)"],
    not_included: NOT_INCLUDED,
    unknown: [
      "Cost of compute in money",
      "Margin (revenue minus all cost)",
      "Cost per customer or per unit beyond measured wall time",
      ...(engine.available ? [] : ["All compute figures (engine economics unavailable)"]),
    ],
    statement:
      "Measured: pay-as-you-go revenue and engine compute time. Not included: fixed infrastructure, Stripe fees, LLM cost and people. No margin is claimed beyond what is shown; anything else is unknown.",
  };
}
