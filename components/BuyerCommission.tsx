"use client";

import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import type { ProductId } from "@/lib/products";

/**
 * Start a checkout for the project behind a buyer link.
 *
 * The product id and the link go to the existing /api/checkout, which prices the session from lib/products.ts and refuses
 * a revoked link before Stripe is touched. This component holds no price: the label it is given is built on the server
 * from the same catalogue entry.
 */
export function BuyerCommission({
  shareToken,
  options,
}: {
  shareToken: string;
  options: { id: ProductId; label: string; primary: boolean }[];
}) {
  const [busy, setBusy] = useState<ProductId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");

  async function go(product: ProductId) {
    setBusy(product);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product,
          project_share_token: shareToken,
          email: email.trim() || undefined,
          service: "buyer-page",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok && body?.url) {
        window.location.href = body.url as string;
        return;
      }
      setError(
        body?.error === "Payments not configured"
          ? "Checkout is not live on this deployment yet. Nothing was charged."
          : (body?.error ?? "Could not start checkout. Nothing was charged.")
      );
    } catch {
      setError("Could not reach checkout. Nothing was charged.");
    }
    setBusy(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="text-xs text-mute" htmlFor="buyer-email">
        Billing email (optional)
      </label>
      <input
        id="buyer-email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full max-w-sm rounded border border-line bg-ink px-3 py-2 text-sm text-ghost"
      />
      <div className="flex flex-wrap gap-3">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={busy !== null}
            onClick={() => void go(o.id)}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
              o.primary ? "bg-power text-ink hover:bg-power/90" : "border border-line text-ghost hover:border-power/50"
            }`}
          >
            {busy === o.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {busy === o.id ? "Opening checkout" : o.label}
            {busy === o.id ? null : <ArrowRight className="h-4 w-4" aria-hidden />}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="max-w-md text-[13px] text-flag">
          {error}
        </p>
      ) : null}
      <p className="max-w-md text-[11px] text-faint">Nothing is charged until payment is completed on Stripe&apos;s page.</p>
    </div>
  );
}
