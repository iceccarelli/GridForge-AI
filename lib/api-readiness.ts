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
  | "revocation_not_persistable";

export interface ApiReadiness { ready: boolean; category: ReadinessCategory; checkedAt: string }

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 20_000;
let cached: { at: number; value: ApiReadiness } | null = null;

export function resetApiReadinessCache(): void { cached = null; }

async function engineVersion(base: string, key: string): Promise<{ tier?: string; revocation_persistable?: boolean } | null> {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/version`, {
      headers: { "X-API-Key": key },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as { tier?: string; revocation_persistable?: boolean };
  } catch {
    return null;
  }
}

async function check(): Promise<ReadinessCategory> {
  if (!signingConfigured()) return "signing_unconfigured";
  const base = process.env.GRIDFORGE_API_URL;
  if (!base) return "engine_unconfigured";

  const probe = issueKey({ account: "ttp-readiness-probe", quota: 1, scope: "trial", days: 1 }).token;
  const asClient = await engineVersion(base, probe);
  if (!asClient) return "engine_unreachable";
  if (asClient.tier !== "client") return "signing_mismatch";

  const admin = process.env.GRIDFORGE_ADMIN_KEY;
  if (!admin) return "revocation_unconfigured";
  const asOperator = await engineVersion(base, admin);
  if (!asOperator) return "engine_unreachable";
  if (asOperator.tier !== "internal") return "revocation_mismatch";
  if (asOperator.revocation_persistable === false) return "revocation_not_persistable";
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
