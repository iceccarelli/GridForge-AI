"use client";

import { useId, useState } from "react";
import { ArrowRight } from "lucide-react";
import { API_PRODUCTS, eurFromCents } from "@/lib/products";
import { SITE } from "@/lib/site";
import { breakEven, type ToolRate } from "@/lib/payg-pricing";

/**
 * Buy a monthly plan. Checkout runs in subscription mode; the webhook opens an account and emails a link where
 * the key is minted and shown once.
 *
 * What a plan IS is stated from the catalogue's structured fields only: price, included units, and what those
 * units buy at the engine's published weights. The catalogue's free-text descriptions also list perks that are
 * arranged by hand (named engineers, priority, roadmap input, redistribution terms). None of that is
 * provisioned by the key or automated, so it is not presented as a feature of any plan; the one sentence below
 * the cards says what it is.
 *
 * The email field is not decoration: it is the only way the key reaches them, and Stripe's receipt email is not
 * guaranteed to be the one their engineers read.
 */
export default function ApiPlans({ rates = [] }: { rates?: ToolRate[] }) {
  const uid = useId();
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const units = (ep: string) => rates.find((r) => r.endpoint === ep)?.units ?? 0;
  const study = units("/v1/study");
  const screen = units("/v1/screen");

  async function buy(product: string) {
    setBusy(product);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, email: email || undefined, company }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.url) {
        window.location.href = data.url as string;
        return;
      }
      setError(data.error || "Could not start checkout.");
    } catch {
      setError("Network error. Nothing was charged. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const input =
    "mt-1 min-h-11 w-full rounded border border-line bg-panel px-3 py-2 text-base text-ghost placeholder:text-faint focus:border-power focus:outline-none focus:ring-2 focus:ring-power/40";
  const lab = "font-mono text-[10px] uppercase tracking-[0.14em] text-faint";

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-email`} className={lab}>
            Work email
          </label>
          <input
            id={`${uid}-email`}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@operator.com"
            aria-describedby={`${uid}-hint`}
            className={input}
          />
        </div>
        <div>
          <label htmlFor={`${uid}-company`} className={lab}>
            Company
          </label>
          <input
            id={`${uid}-company`}
            autoComplete="organization"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Operator BV"
            className={input}
          />
        </div>
      </div>
      <p id={`${uid}-hint`} className="mt-2 text-[11px] text-faint">
        The key link goes to this address. Use the one your engineers actually read.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {API_PRODUCTS.map((p) => {
          const n = p.apiUnits ?? 0;
          const be = breakEven(p);
          return (
            <div key={p.id} className="panel flex flex-col p-5">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">{p.name}</span>
              <p className="mt-3 font-mono text-3xl font-semibold text-ghost">
                {eurFromCents(p.amountCents)}
                <span className="text-sm font-normal text-faint"> /month</span>
              </p>
              <p className="mt-1 text-xs text-faint">
                {n.toLocaleString("en-IE")} units
                {study > 0 && screen > 0
                  ? `: ${Math.floor(n / study).toLocaleString("en-IE")} full studies, or ${Math.floor(n / screen).toLocaleString("en-IE")} screens, or any mix`
                  : ""}
              </p>
              <ul className="mt-3 flex-1 space-y-1.5 text-sm text-mute">
                <li>A signed API key and the MCP endpoint, with the same endpoints and evidence on every number as the free allowance.</li>
                <li>{be.text}</li>
                <li>Screening-mode output only: no issued opinion, no named signatory, no professional indemnity.</li>
              </ul>
              <button
                type="button"
                onClick={() => buy(p.id)}
                disabled={busy !== null}
                className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded bg-power px-4 py-2.5 text-sm font-semibold text-ink disabled:opacity-50"
              >
                {busy === p.id ? "Opening checkout" : `Start ${p.name}`} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>

      <div aria-live="polite">
        {error ? (
          <p role="alert" className="mt-4 text-sm text-queue">
            {error}
          </p>
        ) : null}
      </div>

      <p className="mt-5 text-xs text-faint">
        Billed monthly through Stripe. To cancel, write to{" "}
        <a href={`mailto:${SITE.email}`} className="text-mute underline">
          {SITE.email}
        </a>
        . No overage billing: past the included units the engine returns 402 and refuses the call, so you never meet an
        invoice you did not expect. Anything beyond the API itself, such as support, a named contact or redistribution
        terms, is arranged by email after purchase. It is not automated and it is not part of what the key does. No
        availability SLA comes with any plan.
      </p>
    </div>
  );
}
