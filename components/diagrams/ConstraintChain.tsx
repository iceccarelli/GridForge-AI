import Link from "next/link";

// The path from the utility connection to useful AI compute, as the series of limits a hall's power and cooling pass through. The point of
// the figure is the word "smallest": useful capacity is set by the weakest stage in the chain, not by the first number on the contract.
// Each stage names the public constraint that tests it, so the figure is also a route into the reference. Ordered list in HTML, so it reads in
// sequence on any width and for any assistive technology.

interface Stage {
  label: string;
  slug: string | null;
  note: string;
  domain: "electrical" | "thermal" | "physical";
}

export const CHAIN: Stage[] = [
  { label: "Utility connection", slug: "firm-supply-capacity", note: "What the grid agreement lets you import, and what holds in contingency.", domain: "electrical" },
  { label: "Transformer", slug: "transformer-capacity", note: "Often the longest lead time on the ladder.", domain: "electrical" },
  { label: "UPS", slug: "ups-capacity", note: "Protected load, after redundancy is kept.", domain: "electrical" },
  { label: "Busway", slug: "busway-ampacity", note: "Pooled across runs unless the layout forbids it.", domain: "electrical" },
  { label: "Tap-off to the rack", slug: "rack-feed-tapoff-rating", note: "Binds at rack one, not at scale.", domain: "electrical" },
  { label: "Cooling distribution", slug: "cdu-capacity-site-conditions", note: "Duty at your site's conditions, not a reference case.", domain: "thermal" },
  { label: "Plant and flow", slug: "chilled-water-plant-capacity", note: "Heat the plant can reject and the flow the loop can carry.", domain: "thermal" },
  { label: "Floor and positions", slug: "floor-loading", note: "What the slab holds and the positions left.", domain: "physical" },
  { label: "Useful AI compute", slug: null, note: "Racks that run, at the density they are asked to run at.", domain: "physical" },
];

const DOMAIN_TONE = { electrical: "text-power", thermal: "text-queue", physical: "text-mute" } as const;

export function ConstraintChain() {
  return (
    <section aria-labelledby="cc-h" className="panel p-5 sm:p-7">
      <div className="eyebrow mb-2">FROM THE GRID TO USEFUL COMPUTE</div>
      <h3 id="cc-h" className="max-w-2xl text-lg font-semibold text-ghost">Capacity is the smallest of a series, not the first number on the contract.</h3>
      <ol className="mt-5 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
        {CHAIN.map((s, i) => (
          <li key={s.label} className="bg-ink p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="data text-[11px] text-faint">{String(i + 1).padStart(2, "0")}</span>
              <span className={`data text-[10px] uppercase tracking-[0.12em] ${DOMAIN_TONE[s.domain]}`}>{s.domain}</span>
            </div>
            <div className="mt-2 font-semibold text-ghost">
              {s.slug ? (
                <Link href={`/constraints/${s.slug}`} className="underline-offset-4 hover:text-power underline">{s.label}</Link>
              ) : (
                s.label
              )}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-mute">{s.note}</p>
          </li>
        ))}
      </ol>
      <p className="mt-5 max-w-3xl text-[13px] leading-relaxed text-mute">
        The engine solves thirteen such constraints together, names the one that binds first, and then relieves it and solves again: the
        headroom ladder. Nameplate megawatts and useful delivered compute differ by whatever the weakest stage costs.
      </p>
    </section>
  );
}
