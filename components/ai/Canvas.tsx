"use client";

import {
  ClipboardList,
  FileSearch,
  GitCompare,
  Upload,
  Zap,
} from "lucide-react";
import { BlockRenderer } from "./BlockRenderer";
import { ToolActivity } from "./ToolActivity";
import type { ChatMessage } from "./types";

const QUICK_ACTIONS: { icon: typeof Zap; label: string; prompt: string }[] = [
  { icon: Zap, label: "Scope site", prompt: "I want to scope a new site — where do I start?" },
  { icon: FileSearch, label: "Analyze hall", prompt: "How many racks does our hall carry today?" },
  { icon: GitCompare, label: "Compare scenarios", prompt: "Compare two architecture scenarios for this hall." },
  { icon: Upload, label: "Upload info", prompt: "I have site data to give you — busway, tap-off, temperatures." },
  { icon: ClipboardList, label: "Review constraint", prompt: "What binds first — electrical or thermal?" },
];

export function Canvas({
  messages,
  onQuickAction,
}: {
  messages: ChatMessage[];
  onQuickAction: (prompt: string) => void;
}) {
  const turns = messages.filter((m) => m.role === "assistant" && m.turn);

  if (turns.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-6 py-10 text-center">
        <div className="eyebrow mb-3">GRIDFORGE ENGINEERING CANVAS</div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-ghost max-w-xl">
          What are you trying to power?
        </h1>
        <p className="text-sm text-mute mt-3 max-w-md leading-relaxed">
          Describe an existing or proposed AI hall. Every number that shows up here comes from a
          real GridForge engine call — never invented — and carries its evidence class.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mt-8 w-full max-w-lg">
          {QUICK_ACTIONS.map(({ icon: Icon, label, prompt }) => (
            <button
              key={label}
              onClick={() => onQuickAction(prompt)}
              className="flex flex-col items-center gap-2 rounded-xl border border-line bg-panel px-3 py-4 hover:border-power/40 transition-colors"
            >
              <Icon size={18} className="text-power" />
              <span className="text-[12px] text-ghost font-medium">{label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-6 py-5 space-y-6">
      {turns.map((m, i) => (
        <div key={i} className="space-y-3">
          {i > 0 && <div className="border-t border-line pt-3" />}
          {m.turn!.toolCalls.length > 0 && <ToolActivity calls={m.turn!.toolCalls} />}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
            {m.turn!.blocks.map((block, j) => (
              <div key={j} className={block.type === "answer" ? "lg:col-span-2" : undefined}>
                <BlockRenderer block={block} onPrompt={onQuickAction} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
