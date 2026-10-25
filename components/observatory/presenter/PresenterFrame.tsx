// One frame of the presenter journey, as a pure function of (file, steps, frame). No hooks, no clock, no fetch: the same
// inputs always render the same markup, which is what lets the broadcast tool capture frame-exact video. It carries no link
// of any kind.
//
// Layout contract (checked in a real browser at 1280x720 and 1920x1080 for every step): nothing clips, the caption has a fixed
// height for up to three lines (no layout shift between steps), body text is at least 14px and chips at least 11px. The panel on
// the right shows the thing the step is about IN FULL (the selected stage, the ranked constraints, the selected alternative) and
// everything else as one compact line.
import { shownConstraintName } from "@/lib/observatory/journey";
import { buildSceneModel } from "@/lib/observatory/scene-model";
import { totalDuration } from "@/lib/observatory/journey";
import type { JourneyFrame, JourneyStep, ObservatoryScenario, ScenarioFile } from "@/lib/observatory/types";
import { Stage2DPresenter } from "@/components/observatory/Stage2D";
import { EvidenceChip } from "@/components/observatory/EvidenceChip";
import { Fig } from "@/components/observatory/Fig";
import { limits, rankConstraints } from "@/components/observatory/ConstraintsPanel";
import { constraintName } from "@/components/observatory/OutcomesPanel";
import { AFTER_PLAN_NOTE, KIND_LABEL, bindingTag, nodeVisuals, splitLabel } from "@/components/observatory/scene-visuals";
import { fmtNumber, fmtPct, viewCapex, viewTimeToCapacity } from "@/components/observatory/format";

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The first sentence of an engine note, so a long explanation is shortened at a sentence end, never cut mid-word. The rest is on /observatory. */
export function firstSentence(s: string): string {
  const m = /^.*?[.!?](?=\s|$)/.exec(s.trim());
  return m ? m[0] : s.trim();
}

const TAG ="inline-block rounded-full border px-2 py-px font-mono text-[11px] font-bold uppercase leading-4 tracking-wide";

/** The stage the step is about, in full; the binding stages named in words. */
function PathFocus({ scenario, outcomeId, focus }: { scenario: ObservatoryScenario; outcomeId: string; focus: string | null }) {
  const model = buildSceneModel(scenario, outcomeId);
  const visuals = nodeVisuals(model);
  const shown = visuals.find((v) => v.id === focus) ?? visuals.find((v) => v.id === model.bindingAfterPlan) ?? visuals.find((v) => v.id === model.bindingAsFound) ?? visuals[0];
  const title = (id: string | null) => visuals.find((v) => v.id === id)?.title ?? null;
  if (!shown) return null;
  const node = model.nodes[shown.index];
  const tag = bindingTag(shown);
  const asFound = title(model.bindingAsFound);
  const afterPlan = title(model.bindingAfterPlan);
  return (
    <div className="space-y-3 text-sm" data-focus="1">
      <div className="rounded-xl border border-power bg-power/10 px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wider text-mute">{KIND_LABEL[shown.kind]}</p>
        <p className="text-lg font-semibold leading-snug text-ghost">{shown.title}</p>
        {tag ? <p className="mt-1"><span className={`${TAG} ${shown.bindsFound ? "border-queue text-queue" : "border-power text-power"}`}>{tag}</span></p> : null}
        <dl className="mt-2 space-y-1.5">
          <div>
            <dt className="text-mute">Capacity as found</dt>
            <dd><Fig q={node.capacity} large /></dd>
          </div>
          <div>
            <dt className="text-mute">Load as found</dt>
            <dd><Fig q={node.loadAsFound} large /></dd>
          </div>
          <div>
            <dt className="text-mute">Load after the plan</dt>
            <dd><Fig q={node.loadAfterPlan} large /></dd>
            <dd className="text-mute">The engine does not state this stage&apos;s capacity after the plan.</dd>
          </div>
          <div>
            <dt className="text-mute">Utilisation as found</dt>
            <dd className="data text-ghost">
              {fmtPct(shown.utilFound)} {shown.utilEvidence ? <EvidenceChip cls={shown.utilEvidence} compact large /> : null}
              {shown.overFound ? <span className="ml-1 font-mono text-[11px] font-bold uppercase text-flag">over capacity as found</span> : null}
            </dd>
          </div>
        </dl>
      </div>
      <p className="text-mute">
        Binds as found: <span className="text-ghost">{asFound ?? "nothing identified"}</span>. Binds after the plan: <span className="text-ghost">{afterPlan ?? "nothing identified"}</span>.
      </p>
    </div>
  );
}

function ConstraintList({ scenario, outcomeId, focus }: { scenario: ObservatoryScenario; outcomeId: string; focus: string | null }) {
  const model = buildSceneModel(scenario, outcomeId);
  const after = scenario.outcomes.find((o) => o.id === model.outcomeId)?.bindingAfterPlan ?? null;
  const ranked = rankConstraints(scenario.constraints).slice(0, 6);
  const max = ranked.reduce((m, c) => (limits(c) && (c.racksAllowed as number) > m ? (c.racksAllowed as number) : m), 0);
  return (
    <ol className="space-y-1.5" aria-label="Constraints ranked by the racks each allows">
      {ranked.map((c) => (
        <li
          key={c.key}
          data-focus={focus === c.key ? "1" : undefined}
          className={`rounded-lg border px-3 py-1.5 text-sm ${c.binds ? "border-queue bg-queue/10" : focus === c.key ? "border-power bg-power/10" : "border-line bg-panel"}`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 text-ghost">
              {c.rank === null ? "" : `${c.rank}. `}
              {shownConstraintName(c.name)}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="data text-ghost">{limits(c) ? `${fmtNumber(c.racksAllowed as number)} racks` : "passes"}</span>
              <EvidenceChip cls={c.evidence} compact large />
            </span>
          </div>
          {limits(c) ? (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink" aria-hidden="true">
              <div className="h-full rounded-full bg-chart" style={{ width: `${max > 0 ? Math.round(((c.racksAllowed as number) / max) * 100) : 0}%` }} />
            </div>
          ) : (
            <div className="text-mute">does not limit the hall</div>
          )}
          {c.binds ? <div className="font-mono text-[11px] font-bold uppercase text-queue">binds as found</div> : after === c.key ? <div className="font-mono text-[11px] font-bold uppercase text-power">binds after the plan</div> : null}
        </li>
      ))}
    </ol>
  );
}

/** The selected alternative in full, every other as one compact line, so nothing can clip however many there are. */
function OutcomeList({ scenario, outcomeId }: { scenario: ObservatoryScenario; outcomeId: string }) {
  const selected = scenario.outcomes.find((o) => o.id === outcomeId) ?? scenario.outcomes[0];
  const others = scenario.outcomes.filter((o) => o !== selected);
  if (!selected) return null;
  const t = viewTimeToCapacity(selected);
  const cx = viewCapex(selected);
  return (
    <div className="space-y-2 text-sm" role="group" aria-label="Alternatives the engine compared">
      <div data-selected="1" className="rounded-xl border border-power bg-power/10 px-4 py-1.5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-base font-semibold leading-snug text-ghost">{selected.name}</p>
          <EvidenceChip cls={selected.evidence} compact large />
        </div>
        <p className="mt-1 data text-ghost">
          {fmtNumber(selected.racksAsFound)} {"→"} {fmtNumber(selected.racksAfterPlan)} racks
        </p>
        <p className="text-mute">Binds after the plan: {constraintName(selected.bindingAfterPlan, scenario.constraints, selected)}</p>
        <div className="mt-1.5">
          <p className="text-mute">Time to capacity</p>
          <p className="text-ghost">
            {t.text} {t.evidence ? <EvidenceChip cls={t.evidence} compact large /> : null}
          </p>
          {t.note ? <p className="line-clamp-2 text-mute">{firstSentence(t.note)}</p> : null}
        </div>
        <div className="mt-1.5">
          <p className="text-mute">Capital cost</p>
          <p className="text-ghost">
            <span className={cx.kind === "unpriced" ? "" : "data"}>{cx.text}</span> {cx.qualifier ? <span>{cx.qualifier} </span> : null}
            {cx.evidence ? <EvidenceChip cls={cx.evidence} compact large /> : null}
          </p>
          {cx.pricing ? <p className="text-queue">{cx.pricing}</p> : null}
          {cx.note ? <p className="line-clamp-2 text-mute">{cx.note}</p> : null}
        </div>
      </div>
      {others.length > 0 ? (
        <ul className="space-y-1" aria-label="Other alternatives">
          {others.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-1.5">
              <span className="min-w-0 truncate text-ghost">{o.name}</span>
              <span className="data shrink-0 text-mute">
                {fmtNumber(o.racksAsFound)}→{fmtNumber(o.racksAfterPlan)} racks
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// No figure here can age: this panel says what KIND of value each context source is. The values stay on /observatory, where each
// carries its region and the time it was retrieved.
function ContextKinds() {
  const rows: [string, string][] = [
    ["Day-ahead price (Germany/Luxembourg market)", "A published auction result for an hour. A price set in advance, not a live reading."],
    ["Grid generation mix (Germany)", "A reading with its own retrieval time. Its age is shown beside it on the Observatory page, not here."],
    ["Interconnection queues (US ISOs)", "Current only as of each report's own date."],
  ];
  return (
    <div className="space-y-2" role="group" aria-label="What kind of value each context source is">
      {rows.map(([k, v]) => (
        <div key={k} className="rounded-lg border border-line bg-panel px-3 py-2 text-sm">
          <div className="font-semibold text-ghost">{k}</div>
          <div className="text-mute">{v}</div>
        </div>
      ))}
      <p className="text-sm text-mute">The invented halls have no location, so none of this is theirs.</p>
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
      <header className="flex items-center justify-between gap-4 border-b border-line px-8 py-2">
        <div className="min-w-0">
          <p className="eyebrow">GridForge Observatory</p>
          <h1 className="truncate text-xl font-semibold leading-tight">{scenario.title}</h1>
        </div>
        <div className="shrink-0 text-right">
          <p className="rounded-full border border-queue/60 px-3 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-queue">Synthetic demonstration · invented halls</p>
          <p className="mt-0.5 data text-sm text-mute">
            {clock(frame.t)} / {clock(total)}
          </p>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-5 px-8 py-3">
        <div className="min-h-0 overflow-hidden rounded-2xl border border-line bg-panel p-2">
          <Stage2DPresenter model={model} focusId={nodeFocus} />
        </div>
        <section className="min-h-0 overflow-hidden" aria-label={PANEL_TITLE[step.panel]}>
          <h2 className="mb-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-mute">{PANEL_TITLE[step.panel]}</h2>
          {step.panel === "path" ? <PathFocus scenario={scenario} outcomeId={model.outcomeId} focus={nodeFocus} /> : null}
          {step.panel === "constraints" ? <ConstraintList scenario={scenario} outcomeId={model.outcomeId} focus={step.focus} /> : null}
          {step.panel === "outcomes" ? <OutcomeList scenario={scenario} outcomeId={model.outcomeId} /> : null}
          {step.panel === "context" ? <ContextKinds /> : null}
        </section>
      </div>

      <footer className="border-t border-line px-8 pb-3 pt-2">
        <p className="mb-2 min-h-[1.4rem] text-sm leading-snug text-mute" data-presenter="banner">
          {model.basisBanner}
        </p>
        {captions ? (
          <p className="h-[6rem] overflow-hidden rounded-xl bg-panel px-5 py-2.5 text-lg leading-snug text-ghost" data-presenter="caption">
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
