import type { AnswerBlock } from "./types";

export function AnswerCard({ block }: { block: AnswerBlock }) {
  return (
    <div className="rounded-xl border border-line bg-panel/60 px-4 py-3.5">
      <p className="text-[13.5px] text-ghost leading-relaxed whitespace-pre-wrap">{block.text}</p>
    </div>
  );
}
