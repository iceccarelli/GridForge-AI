/**
 * /power/compare and /power/deploy while the DEPLOYED engine does not serve the routes behind them: the pages say so
 * instead of rendering a form that can only 503, the URLs stay in the sitemap, and the server routes answer 503
 * "not deployed yet" with nothing charged (never 502 "try again later"). When the engine does serve the routes the forms
 * are back, with no site redeploy.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_YET_AVAILABLE } from "@/lib/payg-pricing";
import { ROUTE_NOT_DEPLOYED_MESSAGE } from "@/lib/power-deploy";
import { siteUrl } from "@/lib/site";
import { FULL_ENGINE, STALE_ENGINE, stubEngine } from "./engine-stub";
import { PostgrestFake } from "./postgrest-fake";

// The assessment form navigates to the case it creates; there is no app router when rendering to a string.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

async function render(load: () => Promise<{ default: (p?: any) => Promise<React.ReactElement> }>, routes: string[] | "down", props?: unknown) {
  const stop = stubEngine(routes);
  try {
    return renderToStaticMarkup(await (await load()).default(props)).replace(/<!-- -->/g, "");
  } finally {
    stop();
  }
}

describe("/power/compare", () => {
  const load = () => import("@/app/power/compare/page");

  it("stale engine: a clear 'not available yet' state, no form, no WebApplication JSON-LD", async () => {
    const html = await render(load, STALE_ENGINE);
    expect(html).toContain(NOT_YET_AVAILABLE);
    expect(text(html)).toMatch(/not available yet/);
    expect(text(html)).toMatch(/Nothing is calculated, saved or charged/);
    expect(html).not.toMatch(/<form|<input|<select|<textarea/);
    expect(html).not.toContain("application/ld+json");
    expect(html).not.toContain("isAccessibleForFree");
    // The promise to be "free, no account" is not made for a tool that is not there.
    expect(text(html)).not.toMatch(/Free, no account/);
  });

  it("fully deployed engine: the comparison form and its JSON-LD are back", async () => {
    const html = await render(load, FULL_ENGINE);
    expect(html).not.toContain(NOT_YET_AVAILABLE);
    expect(html).toMatch(/<input/);
    expect(html).toContain("application/ld+json");
    expect(text(html)).toMatch(/Free, no account/);
  });

  it("engine unreachable: treated as unavailable, and says it could not confirm", async () => {
    const html = await render(load, "down");
    expect(html).not.toMatch(/<form|<input/);
    expect(html).toContain('data-engine-route-state="unknown"');
  });
});

describe("/power/deploy", () => {
  const load = () => import("@/app/power/deploy/page");

  it("stale engine: no assessment form, an honest state instead", async () => {
    const html = await render(load, STALE_ENGINE);
    expect(html).toContain(NOT_YET_AVAILABLE);
    expect(html).not.toMatch(/<form|<input|<select|<textarea/);
    expect(text(html)).toMatch(/Once it is available, this compares/);
  });

  it("fully deployed engine: the form is back", async () => {
    const html = await render(load, FULL_ENGINE);
    expect(html).not.toContain(NOT_YET_AVAILABLE);
    expect(html).toMatch(/<input/);
  });

  it("a different route being served does not unlock it: only /v1/power/deploy/assess does", async () => {
    const html = await render(load, [...STALE_ENGINE, "/v1/compare", "/v1/power/deploy/spec"]);
    expect(html).toContain(NOT_YET_AVAILABLE);
  });
});

describe("the sitemap keeps the URLs", () => {
  it("lists both pages even while they say 'not available yet'", async () => {
    const map = JSON.stringify(await (await import("@/app/sitemap")).default());
    expect(map).toContain("/power/compare");
    expect(map).toContain("/power/deploy");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The server routes: the engine's own "not found" for a route is 503 "not deployed yet", never 502.
// ---------------------------------------------------------------------------------------------------------------

const ENGINE = "http://engine.test";
const REQUEST = {
  load_profile: { flat_kW: 30000 },
  grid_firm_MW: 10,
  target_MW: 35,
  redundancy: "N+1",
  generation: [{ id: "GEN-A", kind: "gas_engine", nameplate_MW: 20 }],
  bess: [],
};

describe("power deployment routes against an engine that does not serve /v1/power/deploy/assess", () => {
  let db: PostgrestFake;
  let restorePg: () => void;
  let engineMode: "ok" | "stale" | "down" = "ok";
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    process.env.GRIDFORGE_API_URL = ENGINE;
    process.env.GRIDFORGE_API_KEY = "engine-key";
    engineMode = "ok";
    db = new PostgrestFake(["power_deployment_cases"]);
    restorePg = db.install();
    const pgFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(ENGINE)) return pgFetch(input as RequestInfo, init);
      if (url.endsWith("/v1/version")) return new Response(JSON.stringify({}), { status: 200 });
      if (engineMode === "down") return new Response(JSON.stringify({ error: "upstream" }), { status: 502 });
      if (engineMode === "stale") {
        // exactly what the engine on Fly answers for a path it does not serve
        return new Response(JSON.stringify({ error: "not found", endpoints: STALE_ENGINE }), { status: 404 });
      }
      return new Response(
        JSON.stringify({ capacity: { target_MW: 35 }, architectures: [], next_action: { action: "x" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
  });
  afterEach(() => {
    restorePg();
    globalThis.fetch = realFetch;
  });

  const post = (url: string, body: unknown) =>
    new Request(siteUrl(url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("POST /api/power/deploy/cases answers 503 'not deployed', says nothing was charged, and stores no case", async () => {
    engineMode = "stale";
    const { POST } = await import("@/app/api/power/deploy/cases/route");
    const res = await POST(post("/api/power/deploy/cases", REQUEST));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toEqual({ ok: false, error: ROUTE_NOT_DEPLOYED_MESSAGE });
    expect(body.error).toMatch(/not deployed yet/);
    expect(body.error).toMatch(/charged/);
    expect(db.rows("power_deployment_cases")).toHaveLength(0);
  });

  it("POST /api/power/deploy/cases/[token] answers 503 'not deployed' and adds no revision", async () => {
    const { POST: create } = await import("@/app/api/power/deploy/cases/route");
    const token = (await (await create(post("/api/power/deploy/cases", REQUEST))).json()).case_token as string;
    engineMode = "stale";
    const { POST } = await import("@/app/api/power/deploy/cases/[token]/route");
    const res = await POST(post(`/api/power/deploy/cases/${token}`, { target_MW: 45 }), { params: Promise.resolve({ token }) });
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error).toBe(ROUTE_NOT_DEPLOYED_MESSAGE);
    expect(db.rows("power_deployment_cases")).toHaveLength(1);
  });

  it("an engine that is merely down is still a 502, not mistaken for a missing route", async () => {
    engineMode = "down";
    const { POST } = await import("@/app/api/power/deploy/cases/route");
    const res = await POST(post("/api/power/deploy/cases", REQUEST));
    expect(res.status).toBe(502);
  });
});
