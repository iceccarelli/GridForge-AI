// What the DEPLOYED engine says it serves, read from its public GET /v1/version.
//
// The repository can be ahead of the engine on Fly (the Python tree is deployed by a separate step), so a page or a
// machine-readable file that describes an engine route must not assume the route exists. Surfaces that advertise a
// route ask here first. When the engine cannot be read, nothing is advertised: an unverified capability is not a
// claim this site makes.

const TTL_MS = 5 * 60_000;
const TTL_UNREADABLE_MS = 60_000; // a failed read is retried sooner than a good one is refreshed
let cache: { at: number; routes: Set<string> | null } | null = null;

export async function deployedEngineRoutes(): Promise<Set<string> | null> {
  if (cache && Date.now() - cache.at < (cache.routes ? TTL_MS : TTL_UNREADABLE_MS)) return cache.routes;
  const base = (process.env.GRIDFORGE_API_URL || "https://gridforge-engine.fly.dev").replace(/\/$/, "");
  let routes: Set<string> | null = null;
  try {
    const res = await fetch(`${base}/v1/version`, { signal: AbortSignal.timeout(8_000), next: { revalidate: 300 } });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { endpoints?: unknown } | null;
      if (Array.isArray(body?.endpoints) && body.endpoints.every((e) => typeof e === "string")) {
        routes = new Set(body.endpoints as string[]);
      }
    }
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

/** Test seam. */
export function resetEngineCapabilityCache(): void {
  cache = null;
}
