"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A freshly minted key, shown exactly once.
 *
 * The key is rendered from the response that minted it and is never fetched, stored or shown again: the engine
 * verifies keys by their signature, so there is no copy anywhere for anyone to take. Shared by the key panel
 * and the cap-change flow (a cap lives in the signed key, so changing it mints a new key).
 */
export default function OneTimeKey({
  secret,
  expires,
  children,
}: {
  secret: string;
  expires: string | null;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setCopyError(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <div>
      <div className="rounded border border-power/40 bg-power/10 p-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-power">
          Copy this now: it is shown once
        </p>
        <p className="mt-2 break-all font-mono text-xs text-ghost">{secret}</p>
        <button
          type="button"
          onClick={copy}
          className="mt-3 inline-flex min-h-11 items-center gap-2 rounded bg-power px-4 py-2 text-sm font-semibold text-ink"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy key"}
        </button>
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? "Key copied to the clipboard" : ""}
        </span>
        {copyError ? (
          <p role="alert" className="mt-2 text-sm text-queue">
            Could not reach the clipboard. Select the key above and copy it manually.
          </p>
        ) : null}
      </div>
      <p className="mt-3 text-xs text-faint">
        We do not store it. The engine verifies it by its signature, so there is no copy anywhere for
        anyone to take, including us.
        {expires ? (
          <>
            {" "}
            It is valid until <span className="font-mono text-mute">{expires}</span> and{" "}
            <strong className="font-semibold text-mute">does not renew by itself</strong>: before that date you
            rotate it here and put the new one into your deployment. A payment does not extend a key, because a
            new expiry means a new signature.
          </>
        ) : null}
      </p>
      {children}
    </div>
  );
}
