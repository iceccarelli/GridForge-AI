import { FolderOpen, Info } from "lucide-react";

/**
 * Right-pane project/context stub.
 *
 * Durable project memory (persisted hall context, saved threads, cross-session
 * recall) is Agent 5's job and is on hold per reports/TTP-AI-AGENT-PLAN.md — this
 * is deliberately a static placeholder, not a partial implementation of that
 * feature. It shows what the pane will hold without persisting anything.
 */
export function ProjectPanel() {
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3.5 border-b border-line flex items-center gap-2">
        <FolderOpen size={15} className="text-power shrink-0" />
        <div>
          <div className="text-sm font-semibold text-ghost">Project</div>
          <div className="data text-[10px] text-faint">Untitled hall</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="rounded-lg border border-line bg-ink/40 p-3.5">
          <div className="eyebrow text-[10px] mb-2">SITE</div>
          <p className="text-[12px] text-faint leading-relaxed">
            No site attached yet. Details you give the conversation — hall size, contracted MW,
            platform — will summarize here once you start scoping.
          </p>
        </div>

        <div className="rounded-lg border border-line bg-ink/40 p-3.5">
          <div className="eyebrow text-[10px] mb-2">SAVED THREADS</div>
          <p className="text-[12px] text-faint leading-relaxed">None yet.</p>
        </div>

        <div className="rounded-lg border border-line bg-ink/40 p-3.5">
          <div className="eyebrow text-[10px] mb-2">ENGAGEMENTS</div>
          <p className="text-[12px] text-faint leading-relaxed">
            Density Screens, studies or specs purchased for this project will list here.
          </p>
        </div>

        <div className="rounded-lg border border-queue/30 bg-queue/[0.05] p-3.5 flex gap-2">
          <Info size={13} className="text-queue shrink-0 mt-0.5" />
          <p className="text-[11px] text-mute leading-relaxed">
            This panel is a preview. Project memory that persists across sessions is on the
            roadmap and not wired up yet — nothing here is saved when you leave.
          </p>
        </div>
      </div>
    </div>
  );
}
