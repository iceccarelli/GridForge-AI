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

import { issueKey, signingConfigured } from "@/lib/api-access";

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

export function resetApiReadinessCache(): void { cached = null; }

type Version = { tier: unknown; revocation_persistable: unknown };

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
    return { tier: o.tier, revocation_persistable: o.revocation_persistable };
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
