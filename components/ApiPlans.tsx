"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { API_PRODUCTS, eurFromCents } from "@/lib/products";

/**
 * Buy metered access. Checkout runs in subscription mode; the webhook opens an
 * account and emails a link where the key is minted and shown once.
 *
 * The email field is not decoration: it is the only way the key reaches them, and
 * Stripe's receipt email is not guaranteed to be the one their engineers read.
 */
export default function ApiPlans() {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function buy(product: string) {
    setBusy(product);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, email: email || undefined, company }),
      });
      const data = await res.json();
      if (data.ok && data.url) {
        window.location.href = data.url as string;
        return;
      }
      setError(data.error || "Could not start checkout.");
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            Work email
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@operator.com"
            className="mt-1 w-full rounded border border-line bg-panel px-3 py-2 text-sm text-ghost placeholder:text-faint focus:border-power focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            Company
          </span>
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Operator BV"
            className="mt-1 w-full rounded border border-line bg-panel px-3 py-2 text-sm text-ghost placeholder:text-faint focus:border-power focus:outline-none"
          />
        </label>
      </div>
      <p className="mt-2 text-[11px] text-faint">
        The key link goes to this address. Use the one your engineers actually read.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {API_PRODUCTS.map((p) => (
          <div key={p.id} className="panel flex flex-col p-5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">
              {p.name}
            </span>
            <p className="mt-3 font-mono text-3xl font-semibold text-ghost">
              {eurFromCents(p.amountCents)}
              <span className="text-sm font-normal text-faint"> /month</span>
            </p>
            <p className="mt-1 text-xs text-faint">
              {(p.apiUnits ?? 0).toLocaleString("en-IE")} units ·{" "}
              {Math.floor((p.apiUnits ?? 0) / 5).toLocaleString("en-IE")} full solves, or{" "}
              {(p.apiUnits ?? 0).toLocaleString("en-IE")} screens
            </p>
            <p className="mt-3 flex-1 text-sm text-mute">{p.description}</p>
            <button
              onClick={() => buy(p.id)}
              disabled={busy !== null}
              className="mt-5 inline-flex items-center justify-center gap-2 rounded bg-power px-4 py-2.5 text-sm font-semibold text-ink disabled:opacity-50"
            >
              {busy === p.id ? "Opening checkout…" : "Start"}{" "}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {error ? <p className="mt-4 text-sm text-queue">{error}</p> : null}

      <p className="mt-5 text-xs text-faint">
        Monthly, cancel any time. No overage billing: over the allowance the engine returns 402
        and you upgrade or wait for the reset — we would rather you saw a refusal than an
        invoice you did not expect.
      </p>
    </div>
  );
}
