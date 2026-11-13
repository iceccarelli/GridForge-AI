import Link from "next/link";
import { resolveStep } from "@/lib/audience-links";
import type { PathStep } from "@/lib/audiences";

/** The route through the offers for one buyer: an ordered list, each step with its price from the catalogue and why it comes here. */
export function PathList({ path, label }: { path: PathStep[]; label: string }) {
  const steps = path.map(resolveStep);
  return (
    <ol className="mt-5 space-y-3" aria-label={label}>
      {steps.map((s, i) => (
        <li key={`${s.name}-${i}`} className="panel flex gap-4 p-5">
          <span aria-hidden className="data mt-0.5 text-xs text-faint">{String(i + 1).padStart(2, "0")}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <Link href={s.href} className="inline-flex min-h-11 items-center font-semibold text-ghost underline-offset-4 hover:text-power underline">
                {s.name}
              </Link>
              <span className="data text-[13px] text-power">{s.price}</span>
            </div>
            {s.turnaround ? <p className="data mt-1 text-xs text-faint">{s.turnaround}</p> : null}
            <p className="mt-2 text-[15px] leading-relaxed text-mute">{s.why}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
