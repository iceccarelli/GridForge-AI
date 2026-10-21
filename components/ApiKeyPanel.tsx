"use client";

import { useState } from "react";
import { AlertTriangle, KeyRound, RefreshCw } from "lucide-react";
import OneTimeKey from "@/components/OneTimeKey";
import { FREE_CAPACITY_MESSAGE, isFreeCapacityRefusal } from "@/lib/payg-client";

/**
 * Issue and rotate. The key is rendered exactly once, in this component, from the
 * response that minted it: it is never fetched, never stored and never shown
 * again. Rotation revokes the previous id, because a leaked key that keeps working
 * until it expires has been duplicated, not rotated.
 *
 * A key does NOT renew. It carries its own expiry inside its signature so the
 * engine can verify it offline, which means nothing can extend it in place: not a
 * subscription payment, not a new invoice. The customer rotates, and this panel
 * says how many days are left rather than implying it looks after itself.
 */
export default function ApiKeyPanel({
  token,
  engine,
  hasKey,
  keyId,
  expires,
  daysLeft,
  needsRotation,
  status,
  cancelled,
  signingConfigured,
}: {
  token: string;
  engine: string;
  hasKey: boolean;
  keyId: string | null;
  expires: string | null;
  /** Days until the live key expires; negative once it has. Null when there is no key. */
  daysLeft: number | null;
  needsRotation: boolean;
  status: string;
  cancelled: boolean;
  signingConfigured: boolean;
}) {
  const [key, setKey] = useState<string | null>(null);
  const [liveId, setLiveId] = useState(keyId);
  const [liveExpires, setLiveExpires] = useState(expires);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [capacityFull, setCapacityFull] = useState(false);

  const blocked = cancelled || status !== "active";

  async function mint(rotate: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setCapacityFull(false);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, rotate }),
      });
      const data = await res.json().catch(() => ({}));
      if (isFreeCapacityRefusal(res.status, data)) {
        // Not "slow down": this month's free allowances are all taken. Pay-as-you-go needs none.
        setCapacityFull(true);
        return;
      }
      if (!data.ok) {
        setError(data.error || "Could not issue a key.");
        return;
      }
      if (data.issued) {
        setKey(data.key);
        setLiveId(null);
        setLiveExpires(data.expires);
        if (data.new_key_unverified && data.rotation_note) setNotice(String(data.rotation_note));
        else if (data.revocation_pending && data.revocation_note) setNotice(String(data.revocation_note));
      } else {
        setError(data.note || "A key is already live for this account.");
      }
    } catch {
      setError("Network error. Nothing was changed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!signingConfigured) {
    return (
      <div className="mt-8 rounded border border-flag/40 bg-flag/10 p-5 text-sm text-ghost">
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-flag">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Key signing is not configured
        </span>
        <p className="mt-2 text-mute">
          GRIDFORGE_KEY_SECRET must be set here and on the engine, to the same value. Until then
          no key can be issued. This is our problem, not yours.
        </p>
      </div>
    );
  }

  const expiryLine =
    daysLeft === null
      ? null
      : daysLeft < 0
        ? "This key has expired. Mint a replacement; the old one is already dead."
        : needsRotation
          ? `This key expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Rotate it before then: it will not extend itself.`
          : `This key expires in ${daysLeft} days. It does not renew by itself; rotate it before then.`;

  return (
    <section className="mt-8 rounded border border-line bg-panel-2 p-5 sm:p-6" aria-labelledby="key-heading">
      <h2 id="key-heading" className="flex items-center gap-2 text-lg font-semibold text-ghost">
        <KeyRound className="h-4 w-4 text-power" aria-hidden /> Your key
      </h2>

      {key ? (
        <div className="mt-4">
          <OneTimeKey secret={key} expires={liveExpires} />
        </div>
      ) : (
        <div className="mt-4">
          {hasKey || liveId ? (
            <>
              <p className="text-sm text-mute">
                A key is live for this account (
                <span className="font-mono text-ghost">{liveId ?? keyId}</span>), valid until{" "}
                <span className="font-mono text-ghost">{liveExpires ?? expires}</span>. It cannot be
                shown again. If you have lost it, rotate: that issues a new one and revokes the
                current one immediately.
              </p>
              {expiryLine ? (
                <p
                  className={`mt-2 text-sm ${daysLeft !== null && (daysLeft < 0 || needsRotation) ? "text-queue" : "text-mute"}`}
                >
                  {expiryLine}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-mute">
              No key has been issued yet. Issue one and copy it: you will not see it twice.
            </p>
          )}
          {blocked ? (
            <p className="mt-3 text-sm text-queue">
              {cancelled
                ? "This account is cancelled, so no key can be issued."
                : "A key cannot be issued or rotated while the latest payment is outstanding. See what to do below."}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            {!hasKey && !liveId ? (
              <button
                type="button"
                onClick={() => mint(false)}
                disabled={busy || blocked}
                className="inline-flex min-h-11 items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink disabled:opacity-50"
              >
                <KeyRound className="h-4 w-4" aria-hidden /> {busy ? "Issuing" : "Issue my key"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => mint(true)}
                disabled={busy || blocked}
                className="inline-flex min-h-11 items-center gap-2 rounded border border-line px-5 py-2.5 font-semibold text-ghost hover:border-power/50 disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" aria-hidden /> {busy ? "Rotating" : "Rotate key"}
              </button>
            )}
          </div>
        </div>
      )}

      <div aria-live="polite">
        {notice ? <p className="mt-4 text-sm text-queue">{notice}</p> : null}
        {capacityFull ? (
          <div role="alert" className="mt-4 rounded border border-queue/40 bg-queue/10 p-4 text-sm text-ghost">
            <p>{FREE_CAPACITY_MESSAGE}</p>
            <p className="mt-2">
              <a href="#enable-heading" className="text-power underline">
                Go to pay as you go
              </a>
            </p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-queue">
            {error}
          </p>
        ) : null}
      </div>

      <p className="mt-5 border-t border-line pt-4 text-[11px] text-faint">
        Send it as <span className="font-mono text-mute">x-api-key</span>, or as{" "}
        <span className="font-mono text-mute">Authorization: Bearer</span>, to{" "}
        <span className="break-all font-mono text-mute">{engine}</span>.
      </p>
    </section>
  );
}
