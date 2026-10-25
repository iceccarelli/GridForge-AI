import Link from "next/link";
import { PRODUCTS, eurFromCents } from "@/lib/products";

/**
 * The calm way out of the Observatory. The free qualifier is the next step for someone who wants their own hall; the paid
 * Density Screen is linked, not sold: no checkout, no sign-in, no account or billing link. The price and turnaround come from
 * the catalogue, never typed here.
 */
export function FunnelCta() {
  const screen = PRODUCTS.density_screen;
  return (
    <section aria-labelledby="next-h" className="rounded-2xl border border-line bg-panel p-6 sm:p-8" data-observatory="next-step">
      <p className="eyebrow">Your own hall</p>
      <h2 id="next-h" className="mt-1 text-2xl font-semibold text-ghost sm:text-3xl">
        Everything above is invented. The qualifier uses your numbers.
      </h2>
      <p className="mt-3 max-w-2xl text-sm text-mute">
        Seven figures you already know go into the same engine, and it names the stage that binds first in your hall and which of your inputs nobody has measured. It is free, needs
        no account, and its answer is directional.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link href="/qualify" className="btn-primary inline-flex items-center rounded-full px-6 py-3 text-sm">
          Run the free qualifier on your hall
        </Link>
        <Link href="/pricing#engagements" className="text-sm text-power underline underline-offset-4">
          Or see the {screen.name} ({eurFromCents(screen.amountCents)}, {screen.turnaroundDays} working days)
        </Link>
      </div>
    </section>
  );
}
