"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  Search,
  TrendingUp,
  Ruler,
  CheckCircle2,
  ChevronDown,
  FileSearch,
  PencilRuler,
  Rocket,
} from "lucide-react";
import { openAudit } from "@/lib/ui";
import { TimeToPower } from "@/components/TimeToPower";
import { LoadSimulator } from "@/components/LoadSimulator";
import { TimeToPowerComparator } from "@/components/TimeToPowerComparator";
import { ConfigStudio } from "@/components/ConfigStudio";
import { SingleLineDiagram } from "@/components/SingleLineDiagram";
import { SectionNav } from "@/components/SectionNav";
import { JsonLd } from "@/components/JsonLd";
import { LiveConsole } from "@/components/LiveConsole";
import { LiveScenario } from "@/components/LiveScenario";
import { SystemFlow } from "@/components/SystemFlow";
import {
  MARKET_STATS,
  PROBLEM_CARDS,
  SERVICES,
  ARCHITECTURES,
  TECH,
  FAQ,
  SITE,
} from "@/lib/site";
import { POWER_BLOCKS } from "@/lib/catalog";


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
          {/* Global BackgroundReel shows through here. Light scrims only:
              readable headline on the left, image breathes on the right. */}
          <div className="absolute inset-0 bg-gradient-to-r from-ink/85 via-ink/45 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-b from-ink/40 via-transparent to-ink/70" />
          <div className="absolute inset-0 blueprint opacity-20" />
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
              Independent engineering for behind-the-meter generation, DC
              distribution, and physics-informed EMS — so your compute schedule
              stops waiting on the grid.
            </p>
            <p className="text-mute max-w-xl mb-9">
              Start with a Power Audit. You get a real engineer's read on your
              site, not a sales deck.
            </p>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => openAudit("hero")}
                className="btn-primary px-8 py-4 text-base rounded-xl flex items-center justify-center gap-2 group"
              >
                Request a power audit
                <ArrowRight
                  size={18}
                  className="group-hover:translate-x-0.5 transition"
                />
              </button>
              <a
                href="#architectures"
                className="btn-secondary px-7 py-4 text-base rounded-xl flex items-center justify-center gap-2"
              >
                See the architectures
              </a>
            </div>
          </div>

          {/* Signature */}
          <div className="lg:pl-4">
            <TimeToPower />
          </div>
        </div>

        <motion.a
          href="#market"
          aria-label="Scroll"
          animate={{ y: [0, 7, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="absolute bottom-7 left-1/2 -translate-x-1/2 text-faint hover:text-mute hidden sm:block"
        >
          <ChevronDown size={22} />
        </motion.a>
      </section>

      {/* ============== MARKET REALITY ============== */}
      <section id="market" className="border-y border-line bg-[#060912] py-10">
        <div className="max-w-7xl mx-auto px-6">
          <div className="data text-[10px] tracking-[0.18em] text-faint mb-7 text-center lg:text-left">
            THE MARKET YOU'RE ALREADY OPERATING IN
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-8">
            {MARKET_STATS.map((s, i) => (
              <div key={i}>
                <div className="data text-3xl sm:text-4xl font-semibold tracking-tight text-white">
                  {s.value}
                </div>
                <div className="text-sm text-mute mt-1.5 leading-snug">
                  {s.label}
                </div>
                <div className="data text-[10px] text-faint mt-2">{s.source}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============== PROBLEM ============== */}
      <section id="problem" className="max-w-7xl mx-auto px-6 pt-20 pb-16">
        <div className="max-w-2xl mb-12">
          <div className="eyebrow eyebrow-queue mb-3">THE #1 BOTTLENECK IN AI</div>
          <h2 className="section-title">
            Grid queues are setting your<br />deployment timeline.
          </h2>
          <p className="text-mute mt-5 text-lg leading-relaxed">
            A data center can be built in two to three years — but it's inert
            until it can draw power. In constrained markets, that's the binding
            constraint on the whole roadmap.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-5">
          {PROBLEM_CARDS.map((c, i) => (
            <div
              key={i}
              className={`panel panel-hover sweep p-7 ${
                c.kind === "power" ? "border-power/30" : ""
              }`}
            >
              <div
                className={`eyebrow ${
                  c.kind === "queue" ? "eyebrow-queue" : ""
                } mb-3`}
              >
                {c.label}
              </div>
              <p className="text-ghost/85 leading-relaxed text-[15px]">{c.body}</p>
              <div className="data text-[10px] text-faint mt-5 pt-4 border-t border-line">
                {c.source}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10">
          <button
            onClick={() => openAudit("problem")}
            className="btn-primary px-7 py-3.5 rounded-xl text-sm inline-flex items-center gap-2"
          >
            Stop waiting on the queue <ArrowRight size={16} />
          </button>
        </div>
      </section>

      {/* ============== LIVE MARKET ============== */}
      <section id="intelligence" className="max-w-5xl mx-auto px-6 pt-4 pb-16">
        <div className="max-w-2xl mb-10">
          <div className="eyebrow mb-3">REAL DATA, NOT A MOCKUP</div>
          <h2 className="section-title">The market proves the thesis daily.</h2>
          <p className="text-mute text-[15px] leading-relaxed mt-4">
            This pulls the live EPEX day-ahead curve for the German grid. The
            volatility you see is the whole reason on-site storage and firm
            behind-the-meter power pencil out — and it&apos;s fetched live, not
            illustrated.
          </p>
        </div>
        <LiveConsole />
        <div className="mt-6">
          <LiveScenario />
        </div>
      </section>

      {/* ============== APPROACH ============== */}
      <section className="bg-[#060912] border-y border-line py-20">
        <div className="max-w-7xl mx-auto px-6">
          <div className="max-w-2xl mb-12">
            <div className="eyebrow mb-3">HOW WE ENGAGE</div>
            <h2 className="section-title">From a site to a plan you can fund.</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-5">
            {[
              {
                icon: FileSearch,
                step: "01",
                title: "Audit the site",
                body: "Load profile, interconnection status, and behind-the-meter options. A defensible go / no-go in days, not months.",
              },
              {
                icon: PencilRuler,
                step: "02",
                title: "Engineer the system",
                body: "Feasibility, financial model, and a ready-to-permit integration design — sized from your real load, not a rule of thumb.",
              },
              {
                icon: Rocket,
                step: "03",
                title: "Commission & tune",
                body: "Support through commissioning, then tune the EMS against live telemetry so peak shaving is real, not theoretical.",
              },
            ].map((s) => {
              const Icon = s.icon;
              return (
                <div key={s.step} className="panel p-7 relative">
                  <div className="flex items-center justify-between mb-5">
                    <div className="w-11 h-11 rounded-xl bg-power/10 flex items-center justify-center">
                      <Icon className="w-5 h-5 text-power" />
                    </div>
                    <span className="data text-2xl text-line font-semibold">
                      {s.step}
                    </span>
                  </div>
                  <h3 className="text-xl font-semibold tracking-tight mb-3">
                    {s.title}
                  </h3>
                  <p className="text-mute text-[15px] leading-relaxed">{s.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============== COMPARATOR ============== */}
      <section id="comparator" className="max-w-5xl mx-auto px-6 pt-20 pb-4">
        <div className="max-w-2xl mb-10">
          <div className="eyebrow mb-3">QUANTIFY THE GAP</div>
          <h2 className="section-title">What is the queue costing you?</h2>
          <p className="text-mute text-[15px] leading-relaxed mt-4">
            The hero shows the gap. This puts a number on it for your project —
            cluster size, your market&apos;s interconnection wait, and what a
            megawatt of online compute is worth to you.
          </p>
        </div>
        <TimeToPowerComparator />
      </section>

      {/* ============== DEMONSTRATION ============== */}
      <section id="simulator" className="max-w-5xl mx-auto px-6 py-20">
        <div className="max-w-2xl mb-10">
          <div className="eyebrow mb-3">SEE THE PHYSICS</div>
          <h2 className="section-title">Most power engineers model a flat load.</h2>
          <p className="text-mute text-[15px] leading-relaxed mt-4">
            AI training doesn&apos;t draw flat. Checkpoints and all-reduce steps
            slam the cluster with sharp, sub-second transients. Size your firm
            generation for those peaks and you overbuild; ignore them and you
            brown out. The battery is what catches the spike — here&apos;s the
            stack doing it, live.
          </p>
        </div>
        <LoadSimulator />
      </section>

      {/* ============== SERVICES ============== */}
      <section id="services" className="max-w-7xl mx-auto px-6 py-20">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
          <div className="max-w-xl">
            <div className="eyebrow mb-3">WHAT YOU CAN BUY TODAY</div>
            <h2 className="section-title">Engineering services, fixed scope.</h2>
          </div>
          <p className="max-w-sm text-mute">
            Real deliverables a senior power-systems engineer produces for your
            specific site. This is where engagements start.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          {SERVICES.map((s, i) => {
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
                <h3 className="text-xl font-semibold tracking-tight mb-3">
                  {s.title}
                </h3>
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
              </div>
            );
          })}
        </div>

        <div className="mt-10">
          <button
            onClick={() => openAudit("services")}
            className="btn-secondary px-7 py-3.5 rounded-xl text-sm inline-flex items-center gap-2"
          >
            Scope an engagement <ArrowRight size={16} />
          </button>
        </div>
      </section>

      {/* ============== WHAT YOU CAN DEPLOY ============== */}
      <section id="deploy" className="max-w-7xl mx-auto px-6 py-20">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
          <div className="max-w-xl">
            <div className="eyebrow mb-3">MEGAWATTS IN MONTHS</div>
            <h2 className="section-title">Power blocks you can deploy.</h2>
          </div>
          <p className="max-w-sm text-mute">
            Productized behind-the-meter capacity, engineered to your site. Energized
            in months while the interconnection queue says years.
          </p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
          {POWER_BLOCKS.map((b) => (
            <div
              key={b.id}
              className={`panel panel-hover sweep p-6 flex flex-col ${
                b.flagship ? "border-power/40" : ""
              }`}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="data text-[10px] text-faint">{b.firmPct}% FIRM</div>
                {b.flagship && <span className="pill pill-progress">MOST REQUESTED</span>}
              </div>
              <div className="text-3xl font-semibold text-power leading-none">
                {b.capacityMW}
                <span className="text-base"> MW</span>
              </div>
              <h3 className="text-base font-semibold tracking-tight mt-3 mb-2">{b.name}</h3>
              <p className="text-ghost/75 text-[13px] leading-relaxed flex-1">{b.tagline}</p>
              <div className="mt-5 pt-4 border-t border-line">
                <div className="data text-[10px] text-faint mb-1">TIME TO ENERGIZED</div>
                <div className="data text-sm text-queue">{b.leadTime}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            href="/infrastructure"
            className="btn-primary px-7 py-3.5 rounded-xl text-sm inline-flex items-center gap-2"
          >
            See full specs &amp; configure <ArrowRight size={16} />
          </Link>
          <Link
            href="/pricing"
            className="btn-secondary px-7 py-3.5 rounded-xl text-sm inline-flex items-center gap-2"
          >
            Pricing &amp; reserve
          </Link>
        </div>
      </section>
      {/* ============== HOW IT WORKS ============== */}
      <section id="how" className="max-w-5xl mx-auto px-6 py-20">
        <div className="max-w-2xl mb-10">
          <div className="eyebrow mb-3">THE PIPELINE, STEP BY STEP</div>
          <h2 className="section-title">What actually happens when load spikes.</h2>
          <p className="text-mute text-[15px] leading-relaxed mt-4">
            Behind-the-meter only works if the system handles the sharp, sub-second
            transients of AI training. Here&apos;s the exact sequence — play it, or
            step through it yourself.
          </p>
        </div>
        <SystemFlow />
      </section>

      {/* ============== REFERENCE ARCHITECTURES ============== */}
      <section
        id="architectures"
        className="bg-[#060912] border-y border-line py-20"
      >
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-4">
            <div className="max-w-xl">
              <div className="eyebrow mb-3">REFERENCE ARCHITECTURES</div>
              <h2 className="section-title">
                The systems we design,<br />drawn to first principles.
              </h2>
            </div>
            <p className="max-w-sm text-mute">
              Validated engineering reference designs — the depth behind the
              services.
            </p>
          </div>

          <div className="pill pill-progress inline-block mb-10">
            REFERENCE DESIGNS — NOT DELIVERED CUSTOMER PROJECTS
          </div>

          <div className="grid lg:grid-cols-3 gap-5">
            {ARCHITECTURES.map((a) => (
              <div key={a.code} className="panel panel-hover p-7 flex flex-col">
                <div className="flex items-center justify-between mb-4">
                  <span className="data text-xs text-power tracking-[0.12em]">
                    {a.code}
                  </span>
                  <span className="data text-[10px] text-faint">{a.spec}</span>
                </div>
                <h3 className="text-2xl font-semibold tracking-tight mb-3">
                  {a.title}
                </h3>
                <p className="text-ghost/80 text-[15px] leading-relaxed mb-6">
                  {a.summary}
                </p>
                <div className="space-y-2.5 mt-auto">
                  {a.points.map((p, i) => (
                    <div key={i} className="flex items-start gap-2.5 text-sm">
                      <CheckCircle2 className="w-4 h-4 text-power mt-0.5 shrink-0" />
                      <span className="text-ghost/80">{p}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-10">
            <button
              onClick={() => openAudit("architectures")}
              className="btn-secondary px-7 py-3.5 rounded-xl text-sm inline-flex items-center gap-2"
            >
              Request a technical brief <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </section>

      {/* ============== CONFIGURATOR ============== */}
      <section id="configure" className="max-w-5xl mx-auto px-6 py-20">
        <div className="max-w-2xl mb-10">
          <div className="eyebrow mb-3">MATCH A DESIGN TO YOUR SITE</div>
          <h2 className="section-title">Which reference fits your build?</h2>
          <p className="text-mute text-[15px] leading-relaxed mt-4">
            Dial in your target capacity and firm/renewable balance. It maps you
            to a reference variant with an honest first-power timeline and a
            phasing plan — a starting point for the conversation, not a quote.
          </p>
        </div>
        <ConfigStudio />
      </section>

      {/* ============== SINGLE-LINE DIAGRAM ============== */}
      <section id="single-line" className="max-w-5xl mx-auto px-6 py-20">
        <div className="max-w-2xl mb-10">
          <div className="eyebrow mb-3">THE REFERENCE ARCHITECTURE, IN DETAIL</div>
          <h2 className="section-title">What the internal power system actually looks like.</h2>
          <p className="text-mute text-[15px] leading-relaxed mt-4">
            Past the marketing: a real single-line diagram of a behind-the-meter
            facility — grid, metering boundary, switchboard, UPS, distribution, and
            the on-site generation and storage that keep the racks fed. Click through it.
          </p>
        </div>
        <SingleLineDiagram />
      </section>

      {/* ============== TECHNOLOGY ============== */}
      <section id="technology" className="max-w-5xl mx-auto px-6 py-20">
        <div className="max-w-2xl mb-12">
          <div className="eyebrow mb-3">DETERMINISTIC · PHYSICS-INFORMED</div>
          <h2 className="section-title">Technology rooted in first principles.</h2>
        </div>
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

      {/* ============== ABOUT / FOUNDER ============== */}
      <section
        id="about"
        className="bg-[#060912] border-y border-line py-20"
      >
        <div className="max-w-4xl mx-auto px-6">
          <div className="eyebrow mb-3">FOUNDER-LED</div>
          <h2 className="section-title mb-7">{SITE.founder}</h2>
          <p className="text-lg text-ghost/85 leading-relaxed max-w-2xl">
            GridForge AI is the engineering practice of {SITE.founder} — a grid
            networks engineer working on the digitalization of high-voltage
            assets, with an M.Sc. from RWTH Aachen in cross-domain grid
            intelligence. The premise is simple: the AI buildout is gated by
            power, and the fastest path through it is deterministic,
            physics-informed engineering — not vendor catalogs.
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
            Send the site details. You'll hear back from the engineer within one
            business day.
          </p>
          <button
            onClick={() => openAudit("final")}
            className="mt-9 btn-primary text-base px-10 py-5 rounded-xl inline-flex items-center gap-2"
          >
            Request a power audit <ArrowRight size={18} />
          </button>
          <div className="data text-[11px] text-faint mt-6">
            No obligation · NDA on request · {SITE.email}
          </div>
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
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <p className="text-mute leading-relaxed pt-3 pr-8">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
