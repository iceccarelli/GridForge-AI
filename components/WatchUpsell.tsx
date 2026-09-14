"use client";

import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { eur } from "@/lib/commerce";
import { PRODUCTS } from "@/lib/products";

/**
 * The follow-on offer, shown under a delivered study.
 *
 * This is the right moment and the honest argument: the document they have just
 * read is a photograph, and their hall is not. Nothing here claims the study goes
 * stale on a timer — it says what is true, that when an input moves or our own
 * libraries move, the answer can move with it.
 */
export function WatchUpsell() {
  const watch = PRODUCTS.hall_watch;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commission() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: watch.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok || !body.url) {
        setError(
          body?.error === "Payments not configured"
            ? "Checkout is not live on this deployment yet."
            : (body?.error ?? "Could not start checkout.")
        );
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
    <aside className="mt-10 rounded border border-line bg-panel-2 p-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
        Keep the model live
      </p>
      <h2 className="mt-2 text-xl font-semibold text-ghost">
        This document is a photograph. Your hall is not.
      </h2>
      <p className="mt-3 max-w-2xl text-sm text-mute">{watch.description}</p>
      <p className="mt-2 max-w-2xl text-xs text-faint">
        Including when the movement comes from our side — a quotation replacing a placeholder, a
        platform&apos;s figures revised, a constraint added. If nothing material changes, you get
        that in three lines rather than a document written to justify the fee.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={commission}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded bg-power px-4 py-2 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Start a Hall Watch · {eur(watch.amountCents)} per quarter
        </button>
        <span className="text-[11px] text-faint">Cancel any time; no minimum term.</span>
      </div>
      {error ? <p className="mt-3 text-sm text-flag">{error}</p> : null}
    </aside>
  );
}
