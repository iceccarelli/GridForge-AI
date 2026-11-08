import { engineeringAssumptionDefinition, ENGINEERING_ASSUMPTIONS_NOTE } from "@/lib/definitions";
import type { EngineeringAssumption } from "@/lib/engineering-constants";

/**
 * The engine's reserved engineering constants, each with its value, the class the engine labels it with, where it applies and what
 * replaces it. Everything shown is built by lib/engineering-constants.ts from the engine's published data and a drift-tested file;
 * this component adds no figure of its own.
 */
export function EngineeringAssumptions({
  items,
  heading,
  headingLevel = 2,
  showNote = true,
}: {
  items: EngineeringAssumption[];
  heading: string;
  headingLevel?: 2 | 3;
  showNote?: boolean;
}) {
  if (items.length === 0) return null;
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="mt-10 rounded border border-line bg-panel-2 p-6" aria-labelledby="engineering-assumptions-h" data-testid="engineering-assumptions">
      <H id="engineering-assumptions-h" className="text-lg font-semibold text-ghost">
        {heading}
      </H>
      {showNote ? <p className="mt-2 max-w-3xl text-sm text-mute">{ENGINEERING_ASSUMPTIONS_NOTE}</p> : null}
      <div className="mt-4 space-y-5">
        {items.map((a) => (
          <article key={a.id} data-assumption={a.id} className="rounded border border-line p-4">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-power">{a.title}</h3>
            <p data-assumption-definition className="mt-2 text-sm text-ghost">
              {engineeringAssumptionDefinition(a)}
            </p>
            <dl className="mt-3 space-y-2 text-sm text-mute">
              <Row k="Value" v={a.value} />
              <Row k="Evidence class" v={a.evidenceClass} />
              <Row k="Where it applies" v={a.appliesWhere} />
              <Row k="What replaces or overrides it" v={a.overriddenBy} />
            </dl>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-mute">
              {a.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{k}</dt>
      <dd className="mt-0.5">{v}</dd>
    </div>
  );
}
