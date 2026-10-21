"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import CapChooser from "@/components/CapChooser";
import OneTimeKey from "@/components/OneTimeKey";
import UsageMeter from "@/components/UsageMeter";
import { PAYG } from "@/lib/products";
import { SITE } from "@/lib/site";
import {
  changeCap,
  enablePayg,
  getUsage,
  planLabel,
  type ClientFailure,
  type MintedKey,
  type Settlement,
  type UsageSnapshot,
} from "@/lib/payg-client";
import { billingRuleText, eurExact, formatUtc } from "@/lib/payg-pricing";

type Load =
  | { phase: "loading" }
  | { phase: "ready"; usage: UsageSnapshot }
  | { phase: "failed"; failure: Pick<ClientFailure, "kind" | "message"> };

const SETTLEMENT_WORDS: Record<string, string> = {
  pending: "Being invoiced",
  carried: "Carried to next month (under the minimum invoice)",
  invoiced: "Invoiced, awaiting payment",
  paid: "Paid",
  failed: "Payment failed",
  void: "Void",
  unknown: "Status not reported",
};

/**
 * The account portal body: plan, meter, last events, settlements, enabling pay-as-you-go, changing the cap,
 * and what to do when a payment fails or the engine answers 402.
 *
 * Everything dynamic comes from GET /api/usage. When that route is missing or failing closed, the sections
 * that need it say "not available on this deployment" and nothing is drawn in their place: no meter, no
 * invoices, no events. What the server page already knew (plan, status, allowance) is still shown.
 */
export default function PaygPortal({
  token,
  plan: planProp,
  status: statusProp,
  monthlyUnits,
}: {
  token: string;
  plan: string;
  status: string;
  monthlyUnits: number;
}) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const res = await getUsage(token);
    setLoad(res.ok ? { phase: "ready", usage: res.data } : { phase: "failed", failure: res });
    setRefreshing(false);
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const usage = load.phase === "ready" ? load.usage : null;
  const plan = usage?.account.plan ?? planProp;
  const status = usage?.account.status ?? statusProp;
  const isFree = plan === "api_free";
  const isPayg = plan === "api_payg";
  const active = status === "active";
  const cap = usage ? (usage.unitsCap ?? usage.account.capUnits) : null;
  const meterLabel = isFree ? "Free allowance this month" : isPayg ? "Your cap this month" : "Monthly quota";

  return (
    <div className="space-y-8">
      <section aria-labelledby="usage-heading" className="rounded border border-line bg-panel-2 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="usage-heading" className="text-lg font-semibold text-ghost">
            Plan and usage
          </h2>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex min-h-11 items-center gap-2 rounded border border-line px-3 py-1.5 text-sm text-mute hover:text-ghost disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <Fact k="Plan" v={planLabel(plan)} />
          <Fact k="Status" v={status === "active" ? "Active" : status === "past_due" ? "Payment failed" : status === "cancelled" ? "Cancelled" : status} />
          <Fact
            k={isFree || isPayg ? "Per-call price" : "Included"}
            v={
              isFree
                ? "Free, never invoiced"
                : isPayg
                  ? `${eurExact(usage?.unitPriceCents ?? PAYG.unitPriceCents)} a unit`
                  : `${monthlyUnits.toLocaleString("en-IE")} units a month`
            }
          />
        </dl>

        <div className="mt-5" aria-live="polite">
          {load.phase === "loading" ? (
            <p className="text-sm text-mute">Loading your usage</p>
          ) : usage ? (
            <UsageMeter
              label={meterLabel}
              used={usage.unitsUsed}
              cap={cap}
              accruedCents={isPayg ? usage.eurAccruedCents : null}
              unitPriceCents={usage.unitPriceCents ?? PAYG.unitPriceCents}
            />
          ) : (
            <p role="status" className="rounded border border-line bg-panel p-3 text-sm text-mute">
              Live usage is not shown: {load.phase === "failed" ? load.failure.message : ""} No figure is drawn in its
              place. You can still read the meter yourself with{" "}
              <span className="font-mono text-ghost">GET /v1/usage</span> and your key (see below).
            </p>
          )}
          {usage?.month ? <p className="mt-2 text-[11px] text-faint">Month: {usage.month} (UTC). Counters reset at the start of each UTC month.</p> : null}
        </div>
      </section>

      <Recovery status={status} isPayg={isPayg} />

      {isFree && active ? <EnablePayg token={token} /> : null}
      {isPayg && active ? <ChangeCap token={token} currentEur={usage?.account.capEur ?? null} onChanged={refresh} /> : null}

      <WhenRefused isFree={isFree} isPayg={isPayg} />

      <Events usage={usage} failed={load.phase === "failed"} />
      {isPayg ? <Settlements usage={usage} failed={load.phase === "failed"} /> : null}

      <section aria-labelledby="stop-heading" className="rounded border border-line bg-panel-2 p-5 sm:p-6">
        <h2 id="stop-heading" className="text-lg font-semibold text-ghost">
          Stopping, upgrading, closing
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-mute">
          {isPayg ? (
            <li>
              There is no subscription to cancel. With no calls there is no charge. To spend less, lower the cap
              above; to stop altogether, stop calling and rotate or discard the key. A month under{" "}
              {eurExact(PAYG.minInvoiceCents)} is carried forward rather than invoiced.
            </li>
          ) : null}
          {isFree ? (
            <li>
              Nothing to cancel: the free allowance has no card and no invoice. Unused allowance does not carry
              over.
            </li>
          ) : null}
          {!isFree && !isPayg ? (
            <li>
              This is a subscription with a fixed monthly quota and no overage: past it, the engine refuses
              paid calls until the month resets. Plans are separate accounts, so buying a larger one on the{" "}
              <Link href="/developers#plans" className="text-power underline">
                developers page
              </Link>{" "}
              opens its own account and key and does not change this one.
            </li>
          ) : null}
          <li>
            To close the account or ask about anything on this page, write to{" "}
            <a href={`mailto:${SITE.email}`} className="text-power underline">
              {SITE.email}
            </a>
            . Arrangements beyond the API itself, such as support or commercial terms, are agreed by email; none of
            them is provisioned automatically.
          </li>
        </ul>
      </section>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded border border-line bg-panel px-3 py-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{k}</dt>
      <dd className="mt-1 text-sm font-semibold text-ghost">{v}</dd>
    </div>
  );
}

function Recovery({ status, isPayg }: { status: string; isPayg: boolean }) {
  if (status === "active") return null;
  const cancelled = status === "cancelled";
  return (
    <section role="alert" className="rounded border border-flag/40 bg-flag/10 p-5 text-sm text-ghost">
      <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-flag">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        {cancelled ? "Account cancelled" : "Payment failed"}
      </p>
      {cancelled ? (
        <p className="mt-2 text-mute">
          This account has ended. Its live key has been revoked and no new one will be issued. A new account, from the
          developers page, starts clean.
        </p>
      ) : isPayg ? (
        <>
          <p className="mt-2 text-mute">
            The invoice for a settled month did not clear. Until it does, the live key is revoked (the engine stops
            accepting it) and no new key can be issued. Nothing further accrues while the key is dead.
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-mute">
            <li>
              Open the unpaid invoice from <strong className="font-semibold text-ghost">Settlements</strong> below and pay
              it, or fix the card on that invoice page.
            </li>
            <li>When the payment succeeds, this account returns to active on its own. Refresh this page to see it.</li>
            <li>
              Then rotate here to issue a new key. The revoked key does not come back, so put the new one into your
              deployment.
            </li>
          </ol>
          <p className="mt-3 text-xs text-faint">
            If an invoice is not listed or the link does not work, write to{" "}
            <a href={`mailto:${SITE.email}`} className="text-power underline">
              {SITE.email}
            </a>
            .
          </p>
        </>
      ) : (
        <p className="mt-2 text-mute">
          Your last subscription invoice did not clear. A key you already hold keeps working until it expires, but no
          new key can be issued until the payment succeeds. Pay the failed invoice from the email Stripe sent, or write
          to{" "}
          <a href={`mailto:${SITE.email}`} className="text-power underline">
            {SITE.email}
          </a>
          . A payment does not extend a key: rotate here once the account is active again.
        </p>
      )}
    </section>
  );
}

function EnablePayg({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(capEur: number) {
    setBusy(true);
    setError(null);
    const res = await enablePayg(token, capEur);
    if (res.ok) {
      window.location.href = res.data.url;
      return; // leaving the page: keep the button busy so it is not pressed twice
    }
    setError(res.message);
    setBusy(false);
  }

  return (
    <section aria-labelledby="enable-heading" className="rounded border border-power/40 bg-panel-2 p-5 sm:p-6">
      <h2 id="enable-heading" className="text-lg font-semibold text-ghost">
        Go beyond the free allowance: pay as you go
      </h2>
      <p className="mt-2 text-sm text-mute">
        Optional. Choose the most you are willing to spend in a month. The engine enforces it: when a call would take
        you over, it is refused and costs nothing. You save a card with Stripe; saving it does not charge it.
      </p>
      <div className="mt-4">
        <CapChooser
          submitLabel="Save a card and enable pay as you go"
          busyLabel="Opening Stripe"
          busy={busy}
          error={error}
          onSubmit={go}
        >
          <p className="mt-3 text-xs text-faint">{billingRuleText()}</p>
        </CapChooser>
      </div>
    </section>
  );
}

function ChangeCap({
  token,
  currentEur,
  onChanged,
}: {
  token: string;
  currentEur: number | null;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedKey | null>(null);

  async function go(capEur: number) {
    setBusy(true);
    setError(null);
    const res = await changeCap(token, capEur);
    setBusy(false);
    if (res.ok) {
      setMinted(res.data);
      void onChanged();
    } else {
      setError(res.message);
    }
  }

  return (
    <section aria-labelledby="cap-heading" className="rounded border border-line bg-panel-2 p-5 sm:p-6">
      <h2 id="cap-heading" className="text-lg font-semibold text-ghost">
        Your monthly cap{currentEur !== null ? `: ${eurExact(currentEur * 100)}` : ""}
      </h2>
      <p className="mt-2 text-sm text-mute">
        The cap is written into your key, which is how the engine can stop at it. Changing it therefore issues a new key
        and revokes the current one. Units already used this month stay on the account, whichever key made them.
      </p>
      {minted ? (
        <div className="mt-4" aria-live="polite">
          <p className="mb-3 text-sm text-verified">Cap changed. This is your new key.</p>
          <OneTimeKey secret={minted.key} expires={minted.expires}>
            {minted.revocationPending ? (
              <p className="mt-3 text-sm text-queue">
                {minted.revocationNote ??
                  "We could not confirm the engine has revoked the previous key yet. Treat it as still working until it is."}
              </p>
            ) : null}
          </OneTimeKey>
        </div>
      ) : (
        <div className="mt-4">
          <CapChooser
            initialEur={currentEur}
            submitLabel="Change cap and issue a new key"
            busyLabel="Changing the cap"
            busy={busy}
            error={error}
            onSubmit={go}
          />
        </div>
      )}
    </section>
  );
}

function WhenRefused({ isFree, isPayg }: { isFree: boolean; isPayg: boolean }) {
  return (
    <section aria-labelledby="refused-heading" className="rounded border border-line bg-panel-2 p-5 sm:p-6">
      <h2 id="refused-heading" className="text-lg font-semibold text-ghost">
        If the engine answers 402
      </h2>
      <p className="mt-2 text-sm text-mute">
        A 402 means &ldquo;buy more&rdquo;, not &ldquo;retry later&rdquo;: the call needed more units than you have left,
        so it was refused and not charged. The engine tells you to fix it on your account page. This is that page, and
        here is what to do:
      </p>
      <ul className="mt-3 space-y-2 text-sm text-mute">
        {isFree ? (
          <>
            <li>
              <strong className="font-semibold text-ghost">Enable pay as you go</strong> above, with a cap you choose, or
              wait for the allowance to reset at the start of the UTC month.
            </li>
            <li>
              Or take a plan from the{" "}
              <Link href="/developers#plans" className="text-power underline">
                developers page
              </Link>{" "}
              if your volume warrants one.
            </li>
          </>
        ) : isPayg ? (
          <li>
            You reached your own cap. <strong className="font-semibold text-ghost">Raise it above</strong> (that issues a
            new key), or wait for the month to reset. The engine will not go past the cap, which is the point of it.
          </li>
        ) : (
          <li>
            You used this month&apos;s quota. Subscriptions have no overage. Wait for the reset at the start of the UTC
            month, or buy a larger plan from the{" "}
            <Link href="/developers#plans" className="text-power underline">
              developers page
            </Link>
            .
          </li>
        )}
        <li>
          A 402 can also mean the account&apos;s latest payment has not cleared. If a banner above says so, follow the
          steps in it.
        </li>
      </ul>
    </section>
  );
}

function Events({ usage, failed }: { usage: UsageSnapshot | null; failed: boolean }) {
  return (
    <section aria-labelledby="events-heading" className="rounded border border-line bg-panel-2 p-5 sm:p-6">
      <h2 id="events-heading" className="text-lg font-semibold text-ghost">
        Last events
      </h2>
      {!usage ? (
        <p role="status" className="mt-3 text-sm text-mute">
          {failed ? "Not available on this deployment, or not reachable right now." : "Loading."} No events are shown
          rather than invented ones.
        </p>
      ) : usage.events.length === 0 ? (
        <p className="mt-3 text-sm text-mute">No calls recorded yet.</p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <caption className="sr-only">Most recent metered calls, newest first</caption>
              <thead>
                <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                  <th scope="col" className="py-2 pr-3">When</th>
                  <th scope="col" className="py-2 pr-3">Endpoint</th>
                  <th scope="col" className="py-2 pr-3 text-right">Units</th>
                  <th scope="col" className="py-2">Project</th>
                </tr>
              </thead>
              <tbody>
                {usage.events.slice(0, 20).map((e, i) => (
                  <tr key={`${e.ts}-${i}`} className="border-b border-line/60">
                    <td className="py-2 pr-3 font-mono text-xs text-mute">{formatUtc(e.ts)}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-ghost">{e.endpoint}</td>
                    <td className="py-2 pr-3 text-right font-mono text-xs">
                      {e.kind === "refund" ? (
                        <span className="text-verified">refund -{e.units}</span>
                      ) : (
                        <span className="text-ghost">{e.units}</span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-xs text-mute">{e.project || "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-faint">
            A refund reverses a call that produced no answer. It is netted off before anything is invoiced.
          </p>
        </>
      )}
    </section>
  );
}

function Settlements({ usage, failed }: { usage: UsageSnapshot | null; failed: boolean }) {
  return (
    <section aria-labelledby="settle-heading" className="rounded border border-line bg-panel-2 p-5 sm:p-6">
      <h2 id="settle-heading" className="text-lg font-semibold text-ghost">
        Settlements
      </h2>
      <p className="mt-2 text-sm text-mute">{billingRuleText()}</p>
      {!usage ? (
        <p role="status" className="mt-3 text-sm text-mute">
          {failed ? "Not available on this deployment, or not reachable right now." : "Loading."} No invoices are shown
          rather than invented ones.
        </p>
      ) : usage.settlements.length === 0 ? (
        <p className="mt-3 text-sm text-mute">
          No month has been settled yet. A month is invoiced after it closes, and only if it has net usage.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <caption className="sr-only">Monthly settlements and their Stripe invoices</caption>
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                <th scope="col" className="py-2 pr-3">Month</th>
                <th scope="col" className="py-2 pr-3 text-right">Units</th>
                <th scope="col" className="py-2 pr-3 text-right">Amount</th>
                <th scope="col" className="py-2 pr-3">Status</th>
                <th scope="col" className="py-2">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {usage.settlements.map((s) => (
                <SettlementRow key={s.month} s={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SettlementRow({ s }: { s: Settlement }) {
  return (
    <tr className="border-b border-line/60">
      <td className="py-2 pr-3 font-mono text-xs text-ghost">{s.month}</td>
      <td className="py-2 pr-3 text-right font-mono text-xs text-mute">{s.units ?? "n/a"}</td>
      <td className="py-2 pr-3 text-right font-mono text-xs text-ghost">{s.amountCents === null ? "n/a" : eurExact(s.amountCents)}</td>
      <td className={`py-2 pr-3 text-xs ${s.status === "failed" ? "text-flag" : s.status === "paid" ? "text-verified" : "text-mute"}`}>
        {SETTLEMENT_WORDS[s.status]}
      </td>
      <td className="py-2 text-xs">
        {s.invoiceUrl ? (
          <a
            href={s.invoiceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-8 items-center gap-1 text-power underline"
            aria-label={`Open the Stripe invoice for ${s.month} (opens in a new tab)`}
          >
            View invoice <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : (
          <span className="text-faint">none yet</span>
        )}
      </td>
    </tr>
  );
}
