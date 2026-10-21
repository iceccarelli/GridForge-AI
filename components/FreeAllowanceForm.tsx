"use client";

import { useId, useRef, useState } from "react";
import { ArrowRight, CircleAlert, Loader2, MailCheck } from "lucide-react";
import Link from "next/link";
import { PAYG } from "@/lib/products";
import { QUALIFY_LINK } from "@/lib/nav";
import { requestFreeAccount, validateEmail, type ClientFailure } from "@/lib/payg-client";

type Phase =
  | { name: "idle" }
  | { name: "sending" }
  | { name: "sent"; email: string }
  | { name: "error"; failure: Pick<ClientFailure, "kind" | "message"> };

/**
 * Free developer allowance: an email address and nothing else.
 *
 * No card is asked for and no key is shown here. The link in the email opens the portal, and the key is
 * minted there: clicking it is the email verification. The server answers identically whether the address is
 * new or already has an account, so "Check your email" says only what is true: if an account can be made, the
 * link is on its way. Used on /developers, the home page and under a qualifier result.
 */
export default function FreeAllowanceForm({
  compact = false,
  heading = "Get the free allowance",
}: {
  compact?: boolean;
  heading?: string;
}) {
  const uid = useId();
  const inputId = `${uid}-email`;
  const hintId = `${uid}-hint`;
  const errId = `${uid}-err`;
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const sentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sending = phase.name === "sending";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    const v = validateEmail(email);
    if (!v.ok) {
      setFieldError(v.error);
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    setPhase({ name: "sending" });
    const res = await requestFreeAccount({ email: v.email });
    if (res.ok) {
      setPhase({ name: "sent", email: v.email });
      // Move focus to the confirmation so a screen-reader or keyboard user lands on it.
      setTimeout(() => sentRef.current?.focus(), 0);
    } else {
      setPhase({ name: "error", failure: res });
    }
  }

  function again() {
    setPhase({ name: "idle" });
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  if (phase.name === "sent") {
    return (
      <div
        ref={sentRef}
        tabIndex={-1}
        role="status"
        className="rounded border border-verified/40 bg-verified/10 p-5 outline-none focus-visible:ring-2 focus-visible:ring-power/60"
      >
        <p className="flex items-center gap-2 font-semibold text-ghost">
          <MailCheck className="h-4 w-4 text-verified" aria-hidden /> Check your email
        </p>
        <p className="mt-2 text-sm text-mute">
          If <span className="break-all font-mono text-ghost">{phase.email}</span> can have a free account, a
          link to it is on its way. Opening the link is what verifies the address, and your key is created
          there, once. Nothing is charged and no card is held.
        </p>
        <p className="mt-2 text-xs text-faint">
          Nothing there after a few minutes? Check spam, or{" "}
          <button type="button" onClick={again} className="underline hover:text-mute">
            try again or use another address
          </button>
          . We say the same thing for every address, so this page cannot tell you whether one already has an
          account.
        </p>
      </div>
    );
  }

  const failure = phase.name === "error" ? phase.failure : null;
  const unavailable = failure?.kind === "unavailable";

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${uid}-h`} aria-busy={sending}>
      {compact ? null : (
        <>
          <h3 id={`${uid}-h`} className="text-lg font-semibold text-ghost">
            {heading}
          </h3>
          <p className="mt-2 text-sm text-mute">
            {PAYG.freeAllowanceUnits} units a month, no card. Enough for {PAYG.freeAllowanceUnits} constraint
            screens, or a handful of full studies, to check the engine against a hall you know. It is never
            invoiced; when it runs out the engine answers 402 and nothing is charged.
          </p>
        </>
      )}
      {compact ? (
        <h3 id={`${uid}-h`} className="sr-only">
          {heading}
        </h3>
      ) : null}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="sr-only">
            Email address
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="email"
            name="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldError) setFieldError(null);
            }}
            placeholder="you@operator.com"
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${hintId} ${errId}` : hintId}
            disabled={sending}
            className="min-h-11 w-full rounded border border-line bg-panel px-3 py-2 text-base text-ghost placeholder:text-faint focus:border-power focus:outline-none focus:ring-2 focus:ring-power/40 disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={sending}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {sending ? "Sending the link" : "Email me the link"}
          {sending ? null : <ArrowRight className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      <p id={hintId} className="mt-2 text-[11px] text-faint">
        Email only. The link goes to this address, and opening it creates your key.
      </p>
      <div>
        {fieldError ? (
          <p id={errId} role="alert" className="mt-2 flex items-start gap-2 text-sm text-flag">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {fieldError}
          </p>
        ) : null}
        {failure ? (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded border border-flag/40 bg-flag/10 p-3 text-sm text-ghost">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-flag" aria-hidden />
            <div>
              <p>{failure.message}</p>
              {unavailable ? (
                <p className="mt-1 text-xs text-mute">
                  The free allowance is not offered here yet. The{" "}
                  <Link href={QUALIFY_LINK.href} className="text-power underline">
                    {QUALIFY_LINK.label.toLowerCase()}
                  </Link>{" "}
                  needs no account and works now.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </form>
  );
}
