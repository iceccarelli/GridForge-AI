"use client";

import React, { useEffect, useState } from "react";
import {
  INTELLIGENCE_CANCEL_TERMS,
  INTELLIGENCE_PORTAL_EXPLANATION,
  MANAGE_SUBSCRIPTION_LABEL,
  memberBillingNote,
  portalUnavailableMessage,
  suspendedAccessNote,
} from "@/lib/subscription-manage";
import { openIntelligencePortal, type ClientFailure, type FetchLike } from "@/lib/payg-client";

/**
 * Billing for a GridForge Intelligence subscription, on the signed-in account page. Two people can see this page paid for, and only one of them
 * can act on it:
 *
 *   owner   the billing owner: the label button, which opens Stripe's billing page for THIS subscription (POST /api/billing/portal with the
 *           Supabase session; the server reads the Stripe customer from the owner's own row), and the one sentence on what cancelling does
 *           (INTELLIGENCE_CANCEL_TERMS, the same one the sales page and the Terms print).
 *   member  a seat on someone else's subscription: no button, because the server would refuse it (403). It says the account owner manages
 *           billing and, where the page already shows the owner's address to members, whose it is.
 *
 * Nothing is cancelled by opening the portal; a cancellation reaches the site only when Stripe reports it (the signed webhook).
 */

/** Failures that mean "self-service is not available", where the page names the one next step. Refusals of WHO (401/402/403/429) keep the server's words. */
function failureMessage(f: ClientFailure): string {
  return f.kind === "unavailable" || f.kind === "network" || f.kind === "server" || f.status === 409
    ? f.message.includes("write to ")
      ? f.message
      : `${f.message} ${portalUnavailableMessage()}`
    : f.message;
}

/** Ask for the portal. Returns the https URL to go to, or the message to show. Exported so the behaviour is testable without a browser. */
export async function requestIntelligencePortal(
  authHeaders: () => Promise<Record<string, string>>,
  f?: FetchLike
): Promise<{ url: string } | { message: string }> {
  let auth: Record<string, string>;
  try {
    auth = await authHeaders();
  } catch {
    return { message: "Sign in again, then try once more." };
  }
  const res = await openIntelligencePortal(auth, f);
  return res.ok ? { url: res.data.url } : { message: failureMessage(res) };
}

/**
 * What /account says where it has no entitling subscription to show (the Gate): the page cannot tell "never subscribed" from "suspended by a
 * full refund, an open dispute or a pause" (/api/subscription-status answers `active: false` for both), so it names the next step for the
 * second kind of visitor and does NOT print the owner's cancel control or sentence, which exist only while access is on.
 */
export function SuspendedAccessNote() {
  return (
    <p className="mt-3 max-w-xl text-[13px] text-mute" data-testid="suspended-access-note">
      {suspendedAccessNote()}
    </p>
  );
}

export function IntelligenceManage({
  role,
  ownerEmail,
  authHeaders,
}: {
  role: "owner" | "member";
  /** The owner's address, set only for a member: it is what /api/subscription-status already tells a seat holder. */
  ownerEmail: string | null;
  authHeaders: () => Promise<Record<string, string>>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Back from Stripe's billing page (the portal's return address is /account?billing=returned): the change, if any, is Stripe's until it reports it.
  const [returned, setReturned] = useState(false);
  useEffect(() => {
    try {
      setReturned(new URLSearchParams(window.location.search).get("billing") === "returned");
    } catch {
      /* no location: nothing to say */
    }
  }, []);

  if (role === "member") {
    return (
      <section aria-labelledby="intel-billing-heading" className="mt-8 rounded-[var(--radius)] border border-line bg-panel p-6">
        <h2 id="intel-billing-heading" className="text-lg font-semibold tracking-tight">Billing</h2>
        <p className="mt-2 text-[13px] text-mute">{memberBillingNote(ownerEmail)}</p>
      </section>
    );
  }

  async function open() {
    setBusy(true);
    setMessage(null);
    const r = await requestIntelligencePortal(authHeaders);
    if ("url" in r) {
      window.location.href = r.url;
      return; // leaving the page: stay busy so it is not pressed twice
    }
    setMessage(r.message);
    setBusy(false);
  }

  return (
    <section aria-labelledby="intel-billing-heading" className="mt-8 rounded-[var(--radius)] border border-line bg-panel p-6">
      <h2 id="intel-billing-heading" className="text-lg font-semibold tracking-tight">{MANAGE_SUBSCRIPTION_LABEL}</h2>
      <p className="mt-2 max-w-2xl text-[13px] text-mute">{INTELLIGENCE_PORTAL_EXPLANATION}</p>
      <p className="mt-2 max-w-2xl text-[13px] text-mute" data-testid="cancel-terms">{INTELLIGENCE_CANCEL_TERMS}</p>
      {returned ? (
        <p role="status" className="mt-3 text-[13px] text-ghost">
          Back from Stripe. Any change you made is saved with Stripe and reaches this account when Stripe reports it.
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void open()}
        disabled={busy}
        className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-5 py-2.5 text-sm font-semibold text-ghost hover:border-power/50 disabled:opacity-60"
      >
        {busy ? "Opening Stripe" : MANAGE_SUBSCRIPTION_LABEL}
      </button>
      {message ? (
        <p role="alert" className="mt-3 text-sm text-flag">
          {message}
        </p>
      ) : null}
    </section>
  );
}
