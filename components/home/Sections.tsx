import Link from "next/link";
import { ArrowRight, Building2, Clock, Coins, Gauge, ShieldAlert } from "lucide-react";
import { BindingConstraintInsightsFallback } from "@/components/home/Fallbacks";
import { CommissionScreen } from "@/components/CommissionScreen";
import FreeAllowanceForm from "@/components/FreeAllowanceForm";
import { LazyIsland } from "@/components/home/LazyIsland";
import { Faq } from "@/components/home/Faq";
import { TtpPhoto } from "@/components/TtpPhoto";
import { ConstraintChain } from "@/components/diagrams/ConstraintChain";
import { EvidenceBoundary } from "@/components/diagrams/EvidenceBoundary";
import { RackDensityChart } from "@/components/diagrams/RackDensityChart";
import { figureCitation, marketFigure, verificationLabel } from "@/lib/market-evidence";
import { QUALIFY_LINK } from "@/lib/nav";
import { PAYG, PRODUCTS, eurFromCents } from "@/lib/products";
import { MARKET_STATS, SITE, TECH, serviceCards } from "@/lib/site";

const SPINE = [
  { icon: Building2, label: "SITE", body: "The hall you already have: racks, cooling, busway, transformer, grid connection. The facts, assembled once." },
  { icon: ShieldAlert, label: "BINDING CONSTRAINT", body: "Thirteen constraint families solved jointly. One sets the ceiling, named and given its evidence class." },
  { icon: Gauge, label: "HEADROOM", body: "The costed ladder of relief: each rung a limit removed, priced, lead-timed, with the racks it unlocks." },
  { icon: Coins, label: "COST", body: "What each rung of relief costs, quoted at your site's own conditions, not a vendor's reference case." },
  { icon: Clock, label: "TIME", body: "The single item that sets your energisation date. Where its lead time is an assumption it is labelled one, not a date." },
];

/** Problem: the decision spine, the engineering diagrams that explain it, and the market figures with how strongly each was checked. */
export function Problem() {
  return (
    <section id="market" className="border-y border-line bg-[#060912] py-16">
      <div className="mx-auto max-w-7xl px-6">
        <div className="eyebrow eyebrow-queue mb-3">HOW THE ANSWER IS BUILT</div>
        <h2 className="section-title max-w-2xl">
          Nobody in the building can say<br />what stops the next rack. This does.
        </h2>

        <ol className="mt-10 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-5">
          {SPINE.map((s, i) => {
            const Icon = s.icon;
            return (
              <li key={s.label} className="relative flex flex-col gap-3 bg-ink p-6">
                <div className="flex items-center justify-between">
                  <Icon className="h-4 w-4 text-power" aria-hidden />
                  <span className="data text-[10px] text-faint">{String(i + 1).padStart(2, "0")}</span>
                </div>
                <div className="data text-[11px] font-semibold tracking-[0.12em] text-power">{s.label}</div>
                <p className="text-[13px] leading-relaxed text-mute">{s.body}</p>
              </li>
            );
          })}
        </ol>

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <ConstraintChain />
          <RackDensityChart />
        </div>

        <div className="mt-14 grid items-center gap-10 lg:grid-cols-2">
          <div className="max-w-xl">
            <p className="text-lg leading-relaxed text-mute">
              The grid connection is already yours. What stops the next rack (busway, transformer, cooling, floor loading) is rarely the
              constraint people expect, and today nobody in the building has it in writing.
            </p>
            <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-7">
              {MARKET_STATS.map((s) => {
                const f = marketFigure(s.figure);
                return (
                  <div key={s.figure} className="flex flex-col">
                    <dt className="order-2 mt-1 text-xs leading-snug text-mute">{s.label}</dt>
                    <dd className="data order-1 text-2xl font-semibold tracking-tight text-white sm:text-3xl">{s.value}</dd>
                    <dd className="data order-3 mt-1.5 text-[10px] leading-snug text-faint">
                      <a href={f.url} rel="noopener noreferrer" target="_blank" className="underline underline-offset-2 hover:text-mute">
                        {figureCitation(f)}
                      </a>
                      <br />
                      {verificationLabel(f.verification)}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <p className="mt-6 text-[12px] leading-relaxed text-faint">
              These describe the market, not our results. Each figure&rsquo;s publisher, period, geography and how it was checked are recorded on{" "}
              <Link href="/evidence#market-figures" className="text-power underline">the evidence page</Link>.
            </p>
          </div>
          <TtpPhoto id="ttp-03" className="relative aspect-[16/9] overflow-hidden rounded-2xl border border-line" />
        </div>

        <div className="mt-10">
          <CommissionScreen productId="density_screen" context="problem" tone="primary" />
        </div>
      </div>
    </section>
  );
}

/** Proof of method: the live feed and the comparator, mounted only when scrolled near. */
export function Proof() {
  return (
    <section id="intelligence" className="mx-auto max-w-5xl px-6 pb-16 pt-20">
      <div className="mb-10 max-w-2xl">
        <div className="eyebrow mb-3">PROOF OF METHOD · REAL DATA, NOT A MOCKUP</div>
        <h2 className="section-title">Live, deterministic and quantified, not illustrated.</h2>
        <p className="mt-4 text-[15px] leading-relaxed text-mute">
          Below, the live EPEX day-ahead curve for the German grid, fetched when you scroll to it. It is wholesale price context, not the
          headroom of any site. Under it, put a number on what an unrelieved constraint is costing your own project; those figures are your
          inputs and are labelled as planning estimates.
        </p>
      </div>
      <LazyIsland which="liveConsole" minHeight={420} label="The live market view loads as you scroll to it." />
      <div className="mb-10 mt-14">
        <div className="eyebrow mb-3">QUANTIFY THE GAP</div>
        <h3 className="section-title">What is an unrelieved constraint costing you?</h3>
      </div>
      <LazyIsland which="comparator" minHeight={520} label="The comparison tool loads as you scroll to it." />
      <div className="mt-14">
        <LazyIsland which="timeToPower" minHeight={480} label="The time-to-power planner loads as you scroll to it." />
      </div>
    </section>
  );
}

export function Qualifier() {
  return (
    <section id="qualify" className="mx-auto max-w-5xl px-6 py-28 sm:py-32">
      <div className="mb-10 flex flex-col justify-between gap-6 md:flex-row md:items-end">
        <div className="max-w-xl">
          <div className="eyebrow mb-3 text-power">RUN IT ON YOUR OWN HALL</div>
          <h2 className="section-title-hero">
            Most halls don&rsquo;t fail on cooling.
            <br />
            They fail on a 63&nbsp;A tap-off.
          </h2>
        </div>
        <p className="max-w-sm text-mute">
          Thirteen constraints decide how much AI compute an existing hall can carry. One binds first, and it is rarely the one people
          expect. Seven numbers you already know, and the engine tells you which: free, no contact details.
        </p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="panel p-6 sm:p-8">
          <LazyIsland which="insights" compact minHeight={260} label="What the free check reports loads as you scroll to it." />
          <noscript>
            <BindingConstraintInsightsFallback />
          </noscript>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link href={QUALIFY_LINK.href} className="inline-flex min-h-11 items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink">
              {QUALIFY_LINK.label} <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <span className="font-mono text-[11px] text-faint">
              solved server-side · the free Time-to-Power comparison adds indicative cost and time, with evidence classes
            </span>
          </div>
        </div>
        <TtpPhoto id="ttp-04" className="relative hidden aspect-[3/2] overflow-hidden rounded-2xl border border-line lg:block" />
      </div>
    </section>
  );
}

export function Developers() {
  return (
    <section id="developers-free" className="mx-auto max-w-5xl px-6 pb-8">
      <div className="panel grid items-start gap-8 p-6 sm:p-8 md:grid-cols-[1.1fr_1fr]">
        <div>
          <div className="eyebrow mb-3">FOR SOFTWARE THAT CALLS THE ENGINE</div>
          <h2 className="section-title">Put the engine in your own tooling, free to start.</h2>
          <p className="mt-4 text-[15px] leading-relaxed text-mute">
            {PAYG.freeAllowanceUnits} units a month with an email address and no card. Past that you choose: pay as you go under a monthly cap you
            set, or a plan once the volume warrants one.{" "}
            <Link href="/developers#rates" className="text-power underline">See what it costs</Link>. Screening output only; an engagement is produced
            and reviewed by a senior engineer, in screening mode and not as an issued engineering opinion.
          </p>
        </div>
        <FreeAllowanceForm compact heading="Get the free allowance" />
      </div>
    </section>
  );
}

export function Services() {
  const cards = serviceCards();
  return (
    <section id="services" className="mx-auto max-w-7xl px-6 py-20">
      <div className="mb-12 flex flex-col justify-between gap-6 md:flex-row md:items-end">
        <div className="max-w-xl">
          <div className="eyebrow mb-3">WHAT YOU CAN BUY TODAY</div>
          <h2 className="section-title">Fixed fee, named artefact, no hourly billing.</h2>
        </div>
        <p className="max-w-sm text-mute">
          Every engagement is priced before it starts. The figure on each card is what checkout charges, read from the same catalogue. The
          Study is booked with a deposit against a fee agreed with you at scoping, before any work.
        </p>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        {cards.map((s, i) => (
          <article key={s.productId} className={`panel panel-hover sweep flex flex-col p-7 ${s.flagship ? "border-power/40" : ""}`}>
            <div className="mb-5 flex items-start justify-between">
              <span className="data text-[11px] tracking-[0.12em] text-faint">{String(i + 1).padStart(2, "0")}</span>
              {s.flagship && <span className="pill pill-progress">START HERE</span>}
            </div>
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <h3 className="text-xl font-semibold tracking-tight">{s.title}</h3>
              <span className="data whitespace-nowrap font-mono text-power">
                {s.price}
                {s.recurring ? <span className="text-faint"> {s.recurring}</span> : null}
              </span>
            </div>
            {s.band ? (
              <p className="-mt-1 mb-3 text-xs text-faint" data-testid="deposit-band">{s.band}</p>
            ) : null}
            <p className="flex-1 text-[15px] leading-relaxed text-ghost/80">{s.desc}</p>
            <div className="mt-6 flex items-end justify-between gap-4 border-t border-line pt-5">
              <div>
                <div className="data mb-1 text-[10px] text-faint">YOU RECEIVE</div>
                <div className="text-sm font-medium text-power">{s.deliverable}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="data mb-1 text-[10px] text-faint">TIMELINE</div>
                <div className="data text-sm text-ghost">{s.timeline}</div>
              </div>
            </div>
            <div className="mt-5">
              <CommissionScreen
                productId={s.productId}
                context={`services-${s.productId}`}
                tone={s.flagship ? "primary" : "outline"}
                label={`${s.recurring ? "Start" : "Commission"} — ${s.price}${s.band ? " deposit" : ""}`}
              />
            </div>
          </article>
        ))}
      </div>
      <p className="mt-8 text-sm text-mute">
        The {PRODUCTS.density_screen.name} ({eurFromCents(PRODUCTS.density_screen.amountCents)}) is the first paid step and credits in full against the
        next study.{" "}
        <Link href="/products" className="text-power underline">What each one is, and what it is not</Link>.
      </p>
    </section>
  );
}

export function Technology() {
  return (
    <section id="technology" className="mx-auto max-w-5xl px-6 py-20">
      <div className="mb-12 max-w-2xl">
        <div className="eyebrow mb-3">DETERMINISTIC · PHYSICS-INFORMED</div>
        <h2 className="section-title">Technology rooted in first principles.</h2>
      </div>
      <TtpPhoto id="ttp-02" className="relative mb-12 aspect-[16/9] overflow-hidden rounded-2xl border border-line" />
      <div className="grid gap-x-14 gap-y-10 md:grid-cols-2">
        {TECH.map((t, i) => (
          <div key={t.title} className="border-l-2 border-line pl-6">
            <div className="data mb-2 text-[10px] text-faint">{String(i + 1).padStart(2, "0")}</div>
            <h3 className="mb-2.5 text-lg font-semibold tracking-tight">{t.title}</h3>
            <p className="text-[15px] leading-relaxed text-ghost/75">{t.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Evidence() {
  return (
    <section id="evidence" className="border-y border-line bg-[#060912] py-20">
      <div className="mx-auto max-w-5xl px-6">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div className="max-w-xl">
            <div className="eyebrow mb-3">MODEL VS FIELD</div>
            <h2 className="section-title mb-5">Every number carries its evidence class.</h2>
            <p className="text-[15px] leading-relaxed text-mute">
              Assumed, modelled, simulated and estimated figures are labelled as such: E0 through E3. Nothing here is presented as measured or
              field-validated (E4&ndash;E7) until it actually is. The calibration ledger comparing modelled results against instrumented
              field data is empty today, and every study and API response says so. That is the honest starting point for a future track
              record, not a gap we hide.
            </p>
          </div>
          <TtpPhoto id="ttp-14" className="relative aspect-[3/2] overflow-hidden rounded-2xl border border-line" />
        </div>
        <div className="mt-12">
          <EvidenceBoundary />
        </div>
      </div>
    </section>
  );
}

export function Founder() {
  const cols = [
    { k: "DISCIPLINE", v: "Power-systems engineering, grid intelligence, and deterministic control." },
    { k: "PRINCIPLE", v: "Every design starts from power-flow physics and control theory, with no black boxes." },
    { k: "STAGE", v: "Pilot-stage and direct. Early partners work with the engineer, not an account manager." },
  ];
  return (
    <section id="about" className="border-y border-line bg-[#060912] py-16">
      <div className="mx-auto max-w-4xl px-6">
        <div className="eyebrow mb-3">FOUNDER-LED</div>
        <h2 className="section-title-quiet mb-7">{SITE.founder}</h2>
        <p className="max-w-2xl text-lg leading-relaxed text-ghost/85">
          Time to Power is built by {SITE.founder}, a grid networks engineer working on the digitalization of high-voltage assets, with an M.Sc.
          from RWTH Aachen in cross-domain grid intelligence. The premise is simple: the AI buildout is gated by power, and the engine
          underneath, GridForge Engine, answers what a hall can actually carry with deterministic, evidence-graded engineering, not a vendor
          catalog.
        </p>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {cols.map((b) => (
            <div key={b.k} className="panel p-6">
              <div className="data mb-2 text-[10px] tracking-[0.14em] text-power">{b.k}</div>
              <div className="text-[15px] leading-relaxed text-ghost/85">{b.v}</div>
            </div>
          ))}
        </div>
        <p className="mt-8 text-sm text-mute">
          Founder principles and prior work:{" "}
          <a href={SITE.founderUrl} target="_blank" rel="noopener noreferrer" className="text-power underline">igrimaldi.engineering</a>
          . The engine&rsquo;s source is{" "}
          <a href={SITE.repo} target="_blank" rel="noopener noreferrer" className="text-power underline">public on GitHub</a>.
        </p>
      </div>
    </section>
  );
}

export function FaqSection() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-6 py-16">
      <div className="eyebrow mb-3">STRAIGHT ANSWERS</div>
      <h2 className="section-title-quiet mb-10">No overclaiming.</h2>
      <Faq />
    </section>
  );
}

export function FinalCta() {
  return (
    <section id="final-cta" className="border-t border-line bg-[#060912] py-20">
      <div className="mx-auto max-w-3xl px-6 text-center">
        <div className="eyebrow mb-3">READY WHEN YOU ARE</div>
        <h2 className="section-title mb-5">
          Let&rsquo;s pressure-test your<br />time-to-power.
        </h2>
        <p className="mx-auto max-w-md text-lg text-mute">
          One hall, {PRODUCTS.density_screen.turnaroundDays} working days from a complete intake, a fixed fee. You get the constraint that binds it
          and the list of inputs nobody has measured.
        </p>
        <div className="mt-9 flex justify-center">
          <CommissionScreen productId="density_screen" context="final" size="lg" />
        </div>
        <div className="data mt-6 text-[11px] text-faint">Credits in full against the full study · NDA on request · {SITE.email}</div>
        <TtpPhoto id="ttp-17" className="relative mt-12 aspect-[16/9] overflow-hidden rounded-2xl border border-line" />
      </div>
    </section>
  );
}
