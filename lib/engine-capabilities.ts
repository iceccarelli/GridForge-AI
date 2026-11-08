// What the DEPLOYED engine says it serves, read from its public GET /v1/version.
//
// The repository can be ahead of the engine on Fly (the Python tree is deployed by a separate step), so a page or a
// machine-readable file that describes an engine route must not assume the route exists. Surfaces that advertise a
// route ask here first. When the engine cannot be read, nothing is advertised: an unverified capability is not a
// claim this site makes.
//
// Pages that use this must re-render without a site redeploy (`export const revalidate = 300`, or an async server
// component): the answer changes when the engine is redeployed, not when this site is.

const TTL_MS = 5 * 60_000;
const TTL_UNREADABLE_MS = 60_000; // a failed read is retried sooner than a good one is refreshed
let cache: { at: number; routes: Set<string> | null; flags: ReadonlySet<string> } | null = null;

/** "available": the engine lists the route. "unavailable": it was read and does not. "unknown": it could not be read. */
export type Availability = "available" | "unavailable" | "unknown";

/**
 * The routes a /v1/version body says the engine serves. `endpoints` is the engine's own list; the MCP transport is
 * declared separately (`machine_interface.mcp`) and not in that list, so it counts only when the engine states it.
 * Returns null for a body that is not well formed: nothing is guessed.
 */
export function routesFromVersion(body: unknown): Set<string> | null {
  const b = body as { endpoints?: unknown; machine_interface?: { mcp?: unknown } } | null;
  if (!b || !Array.isArray(b.endpoints) || !b.endpoints.every((e) => typeof e === "string")) return null;
  const routes = new Set(b.endpoints as string[]);
  const mcp = b.machine_interface?.mcp;
  if (typeof mcp === "string" && mcp.startsWith("/")) routes.add(mcp);
  return routes;
}

/**
 * The behaviour flags a /v1/version body declares in `capabilities` (for example `qualify_assumed_fields`: POST /v1/qualify accepts
 * `assumed_fields`). A flag counts only when its value is exactly `true`; a body without `capabilities` (an engine older than the key) yields none.
 * Nothing is inferred from the route list or the version number: an engine that does not say it does a thing is treated as not doing it.
 */
export function capabilityFlagsFromVersion(body: unknown): Set<string> {
  const caps = (body as { capabilities?: unknown } | null)?.capabilities;
  const out = new Set<string>();
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return out;
  for (const [k, v] of Object.entries(caps as Record<string, unknown>)) if (v === true) out.add(k);
  return out;
}

async function readDeployedVersion(): Promise<{ routes: Set<string> | null; flags: ReadonlySet<string> }> {
  if (cache && Date.now() - cache.at < (cache.routes ? TTL_MS : TTL_UNREADABLE_MS)) return cache;
  const base = (process.env.GRIDFORGE_API_URL || "https://gridforge-engine.fly.dev").replace(/\/$/, "");
  let routes: Set<string> | null = null;
  let flags: ReadonlySet<string> = new Set();
  try {
    const res = await fetch(`${base}/v1/version`, { signal: AbortSignal.timeout(8_000), next: { revalidate: 300 } });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      routes = routesFromVersion(body);
      // Flags are read only from a body whose route list is well formed: a response that is not a /v1/version answer says nothing.
      if (routes) flags = capabilityFlagsFromVersion(body);
    }
  } catch {
    routes = null;
  }
  cache = { at: Date.now(), routes, flags };
  return cache;
}

export async function deployedEngineRoutes(): Promise<Set<string> | null> {
  return (await readDeployedVersion()).routes;
}

/** The capability flags the deployed engine declares in GET /v1/version. Empty when it cannot be read or declares none. */
export async function deployedEngineFlags(): Promise<ReadonlySet<string>> {
  return (await readDeployedVersion()).flags;
}

/**
 * True only when the DEPLOYED engine declares the flag as true in /v1/version `capabilities`. Unreadable, malformed, or an older engine without
 * the key: false. A page that gates a feature on an engine behaviour asks here, so it shows the feature only once the deployed engine does it.
 */
export async function engineHas(flag: string): Promise<boolean> {
  return (await deployedEngineFlags()).has(flag);
}

/** The flag POST /v1/qualify's `assumed_fields` is advertised under (gridforge/api/server.py CAPABILITIES). */
export const QUALIFY_ASSUMED_FIELDS_FLAG = "qualify_assumed_fields";

/** True only when the deployed engine lists the route. Unknown (engine unreachable) is false. */
export async function engineServes(path: string): Promise<boolean> {
  const routes = await deployedEngineRoutes();
  return routes ? routes.has(path) : false;
}

/** Like engineServes, but keeps "could not be read" apart from "read, and it does not serve it". */
export function availabilityIn(routes: Set<string> | null, path: string): Availability {
  if (!routes) return "unknown";
  return routes.has(path) ? "available" : "unavailable";
}

/** The MCP install is offered only when the engine serves both its transport and the free tool every client starts with. */
export function mcpAvailabilityIn(routes: Set<string> | null): Availability {
  const states = (["/mcp", "/v1/qualify"] as const).map((e) => availabilityIn(routes, e));
  if (states.includes("unknown")) return "unknown";
  return states.every((x) => x === "available") ? "available" : "unavailable";
}

/** Test seam. */
export function resetEngineCapabilityCache(): void {
  cache = null;
}
