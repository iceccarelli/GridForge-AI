"use client";

import React, { useState } from "react";
import { ClipboardList, Loader2 } from "lucide-react";
import { eur } from "@/lib/commerce";
import { PRODUCTS } from "@/lib/products";

/**
 * The follow-on offer under a delivered study or screen.
 *
 * This is the moment the argument is strongest, and it is not a sales argument —
 * it is the next thing the client physically has to do. The document they have
 * just read ends with a constraint and a date. Somebody now has to write a
 * specification for the thing that relieves it, and compare four quotations that
 * will otherwise answer four different questions.
 *
 * Shown after the working files rather than before: they should check our
 * arithmetic first. An upsell that arrives before the evidence reads as the point
 * of the document.
 */
export function SpecUpsell({ constraint }: { constraint?: string | null }) {
  const spec = PRODUCTS.procurement_spec;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commission() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: spec.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok || !body.url) {
        setError(body?.error ?? "Could not start checkout.");
        return;
      }
      window.location.href = body.url as string;
    } catch {
      setError("Could not reach checkout.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded border border-line bg-panel-2 p-6">
      <div className="flex items-start gap-3">
        <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-power" />
        <div className="flex-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">
            What happens next
          </span>
          <h2 className="mt-2 text-lg font-semibold text-ghost">
            {constraint
              ? `Now somebody has to buy the thing that relieves ${constraint.toLowerCase()}.`
              : "Now somebody has to buy the thing that relieves it."}
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-mute">
            Between this document and a purchase order sits three weeks of an engineer writing
            a specification, arguing about what to ask for, and comparing four quotations that
            answer four different questions. We generate the specification from the same
            solved model: every duty derived from a constraint in your hall and quoted at your
            site&rsquo;s own conditions, with a response schedule that makes the bids
            comparable — then ranked in racks and weeks, not only in euros.
          </p>
          <ul className="mt-3 space-y-1 text-sm text-mute">
            <li>— No make, no model, no supplier named. We take no margin on hardware.</li>
            <li>— A bid that is cheaper and fourteen weeks slower is visible as the expensive one.</li>
            <li>
              — The quotations come back and replace our library defaults, so the next number we
              give you is stronger than this one.
            </li>
          </ul>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <button
              onClick={commission}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Commission it — {eur(spec.amountCents)}
            </button>
            <span className="text-xs text-faint">
              {spec.turnaroundDays} working days. One relief per engagement.
            </span>
          </div>
          {error ? <p className="mt-3 text-sm text-queue">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}
