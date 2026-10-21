"use client";

import React, { useState } from "react";
import { Loader2 } from "lucide-react";

/**
 * "Cancel any time; no minimum term" needs a way to do it. This opens the Stripe billing portal for this watch's own
 * subscription (POST /api/billing/portal { token }); Stripe, not this site, handles the cancellation. Cancelling stops the
 * scheduled runs (the webhook marks the watch cancelled); notes already stored stay readable.
 *
 * If that route is not deployed (404) or the portal cannot be opened, it says so and falls back to email, which is the only
 * other route and is answered by a person. It never pretends the subscription was cancelled: the page shows `cancelled`
 * only once Stripe has said so.
 */
/**
 * Ask the billing route for this watch's portal. A 404 (the route is not deployed), any refusal and any network failure are
 * "fall back to email"; only a real https portal URL is followed.
 */
export async function requestPortal(token: string, doFetch: typeof fetch = fetch): Promise<{ url: string } | { message: string }> {
  try {
    const res = await doFetch("/api/billing/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.status === 404) return { message: "Self-service cancellation is not available on this deployment yet." };
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || typeof body.url !== "string" || !/^https:\/\//.test(body.url)) {
      return { message: body.error ?? "We could not open the billing portal just now." };
    }
    return { url: body.url };
  } catch {
    return { message: "We could not reach the billing portal just now." };
  }
}

export function WatchManage({ token, email }: { token: string; email: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);

  async function open() {
    setBusy(true);
    setMessage(null);
    setFallback(false);
    const r = await requestPortal(token);
    if ("url" in r) {
      window.location.href = r.url;
      return;
    }
    setFallback(true);
    setMessage(r.message);
    setBusy(false);
  }

  return (
    <section className="mt-10 max-w-3xl rounded border border-line bg-panel-2 p-5" aria-label="Manage subscription">
      <h2 className="text-sm font-semibold text-ghost">Manage or cancel the subscription</h2>
      <p className="mt-1 text-xs text-faint">
        Opens Stripe&apos;s billing portal for this watch: update the card, see invoices, or cancel. Cancelling is handled by Stripe;
        once it is recorded here the scheduled runs stop and this page says the watch was cancelled. The notes you already have
        stay readable. Nothing is cancelled by opening the portal.
      </p>
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className="mt-3 inline-flex items-center gap-2 rounded border border-line px-4 py-2 text-sm text-ghost hover:border-power/60 disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Manage or cancel subscription
      </button>
      {message ? (
        <p className="mt-3 text-sm text-mute" role="status">
          {message}
          {fallback ? (
            <>
              {" "}
              To cancel or change it now, email{" "}
              <a href={`mailto:${email}?subject=Hall%20Watch%20subscription`} className="text-power hover:underline">
                {email}
              </a>{" "}
              from the address you paid with.
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
