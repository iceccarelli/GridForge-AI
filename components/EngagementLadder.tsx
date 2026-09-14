"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { eur } from "@/lib/commerce";
import { PRODUCTS, type ProductId } from "@/lib/products";

/**
 * The engagement ladder: what can be bought now, in the order clients climb it.
 *
 * Every fee here is fixed and every one buys a named artefact. Nothing on this
 * list is billed by the hour, because the client is buying an answer — and a fee
 * that moves with our effort would make our slowness their problem.
 */

const ORDER: ProductId[] = [
  "density_screen",
  "envelope_study_deposit",
  "portfolio_screen_deposit",
  "hall_watch",
];

const NOTE: Partial<Record<ProductId, string>> = {
  density_screen: "Credits in full against the study.",
  envelope_study_deposit: "Deposit against €22k–€45k, scoped before we start.",
  portfolio_screen_deposit: "Deposit against €60k–€140k, five to fifteen halls.",
  hall_watch: "Cancel any time; no minimum term.",
};

export function EngagementLadder() {
  const [busy, setBusy] = useState<ProductId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function buy(id: ProductId) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: id }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok || !body.url) {
        setError(
          body?.error === "Payments not configured"
            ? "Checkout is not live on this deployment yet — use the enquiry route below."
            : (body?.error ?? "Could not start checkout.")
        );
        return;
      }
      window.location.href = body.url as string;
    } catch {
      setError("Could not reach checkout.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-20">
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="max-w-xl">
          <div className="eyebrow mb-2 text-power">Capacity engineering — buy today</div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Fixed fee, named artefact, no hourly billing.
          </h2>
        </div>
        <p className="max-w-sm text-[14px] text-mute">
          Start where your question is. Most halls start with the screen, because it costs less
          than the meeting you would otherwise have about whether to have a meeting.
        </p>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {ORDER.map((id) => {
          const p = PRODUCTS[id];
          return (
            <div key={id} className="panel flex flex-col p-6">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-lg font-semibold text-ghost">{p.name}</h3>
                <span className="data whitespace-nowrap font-mono text-power">
                  {eur(p.amountCents)}
                  {p.recurring ? (
                    <span className="text-faint">
                      {" "}
                      / {p.recurring.intervalCount === 3 ? "quarter" : p.recurring.interval}
                    </span>
                  ) : null}
                </span>
              </div>
              <p className="mt-3 text-[14px] leading-relaxed text-mute">{p.description}</p>
              <p className="mt-3 text-[13px] leading-relaxed text-faint">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em]">
                  You receive
                </span>
                <br />
                {p.deliverable}
              </p>
              <div className="mt-auto pt-5">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => buy(id)}
                    disabled={busy === id}
                    className="inline-flex items-center gap-2 rounded-lg bg-power px-4 py-2.5 text-sm font-medium text-ink transition-all hover:bg-power/90 disabled:opacity-60"
                  >
                    {busy === id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {p.recurring ? "Start" : "Commission"} <ArrowRight size={15} />
                  </button>
                  <span className="text-[11px] text-faint">
                    {NOTE[id]}
                    {p.turnaroundDays && !p.recurring
                      ? ` ${p.turnaroundDays} working days from a complete intake.`
                      : ""}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {error ? <p className="mt-4 text-sm text-flag">{error}</p> : null}

      <p className="mt-6 max-w-3xl text-[13px] leading-relaxed text-faint">
        Not sure which? Run the{" "}
        <Link href="/qualify" className="text-power hover:underline">
          free qualifier
        </Link>{" "}
        first. It names the constraint that binds your hall and the inputs nobody has measured, and
        it costs nothing. If it tells you the answer is no, that is the cheapest no you will ever
        get.
      </p>
    </section>
  );
}
