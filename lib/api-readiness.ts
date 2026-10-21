// Server-only: may the website SELL an API plan right now?
//
// An API plan is a promise of three things: a key the engine will accept, a lifecycle that can end that
// key, and a customer who can reach both. "GRIDFORGE_KEY_SECRET is non-empty here" proves none of them --
// the engine verifies with ITS copy of the secret, and a different value there means every key we mint is
// refused after the customer has paid.
//
// So this does what a customer's first call would do, in advance and without cost:
//
//   1. mint a throwaway 1-day signed key (a fixed probe account, quota 1, never stored, never returned)
//      and ask the engine `GET /v1/version` with it. The engine answers `tier: "client"` only if it
//      verified our signature; a mismatched secret reads as `tier: "public"`. GET /v1/version is not
//      metered, creates no account and runs no solve.
//   2. ask the same endpoint with GRIDFORGE_ADMIN_KEY. `tier: "internal"` proves the admin credential
//      matches the engine's, i.e. cancellation can revoke a key; `revocation_persistable` (operator tier
//      only) says the engine has somewhere durable to record the revocation.
//
// The result is a category, never a value: nothing here reveals, fingerprints or echoes a secret, and the
// only public surface is a boolean-ish refusal on checkout. The probe key never leaves this process.
// Unverifiable (engine down, URL unset) is NOT ready: an API plan is only sold on a positive proof.

import { NextResponse } from "next/server";
import { issueKey, signingConfigured } from "@/lib/api-access";
import { PAYG } from "@/lib/products";

export type ReadinessCategory =
  | "ready"
  | "signing_unconfigured"
  | "engine_unconfigured"
  | "engine_unreachable"
  | "signing_mismatch"
  | "revocation_unconfigured"
  | "revocation_mismatch"
  | "revocation_unverifiable"
  | "revocation_not_persistable"
  | "engine_malformed";

export interface ApiReadiness { ready: boolean; category: ReadinessCategory; checkedAt: string }

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 20_000;
let cached: { at: number; value: ApiReadiness } | null = null;

export function resetApiReadinessCache(): void { cached = null; meteredCached = null; }

type Version = { tier: unknown; revocation_persistable: unknown; raw: Record<string, unknown> };

/** null = unreachable / non-2xx / timeout; "malformed" = answered, but not with a JSON object. */
async function engineVersion(base: string, key: string): Promise<Version | "malformed" | null> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}/v1/version`, {
      headers: { "X-API-Key": key },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const j = (await res.json()) as unknown;
    if (j === null || typeof j !== "object" || Array.isArray(j)) return "malformed";
    const o = j as Record<string, unknown>;
    return { tier: o.tier, revocation_persistable: o.revocation_persistable, raw: o };
  } catch {
    return "malformed";
  }
}

async function check(): Promise<ReadinessCategory> {
  if (!signingConfigured()) return "signing_unconfigured";
  const base = process.env.GRIDFORGE_API_URL;
  if (!base) return "engine_unconfigured";

  const probe = issueKey({ account: "ttp-readiness-probe", quota: 1, scope: "trial", days: 1 }).token;
  const asClient = await engineVersion(base, probe);
  if (asClient === null) return "engine_unreachable";
  if (asClient === "malformed") return "engine_malformed";
  if (asClient.tier !== "client") return "signing_mismatch";

  const admin = process.env.GRIDFORGE_ADMIN_KEY;
  if (!admin) return "revocation_unconfigured";
  const asOperator = await engineVersion(base, admin);
  if (asOperator === null) return "engine_unreachable";
  if (asOperator === "malformed") return "engine_malformed";
  if (asOperator.tier !== "internal") return "revocation_mismatch";
  // Positive evidence only. The engine proves durability by performing a real write/flush/rename/read-back
  // beside its revocation store. An engine that does not report the capability (older contract), reports
  // null / a string / a number, or reports false, has not proved it -- and the sale does not happen.
  if (asOperator.revocation_persistable === undefined || asOperator.revocation_persistable === null) return "revocation_unverifiable";
  if (asOperator.revocation_persistable !== true) {
    return typeof asOperator.revocation_persistable === "boolean" ? "revocation_not_persistable" : "revocation_unverifiable";
  }
  return "ready";
}

export async function apiSalesReadiness(): Promise<ApiReadiness> {
  const now = Date.now();
  if (cached && now - cached.at < (cached.value.ready ? OK_TTL_MS : FAIL_TTL_MS)) return cached.value;
  const category = await check().catch((): ReadinessCategory => "engine_unreachable");
  const value: ApiReadiness = { ready: category === "ready", category, checkedAt: new Date(now).toISOString() };
  cached = { at: now, value };
  return value;
}


// ---------------------------------------------------------------------------------------------------------------------
// Metered access: may the website ISSUE a free-allowance or pay-as-you-go key, or open pay-as-you-go, right now?
//
// A subscription key only needs the engine to verify our signature. A free-allowance or pay-as-you-go key needs more: the
// engine must serve the ledger the invoice is built from, accept the `payg` scope, and quote the SAME unit price and allowance
// this site shows. Against an engine built before the ledger existed, a payg key is refused outright (unknown scope), a
// free key is capped but unrecorded, and the daily settlement finds no ledger to read. Whether that is the case is knowable in
// advance and without cost, so the site says "not open yet" instead of issuing something the engine cannot honour.
// ---------------------------------------------------------------------------------------------------------------------

export type MeteredCategory =
  | ReadinessCategory
  | "metering_unsupported"   // the engine does not publish the pay-as-you-go block, or has no operator ledger route
  | "metering_mismatch"      // the engine quotes a different unit price, minimum invoice, currency or free allowance than this site
  | "ledger_unavailable";    // the engine reports its ledger as not durable / not writable

export interface MeteredReadiness { ready: boolean; category: MeteredCategory; checkedAt: string }

let meteredCached: { at: number; value: MeteredReadiness } | null = null;

async function meteredCheck(): Promise<MeteredCategory> {
  const base = await check();
  if (base !== "ready") return base;
  const url = (process.env.GRIDFORGE_API_URL as string).replace(/\/$/, "");
  const admin = process.env.GRIDFORGE_ADMIN_KEY as string;

  // 1. The engine accepts the payg scope (a stale engine reads our key as an unknown scope: tier "public").
  const paygProbe = issueKey({ account: "ttp-readiness-probe", quota: 1, scope: "payg", days: 1 }).token;
  const asPayg = await engineVersion(url, paygProbe);
  if (asPayg === null) return "engine_unreachable";
  if (asPayg === "malformed") return "engine_malformed";
  if (asPayg.tier !== "client") return "metering_unsupported";

  // 2. It publishes the scheme, and the scheme is the one this site quotes.
  const published = asPayg.raw.payg as Record<string, unknown> | null | undefined;
  if (!published || typeof published !== "object" || Array.isArray(published)) return "metering_unsupported";
  if (
    published.unit_price_cents !== PAYG.unitPriceCents ||
    published.currency !== PAYG.currency ||
    published.min_invoice_cents !== PAYG.minInvoiceCents ||
    published.free_allowance_units !== PAYG.freeAllowanceUnits
  ) {
    return "metering_mismatch";
  }
  const metering = asPayg.raw.metering as Record<string, unknown> | null | undefined;
  if (!metering || typeof metering !== "object" || metering.ledger_durable !== true) return "ledger_unavailable";

  // 3. The operator can read the ledger the invoice is built from (404 here is an engine without the route).
  let res: Response;
  try {
    res = await fetch(`${url}/v1/admin/ledger?limit=1`, { headers: { "X-API-Key": admin }, signal: AbortSignal.timeout(5_000), cache: "no-store" });
  } catch {
    return "engine_unreachable";
  }
  if (res.status === 404) return "metering_unsupported";
  if (!res.ok) return "engine_unreachable";
  try {
    const j = (await res.json()) as { durable?: unknown; head_seq?: unknown };
    if (j.durable !== true) return "ledger_unavailable";
    if (typeof j.head_seq !== "number") return "metering_unsupported";
  } catch {
    return "engine_malformed";
  }
  return "ready";
}

export async function meteredReadiness(): Promise<MeteredReadiness> {
  const now = Date.now();
  if (meteredCached && now - meteredCached.at < (meteredCached.value.ready ? OK_TTL_MS : FAIL_TTL_MS)) return meteredCached.value;
  const category = await meteredCheck().catch((): MeteredCategory => "engine_unreachable");
  const value: MeteredReadiness = { ready: category === "ready", category, checkedAt: new Date(now).toISOString() };
  meteredCached = { at: now, value };
  return value;
}

/**
 * The refusal for a route that would issue or enable something the engine cannot yet honour; null when it can. The category goes
 * to the log, never to the customer, and nothing has been created or charged when this answers.
 */
export async function meteredUnavailable(): Promise<NextResponse | null> {
  const r = await meteredReadiness();
  if (r.ready) return null;
  console.error(`[GridForge] metered access refused: ${r.category}`);
  return NextResponse.json(
    {
      ok: false,
      reason: "metered_unavailable",
      error: "Free developer keys and pay-as-you-go are not open on this deployment yet. Nothing was created and nothing was charged. The free qualifier and the cost estimate need no key.",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}
