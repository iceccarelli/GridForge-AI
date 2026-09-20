"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { m, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  Search,
  TrendingUp,
  Ruler,
  CheckCircle2,
  ChevronDown,
  Building2,
  ShieldAlert,
  Gauge,
  Coins,
  Clock,
} from "lucide-react";
import { commissionDensityScreen, DENSITY_SCREEN_CTA } from "@/lib/ui";
import { CommissionScreen } from "@/components/CommissionScreen";
import { HeroReel } from "@/components/HeroReel";
import dynamic from "next/dynamic";
import { TimeToPower } from "@/components/TimeToPower";
const TimeToPowerComparator = dynamic(() => import("@/components/TimeToPowerComparator").then(m => m.TimeToPowerComparator));
const BindingConstraintInsights = dynamic(() =>
  import("@/components/BindingConstraintInsights").then((m) => m.BindingConstraintInsights)
);
import { SectionNav } from "@/components/SectionNav";
import { JsonLd } from "@/components/JsonLd";
import { TtpPhoto } from "@/components/TtpPhoto";
import { REFERENCE_PHOTO_NOTICE as TTP_HERO_CAPTION } from "@/lib/ttp-images";
const LiveConsole = dynamic(() => import("@/components/LiveConsole").then(m => m.LiveConsole));
import {
  MARKET_STATS,
  serviceCards,
  TECH,
  FAQ,
  SITE,
} from "@/lib/site";


const serviceIcons: Record<string, React.ElementType> = {
  search: Search,
  trending: TrendingUp,
  ruler: Ruler,
  check: CheckCircle2,
};

export default function Home() {


  return (
    <div className="overflow-hidden">
      <JsonLd />
      <SectionNav />
      {/* ============== HERO ============== */}
      <section className="relative min-h-[100dvh] flex items-center pt-24 pb-16">
        <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
          {/* Hero has its OWN power-grid reel, distinct from the site-wide data-center reel. */}
          <HeroReel />
        </div>

        <div className="relative z-10 max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-12 lg:gap-10 items-center w-full">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-line bg-white/5 data text-[10px] tracking-[0.16em] text-mute mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-verified animate-pulse" />
              PILOT-STAGE · FOUNDER-LED · PHYSICS-INFORMED
            </div>

            <h1 className="display text-[2.6rem] sm:text-6xl lg:text-[4.4rem] font-semibold mb-6">
              The bottleneck<br />
              isn't chips.<br />
              <span className="text-power">It's power.</span>
            </h1>

            <p className="text-lg sm:text-xl text-ghost/80 max-w-xl mb-3 leading-relaxed">
              Give us the technical information for an existing or proposed AI
              site, and we tell you how much useful AI compute it can actually
              support, what blocks it, what fixes it costs, and when the
              compute can go live. No equipment to sell.
            </p>
            <p className="text-mute max-w-xl mb-9">
              Start with a Density Screen: one hall, five working days, a document
              that names what binds it. Fixed fee, and it credits in full against
              the full study.
            </p>

            <div className="flex flex-col sm:flex-row gap-3">
              <CommissionScreen productId="density_screen" context="hero" size="lg" />
              <Link
                href="/qualify"
                className="btn-secondary px-7 py-4 text-base rounded-xl flex items-center justify-center gap-2"
              >
                Or run the free qualifier
              </Link>
            </div>
            <p className="data text-[11px] text-faint mt-4">
              Seven numbers, no card, no call. It names your binding constraint before
              you decide whether to buy anything.
            </p>
            <p className="data text-[10px] text-faint/70 mt-8">
              {TTP_HERO_CAPTION}
            </p>
          </div>

          {/* Signature */}
          <div className="lg:pl-4">
            <TimeToPower />
          </div>
        </div>

        <m.a
          href="#market"
          aria-label="Scroll"
          animate={{ y: [0, 7, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="absolute bottom-7 left-1/2 -translate-x-1/2 text-faint hover:text-mute hidden sm:block"
        >
          <ChevronDown size={22} />
        </m.a>
      </section>

      {/* ============== DECISION STRIP ============== */}
      {/* One spine, stated once. SITE -> BINDING CONSTRAINT -> HEADROOM -> COST ->
          TIME is the whole pitch; the market stats and the three problem claims
          that used to be two separate full-bleed sections here now support this
          one, rather than repeating it under different headings. See
          reports/TTP-CONVERSION-AUDIT.md section 1 for why the old Approach
          section (three sections telling the same "screen -> study -> spec"
          story) was removed rather than kept alongside this. */}
      <section id="market" className="border-y border-line bg-[#060912] py-16">
        <div className="max-w-7xl mx-auto px-6">
          <div className="eyebrow eyebrow-queue mb-3">HOW THE ANSWER IS BUILT</div>
          <h2 className="section-title max-w-2xl">
            Nobody in the building can say<br />what stops the next rack. This does.
          </h2>

          <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-5 gap-px bg-line rounded-xl overflow-hidden border border-line">
            {[
              { icon: Building2, label: "SITE", body: "The hall you already have — racks, cooling, busway, transformer, grid connection. The facts, assembled once." },
              { icon: ShieldAlert, label: "BINDING CONSTRAINT", body: "Thirteen constraint families solved jointly. One sets the ceiling, named and given its evidence class." },
              { icon: Gauge, label: "HEADROOM", body: "The costed ladder of relief: each rung a limit removed, priced, lead-timed, with the racks it unlocks." },
              { icon: Coins, label: "COST", body: "What each rung of relief actually costs, quoted at your site's own conditions, not a vendor's reference case." },
              { icon: Clock, label: "TIME", body: "The single item that sets your energisation date. Not a typical lead time — yours." },
            ].map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={s.label} className="bg-ink p-6 flex flex-col gap-3 relative">
                  <div className="flex items-center justify-between">
                    <Icon className="w-4 h-4 text-power" />
                    <span className="data text-[10px] text-faint">{String(i + 1).padStart(2, "0")}</span>
                  </div>
                  <div className="data text-[11px] tracking-[0.12em] text-power font-semibold">{s.label}</div>
                  <p className="text-[13px] text-mute leading-relaxed">{s.body}</p>
                </div>
              );
            })}
          </div>

          <div className="mt-12 grid lg:grid-cols-2 gap-10 items-center">
            <div className="max-w-xl">
              <p className="text-mute text-lg leading-relaxed">
                The grid connection is already yours. What actually stops the
                next rack — busway, transformer, cooling, floor loading — is
                rarely the constraint people expect, and today nobody in the
                building has it in writing.
              </p>
              <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6">
                {MARKET_STATS.map((s, i) => (
                  <div key={i}>
                    <div className="data text-2xl sm:text-3xl font-semibold tracking-tight text-white">
                      {s.value}
                    </div>
                    <div className="text-xs text-mute mt-1 leading-snug">{s.label}</div>
                    <div className="data text-[9px] text-faint mt-1.5">{s.source}</div>
                  </div>
                ))}
              </div>
            </div>
            <TtpPhoto id="ttp-03" className="rounded-2xl overflow-hidden border border-line aspect-[16/9]" />
          </div>

          <div className="mt-10">
            <button
              onClick={() => commissionDensityScreen({ context: "problem" })}
              className="btn-primary px-7 py-3.5 rounded-xl text-sm inline-flex items-center gap-2"
            >
              {DENSITY_SCREEN_CTA} <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </section>

      {/* ============== PROOF OF METHOD ============== */}
      {/* LiveConsole (real EPEX feed) and the comparator, under one heading —
          both exist to show the engine is live and deterministic, not to argue
          the thesis a second time. */}
      <section id="intelligence" className="max-w-5xl mx-auto px-6 pt-20 pb-16">
        <div className="max-w-2xl mb-10">
          <div className="eyebrow mb-3">PROOF OF METHOD — REAL DATA, NOT A MOCKUP</div>
          <h2 className="section-title">Live, deterministic, and quantified — not illustrated.</h2>
          <p className="text-mute text-[15px] leading-relaxed mt-4">
            This pulls the live EPEX day-ahead curve for the German grid, fetched
            live rather than illustrated — the same market where a blocked
            connection or a 160-week transformer lead time turns a density
            constraint into a cost. Below it, put a number on what an unrelieved
            constraint is costing your own project.
          </p>
        </div>
        <LiveConsole />

        <div className="mt-14 mb-10">
          <div className="eyebrow mb-3">QUANTIFY THE GAP</div>
          <h3 className="section-title">What is an unrelieved constraint costing you?</h3>
        </div>
        <TimeToPowerComparator />

        <div className="mt-10 grid sm:grid-cols-3 gap-4">
          <Link
            href="/qualify"
            className="panel panel-hover p-5 flex flex-col gap-1.5"
          >
            <span className="eyebrow-queue text-[10px]">FREE · 90 SECONDS</span>
            <span className="font-semibold text-ghost">Run the qualifier</span>
            <span className="text-sm text-mute leading-relaxed">
              Seven numbers on your hall, no card. It names what binds first.
            </span>
          </Link>
          <button
            onClick={() => commissionDensityScreen({ context: "proof" })}
            className="panel panel-hover p-5 flex flex-col gap-1.5 text-left"
          >
            <span className="eyebrow text-[10px]">EUR 4,500 · 5 DAYS</span>
            <span className="font-semibold text-ghost">Commission a Density Screen</span>
            <span className="text-sm text-mute leading-relaxed">
              One hall, a defensible answer on what stops the next rack.
            </span>
          </button>
          <Link
            href="/intelligence"
            className="panel panel-hover p-5 flex flex-col gap-1.5"
          >
            <span className="eyebrow text-[10px]">BUILDING TOWARD</span>
            <span className="font-semibold text-ghost">Market economics lab</span>
            <span className="text-sm text-mute leading-relaxed">
              Wholesale-price context for an existing site&apos;s operating cost —
              not equipment we sell.
            </span>
          </Link>
        </div>
      </section>

      {/* ============== SERVICES ============== */}
      {/* The qualifier. Everything above this is argument; this is the engine
          answering a question about the reader's own hall, for nothing. It is also
          where the binding-constraint dataset comes from. */}
      <section id="qualify" className="max-w-5xl mx-auto px-6 py-20">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-8">
          <div className="max-w-xl">
            <div className="eyebrow mb-3 text-power">RUN IT ON YOUR OWN HALL</div>
            <h2 className="section-title">
              Most halls don&rsquo;t fail on cooling.
              <br />
              They fail on a 63&nbsp;A tap-off.
            </h2>
          </div>
          <p className="max-w-sm text-mute">
            Thirteen constraints decide how much AI compute an existing hall can carry. One binds
            first, and it is rarely the one people expect. Seven numbers you already know, and the
            engine tells you which — free, no contact details.
          </p>
        </div>

        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-6 items-start">
          <div className="panel p-6 sm:p-8">
            <BindingConstraintInsights compact />
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href="/qualify"
                className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink"
              >
                Find the binding constraint <ArrowRight className="h-4 w-4" />
              </Link>
              <span className="text-[11px] text-faint font-mono">
                solved server-side · capital cost and programme duration are the paid engagement
              </span>
            </div>
          </div>
          <TtpPhoto
            id="ttp-04"
            className="rounded-2xl overflow-hidden border border-line aspect-[3/2] hidden lg:block"
          />
        </div>
      </section>

      <section id="services" className="max-w-7xl mx-auto px-6 py-20">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
          <div className="max-w-xl">
            <div className="eyebrow mb-3">WHAT YOU CAN BUY TODAY</div>
            <h2 className="section-title">Fixed fee, named artefact, no hourly billing.</h2>
          </div>
          <p className="max-w-sm text-mute">
            Four engagements, every one priced before it starts. The fee on each card
            is the fee checkout charges — both are read from the same catalogue.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          {serviceCards().map((s, i) => {
            const Icon = serviceIcons[s.icon] ?? Search;
            return (
              <div
                key={i}
                className={`panel panel-hover sweep p-7 flex flex-col ${
                  s.flagship ? "border-power/40" : ""
                }`}
              >
                <div className="flex items-start justify-between mb-5">
                  <div className="w-11 h-11 rounded-xl bg-white/5 flex items-center justify-center">
                    <Icon className="w-5 h-5 text-power" />
                  </div>
                  {s.flagship && (
                    <span className="pill pill-progress">START HERE</span>
                  )}
                </div>
                <div className="flex items-baseline justify-between gap-4 mb-3">
                  <h3 className="text-xl font-semibold tracking-tight">{s.title}</h3>
                  <span className="data font-mono text-power whitespace-nowrap">
                    {s.price}
                    {s.recurring ? (
                      <span className="text-faint"> {s.recurring}</span>
                    ) : null}
                  </span>
                </div>
                <p className="text-ghost/80 text-[15px] leading-relaxed flex-1">
                  {s.desc}
                </p>
                <div className="mt-6 pt-5 border-t border-line flex items-end justify-between gap-4">
                  <div>
                    <div className="data text-[10px] text-faint mb-1">
                      YOU RECEIVE
                    </div>
                    <div className="text-sm font-medium text-power">
                      {s.deliverable}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="data text-[10px] text-faint mb-1">
                      TIMELINE
                    </div>
                    <div className="data text-sm text-ghost">{s.timeline}</div>
                  </div>
                </div>
                <div className="mt-5">
                  <CommissionScreen
                    productId={s.productId}
                    context={`services-${s.productId}`}
                    tone={s.flagship ? "primary" : "outline"}
                    label={`${s.recurring ? "Start" : "Commission"} — ${s.price}`}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-10">
          <button
            onClick={() => commissionDensityScreen({ context: "services" })}
            className="btn-secondary px-7 py-3.5 rounded-xl text-sm inline-flex items-center gap-2"
          >
            {DENSITY_SCREEN_CTA} <ArrowRight size={16} />
          </button>
        </div>
      </section>

      {/* ============== WHAT YOU CAN DEPLOY ============== */}
      {/* A "MEGAWATTS IN MONTHS / Power blocks you can deploy" section stood here,
          rendering POWER_BLOCKS: containerised 1-50 MW blocks with gensets, BESS,
          footprints and weeks-to-energised. "Stand up a megawatt while the queue
          says 2031." We do not stand up megawatts. We tell an operator what stops
          the megawatts they already have contracted from becoming compute, which
          is a harder thing to say and the only one we can stand behind. */}
      {/* Two sections stood here: a "SEE THE PHYSICS" gas/fuel-cell/BESS load
          simulator (LoadSimulator) and a "HOW IT WORKS" behind-the-meter
          single-line diagram (SystemFlow) — a full generation+storage stack
          catching a training spike. Both describe a hybrid microgrid business
          this practice does not build, own or fund, the same category of
          artefact as the deleted /infrastructure page. Removed from the money
          path rather than rewritten; the components remain in components/ for
          a future pass that repurposes the animation shell honestly. */}
      {/* Three sections stood here: REFERENCE ARCHITECTURES, the CONFIGURATOR and a
          SINGLE-LINE DIAGRAM of a behind-the-meter facility. All three described
          hybrid power plants — gensets, fuel cells, utility-scale storage, campus
          builds past 120 MW — that this practice does not design, build, own or
          fund, and that the capital rule puts out of scope permanently. They were
          the strongest-looking part of the page and the least true. What replaced
          them is upstream: /constraints publishes the physics in full, /platforms
          publishes what a hall is actually being asked to carry, and /qualify
          answers the question for the reader's own hall. */}
      {/* ============== TECHNOLOGY ============== */}
      <section id="technology" className="max-w-5xl mx-auto px-6 py-20">
        <div className="max-w-2xl mb-12">
          <div className="eyebrow mb-3">DETERMINISTIC · PHYSICS-INFORMED</div>
          <h2 className="section-title">Technology rooted in first principles.</h2>
        </div>
        <TtpPhoto
          id="ttp-02"
          className="rounded-2xl overflow-hidden border border-line aspect-[16/9] mb-12"
        />
        <div className="grid md:grid-cols-2 gap-x-14 gap-y-10">
          {TECH.map((t, i) => (
            <div key={i} className="border-l-2 border-line pl-6">
              <div className="data text-[10px] text-faint mb-2">
                {String(i + 1).padStart(2, "0")}
              </div>
              <h3 className="font-semibold text-lg mb-2.5 tracking-tight">
                {t.title}
              </h3>
              <p className="text-ghost/75 text-[15px] leading-relaxed">{t.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ============== EVIDENCE / CALIBRATION ============== */}
      <section id="evidence" className="bg-[#060912] border-y border-line py-20">
        <div className="max-w-5xl mx-auto px-6">
          <div className="grid lg:grid-cols-2 gap-10 items-center">
            <div className="max-w-xl">
              <div className="eyebrow mb-3">MODEL VS FIELD</div>
              <h2 className="section-title mb-5">
                Every number carries its evidence class.
              </h2>
              <p className="text-mute text-[15px] leading-relaxed">
                Assumed, modelled, simulated and estimated figures are labelled
                as such — E0 through E3. Nothing here is presented as measured
                or field-validated (E4&ndash;E7) until it actually is. The
                calibration ledger comparing modelled results against
                instrumented field data is empty today, and every study and API
                response says so. That is the honest starting point for a
                future track record, not a gap we hide.
              </p>
            </div>
            <TtpPhoto
              id="ttp-14"
              className="rounded-2xl overflow-hidden border border-line aspect-[3/2]"
            />
          </div>
        </div>
      </section>

      {/* ============== ABOUT / FOUNDER ============== */}
      <section
        id="about"
        className="bg-[#060912] border-y border-line py-20"
      >
        <div className="max-w-4xl mx-auto px-6">
          <div className="eyebrow mb-3">FOUNDER-LED</div>
          <h2 className="section-title mb-7">{SITE.founder}</h2>
          <p className="text-lg text-ghost/85 leading-relaxed max-w-2xl">
            Time to Power is built by {SITE.founder} — a grid networks engineer
            working on the digitalization of high-voltage assets, with an
            M.Sc. from RWTH Aachen in cross-domain grid intelligence. The
            premise is simple: the AI buildout is gated by power, and the
            engine underneath — GridForge Engine — answers what a hall can
            actually carry with deterministic, evidence-graded engineering,
            not a vendor catalog.
          </p>

          <div className="mt-10 grid md:grid-cols-3 gap-5">
            {[
              {
                k: "DISCIPLINE",
                v: "Power-systems engineering, grid intelligence, and deterministic control.",
              },
              {
                k: "PRINCIPLE",
                v: "Every design starts from power-flow physics and control theory — no black boxes.",
              },
              {
                k: "STAGE",
                v: "Pilot-stage and direct. Early partners work with the engineer, not an account manager.",
              },
            ].map((b) => (
              <div key={b.k} className="panel p-6">
                <div className="data text-[10px] text-power tracking-[0.14em] mb-2">
                  {b.k}
                </div>
                <div className="text-[15px] text-ghost/85 leading-relaxed">
                  {b.v}
                </div>
              </div>
            ))}
          </div>

          <p className="mt-8 text-sm text-mute">
            Founder principles and prior work:{" "}
            <a
              href={SITE.founderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-power hover:underline"
            >
              igrimaldi.engineering
            </a>
          </p>
        </div>
      </section>

      {/* ============== FAQ ============== */}
      <section id="faq" className="max-w-3xl mx-auto px-6 py-20">
        <div className="eyebrow mb-3">STRAIGHT ANSWERS</div>
        <h2 className="section-title mb-10">No overclaiming.</h2>
        <div className="divide-y divide-line border-y border-line">
          {FAQ.map((f, i) => (
            <FaqItem key={i} q={f.q} a={f.a} />
          ))}
        </div>
      </section>

      {/* ============== FINAL CTA ============== */}
      <section className="bg-[#060912] border-t border-line py-20">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <div className="eyebrow mb-3">READY WHEN YOU ARE</div>
          <h2 className="section-title mb-5">
            Let's pressure-test your<br />time-to-power.
          </h2>
          <p className="text-lg text-mute max-w-md mx-auto">
            One hall, five working days, a fixed fee. You get the constraint that
            binds it and the list of inputs nobody has measured.
          </p>
          <div className="mt-9 flex justify-center">
            <CommissionScreen productId="density_screen" context="final" size="lg" />
          </div>
          <div className="data text-[11px] text-faint mt-6">
            Credits in full against the full study · NDA on request · {SITE.email}
          </div>
          <TtpPhoto
            id="ttp-17"
            className="rounded-2xl overflow-hidden border border-line aspect-[16/9] mt-12"
          />
        </div>
      </section>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-5">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-4 text-left"
        aria-expanded={open}
      >
        <span className="font-medium text-lg text-ghost">{q}</span>
        <ChevronDown
          size={20}
          className={`text-mute shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <p className="text-mute leading-relaxed pt-3 pr-8">{a}</p>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
