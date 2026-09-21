import type { AssistantTurn, ChatMessage } from "./types";

/**
 * The workspace's one call into the real engine-bound agent — POSTs the
 * transcript to /api/chat (lib/ai/agent.ts's tool-calling loop) and returns
 * the shared { blocks, toolCalls } contract every card in this directory
 * renders. components/ai/mock.ts is a dev/test-only stand-in; this is the
 * production path.
 */
export async function getAssistantTurn(messages: ChatMessage[]): Promise<AssistantTurn> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: messages.map((m) => ({ role: m.role, content: m.content })) }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/api/chat ${res.status}: ${detail || res.statusText}`);
  }

  const json: { ok: boolean; reply?: string; blocks?: unknown; toolCalls?: unknown; error?: string } =
    await res.json();
  if (!json.ok) {
    throw new Error(json.error || "Agent unavailable");
  }

  const toolCalls = Array.isArray(json.toolCalls) ? (json.toolCalls as AssistantTurn["toolCalls"]) : [];
  const blocks = Array.isArray(json.blocks) ? (json.blocks as AssistantTurn["blocks"]) : [];

  // The route's `blocks` are engine-derived metric/refusal/missing-input
  // blocks only — it never emits an "answer" block itself. Every card in
  // this directory (and WorkspaceClient's chat summary) expects one, so
  // prepend the model's prose reply here rather than in every consumer.
  const hasAnswer = blocks.some((b) => b.type === "answer");
  if (!hasAnswer && json.reply) {
    blocks.unshift({ type: "answer", text: json.reply });
  }

  return { toolCalls, blocks };
}
