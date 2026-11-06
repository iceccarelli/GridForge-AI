/**
 * app/api/chat captures a lead from the conversation and stores it. When that store fails the failure must stay VISIBLE to the operator
 * and the lead's own words (name, address, company, notes) must NEVER reach a log line: logs are shipped to third-party log drains.
 *
 * Both store failures are exercised: a PostgREST rejection (a status, whose body echoes the row) and a transport throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";

const PII = {
  name: "Ada Quillfeather",
  email: "ada.quillfeather@hallco-private.example",
  company: "Hallco Private Holdings",
  message: "Secret plan: our 60 MW hall at the Quillfeather site",
};

let mode: "reject" | "throw" | "ok";
let leadPosts = 0;
let restore: () => void;

function anthropicReply(text: string) {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  };
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-placeholder-test";
  process.env.SUPABASE_URL = "http://store.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_placeholder";
  delete process.env.RESEND_API_KEY;
  delete process.env.LEAD_TO_EMAIL;
  leadPosts = 0;
  let anthropicCalls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.anthropic.com/v1/messages")) {
      anthropicCalls += 1;
      // call 1 is the agent turn, call 2 the lead extraction
      const text = anthropicCalls === 1 ? "Thanks, noted." : JSON.stringify({
        capacity: "60 MW", location: "Frankfurt", urgency: "90days", gridStatus: "in_queue", services: [],
        message: PII.message, name: PII.name, company: PII.company, email: PII.email,
      });
      return new Response(JSON.stringify(anthropicReply(text)), { status: 200, headers: { "content-type": "application/json" } });
    }
    // The shared rate counter lives in the same store: admit everything so the lead path is what is under test.
    if (url.includes("/rest/v1/rpc/gf_rate_limit_hit")) return new Response(JSON.stringify({ allowed: true, retry_after_seconds: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("http://store.test/rest/v1/leads")) {
      leadPosts += 1;
      if (mode === "throw") throw Object.assign(new TypeError(`fetch failed for ${url} body=${String(init?.body)}`), { cause: String(init?.body) });
      if (mode === "reject") {
        // PostgREST echoes the offending row in `details`.
        return new Response(JSON.stringify({ code: "23505", message: "duplicate", details: `Key (email)=(${PII.email}) already exists. ${init?.body}` }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 201 });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  restore = () => { globalThis.fetch = previous; };
});
afterEach(() => { restore(); vi.restoreAllMocks(); });

async function chatThreeTurns() {
  const { POST } = await import("@/app/api/chat/route");
  return POST(new Request(siteUrl("/api/chat"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [
      { role: "user", content: "We run a 60 MW hall in Frankfurt" },
      { role: "assistant", content: "Where are you with the grid connection?" },
      { role: "user", content: "In the queue; need power this quarter" },
    ] }),
  }));
}

function logged(): string {
  const spies = [console.error, console.warn, console.log, console.info, console.debug] as unknown as { mock: { calls: unknown[][] } }[];
  return spies.flatMap((s) => s.mock.calls).map((args) => args.map((a) => (a instanceof Error ? `${a.name}:${a.message}:${String(a.cause ?? "")}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
}

describe("a failing lead store never puts the lead's words in a log", () => {
  for (const failure of ["reject", "throw"] as const) {
    it(`store ${failure}: no name, address, company or note reaches any console method, and the fault is still logged by category`, async () => {
      mode = failure;
      for (const m of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => {});
      const res = await chatThreeTurns();
      expect(res.status).toBe(200);
      expect(leadPosts).toBe(1);
      const out = logged();
      for (const secret of [PII.name, PII.email, PII.company, PII.message, "Quillfeather", "hallco-private"]) expect(out, secret).not.toContain(secret);
      // still visible: the operator can see a lead was lost, with a status-level category and a correlation id, never the body
      const line = out.split("\n").find((l) => /lead NOT persisted/.test(l));
      expect(line, out).toBeDefined();
      expect(line).toMatch(failure === "reject" ? /HTTP 409/ : /unreachable/);
      expect(line).toMatch(/ref [a-f0-9]{8}/);
    });
  }

  it("a stored lead logs nothing about the lead", async () => {
    mode = "ok";
    for (const m of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => {});
    await chatThreeTurns();
    expect(leadPosts).toBe(1);
    const out = logged();
    expect(out).not.toContain(PII.email);
    expect(out).not.toMatch(/NOT persisted/);
  });
});
