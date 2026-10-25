"use client";

// The interactive part of /observatory. One scenario and one outcome select ONE SceneModel (buildSceneModel); the stage, the
// stage table, the detail card and the text alternative all draw from it, so they cannot disagree. The market/grid panel and
// the call to action arrive as server-rendered slots, so their code is not part of this bundle.
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import type { ScenarioFile, SceneModel, ObservatoryScenario } from "@/lib/observatory/types";
import { buildSceneModel } from "@/lib/observatory/scene-model";
import { BasisTag, EvidenceChip } from "@/components/observatory/EvidenceChip";
import { EVIDENCE_CLASSES, EVIDENCE_LEGEND } from "@/components/observatory/evidence";
import { Stage } from "@/components/observatory/Stage";
import { NodeDetail, NodeTable, RackTable } from "@/components/observatory/PathPanel";
import { ConstraintsPanel } from "@/components/observatory/ConstraintsPanel";
import { OutcomesPanel, constraintName } from "@/components/observatory/OutcomesPanel";
import { fmtNumber, fmtUtc } from "@/components/observatory/format";

function safeBuild(scenario: ObservatoryScenario, outcomeId: string): SceneModel | null {
  try {
    return buildSceneModel(scenario, outcomeId);
  } catch {
    return null;
  }
}

function SectionHead({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="mb-4 max-w-3xl">
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id} className="mt-1 text-2xl font-semibold text-ghost sm:text-3xl">
        {title}
      </h2>
      {children ? <div className="mt-2 text-sm text-mute">{children}</div> : null}
    </header>
  );
}

function Legend() {
  return (
    <details className="rounded-xl border border-line bg-panel p-4">
      <summary className="cursor-pointer text-sm font-semibold text-ghost">Evidence classes E0 to E7: what each means</summary>
      <ul className="mt-3 space-y-2 text-sm">
        {EVIDENCE_CLASSES.map((c) => (
          <li key={c} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0">
              <EvidenceChip cls={c} compact />
            </span>
            <span className="text-mute">
              <span className="text-ghost">{EVIDENCE_LEGEND[c].name}.</span> {EVIDENCE_LEGEND[c].meaning}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-mute">A computed figure is never stronger than the weakest input behind it. Nothing on this page is measured at a site.</p>
    </details>
  );
}

export function ObservatoryExplorer({ file, contextSlot, ctaSlot }: { file: ScenarioFile; contextSlot: ReactNode; ctaSlot: ReactNode }) {
  const uid = useId();
  const descId = `${uid}-scene-text`;
  const first = file.scenarios[0];
  const [scenarioId, setScenarioId] = useState(first.id);
  const scenario = file.scenarios.find((s) => s.id === scenarioId) ?? first;
  const headline = scenario.outcomes.some((o) => o.id === scenario.headlineOutcome) ? scenario.headlineOutcome : scenario.outcomes[0]?.id;
  const [outcomeId, setOutcomeId] = useState(headline);
  const outcome = scenario.outcomes.find((o) => o.id === outcomeId) ?? scenario.outcomes.find((o) => o.id === headline) ?? scenario.outcomes[0];
  const [focusId, setFocusId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const model = useMemo(() => (outcome ? safeBuild(scenario, outcome.id) : null), [scenario, outcome]);
  const defaultDetail = model ? (model.bindingAfterPlan ?? model.bindingAsFound ?? model.nodes[0]?.id ?? null) : null;
  const activeDetail = model && detailId && model.nodes.some((n) => n.id === detailId) ? detailId : defaultDetail;
  const activeFocus = model && focusId && model.nodes.some((n) => n.id === focusId) ? focusId : null;

  const announce = useCallback((s: ObservatoryScenario, o: { name: string; racksAfterPlan: number; evidence: string }) => {
    setAnnouncement(`Showing ${s.title}, alternative ${o.name}: ${fmtNumber(o.racksAfterPlan)} racks after the plan, evidence class ${o.evidence}.`);
  }, []);

  const pickScenario = (id: string) => {
    const s = file.scenarios.find((x) => x.id === id);
    if (!s) return;
    const h = s.outcomes.some((o) => o.id === s.headlineOutcome) ? s.headlineOutcome : s.outcomes[0]?.id;
    setScenarioId(id);
    setOutcomeId(h);
    setFocusId(null);
    setDetailId(null);
    const o = s.outcomes.find((x) => x.id === h);
    if (o) announce(s, o);
  };
  const pickOutcome = (id: string) => {
    setOutcomeId(id);
    const o = scenario.outcomes.find((x) => x.id === id);
    if (o) announce(scenario, o);
  };
  const onSelect = (id: string | null) => {
    setFocusId(id);
    if (id) setDetailId(id);
  };

  const hall = scenario.hall;
  const banner = model?.basisBanner ?? "Synthetic demonstration hall. Engine-modelled, not measured. The calibration ledger is empty.";

  return (
    <div className="relative">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div
        role="note"
        data-basis-banner
        className="z-30 mb-5 rounded-lg border border-queue/60 bg-ink/95 px-4 py-2.5 text-xs leading-relaxed text-ghost backdrop-blur md:sticky md:top-[88px]"
      >
        <span className="mr-2 font-mono font-bold uppercase tracking-wider text-queue">Basis</span>
        {banner}
      </div>

      <div role="group" aria-label="Approved synthetic halls" className="mb-6 flex flex-wrap gap-2">
        {file.scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={s.id === scenario.id}
            onClick={() => pickScenario(s.id)}
            className={`rounded-xl border px-4 py-2 text-left transition-colors ${
              s.id === scenario.id ? "border-power bg-power/10" : "border-line bg-panel hover:border-power/60"
            }`}
          >
            <span className={`block text-sm font-semibold ${s.id === scenario.id ? "text-power" : "text-ghost"}`}>{s.title}</span>
            {s.hall.name !== s.title ? <span className="block text-xs text-mute">{s.hall.name}</span> : null}
          </button>
        ))}
      </div>

      <p className="mb-8 max-w-3xl text-sm text-mute">{scenario.summary}</p>

      {!model || !outcome ? (
        <div role="alert" className="rounded-xl border border-flag/50 bg-flag/5 p-5 text-sm text-ghost" data-observatory="scenario-unavailable">
          <p className="font-semibold">This scenario cannot be shown.</p>
          <p className="mt-1 text-mute">The scene could not be built from its data, so no figures from it are displayed. Choose another hall, or run the free qualifier on yours.</p>
        </div>
      ) : (
        <>
          <section id="path" aria-labelledby="path-h" className="scroll-mt-28">
            <SectionHead id="path-h" eyebrow="Power path" title="From the grid connection to the rack">
              Each stage shows what it can carry and what it is asked to carry, as found and after the plan. The stage that limits the hall is marked in words as well as colour.
            </SectionHead>

            <div className="mb-3 flex flex-wrap items-center gap-3">
              <label className="flex flex-wrap items-center gap-2 text-sm text-mute">
                Alternative shown
                <select
                  value={outcome.id}
                  onChange={(e) => pickOutcome(e.target.value)}
                  className="field rounded-lg px-3 py-1.5 text-sm text-ghost"
                >
                  {scenario.outcomes.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0">
                <Stage model={model} selectedId={activeDetail} focusId={activeFocus} onSelect={onSelect} descriptionId={descId} />
                <details className="mt-3 rounded-lg border border-line bg-panel p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-ghost">Text description of this scene</summary>
                  <p id={descId} className="mt-2 text-sm leading-relaxed text-mute">
                    {model.textAlternative}
                  </p>
                </details>
              </div>
              <div className="min-w-0 space-y-4">
                <NodeDetail model={model} nodeId={activeDetail} constraints={scenario.constraints} />
                <div className="rounded-xl border border-line bg-panel p-4">
                  <h3 className="text-sm font-semibold text-ghost">The invented hall</h3>
                  <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-mute">Name</dt>
                    <dd className="text-ghost">{hall.name}</dd>
                    <dt className="text-mute">Platform</dt>
                    <dd className="text-ghost">{hall.platform}</dd>
                    <dt className="text-mute">Contracted</dt>
                    <dd><span className="data text-ghost">{fmtNumber(hall.contractedMW)} MW</span> <BasisTag>synthetic input</BasisTag></dd>
                    <dt className="text-mute">IT load now</dt>
                    <dd><span className="data text-ghost">{fmtNumber(hall.currentItLoadMW)} MW</span> <BasisTag>synthetic input</BasisTag></dd>
                    <dt className="text-mute">Free positions</dt>
                    <dd><span className="data text-ghost">{fmtNumber(hall.positionsAvailable)}</span> <BasisTag>synthetic input</BasisTag></dd>
                    <dt className="text-mute">Pretend location</dt>
                    <dd className="text-ghost">{hall.region}</dd>
                  </dl>
                  <p className="mt-2 text-xs text-mute">The location is for the story only. It does not choose the market and grid data below.</p>
                </div>
                <Legend />
              </div>
            </div>

            <div className="mt-6">
              <NodeTable model={model} selectedId={activeDetail} onSelect={(id) => onSelect(id)} />
            </div>
            <div className="mt-8">
              <RackTable model={model} />
            </div>
          </section>

          <section id="constraints" aria-labelledby="constraints-h" className="mt-16 scroll-mt-28">
            <SectionHead id="constraints-h" eyebrow="Rack and density constraints" title="What limits the number of racks">
              Every constraint answers one question: how many racks could this hall carry if only this limit applied? The lowest answer binds.
            </SectionHead>
            <ConstraintsPanel constraints={scenario.constraints} bindingAfterPlanKey={outcome.bindingAfterPlan} />
          </section>

          <section id="outcomes" aria-labelledby="outcomes-h" className="mt-16 scroll-mt-28">
            <SectionHead id="outcomes-h" eyebrow="Scenario outcomes" title="What each way of relieving it does">
              Time is a programme length, never a date, unless every lead time was supplied. Cost is shown only where it is priced, with the missing parts named.
            </SectionHead>
            <OutcomesPanel outcomes={scenario.outcomes} constraints={scenario.constraints} selectedId={outcome.id} onSelect={pickOutcome} />
            <p className="mt-3 text-sm text-mute">
              Binding stage after the plan for the alternative shown: <span className="text-ghost">{constraintName(outcome.bindingAfterPlan, scenario.constraints)}</span>.
            </p>
          </section>
        </>
      )}

      <section id="context" aria-labelledby="context-h" className="mt-16 scroll-mt-28">
        <SectionHead id="context-h" eyebrow="Market and grid conditions" title="The grid a real hall would sit on">
          These are published figures for a reference region, each with where it came from, what it describes and how old it is.
        </SectionHead>
        {contextSlot}
      </section>

      <section id="limitations" aria-labelledby="limitations-h" className="mt-16 scroll-mt-28">
        <SectionHead id="limitations-h" eyebrow="Limits of this page" title="What this page does not show" />
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-mute marker:text-faint">
          <li data-calibration>{file.calibration.statement}</li>
          {scenario.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
          <li>Every hall shown is invented for demonstration. No customer data is used.</li>
        </ul>
        <p className="mt-4 text-xs text-mute">
          Engine {file.engine.version} (code digest <span className="data">{file.engine.codeSha256.slice(0, 12)}</span>). Scenario data generated {fmtUtc(file.generatedAt)}; it is
          computed at build time and changes only when the engine does.
        </p>
      </section>

      <div className="mt-16">{ctaSlot}</div>
    </div>
  );
}
