/**
 * app/api/chat — the scoping engineer, now bound to the real engine through
 * lib/ai/agent.ts's tool-calling loop instead of narrating from memory.
 *
 * These tests fake both external calls the route makes: the Anthropic
 * Messages API (https://api.anthropic.com/v1/messages) and the GridForge
 * engine (GRIDFORGE_API_URL). Nothing here talks to a real model or a real
 * engine — that is the point: it proves the WIRING (tool call → real HTTP
 * call → validated result → reply), not any particular model's judgement.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";

const ENGINE = "http://engine.test";

let restoreFetch: () => void;
let anthropicScript: AnthropicTurn[] = [];
let anthropicCallCount = 0;
let engineHandler: (path: string, body: unknown) => { status: number; body: unknown };

interface AnthropicTurn {
  content: (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  )[];
}

function anthropicMessage(turn: AnthropicTurn) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: turn.content,
    stop_reason: turn.content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function installFetches() {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("api.anthropic.com/v1/messages")) {
      const turn = anthropicScript[anthropicCallCount] ?? anthropicScript[anthropicScript.length - 1];
      anthropicCallCount += 1;
      return new Response(JSON.stringify(anthropicMessage(turn)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.startsWith(ENGINE)) {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const { status, body: respBody } = engineHandler(path, body);
      return new Response(JSON.stringify(respBody), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    // Resend / anything else this route touches — swallow quietly.
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

async function route() {
  return await import("@/app/api/chat/route");
}

function post(body: unknown) {
  return new Request(siteUrl("/api/chat"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-placeholder-test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  delete process.env.GRIDFORGE_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  anthropicScript = [];
  anthropicCallCount = 0;
  engineHandler = () => ({ status: 200, body: {} });
  restoreFetch = installFetches();
});

afterEach(() => {
  restoreFetch();
});

describe("the widget contract is unchanged", () => {
  it("still returns { ok, reply, lead } for a plain reply with no tool call", async () => {
    anthropicScript = [{ content: [{ type: "text", text: "Tell me your contracted MW to start." }] }];
    const { POST } = await route();
    const res = await POST(post({ messages: [{ role: "user", content: "hi" }] }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reply).toBe("Tell me your contracted MW to start.");
    expect(body.lead).toBeNull();
    // No tool call this turn -> no metric block could possibly exist.
    expect((body.blocks ?? []).filter((b: { type: string }) => b.type === "metric")).toHaveLength(0);
    expect(body.toolCalls ?? []).toHaveLength(0);
  });
});

describe("a real tool call binds the reply to a real engine result", () => {
  it("propagates the engine's evidence class and digest into the final blocks, unchanged", async () => {
    engineHandler = (path) => {
      expect(path).toBe("/v1/qualify");
      return {
        status: 200,
        body: {
          platform: {
            id: "gb300_nvl72",
            name: "NVIDIA GB300 NVL72",
            rack_kW: { value: 132, low: 120, high: 140, unit: "kW", evidence: "E3", label: "Rack power draw", digest: "digest-abc" },
          },
          as_found: { racks: 12, binding_constraint: "Rack feed / tap-off rating", domain: "lv", basis: "b" },
          after_relief: { racks: 30, architecture: "full_dlc", then_binds_on: null, sets_the_date: "plant" },
          intake: { completeness: 0.6, required_inputs_missing: 3 },
          notice: "n",
        },
      };
    };
    anthropicScript = [
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "gridforge_qualify",
            input: {
              contracted_MW: 40,
              current_site_peak_MW: 20,
              busway_ampacity_A: 4000,
              tapoff_max_A: 630,
            },
          },
        ],
      },
      { content: [{ type: "text", text: "About 12 racks today, rising to 30 once the tap-off is relieved." }] },
    ];

    const { POST } = await route();
    const res = await POST(post({ messages: [{ role: "user", content: "40 MW contracted, 20 MW peak" }] }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.toolCalls).toHaveLength(1);
    expect(body.toolCalls[0].tool).toBe("gridforge_qualify");
    expect(body.toolCalls[0].ok).toBe(true);

    const metric = body.blocks.find(
      (b: { type: string; label?: string }) => b.type === "metric" && b.label === "Rack power draw"
    );
    expect(metric).toBeDefined();
    expect(metric.quantity.evidence).toBe("E3");
    expect(metric.quantity.digest).toBe("digest-abc");
    expect(metric.sourceTool).toBe("gridforge_qualify");
  });

  it("a missing required input produces a missingInput block, never a guessed engine call", async () => {
    let engineCalled = false;
    engineHandler = () => {
      engineCalled = true;
      return { status: 200, body: {} };
    };
    anthropicScript = [
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "gridforge_qualify",
            // tapoff_max_A deliberately omitted
            input: { contracted_MW: 40, current_site_peak_MW: 20, busway_ampacity_A: 4000 },
          },
        ],
      },
      { content: [{ type: "text", text: "What's the largest installed tap-off rating on site, in amps?" }] },
    ];

    const { POST } = await route();
    const res = await POST(post({ messages: [{ role: "user", content: "40 MW contracted" }] }));
    const body = await res.json();

    expect(engineCalled).toBe(false);
    const missing = body.blocks.find((b: { type: string }) => b.type === "missingInput");
    expect(missing).toBeDefined();
    expect(missing.field).toBe("tapoff_max_A");
    expect(missing.tool).toBe("gridforge_qualify");
  });

  it("refuses a paid tool with a 402-shaped commercialAction, not a 429", async () => {
    let engineCalled = false;
    engineHandler = () => {
      engineCalled = true;
      return { status: 200, body: {} };
    };
    anthropicScript = [
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "gridforge_study",
            input: { intake: { site: { name: "North Hall" } } },
          },
        ],
      },
      { content: [{ type: "text", text: "The full study is part of a paid engagement." }] },
    ];

    const { POST } = await route();
    const res = await POST(post({ messages: [{ role: "user", content: "Run the full study" }] }));
    const body = await res.json();

    // Never invoked the engine for an unentitled paid tool.
    expect(engineCalled).toBe(false);
    expect(body.toolCalls[0].status).toBe(402);
    expect(body.toolCalls[0].status).not.toBe(429);
    expect(body.toolCalls[0].ok).toBe(false);
    const action = body.blocks.find((b: { type: string }) => b.type === "commercialAction");
    expect(action).toBeDefined();
    expect(action.reason).toBe("entitlement_required");
    expect(action.href).toBe("/pricing");
  });

  it("invents nothing when the engine is unreachable for a call it was entitled to make", async () => {
    engineHandler = () => {
      throw new Error("simulated network failure");
    };
    // Patch: make the fetch itself reject for the engine host, not just the handler throw.
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(ENGINE)) throw new Error("simulated network failure");
      return previous(input as RequestInfo, init);
    }) as typeof fetch;

    anthropicScript = [
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "gridforge_qualify",
            input: { contracted_MW: 40, current_site_peak_MW: 20, busway_ampacity_A: 4000, tapoff_max_A: 630 },
          },
        ],
      },
      { content: [{ type: "text", text: "The engine could not be reached — I have nothing to report." }] },
    ];

    const { POST } = await route();
    const res = await POST(post({ messages: [{ role: "user", content: "40 MW contracted" }] }));
    const body = await res.json();

    expect(body.toolCalls[0].ok).toBe(false);
    // No metric block can exist off a failed call.
    expect(body.blocks.filter((b: { type: string }) => b.type === "metric")).toHaveLength(0);
    const action = body.blocks.find((b: { type: string }) => b.type === "commercialAction");
    expect(action).toBeDefined();
  });
});

describe("out of scope stays refused without ever reaching a tool", () => {
  it("refuses a microgrid financing ask before any tool call", async () => {
    let anyCall = false;
    anthropicScript = [{ content: [{ type: "text", text: "should never be reached" }] }];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      anyCall = true;
      return previous(input as RequestInfo, init);
    }) as typeof fetch;

    const { POST } = await route();
    const res = await POST(
      post({ messages: [{ role: "user", content: "Can GridForge finance and own a microgrid for our site?" }] })
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(anyCall).toBe(false);
    expect(body.reply).toMatch(/outside what Time to Power does/i);
  });
});
