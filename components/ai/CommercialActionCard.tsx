"use client";

import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { startCommission } from "@/lib/ui";
import type { CommercialActionBlock } from "./types";

/**
 * Renders a checkout CTA for exactly one existing catalogue product. The price,
 * name and turnaround are read from lib/products.ts at render time — this
 * component has no price of its own and cannot drift from what Stripe charges.
 * Checkout itself goes through the existing startCommission()/api/checkout path
 * (lib/ui.ts), unmodified.
 */
export function CommercialActionCard({ block }: { block: CommercialActionBlock }) {
  const [loading, setLoading] = useState(false);
  const product = PRODUCTS[block.productId];

  if (!product) {
    // Should not happen — productId is validated against the enum before this
    // renders — but never fabricate a fallback price.
    return (
      <div className="panel p-5 border-flag/40">
        <p className="text-[13px] text-flag">Unknown product id: {block.productId}</p>
      </div>
    );
  }

  const priceLabel = product.recurring
    ? `${eurFromCents(product.amountCents)} / ${product.recurring.intervalCount > 1 ? `${product.recurring.intervalCount} ${product.recurring.interval}s` : product.recurring.interval}`
    : product.opensBandCents
      ? `${eurFromCents(product.opensBandCents[0])}–${eurFromCents(product.opensBandCents[1])} (deposit ${eurFromCents(product.amountCents)})`
      : eurFromCents(product.amountCents);

  async function go() {
    setLoading(true);
    console.log("[GridForge] ai_checkout_started", { productId: block.productId, reason: block.reason });
    // block.context (see components/ai/types.ts) is the attribution tag the
    // response block itself asked to carry into Stripe metadata.service — honour
    // it when the server set one, and fall back to a workspace-scoped tag
    // otherwise so every AI-originated checkout is still identifiable at the
    // webhook (see the ai_checkout_started/ai_checkout_completed logging in
    // app/api/checkout/route.ts and app/api/stripe/webhook/route.ts).
    const context = block.context ?? `workspace-${block.productId}`;
    const outcome = await startCommission(block.productId, { context });
    if (!outcome.ok) {
      toast.error(outcome.error);
      setLoading(false);
    }
    // On success the browser navigates away — no need to reset loading.
  }

  return (
    <div className="panel p-5 border-power/30">
      <div className="eyebrow mb-1">COMMERCIAL ACTION</div>
      <h4 className="text-base font-semibold text-ghost">{product.name}</h4>
      <p className="text-[13px] text-mute leading-relaxed mt-1.5 mb-1">{block.reason}</p>
      <p className="text-[12px] text-faint leading-relaxed mb-4">{product.description}</p>

      <div className="flex items-center justify-between gap-3">
        <div className="data text-lg font-semibold text-power">
          {priceLabel}
          {product.turnaroundDays > 0 && (
            <span className="text-xs text-faint ml-2">{product.turnaroundDays} days</span>
          )}
        </div>
        <button
          onClick={go}
          disabled={loading}
          className="btn-primary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-2 disabled:opacity-60"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
          Commission {product.name} — {eurFromCents(product.amountCents)}
        </button>
      </div>
    </div>
  );
}
