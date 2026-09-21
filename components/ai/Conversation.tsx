"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import type { ChatMessage } from "./types";

const STARTER_PROMPTS = [
  "How many racks does our hall carry today?",
  "What binds first — electrical or thermal?",
  "Show me the full headroom ladder.",
  "How much time to power do we save on-site vs the grid queue?",
  "I don't have all the numbers yet — what's missing?",
];

export function Conversation({
  messages,
  loading,
  onSend,
}: {
  messages: ChatMessage[];
  loading: boolean;
  onSend: (text: string) => void;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  function submit() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    onSend(text);
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3.5 border-b border-line">
        <div className="text-sm font-semibold text-ghost">Conversation</div>
        <div className="data text-[10px] text-power">Time to Power · engineering workspace</div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-[12px] text-faint mb-2">Try one of these:</p>
            {STARTER_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => onSend(p)}
                className="block w-full text-left rounded-lg border border-line bg-ink/40 px-3 py-2.5 text-[13px] text-ghost hover:border-power/40 transition-colors"
              >
                {p}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap ${
                m.role === "user" ? "bg-power text-ink" : "bg-ink border border-line text-ghost/90"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl px-3.5 py-2.5 bg-ink border border-line text-mute">
              <Loader2 size={15} className="animate-spin" />
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-line p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="e.g. 40 MW hall, contracted, not sure what binds…"
            className="flex-1 resize-none bg-ink border border-line rounded-lg px-3 py-2.5 text-[13px] text-white placeholder:text-faint focus:border-power/50 focus:outline-none max-h-28"
          />
          <button
            onClick={submit}
            disabled={loading || !input.trim()}
            className="shrink-0 rounded-lg bg-power text-ink p-2.5 disabled:opacity-40 hover:bg-power/90 transition-colors"
            aria-label="Send"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
