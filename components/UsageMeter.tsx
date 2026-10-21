import { meterState } from "@/lib/payg-client";
import { eurExact } from "@/lib/payg-pricing";

const TONE_BAR: Record<string, string> = {
  ok: "bg-power",
  warn: "bg-queue",
  full: "bg-flag",
  unknown: "bg-faint",
};

const TONE_WORD: Record<string, string> = {
  ok: "",
  warn: "Approaching the limit.",
  full: "At the limit: further paid calls are refused with a 402.",
  unknown: "",
};

/**
 * Usage against a cap or allowance. The state is carried by text as well as colour, and the bar is a real
 * `meter` for assistive technology. With no cap there is nothing to measure against, and it says so rather
 * than drawing an empty bar.
 */
export default function UsageMeter({
  label,
  used,
  cap,
  accruedCents,
  unitPriceCents,
}: {
  label: string;
  used: number;
  cap: number | null;
  /** What the month has accrued on pay-as-you-go, when that applies. */
  accruedCents?: number | null;
  unitPriceCents?: number | null;
}) {
  const s = meterState(used, cap);
  const fmt = (n: number) => n.toLocaleString("en-IE");
  const capEur = cap !== null && unitPriceCents ? eurExact(cap * unitPriceCents) : null;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</p>
        <p className="font-mono text-sm text-ghost">
          {fmt(s.used)}
          {s.cap !== null ? <span className="text-faint"> / {fmt(s.cap)} units</span> : <span className="text-faint"> units</span>}
        </p>
      </div>
      {s.cap !== null ? (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={s.cap}
          aria-valuenow={Math.min(s.used, s.cap)}
          aria-valuetext={`${fmt(s.used)} of ${fmt(s.cap)} units, ${s.percent}%`}
          className="mt-2 h-2.5 w-full overflow-hidden rounded bg-line"
        >
          <div className={`h-full ${TONE_BAR[s.tone]}`} style={{ width: `${s.percent}%` }} />
        </div>
      ) : (
        <p className="mt-2 text-xs text-mute">No cap is reported for this account, so there is nothing to measure against.</p>
      )}
      <p className="mt-2 text-xs text-mute">
        {s.cap !== null ? `${s.percent}% used, ${fmt(s.remaining ?? 0)} units left. ` : ""}
        {TONE_WORD[s.tone]}
        {accruedCents !== undefined && accruedCents !== null ? ` Accrued this month: ${eurExact(accruedCents)}.` : ""}
        {capEur ? ` Cap: ${capEur}.` : ""}
      </p>
    </div>
  );
}
