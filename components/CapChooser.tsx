"use client";

import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { PAYG } from "@/lib/products";
import { capPresets, enableStatement, eurExact, validateCapEur } from "@/lib/payg-pricing";

/**
 * The monthly cap chooser. Bounds, presets and the default are the registry's (PAYG), the validation is
 * `validateCapEur`, and the statement beside the button is the same sentence everywhere: no charge is made
 * now, invoiced monthly in arrears, hard stop at the cap.
 */
export default function CapChooser({
  initialEur,
  submitLabel,
  busyLabel,
  busy,
  error,
  disabled,
  onSubmit,
  children,
}: {
  initialEur?: number | null;
  submitLabel: string;
  busyLabel: string;
  busy: boolean;
  error: string | null;
  disabled?: boolean;
  onSubmit: (capEur: number) => void;
  children?: React.ReactNode;
}) {
  const uid = useId();
  const [raw, setRaw] = useState(String(initialEur ?? PAYG.defaultCapEur));
  const [touched, setTouched] = useState(false);
  const check = validateCapEur(raw);
  const showError = touched && !check.ok ? check.error : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (check.ok && check.capEur !== null && !busy && !disabled) onSubmit(check.capEur);
  }

  return (
    <form onSubmit={submit} noValidate aria-busy={busy}>
      <fieldset className="min-w-0" disabled={busy}>
        <legend className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          Monthly cap, in euros
        </legend>
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Suggested caps">
          {capPresets().map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={check.ok && check.capEur === p}
              onClick={() => {
                setRaw(String(p));
                setTouched(true);
              }}
              className={`min-h-11 rounded border px-3 py-1.5 font-mono text-sm ${
                check.ok && check.capEur === p
                  ? "border-power/60 bg-power/10 text-power"
                  : "border-line text-mute hover:text-ghost"
              }`}
            >
              {eurExact(p * 100)}
            </button>
          ))}
        </div>
        <div className="mt-3">
          <label htmlFor={`${uid}-cap`} className="text-xs text-mute">
            Or choose your own, a whole number from {eurExact(PAYG.minCapEur * 100)} to {eurExact(PAYG.maxCapEur * 100)}
          </label>
          <input
            id={`${uid}-cap`}
            type="number"
            inputMode="numeric"
            min={PAYG.minCapEur}
            max={PAYG.maxCapEur}
            step={1}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={showError ? true : undefined}
            aria-describedby={`${uid}-help${showError ? ` ${uid}-err` : ""}`}
            className="mt-1 min-h-11 w-full max-w-xs rounded border border-line bg-panel px-3 py-2 font-mono text-base text-ghost focus:border-power focus:outline-none focus:ring-2 focus:ring-power/40"
          />
          <p id={`${uid}-help`} className="mt-1 text-xs text-mute">
            {check.ok && check.units !== null
              ? `${eurExact((check.capEur ?? 0) * 100)} allows ${check.units.toLocaleString("en-IE")} units a month at ${eurExact(PAYG.unitPriceCents)} each.`
              : "Enter a cap to see how many units it allows."}
          </p>
          {showError ? (
            <p id={`${uid}-err`} role="alert" className="mt-1 text-sm text-flag">
              {showError}
            </p>
          ) : null}
        </div>
      </fieldset>

      <p className="mt-4 rounded border border-line bg-panel p-3 text-sm text-ghost">
        {enableStatement(check.ok ? check.capEur : null)}
      </p>
      {children}

      <button
        type="submit"
        disabled={busy || disabled}
        className="mt-4 inline-flex min-h-11 items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        {busy ? busyLabel : submitLabel}
      </button>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-flag">
          {error}
        </p>
      ) : null}
    </form>
  );
}
