// Shapes an incoming chat transcript into what the orchestration loop needs.
// No physics here — just turning the widget's { role, content } list into
// Anthropic message blocks and applying the same conversation-length cap the
// previous handler used.

export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** The widget never sends more than this; mirrors the previous route's
 *  `messages.slice(-20)`. */
export const MAX_TRANSCRIPT_MESSAGES = 20;

/** One message's ceiling. Generous for a user turn; a model reply (max_tokens 1024) is ~4k characters, so replies fit too. */
export const MAX_MESSAGE_CHARS = 4500;
/** The whole transcript a request may carry to the model, in characters (~8k tokens): bounds input tokens per provider call. */
export const MAX_TRANSCRIPT_CHARS = 32_000;

/** True when a transcript is too large to send to a paid model. Checked before any provider work. */
export function transcriptTooLarge(messages: ChatMessage[]): boolean {
  let total = 0;
  for (const m of messages) {
    if (m.content.length > MAX_MESSAGE_CHARS) return true;
    total += m.content.length;
  }
  return total > MAX_TRANSCRIPT_CHARS;
}

export function normalizeTranscript(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    out.push({ role, content });
  }
  return out.slice(-MAX_TRANSCRIPT_MESSAGES);
}

export function latestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}
