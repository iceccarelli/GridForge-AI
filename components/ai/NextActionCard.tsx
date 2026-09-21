import { ArrowUpRight, CornerDownRight } from "lucide-react";
import type { NextActionBlock } from "./types";

export function NextActionCard({
  block,
  onPrompt,
}: {
  block: NextActionBlock;
  onPrompt?: (prompt: string) => void;
}) {
  const content = (
    <>
      <div className="flex items-center gap-2">
        {block.href ? (
          <ArrowUpRight size={14} className="text-power shrink-0" />
        ) : (
          <CornerDownRight size={14} className="text-power shrink-0" />
        )}
        <span className="text-[13px] font-medium text-ghost">{block.label}</span>
      </div>
      {block.description && (
        <p className="text-[12px] text-faint mt-1 leading-relaxed">{block.description}</p>
      )}
    </>
  );

  if (block.href) {
    return (
      <a
        href={block.href}
        className="block rounded-lg border border-line bg-ink/40 px-3.5 py-3 hover:border-power/40 transition-colors"
      >
        {content}
      </a>
    );
  }

  return (
    <button
      onClick={() => block.prompt && onPrompt?.(block.prompt)}
      className="block w-full text-left rounded-lg border border-line bg-ink/40 px-3.5 py-3 hover:border-power/40 transition-colors"
    >
      {content}
    </button>
  );
}
