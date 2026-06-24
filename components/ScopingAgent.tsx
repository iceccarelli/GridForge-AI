"use client";

import { useState, useRef, useEffect } from "react";
import { MessageSquare, X, Send, Loader2 } from "lucide-react";
import { openAudit } from "@/lib/ui";
import { startDeposit } from "@/lib/checkout";
import { ArrowRight } from "lucide-react";

type Msg = { role: "user" | "assistant"; content: string };

const GREETING: Msg = {
  role: "assistant",
  content:
    "I'm the GridForge scoping engineer. Tell me about your site — approximate MW, location, timeline, and where you are with the grid — and I'll give you a directional read on whether behind-the-meter power can get you energized faster.",
};

export function ScopingAgent() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lead, setLead] = useState<{ tier: string; score: number } | null>(null);
  const [captured, setCaptured] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.filter((m) => m !== GREETING), captured }),
      });
      const data = await res.json();
      if (data.ok && data.reply) {
        setMessages([...next, { role: "assistant", content: data.reply }]);
        if (data.lead && !captured) {
          setLead({ tier: data.lead.tier, score: data.lead.score });
          setCaptured(true);
        }
      } else {
        setMessages([
          ...next,
          { role: "assistant", content: "I'm having trouble right now — try the Request audit form and we'll respond within a day." },
        ]);
      }
    } catch {
      setMessages([
        ...next,
        { role: "assistant", content: "Connection issue — please use the Request audit form instead." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Launcher */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-[60] flex items-center gap-2.5 rounded-full bg-power text-ink pl-4 pr-5 py-3.5 shadow-[0_8px_30px_-6px_rgba(0,229,255,0.5)] hover:scale-105 transition-transform font-medium text-sm"
          aria-label="Open scoping engineer"
        >
          <MessageSquare size={18} /> Scope my site
        </button>
      )}

      {/* Panel */}
      {open && (
        <div className="fixed bottom-6 right-6 z-[60] w-[min(92vw,400px)] h-[min(80vh,600px)] flex flex-col rounded-2xl border border-line bg-panel shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-ink/60">
            <div>
              <div className="font-semibold text-sm">Scoping engineer</div>
              <div className="data text-[10px] text-power">GridForge AI · directional reads</div>
            </div>
            <button onClick={() => setOpen(false)} className="text-mute hover:text-white" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-power text-ink"
                      : "bg-ink border border-line text-ghost/90"
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

          {lead && (
            <div className="border-t border-line px-4 py-3 bg-power/[0.04]">
              {lead.tier === "hot" ? (
                <>
                  <div className="data text-[10px] uppercase tracking-[0.12em] text-power mb-1.5">
                    Your site qualifies · priority
                  </div>
                  <button
                    onClick={() => startDeposit({ service: "Power Audit & Site Assessment", founding: true })}
                    className="w-full rounded-lg bg-power text-ink px-4 py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-2 hover:bg-power/90 transition-all"
                  >
                    Reserve your engagement <ArrowRight size={14} />
                  </button>
                </>
              ) : lead.tier === "warm" ? (
                <button
                  onClick={() => openAudit("scoping-agent")}
                  className="w-full rounded-lg border border-power/50 text-power px-4 py-2.5 text-sm font-medium inline-flex items-center justify-center gap-2 hover:bg-power/10 transition-all"
                >
                  Request your full audit <ArrowRight size={14} />
                </button>
              ) : (
                <button
                  onClick={() => openAudit("scoping-agent")}
                  className="w-full rounded-lg border border-line text-mute px-4 py-2.5 text-sm font-medium hover:text-white hover:border-power/40 transition-all"
                >
                  Get a written assessment →
                </button>
              )}
            </div>
          )}
          <div className="border-t border-line p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder="e.g. 60 MW in ERCOT queue, need power Q3…"
                className="flex-1 resize-none bg-ink border border-line rounded-lg px-3 py-2.5 text-[13px] text-white placeholder:text-faint focus:border-power/50 focus:outline-none max-h-28"
              />
              <button
                onClick={send}
                disabled={loading || !input.trim()}
                className="shrink-0 rounded-lg bg-power text-ink p-2.5 disabled:opacity-40 hover:bg-power/90 transition-colors"
                aria-label="Send"
              >
                <Send size={16} />
              </button>
            </div>
            <button
              onClick={() => openAudit("scoping-agent")}
              className="mt-2 w-full data text-[10px] uppercase tracking-[0.1em] text-mute hover:text-power transition-colors"
            >
              Or request a full audit →
            </button>
          </div>
        </div>
      )}
    </>
  );
}
