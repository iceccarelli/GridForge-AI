"use client";

import type { ConstraintResult, SceneModel } from "@/lib/observatory/types";
import { BasisTag, EvidenceChip } from "@/components/observatory/EvidenceChip";
import { Fig } from "@/components/observatory/Fig";
import { Cell, DataTable, Row, RowHead } from "@/components/observatory/Table";
import { fmtNumber, fmtPct } from "@/components/observatory/format";
import { KIND_LABEL, bindingTag, nodeVisuals, type NodeVisual } from "@/components/observatory/scene-visuals";

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

function Util({ v }: { v: NodeVisual }) {
  if (v.utilFound === null && v.utilAfter === null) {
    return <span className="text-mute">not comparable (a value is missing or the units differ)</span>;
  }
  return (
    <span>
      <span className="data text-ghost">
        {fmtPct(v.utilFound)} {"→"} {fmtPct(v.utilAfter)}
      </span>{" "}
      {v.utilEvidence ? <EvidenceChip cls={v.utilEvidence} compact /> : null}
      <span className="block text-xs text-mute">derived: load divided by capacity, weakest input class</span>
    </span>
  );
}

export function NodeTable({ model, selectedId, onSelect }: { model: SceneModel; selectedId: string | null; onSelect: (id: string) => void }) {
  const visuals = nodeVisuals(model);
  return (
    <DataTable
      caption="Power path, stage by stage: what each stage can carry and what it is asked to carry, as found and after the plan."
      head={["Stage", "Capacity", "Load as found", "Load after the plan", "Utilisation", "Binding"]}
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
          <Cell label="Capacity">
            <Fig q={model.nodes[v.index].capacity} />
          </Cell>
          <Cell label="Load as found">
            <Fig q={model.nodes[v.index].loadAsFound} />
          </Cell>
          <Cell label="Load after the plan">
            <Fig q={model.nodes[v.index].loadAfterPlan} />
          </Cell>
          <Cell label="Utilisation">
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
  const kw = (v: number | null) => (v === null ? <span className="text-mute">not supported by the inputs</span> : <span className="data text-ghost">{fmtNumber(v)} kW</span>);
  return (
    <DataTable
      caption="Rack rows. Counts and densities are inputs to the engine or come from the platform library; none is a measurement."
      head={["Rack row", "Racks", "kW per rack as found", "kW per rack after the plan"]}
    >
      {rows.map((r) => (
        <Row key={r.id}>
          <RowHead label="Rack row">{r.label}</RowHead>
          <Cell label="Racks">
            <span className="data text-ghost">{fmtNumber(r.racks)}</span> <BasisTag>input, not measured</BasisTag>
          </Cell>
          <Cell label="kW per rack as found">
            {kw(r.kwPerRackAsFound)} {r.kwPerRackAsFound !== null ? <BasisTag>input, not measured</BasisTag> : null}
          </Cell>
          <Cell label="kW per rack after the plan">
            {kw(r.kwPerRackAfterPlan)} {r.kwPerRackAfterPlan !== null ? <BasisTag>platform figure, not measured</BasisTag> : null}
          </Cell>
        </Row>
      ))}
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
          <dt className="text-xs text-mute">Capacity</dt>
          <dd><Fig q={node.capacity} /></dd>
        </div>
        <div>
          <dt className="text-xs text-mute">Load as found</dt>
          <dd><Fig q={node.loadAsFound} /></dd>
        </div>
        <div>
          <dt className="text-xs text-mute">Load after the plan</dt>
          <dd><Fig q={node.loadAfterPlan} /></dd>
        </div>
        <div>
          <dt className="text-xs text-mute">Utilisation, as found to after the plan</dt>
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
                {c.racksAllowed === null ? "no racks figure given" : <span className="data text-ghost">{c.racksAllowed} racks allowed</span>}{" "}
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
