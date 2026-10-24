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
let cache: { at: number; routes: Set<string> | null } | null = null;

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

export async function deployedEngineRoutes(): Promise<Set<string> | null> {
  if (cache && Date.now() - cache.at < (cache.routes ? TTL_MS : TTL_UNREADABLE_MS)) return cache.routes;
  const base = (process.env.GRIDFORGE_API_URL || "https://gridforge-engine.fly.dev").replace(/\/$/, "");
  let routes: Set<string> | null = null;
  try {
    const res = await fetch(`${base}/v1/version`, { signal: AbortSignal.timeout(8_000), next: { revalidate: 300 } });
    if (res.ok) routes = routesFromVersion(await res.json().catch(() => null));
  } catch {
    routes = null;
  }
  cache = { at: Date.now(), routes };
  return routes;
}

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

/** Test seam. */
export function resetEngineCapabilityCache(): void {
  cache = null;
}
