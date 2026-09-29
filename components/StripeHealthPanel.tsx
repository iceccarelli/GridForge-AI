"use client";

import { useState } from "react";
import { Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";

interface StripeWebhookHealth {
  configured: boolean;
  reachable: boolean;
  error: string | null;
  expectedUrl: string;
  endpoint: { id: string; url: string; status: string; enabledEvents: string[] } | null;
  missingEvents: string[];
  urlMismatch: boolean;
  healthy: boolean;
  checkedAt: string;
}

/**
 * On demand, not on every dashboard load: this calls the live Stripe account,
 * and there is no reason to spend that round trip (or risk it going stale)
 * every time someone opens /admin. See lib/stripe-health.ts for why this
 * exists at all -- correct webhook handler code and a correctly configured
 * Stripe webhook endpoint are two different facts, and only one of them is
 * visible from this repository.
 */
export function StripeHealthPanel() {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [health, setHealth] = useState<StripeWebhookHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setState("busy");
    setError(null);
    try {
      const res = await fetch("/api/admin/stripe-health");
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not check webhook health.");
        setState("error");
        return;
      }
      setHealth(body.health as StripeWebhookHealth);
      setState("done");
    } catch {
      setError("Could not reach the server.");
      setState("error");
    }
  }

  return (
    <div className="rounded border border-line bg-panel-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          Stripe webhook health
        </h3>
        <button
          onClick={check}
          disabled={state === "busy"}
          className="inline-flex items-center gap-2 rounded border border-line px-3 py-1.5 text-xs font-semibold text-ghost hover:border-power/50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Check now
        </button>
      </div>

      {error && <p className="mt-2 text-[12px] text-flag">{error}</p>}

      {health && (
        <div className="mt-3 space-y-2 text-[12px]">
          <div className="flex items-center gap-2">
            {health.healthy ? (
              <CheckCircle2 className="h-4 w-4 text-power" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-flag" />
            )}
            <span className={health.healthy ? "text-ghost" : "text-flag"}>
              {health.healthy
                ? "Subscription lifecycle events are configured and enabled."
                : health.error}
            </span>
          </div>
          <p className="text-faint">Expected endpoint: {health.expectedUrl}</p>
          {health.endpoint && (
            <>
              <p className="text-faint">
                Registered endpoint: {health.endpoint.url} ({health.endpoint.status})
              </p>
              <p className="text-faint">
                Enabled events: {health.endpoint.enabledEvents.join(", ") || "none"}
              </p>
            </>
          )}
          {health.missingEvents.length > 0 && (
            <p className="text-flag">Missing: {health.missingEvents.join(", ")}</p>
          )}
          <p className="text-faint">Checked {new Date(health.checkedAt).toLocaleString()}</p>
        </div>
      )}
    </div>
  );
}
