import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CommissionScreen } from "@/components/CommissionScreen";
import { HeroReel } from "@/components/HeroReel";
import { QUALIFY_LINK } from "@/lib/nav";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { REFERENCE_PHOTO_NOTICE } from "@/lib/ttp-images";

const SCREEN = PRODUCTS.density_screen;

/** The seven things a buyer needs from the first screen, each answered once, from the catalogue where a figure is involved. */
export function glance(): { k: string; v: string }[] {
  return [
    { k: "Who it is for", v: "The owner or operator of an existing AI-capable data hall, and the investors, engineers and advisors who decide on it." },
    { k: "The decision", v: "Whether this hall is worth a densification study, which constraint binds first, and what relieves it." },
    { k: "What we need", v: "Seven numbers you already know for the free check. For a paid screen, a complete intake: capacity, busway, tap-off, plant temperature, the target platform." },
    { k: "What you get", v: "How many racks of your platform the hall carries as it stands and after each costed rung, what sets the date, and the inputs nobody has measured." },
    {
      k: "Buy now",
      v: `${SCREEN.name}: one hall, ${eurFromCents(SCREEN.amountCents)}, ${SCREEN.turnaroundDays} working days from a complete intake. It credits in full against the next study.`,
    },
    { k: "Free now", v: "The capacity check: no card, no account and no contact details required. It is directional and says so." },
    { k: "Why trust it", v: "Every figure carries an evidence class, and a result carries the weakest one. The calibration ledger is empty today, and every document says so." },
  ];
}

export function Hero() {
  const items = glance();
  return (
    <section className="relative flex min-h-[100dvh] items-center pb-16 pt-24">
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <HeroReel />
      </div>

      <div className="relative z-10 mx-auto grid w-full max-w-7xl items-start gap-12 px-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
        <div>
          <div className="data mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-white/5 px-3 py-1 text-[10px] tracking-[0.16em] text-mute">
            {/* Neutral on purpose: the confirmed-green status colour must not mark a pilot-stage badge. */}
            <span className="h-1.5 w-1.5 rounded-full bg-faint" aria-hidden />
            PILOT-STAGE · FOUNDER-LED · EVIDENCE-GRADED
          </div>

          <h1 className="display mb-6 text-[2.6rem] font-semibold sm:text-6xl lg:text-[4.2rem]">
            The bottleneck<br />
            isn&apos;t chips.<br />
            <span className="text-power">It&apos;s power.</span>
          </h1>

          <p className="mb-3 max-w-xl text-lg leading-relaxed text-ghost/85 sm:text-xl">
            Time to Power evaluates how much useful AI compute an existing data-centre hall can support, identifies the binding electrical
            or thermal constraint, and shows what it takes to unlock additional capacity, with cost, lead time and the evidence behind
            every number.
          </p>
          <p className="mb-8 max-w-xl text-mute">
            A time built on an assumed lead time is labelled as one, not as a date. We sell no equipment.
          </p>

          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <div className="panel flex flex-col p-5">
              <span className="eyebrow-queue data text-[10px]">A · FREE · SEVEN NUMBERS</span>
              <span className="mt-1.5 font-semibold text-ghost">Run the free capacity check</span>
              <p className="mt-1.5 flex-1 text-sm leading-relaxed text-mute">
                Seven numbers, no card, no call. A directional answer naming the constraint likely to bind first, the inputs it is missing,
                and the evidence class.
              </p>
              <Link
                href={QUALIFY_LINK.href}
                className="btn-secondary mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 text-sm"
              >
                {QUALIFY_LINK.label} <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <p className="mt-3 text-[11px] leading-relaxed text-faint">
                Your seven numbers are sent to our engine and the run is stored behind a private link.{" "}
                <Link href="/legal/privacy" className="underline">What is stored</Link>.
              </p>
            </div>

            <div className="panel flex flex-col border-power/40 p-5">
              <span className="eyebrow data text-[10px]">
                B · {eurFromCents(SCREEN.amountCents).toUpperCase()} · {SCREEN.turnaroundDays} DAYS FROM INTAKE
              </span>
              <span className="mt-1.5 font-semibold text-ghost">{SCREEN.name}</span>
              <p className="mt-1.5 flex-1 text-sm leading-relaxed text-mute">
                One hall. The first six rungs of the headroom ladder, the assumptions and the inputs nobody has measured, and a data
                request for your own engineers. Credits in full against the next study.
              </p>
              <div className="mt-4">
                <CommissionScreen productId="density_screen" context="hero" size="lg" />
              </div>
            </div>
          </div>

          {/* One secondary route under the two actions above. The free check is already the "Run free capacity check" button in panel A: no second label for it. */}
          <p className="mt-4 max-w-2xl text-sm">
            <Link href="/reference" className="inline-flex min-h-11 items-center gap-1.5 text-power underline underline-offset-4">
              See a sample deliverable
            </Link>
          </p>

          <p className="data mt-4 text-[10px] text-faint">{REFERENCE_PHOTO_NOTICE}</p>
        </div>

        <aside aria-labelledby="glance-h" className="panel p-6 lg:mt-6">
          <h2 id="glance-h" className="eyebrow mb-4">AT A GLANCE</h2>
          <dl className="space-y-4">
            {items.map((it) => (
              <div key={it.k} className="grid gap-1 sm:grid-cols-[8.5rem_1fr] sm:gap-4">
                <dt className="data text-[11px] uppercase tracking-[0.1em] text-power">{it.k}</dt>
                <dd className="text-[14px] leading-relaxed text-ghost/85">{it.v}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
    </section>
  );
}
