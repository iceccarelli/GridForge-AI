/**
 * A fake of the deployed engine's public GET /v1/version, for tests of surfaces that follow what the engine serves
 * (lib/engine-capabilities.ts). Everything else the stub is asked for falls through to the previous fetch.
 *
 *   const stop = stubEngine(STALE_ENGINE)   // the engine as deployed on Fly today
 *   const stop = stubEngine(FULL_ENGINE)    // an engine redeployed from this repository
 *   const stop = stubEngine("down")         // /v1/version unreachable
 *   ... ; stop();
 */
import { resetEngineCapabilityCache } from "@/lib/engine-capabilities";
import snapshot from "@/lib/engine-deployed.json";

/** The engine as it is deployed today: exactly the committed snapshot. */
export const STALE_ENGINE: string[] = [...snapshot.endpoints];

/** An engine redeployed from this repository: the snapshot plus every route the site and the tool catalogue name. */
export const FULL_ENGINE: string[] = [
  ...snapshot.endpoints,
  "/v1/compare",
  "/v1/estimate",
  "/v1/power/assess",
  "/v1/power/deploy/assess",
  "/v1/power/deploy/spec",
  "/v1/power/deploy/bids",
  "/v1/revoke",
];

export function stubEngine(routes: string[] | "down"): () => void {
  resetEngineCapabilityCache();
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/v1\/version(\?|$)/.test(url)) {
      if (routes === "down") throw new Error("engine unreachable");
      return new Response(JSON.stringify({ version: "test", endpoints: routes, machine_interface: { mcp: "/mcp" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return previous(input as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
    resetEngineCapabilityCache();
  };
}
