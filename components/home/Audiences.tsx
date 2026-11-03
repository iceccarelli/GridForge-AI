import Link from "next/link";
import { AUDIENCES } from "@/lib/audiences";

/** Seven buyers, each linking to a page that starts from their own decision. */
export function Audiences() {
  return (
    <section id="audiences" aria-labelledby="aud-h" className="mx-auto max-w-7xl px-6 py-20">
      <div className="mb-10 max-w-2xl">
        <div className="eyebrow mb-3">WHO IT IS FOR</div>
        <h2 id="aud-h" className="section-title">Seven buyers, seven different decisions.</h2>
        <p className="mt-4 text-[15px] leading-relaxed text-mute">
          An owner deciding whether a hall is worth a study and an advisor comparing bids are asking for different things. Pick the
          one that is yours.
        </p>
      </div>
      <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {AUDIENCES.map((a) => (
          <li key={a.slug} className="bg-ink">
            <Link href={`/for/${a.slug}`} className="flex h-full min-h-11 flex-col gap-2 p-5 transition-colors hover:bg-panel">
              <span className="font-semibold text-ghost">{a.name}</span>
              <span className="text-[13px] leading-relaxed text-mute">{a.summary}</span>
              <span className="data mt-auto pt-2 text-[11px] text-power">{a.firstQuestion}</span>
            </Link>
          </li>
        ))}
        <li className="bg-ink">
          <Link href="/for" className="flex h-full min-h-11 flex-col justify-center gap-1 p-5 text-power hover:bg-panel">
            <span className="font-semibold">All seven, side by side</span>
            <span className="text-[13px] text-mute">Compare what each buyer is deciding.</span>
          </Link>
        </li>
      </ul>
    </section>
  );
}
