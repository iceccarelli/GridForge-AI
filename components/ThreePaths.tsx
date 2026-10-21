import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PAYG, PRODUCTS, eurFromCents } from "@/lib/products";
import { QUALIFY_LINK } from "@/lib/nav";
import { breakEvens, eurExact } from "@/lib/payg-pricing";

/**
 * The three things this company sells, side by side, so /pricing and /developers tell one story:
 *
 *   1. a FREE result       the capacity check: seven numbers, no card, no account
 *   2. METERED software    a free allowance, then pay-as-you-go under a cap you set, then a plan once the
 *                          volume warrants one
 *   3. ENGINEERING         a fixed fee for a deliverable a senior engineer produces and reviews
 *
 * Every figure is read from lib/products.ts (PAYG, the API plans, the engagement catalogue) or derived from
 * it; none is typed here.
 */
export default function ThreePaths() {
  const first = breakEvens()[0];
  const screen = PRODUCTS.density_screen;
  const card = "panel flex flex-col p-5";
  const eyebrow = "font-mono text-[10px] uppercase tracking-[0.14em] text-power";
  const cta =
    "mt-5 inline-flex min-h-11 items-center gap-2 self-start rounded border border-line px-4 py-2 text-sm font-semibold text-ghost hover:border-power/50";
  return (
    <section aria-labelledby="three-paths" className="mt-2">
      <h2 id="three-paths" className="sr-only">
        Three ways to use GridForge
      </h2>
      <ol className="grid gap-4 md:grid-cols-3">
        <li className={card}>
          <span className={eyebrow}>1 · A free result</span>
          <h3 className="mt-2 text-lg font-semibold text-ghost">Find what binds your hall</h3>
          <p className="mt-2 flex-1 text-sm text-mute">
            Seven numbers you already know. The engine returns the constraint that binds first, the racks
            the hall carries as found and after relief, and which inputs were assumed. No card, no account.
            Every figure carries an evidence class, and the calibration record is published as it stands.
          </p>
          <Link href={QUALIFY_LINK.href} className={cta}>
            {QUALIFY_LINK.label} <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </li>
        <li className={card}>
          <span className={eyebrow}>2 · Metered software</span>
          <h3 className="mt-2 text-lg font-semibold text-ghost">Call the engine from your own code</h3>
          <p className="mt-2 flex-1 text-sm text-mute">
            Start on a free allowance of {PAYG.freeAllowanceUnits} units a month, no card. Then pay as you go
            at {eurExact(PAYG.unitPriceCents)} a unit under a monthly cap you set, from {eurExact(PAYG.minCapEur * 100)} to{" "}
            {eurExact(PAYG.maxCapEur * 100)}: invoiced monthly in arrears, with a hard stop at the cap. Take a plan when the
            volume warrants it
            {first ? `: ${first.plan.name} starts to cost less from ${first.breakEvenUnits.toLocaleString("en-IE")} units a month` : ""}.
          </p>
          <Link href="/developers#free" className={cta}>
            Get the free allowance <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </li>
        <li className={card}>
          <span className={eyebrow}>3 · An engineering engagement</span>
          <h3 className="mt-2 text-lg font-semibold text-ghost">A fixed fee, a named deliverable</h3>
          <p className="mt-2 flex-1 text-sm text-mute">
            When you need an engineer&apos;s opinion on a hall, not an API response. Fixed fee agreed before we
            start, produced and reviewed by a person. Most halls begin with the {screen.name}, from{" "}
            {eurFromCents(screen.amountCents)}, which credits in full against the study it usually leads to. API
            responses are screening output and never carry an engineer&apos;s sign-off.
          </p>
          <Link href="/pricing#engagements" className={cta}>
            See the engagements <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </li>
      </ol>
    </section>
  );
}
