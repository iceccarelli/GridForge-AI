"use client";

import { useState } from "react";
import { AlertTriangle, Check, Copy, KeyRound, RefreshCw } from "lucide-react";

/**
 * Issue and rotate. The key is rendered exactly once, in this component, from the
 * response that minted it — it is never fetched, never stored and never shown
 * again. Rotation revokes the previous id, because a leaked key that keeps working
 * until it expires has been duplicated, not rotated.
 */
export default function ApiKeyPanel({
  token,
  engine,
  hasKey,
  keyId,
  expires,
  cancelled,
  signingConfigured,
}: {
  token: string;
  engine: string;
  hasKey: boolean;
  keyId: string | null;
  expires: string | null;
  cancelled: boolean;
  signingConfigured: boolean;
}) {
  const [key, setKey] = useState<string | null>(null);
  const [liveId, setLiveId] = useState(keyId);
  const [liveExpires, setLiveExpires] = useState(expires);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function mint(rotate: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, rotate }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Could not issue a key");
        return;
      }
      if (data.issued) {
        setKey(data.key);
        setLiveId(null);
        setLiveExpires(data.expires);
      } else {
        setError(data.note || "A key is already live for this account.");
      }
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not reach the clipboard — select the key and copy it manually.");
    }
  }

  if (!signingConfigured) {
    return (
      <div className="mt-8 rounded border border-flag/40 bg-flag/10 p-5 text-sm text-ghost">
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-flag">
          <AlertTriangle className="h-3.5 w-3.5" /> Key signing is not configured
        </span>
        <p className="mt-2 text-mute">
          GRIDFORGE_KEY_SECRET must be set here and on the engine, to the same value. Until then
          no key can be issued. This is our problem, not yours — we have been told.
        </p>
      </div>
    );
  }

  return (
    <section className="mt-8 rounded border border-line bg-panel-2 p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-ghost">
        <KeyRound className="h-4 w-4 text-power" /> Your key
      </h2>

      {key ? (
        <div className="mt-4">
          <div className="rounded border border-power/40 bg-power/10 p-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-power">
              Copy this now — it is shown once
            </p>
            <p className="mt-2 break-all font-mono text-xs text-ghost">{key}</p>
            <button
              onClick={copy}
              className="mt-3 inline-flex items-center gap-2 rounded bg-power px-4 py-2 text-sm font-semibold text-ink"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy key"}
            </button>
          </div>
          <p className="mt-3 text-xs text-faint">
            We do not store it. The engine verifies it by its signature, so there is no copy
            anywhere for anyone to take — including us. Valid until {liveExpires}; it renews
            automatically while the subscription is active.
          </p>
        </div>
      ) : (
        <div className="mt-4">
          {hasKey || liveId ? (
            <p className="text-sm text-mute">
              A key is live for this account (
              <span className="font-mono text-ghost">{liveId ?? keyId}</span>), valid until{" "}
              <span className="font-mono text-ghost">{liveExpires ?? expires}</span>. It cannot
              be shown again. If you have lost it, rotate — that issues a new one and revokes
              the current one.
            </p>
          ) : (
            <p className="text-sm text-mute">
              No key has been issued yet. Issue one and copy it — you will not see it twice.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            {!hasKey && !liveId ? (
              <button
                onClick={() => mint(false)}
                disabled={busy || cancelled}
                className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink disabled:opacity-50"
              >
                <KeyRound className="h-4 w-4" /> {busy ? "Issuing…" : "Issue my key"}
              </button>
            ) : (
              <button
                onClick={() => mint(true)}
                disabled={busy || cancelled}
                className="inline-flex items-center gap-2 rounded border border-line px-5 py-2.5 font-semibold text-ghost hover:border-power/50 disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" /> {busy ? "Rotating…" : "Rotate key"}
              </button>
            )}
          </div>
        </div>
      )}

      {error ? <p className="mt-4 text-sm text-queue">{error}</p> : null}

      <p className="mt-5 border-t border-line pt-4 text-[11px] text-faint">
        Send it as <span className="font-mono text-mute">x-api-key</span>, or as{" "}
        <span className="font-mono text-mute">Authorization: Bearer</span>, to{" "}
        <span className="font-mono text-mute">{engine}</span>.
      </p>
    </section>
  );
}
