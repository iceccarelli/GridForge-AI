"use client";

import { useEffect, useState, type ReactNode } from "react";
import { FolderOpen, MessageSquare, PanelsTopLeft } from "lucide-react";
import { Canvas } from "@/components/ai/Canvas";
import { Conversation } from "@/components/ai/Conversation";
import { ProjectPanel } from "@/components/ai/ProjectPanel";
import { getAssistantTurn } from "@/components/ai/chat";
import type { ChatMessage } from "@/components/ai/types";
import { clearWorkspaceSession, loadWorkspaceSession, saveWorkspaceSession } from "@/lib/ai/session";

type MobileTab = "chat" | "canvas" | "project";

/**
 * Three-pane workspace: conversation (left) / engineering canvas (center) /
 * project record (right). Below phone width the panes collapse into
 * tabs instead of a horizontal-scrolling row — see the mobile tab bar at the
 * bottom of this component.
 */
export function WorkspaceClient() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
  const [hydrated, setHydrated] = useState(false);
  // The open project is a bearer token in the URL (?project=...), so a link opens the
  // same record anywhere. localStorage only remembers the last one for convenience.
  const [projectToken, setProjectTokenState] = useState<string | null>(null);

  function setProjectToken(token: string | null) {
    setProjectTokenState(token);
    try {
      const url = new URL(window.location.href);
      if (token) url.searchParams.set("project", token);
      else url.searchParams.delete("project");
      window.history.replaceState(null, "", url.toString());
      if (token) window.localStorage.setItem("gridforge.project", token);
      else window.localStorage.removeItem("gridforge.project");
    } catch {
      /* storage or history unavailable: the in-memory choice still works */
    }
  }

  // Restore a conversation left behind by a reload. Runs after the first
  // render (not in useState's initializer) so the server-rendered markup and
  // the client's first paint always agree — a scoping conversation is
  // client-only state and must never desync hydration.
  useEffect(() => {
    const restored = loadWorkspaceSession(typeof window === "undefined" ? undefined : window.localStorage);
    if (restored.length > 0) setMessages(restored);
    try {
      const fromUrl = new URL(window.location.href).searchParams.get("project");
      setProjectTokenState(fromUrl || window.localStorage.getItem("gridforge.project"));
    } catch {
      /* no URL/storage access: start with no project open */
    }
    setHydrated(true);
  }, []);

  // Persist on every change, once restore has had its turn — otherwise the
  // empty initial state would race the restore and clear a real session.
  useEffect(() => {
    if (!hydrated) return;
    saveWorkspaceSession(typeof window === "undefined" ? undefined : window.localStorage, messages);
  }, [messages, hydrated]);

  function handleReset() {
    setMessages([]);
    clearWorkspaceSession(typeof window === "undefined" ? undefined : window.localStorage);
  }

  async function handleSend(text: string) {
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setLoading(true);
    setMobileTab("canvas");
    try {
      const turn = await getAssistantTurn(next);
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
          <Conversation messages={messages} loading={loading} onSend={handleSend} onReset={handleReset} />
        </div>
        <div className="min-h-0 min-w-0 blueprint">
          <Canvas messages={messages} onQuickAction={handleSend} />
        </div>
        <div className="border-l border-line min-h-0 bg-panel/40">
          <ProjectPanel projectToken={projectToken} onProjectToken={setProjectToken} />
        </div>
      </div>

      {/* Mobile: one pane at a time behind a tab bar */}
      <div className="flex md:hidden flex-1 min-h-0 flex-col">
        <div className="flex-1 min-h-0">
          {mobileTab === "chat" && (
            <div className="h-full bg-panel/40">
              <Conversation messages={messages} loading={loading} onSend={handleSend} onReset={handleReset} />
            </div>
          )}
          {mobileTab === "canvas" && (
            <div className="h-full blueprint">
              <Canvas messages={messages} onQuickAction={handleSend} />
            </div>
          )}
          {mobileTab === "project" && (
            <div className="h-full bg-panel/40">
              <ProjectPanel projectToken={projectToken} onProjectToken={setProjectToken} />
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
