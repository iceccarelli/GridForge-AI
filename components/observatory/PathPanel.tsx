"use client";

import type { ConstraintResult, SceneModel } from "@/lib/observatory/types";
import { BasisTag, EvidenceChip } from "@/components/observatory/EvidenceChip";
import { Fig } from "@/components/observatory/Fig";
import { Cell, DataTable, Row, RowHead } from "@/components/observatory/Table";
import { fmtNumber, fmtPct } from "@/components/observatory/format";
import { AFTER_PLAN_NOTE, KIND_LABEL, bindingTag, nodeVisuals, type NodeVisual } from "@/components/observatory/scene-visuals";

export function BindingTag({ v }: { v: Pick<NodeVisual, "bindsFound" | "bindsAfter"> }) {
  const t = bindingTag(v);
  if (!t) return null;
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-px font-mono text-[10px] font-bold uppercase tracking-wide ${
        v.bindsFound ? "border-queue bg-queue/15 text-queue" : "border-power bg-power/10 text-power"
      }`}
    >
      {t}
    </span>
  );
}

/** Utilisation AS FOUND only: load as found over capacity as found. There is no after-plan ratio (see AFTER_PLAN_NOTE). */
function Util({ v }: { v: NodeVisual }) {
  if (v.utilFound === null) {
    return <span className="text-mute">not comparable (a value is missing or the units differ)</span>;
  }
  return (
    <span>
      <span className="data text-ghost">{fmtPct(v.utilFound)}</span> {v.utilEvidence ? <EvidenceChip cls={v.utilEvidence} compact /> : null}
      {v.overFound ? <span className="ml-1 font-mono text-[10px] font-bold uppercase text-flag">over capacity as found</span> : null}
      <span className="block text-xs text-mute">derived: load as found divided by capacity as found, weakest input class</span>
    </span>
  );
}

export function NodeTable({ model, selectedId, onSelect }: { model: SceneModel; selectedId: string | null; onSelect: (id: string) => void }) {
  const visuals = nodeVisuals(model);
  return (
    <DataTable
      caption={`Power path, stage by stage: what each stage can carry as found, the load it is asked to carry as found and after the plan. Utilisation is shown as found only: ${AFTER_PLAN_NOTE}, so no after-plan ratio is drawn.`}
      head={["Stage", "Capacity as found", "Load as found", "Load after the plan (capacity after the plan not stated)", "Utilisation as found", "Binding"]}
    >
      {visuals.map((v) => (
        <Row key={v.id} emphasis={v.bindsFound}>
          <RowHead label="Stage">
            <button
              type="button"
              onClick={() => onSelect(v.id)}
              aria-pressed={selectedId === v.id}
              className="rounded text-left text-ghost underline decoration-line underline-offset-4 hover:decoration-power aria-pressed:decoration-power"
            >
              {v.title}
            </button>
            <span className="block font-mono text-[10px] uppercase tracking-wider text-mute">{KIND_LABEL[v.kind]}</span>
            {v.detail ? <span className="mt-0.5 block text-xs font-normal text-mute">{v.detail}</span> : null}
          </RowHead>
          <Cell label="Capacity as found">
            <Fig q={model.nodes[v.index].capacity} compactChip />
          </Cell>
          <Cell label="Load as found">
            <Fig q={model.nodes[v.index].loadAsFound} compactChip />
          </Cell>
          <Cell label="Load after the plan">
            <Fig q={model.nodes[v.index].loadAfterPlan} compactChip />
          </Cell>
          <Cell label="Utilisation as found">
            <Util v={v} />
          </Cell>
          <Cell label="Binding">{bindingTag(v) ? <BindingTag v={v} /> : <span className="text-mute">no</span>}</Cell>
        </Row>
      ))}
    </DataTable>
  );
}

export function RackTable({ model }: { model: SceneModel }) {
  const rows = model.rackRows;
  if (rows.length === 0) return null;
  return (
    <DataTable
      caption="Rack rows. The existing racks and their densities are inputs to the engine; the new-platform row is the engine's own output and a platform library figure. None is a measurement."
      head={["Rack row", "Racks", "kW per rack as found", "kW per rack after the plan"]}
    >
      {rows.map((r) => {
        // A row with no density as found has no racks as found: its racks are what the plan adds, which is an engine output.
        const addedByPlan = r.kwPerRackAsFound === null;
        return (
          <Row key={r.id}>
            <RowHead label="Rack row">{r.label}</RowHead>
            <Cell label="Racks">
              <span className="data text-ghost">{fmtNumber(r.racks)}</span> <BasisTag>{addedByPlan ? "engine output: deployable after the plan" : "synthetic input"}</BasisTag>
            </Cell>
            <Cell label="kW per rack as found">
              {r.kwPerRackAsFound === null ? (
                <span className="text-mute">none: no racks of this row deploy as found</span>
              ) : (
                <>
                  <span className="data text-ghost">{fmtNumber(r.kwPerRackAsFound)} kW</span> <BasisTag>synthetic input, not measured</BasisTag>
                </>
              )}
            </Cell>
            <Cell label="kW per rack after the plan">
              {r.kwPerRackAfterPlan === null ? (
                <span className="text-mute">none: no racks of this row deploy after the plan</span>
              ) : (
                <>
                  <span className="data text-ghost">{fmtNumber(r.kwPerRackAfterPlan)} kW</span>{" "}
                  <BasisTag>{addedByPlan ? "platform library figure" : "synthetic input, not measured"}</BasisTag>
                </>
              )}
            </Cell>
          </Row>
        );
      })}
    </DataTable>
  );
}

export function NodeDetail({ model, nodeId, constraints }: { model: SceneModel; nodeId: string | null; constraints: ConstraintResult[] }) {
  const visuals = nodeVisuals(model);
  const v = visuals.find((x) => x.id === nodeId) ?? null;
  if (!v) return null;
  const node = model.nodes[v.index];
  const c = node.constraintKey ? constraints.find((x) => x.key === node.constraintKey) : null;
  return (
    <div className="rounded-xl border border-line bg-panel p-4" aria-labelledby="node-detail-h" role="group">
      <p className="eyebrow">{KIND_LABEL[v.kind]}</p>
      <h3 id="node-detail-h" className="mt-1 text-lg font-semibold text-ghost">
        {v.title}
      </h3>
      {v.detail ? <p className="mt-0.5 text-sm text-mute">{v.detail}</p> : null}
      <div className="mt-2">
        <BindingTag v={v} />
      </div>
      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="text-xs text-mute">Capacity as found</dt>
          <dd><Fig q={node.capacity} /></dd>
        </div>
        <div>
          <dt className="text-xs text-mute">Load as found</dt>
          <dd><Fig q={node.loadAsFound} /></dd>
        </div>
        <div>
          <dt className="text-xs text-mute">Load after the plan ({AFTER_PLAN_NOTE})</dt>
          <dd><Fig q={node.loadAfterPlan} /></dd>
        </div>
        <div>
          <dt className="text-xs text-mute">Utilisation as found</dt>
          <dd><Util v={v} /></dd>
        </div>
        <div>
          <dt className="text-xs text-mute">Engine constraint behind this stage</dt>
          <dd className="text-mute">
            {node.constraintKey === null ? (
              "The engine does not model this stage as a constraint."
            ) : c ? (
              <>
                <span className="text-ghost">{c.name}</span>:{" "}
                {c.passes || c.racksAllowed === null ? (
                  <span className="text-ghost">does not limit the hall (passes)</span>
                ) : (
                  <span className="data text-ghost">{fmtNumber(c.racksAllowed)} racks allowed</span>
                )}{" "}
                <EvidenceChip cls={c.evidence} />
              </>
            ) : (
              <span className="data">{node.constraintKey}</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}
