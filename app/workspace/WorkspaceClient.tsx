"use client";

import { useState, type ReactNode } from "react";
import { FolderOpen, MessageSquare, PanelsTopLeft } from "lucide-react";
import { Canvas } from "@/components/ai/Canvas";
import { Conversation } from "@/components/ai/Conversation";
import { ProjectPanel } from "@/components/ai/ProjectPanel";
import { getAssistantTurn } from "@/components/ai/mock";
import type { ChatMessage } from "@/components/ai/types";

type MobileTab = "chat" | "canvas" | "project";

/**
 * Three-pane workspace: conversation (left) / engineering canvas (center) /
 * project context (right, stub). Below phone width the panes collapse into
 * tabs instead of a horizontal-scrolling row — see the mobile tab bar at the
 * bottom of this component.
 */
export function WorkspaceClient() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");

  async function handleSend(text: string) {
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setLoading(true);
    setMobileTab("canvas");
    try {
      // See components/ai/mock.ts — getAssistantTurn() is the one call to swap
      // for a real fetch("/api/chat") once agent/ttp-ai-core lands.
      const turn = await getAssistantTurn(text);
      const summary =
        turn.blocks.find((b) => b.type === "answer")?.text ??
        "Here's what the engine returned — see the canvas.";
      setMessages([...next, { role: "assistant", content: summary, turn }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-[calc(100dvh-4rem)] sm:h-[calc(100dvh-5rem)] flex flex-col bg-ink">
      {/* Desktop / tablet: three panes side by side */}
      <div className="hidden md:grid flex-1 min-h-0 grid-cols-[340px_1fr_280px] lg:grid-cols-[380px_1fr_300px]">
        <div className="border-r border-line min-h-0 bg-panel/40">
          <Conversation messages={messages} loading={loading} onSend={handleSend} />
        </div>
        <div className="min-h-0 blueprint">
          <Canvas messages={messages} onQuickAction={handleSend} />
        </div>
        <div className="border-l border-line min-h-0 bg-panel/40">
          <ProjectPanel />
        </div>
      </div>

      {/* Mobile: one pane at a time behind a tab bar */}
      <div className="flex md:hidden flex-1 min-h-0 flex-col">
        <div className="flex-1 min-h-0">
          {mobileTab === "chat" && (
            <div className="h-full bg-panel/40">
              <Conversation messages={messages} loading={loading} onSend={handleSend} />
            </div>
          )}
          {mobileTab === "canvas" && (
            <div className="h-full blueprint">
              <Canvas messages={messages} onQuickAction={handleSend} />
            </div>
          )}
          {mobileTab === "project" && (
            <div className="h-full bg-panel/40">
              <ProjectPanel />
            </div>
          )}
        </div>
        <nav
          className="grid grid-cols-3 border-t border-line bg-panel"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <TabButton
            active={mobileTab === "chat"}
            onClick={() => setMobileTab("chat")}
            icon={<MessageSquare size={16} />}
            label="Chat"
          />
          <TabButton
            active={mobileTab === "canvas"}
            onClick={() => setMobileTab("canvas")}
            icon={<PanelsTopLeft size={16} />}
            label="Canvas"
          />
          <TabButton
            active={mobileTab === "project"}
            onClick={() => setMobileTab("project")}
            icon={<FolderOpen size={16} />}
            label="Project"
          />
        </nav>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors ${
        active ? "text-power" : "text-faint"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
