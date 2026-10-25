// One frame of the presenter journey, as a pure function of (file, steps, frame). No hooks, no clock, no fetch: the same
// inputs always render the same markup, which is what lets the broadcast tool capture frame-exact video. It carries no link
// of any kind.
import { buildSceneModel } from "@/lib/observatory/scene-model";
import { totalDuration } from "@/lib/observatory/journey";
import type { JourneyFrame, JourneyStep, ObservatoryScenario, ScenarioFile } from "@/lib/observatory/types";
import { Stage2D } from "@/components/observatory/Stage2D";
import { EvidenceChip } from "@/components/observatory/EvidenceChip";
import { rankConstraints } from "@/components/observatory/ConstraintsPanel";
import { constraintName } from "@/components/observatory/OutcomesPanel";
import { bindingTag, nodeVisuals } from "@/components/observatory/scene-visuals";
import { fmtNumber, fmtPct, viewCapex, viewTimeToCapacity } from "@/components/observatory/format";

const noop = () => {};

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function PathList({ scenario, outcomeId, focus }: { scenario: ObservatoryScenario; outcomeId: string; focus: string | null }) {
  const model = buildSceneModel(scenario, outcomeId);
  return (
    <ol className="space-y-1.5" aria-label="Power path, stage by stage">
      {nodeVisuals(model).map((v) => {
        const tag = bindingTag(v);
        return (
          <li
            key={v.id}
            data-focus={focus === v.id ? "1" : undefined}
            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-1.5 text-sm ${focus === v.id ? "border-power bg-power/10" : "border-line bg-panel"}`}
          >
            <span className="min-w-0 truncate text-ghost">{v.title}</span>
            <span className="flex shrink-0 items-center gap-2">
              {v.utilFound === null && v.utilAfter === null ? (
                <span className="text-mute">not comparable</span>
              ) : (
                <span className="data text-ghost">
                  {fmtPct(v.utilFound)} {"→"} {fmtPct(v.utilAfter)}
                </span>
              )}
              {v.utilEvidence ? <EvidenceChip cls={v.utilEvidence} compact /> : null}
              {tag ? <span className="rounded-full border border-queue px-2 py-px font-mono text-[10px] font-bold uppercase text-queue">{tag}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ConstraintList({ scenario, outcomeId, focus }: { scenario: ObservatoryScenario; outcomeId: string; focus: string | null }) {
  const model = buildSceneModel(scenario, outcomeId);
  const after = scenario.outcomes.find((o) => o.id === model.outcomeId)?.bindingAfterPlan ?? null;
  const ranked = rankConstraints(scenario.constraints).slice(0, 7);
  const max = ranked.reduce((m, c) => (c.racksAllowed !== null && c.racksAllowed > m ? c.racksAllowed : m), 0);
  return (
    <ol className="space-y-1.5" aria-label="Constraints ranked by the racks each allows">
      {ranked.map((c) => (
        <li key={c.key} data-focus={focus === c.key ? "1" : undefined} className={`rounded-lg border px-3 py-1.5 text-sm ${c.binds ? "border-queue bg-queue/10" : focus === c.key ? "border-power bg-power/10" : "border-line bg-panel"}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-ghost">
              {c.rank === null ? "–" : c.rank}. {c.name}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="data text-ghost">{c.racksAllowed === null ? "no figure given" : `${fmtNumber(c.racksAllowed)} racks`}</span>
              <EvidenceChip cls={c.evidence} compact />
            </span>
          </div>
          {c.racksAllowed !== null ? (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink" aria-hidden="true">
              <div className="h-full rounded-full bg-chart" style={{ width: `${max > 0 ? Math.round((c.racksAllowed / max) * 100) : 0}%` }} />
            </div>
          ) : null}
          {c.binds ? <div className="mt-0.5 font-mono text-[10px] uppercase text-queue">binds as found</div> : after === c.key ? <div className="mt-0.5 font-mono text-[10px] uppercase text-power">binds after the plan</div> : null}
        </li>
      ))}
    </ol>
  );
}

function OutcomeList({ scenario, outcomeId }: { scenario: ObservatoryScenario; outcomeId: string }) {
  return (
    <ul className="space-y-2" aria-label="Alternatives the engine compared">
      {scenario.outcomes.map((o) => {
        const t = viewTimeToCapacity(o);
        const cx = viewCapex(o);
        const sel = o.id === outcomeId;
        return (
          <li key={o.id} data-selected={sel ? "1" : undefined} className={`rounded-lg border px-3 py-2 text-sm ${sel ? "border-power bg-power/10" : "border-line bg-panel"}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold text-ghost">{o.name}</span>
              <EvidenceChip cls={o.evidence} compact />
            </div>
            <div className="mt-0.5 data text-ghost">
              {fmtNumber(o.racksAsFound)} {"→"} {fmtNumber(o.racksAfterPlan)} racks
              <span className="text-mute"> · binds after: {constraintName(o.bindingAfterPlan, scenario.constraints)}</span>
            </div>
            <div className="mt-0.5 text-xs text-mute">
              Time: {t.text}
              {t.note ? ` (${t.note})` : ""} · Capital: {cx.text}
              {cx.note ? ` (${cx.note})` : ""}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// No figure here can age: this panel says what KIND of value each context source is. The live values stay on /observatory,
// where each carries the time it was retrieved.
function ContextKinds() {
  const rows: [string, string][] = [
    ["Day-ahead price", "A published auction result for an hour in the reference market. Not a live reading."],
    ["Grid generation mix", "An observation with its own retrieval time. Its age is shown beside it on the Observatory page, not here."],
    ["Interconnection queue", "Current only as of each report's own date."],
  ];
  return (
    <div className="space-y-2" aria-label="What kind of value each context source is">
      {rows.map(([k, v]) => (
        <div key={k} className="rounded-lg border border-line bg-panel px-3 py-2 text-sm">
          <div className="font-semibold text-ghost">{k}</div>
          <div className="text-mute">{v}</div>
        </div>
      ))}
      <p className="text-xs text-mute">None of this is where the invented halls are.</p>
    </div>
  );
}

const PANEL_TITLE: Record<JourneyStep["panel"], string> = {
  path: "Power path",
  constraints: "Constraints, ranked",
  outcomes: "Alternatives compared",
  context: "Market and grid context",
};

export function PresenterFrame({ file, steps, frame, captions = true }: { file: ScenarioFile; steps: JourneyStep[]; frame: JourneyFrame; captions?: boolean }) {
  const step = frame.step;
  const scenario = file.scenarios.find((s) => s.id === step.scenarioId) ?? file.scenarios[0];
  const model = buildSceneModel(scenario, step.outcomeId || undefined);
  const total = totalDuration(steps);
  const nodeFocus = scenario.powerPath.some((n) => n.id === step.focus) ? step.focus : null;
  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col overflow-hidden bg-ink text-ghost"
      data-presenter="frame"
      data-step={step.id}
      data-panel={step.panel}
      data-t={frame.t.toFixed(3)}
    >
      <header className="flex items-center justify-between gap-4 border-b border-line px-8 py-3">
        <div>
          <p className="eyebrow">GridForge Observatory</p>
          <h1 className="text-xl font-semibold">{scenario.title}</h1>
        </div>
        <div className="text-right">
          <p className="rounded-full border border-queue/60 px-3 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-queue">Synthetic demonstration · invented halls</p>
          <p className="mt-1 data text-sm text-mute">
            {clock(frame.t)} / {clock(total)}
          </p>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-6 px-8 py-4">
        <div className="min-h-0 overflow-hidden rounded-2xl border border-line bg-panel p-3" aria-label="Power path diagram">
          <Stage2D model={model} selectedId={nodeFocus} onSelect={noop} />
        </div>
        <section className="min-h-0 overflow-hidden" aria-label={PANEL_TITLE[step.panel]}>
          <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wider text-mute">{PANEL_TITLE[step.panel]}</h2>
          {step.panel === "path" ? <PathList scenario={scenario} outcomeId={model.outcomeId} focus={nodeFocus} /> : null}
          {step.panel === "constraints" ? <ConstraintList scenario={scenario} outcomeId={model.outcomeId} focus={step.focus} /> : null}
          {step.panel === "outcomes" ? <OutcomeList scenario={scenario} outcomeId={model.outcomeId} /> : null}
          {step.panel === "context" ? <ContextKinds /> : null}
        </section>
      </div>

      <footer className="border-t border-line px-8 pb-4 pt-3">
        <p className="mb-2 text-xs text-mute">{model.basisBanner}</p>
        {captions ? (
          <p className="min-h-[3.25rem] rounded-xl bg-panel px-5 py-3 text-lg leading-snug text-ghost" data-presenter="caption">
            {step.caption}
          </p>
        ) : null}
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
          <div className="h-full bg-power" style={{ width: `${total > 0 ? ((frame.t / total) * 100).toFixed(3) : 0}%` }} />
        </div>
      </footer>
    </div>
  );
}
