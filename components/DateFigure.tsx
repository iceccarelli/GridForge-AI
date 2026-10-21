import { describeDate, type DateBasisKeys } from "@/lib/date-basis";

/**
 * A time-to-power figure, shown the only way the site shows one (Rule D).
 *
 * The number comes through lib/date-basis.ts, so it is never printed without what it rests on: an assumed lead time
 * is labelled "assumed lead time, not a date", a scenario with no date shows no number, and a payload that does not say
 * what its figure rests on shows "lead time unverified" and no number. The evidence class is always kept.
 */
export interface DateFigureSource extends DateBasisKeys {
  status?: string | null;
  weeks?: number | null;
  low?: number | null;
  high?: number | null;
  evidence?: string | null;
  sets_the_date?: string | null;
  reason?: string | null;
}

export function DateFigure({
  t,
  evidenceText,
  evidenceClassName = "text-queue",
}: {
  t: DateFigureSource;
  /** The evidence class as the page words it (a code, or "E0 · assumption"). */
  evidenceText?: string | null;
  evidenceClassName?: string;
}) {
  const dated = (t.status === undefined || t.status === "dated") && typeof t.weeks === "number";
  const f = describeDate(dated ? t.weeks : null, t);

  if (f.number === null) {
    const unverified = f.info.basis === "unverified";
    return (
      <span className="text-mute">
        <span className="font-semibold text-ghost">{unverified ? "Lead time unverified." : "No date."}</span>
        {t.reason ? <> {t.reason}</> : null}
        {unverified ? null : <span className="block text-[11px] text-faint">{f.label}</span>}
      </span>
    );
  }
  const hasRange = typeof t.low === "number" && typeof t.high === "number";
  return (
    <span>
      <span className="data text-ghost">{f.number}</span>
      {hasRange ? (
        <>
          {" "}
          <span className="data text-mute">
            ({(t.low as number).toLocaleString("en-IE")}–{(t.high as number).toLocaleString("en-IE")})
          </span>
        </>
      ) : null}
      {evidenceText ? (
        <>
          {" "}
          <span className={`data text-[11px] ${evidenceClassName}`}>{evidenceText}</span>
        </>
      ) : null}
      <span className={`block text-[11px] ${f.info.needsLabel ? "text-queue" : "text-faint"}`}>{f.label}</span>
      {t.sets_the_date ? <span className="block text-[11px] text-faint">set by {t.sets_the_date}</span> : null}
    </span>
  );
}
