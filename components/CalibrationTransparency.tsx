import {
  GATE_COUNT_WORD,
  LEDGER_GATES,
  LEDGER_LIMITS,
  PUBLISHED_VARIABLES,
  RECORD_SHAPE,
  RESIDUALS_PATH,
  RESIDUALS_SCHEMA,
  RESIDUAL_CELL_FIELDS,
  RESIDUAL_REQUIREMENTS,
  RESIDUAL_TOP_FIELDS,
  RESIDUAL_VARIABLE_FIELDS,
  VIEW_CONDITION_COUNT,
  WITHHELD_VARIABLES,
} from "@/lib/calibration-gates";
import type { ResidualRead, ResidualReport } from "@/lib/calibration-residuals";

/**
 * The public account of how a site measurement reaches the calibration ledger, and what the engine's published residual report says.
 * Server-rendered from lib/calibration-gates.ts (one typed list, pinned to the database view by tests) and from one fresh read of the
 * engine. It claims nothing about accuracy: with no approved records it says so, and when the read fails it says that and shows no number.
 */

const UNREADABLE_TEXT = {
  unreachable: "the engine did not answer in time",
  not_served: "the deployed engine does not serve this route",
  http_error: "the engine answered with an error",
  malformed: "the engine's answer did not have the documented shape",
} as const;

const fmt = (n: number | null, unit: string) => (n === null ? "undefined" : `${Number(n.toPrecision(4))} ${unit}`);

const utc = (iso: string) => iso.replace("T", " ").slice(0, 16);

function Status({ read }: { read: ResidualRead }) {
  if (read.status === "unreadable") {
    return (
      <div role="status" className="rounded border border-queue/40 bg-queue/10 p-4">
        <p className="font-semibold text-ghost">The residual report could not be read.</p>
        <p className="mt-1 text-sm text-mute">
          Reading <span className="font-mono">{RESIDUALS_PATH}</span> failed ({UNREADABLE_TEXT[read.reason]}), so this page shows no residual
          and no count from it. It does not substitute an earlier number. Reload to try again.
        </p>
      </div>
    );
  }
  const r = read.report;
  const need = r.requirements ?? RESIDUAL_REQUIREMENTS;
  return (
    <div role="status" className="rounded border border-line bg-panel-2 p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
        Read from the engine at {utc(read.readAt)} UTC (this page refreshes about every five minutes)
      </p>
      {r.n_records === 0 ? (
        <>
          <p className="mt-1 text-lg font-semibold text-ghost">Uncalibrated: 0 approved production records.</p>
          <p className="mt-1 text-sm text-mute">
            No residual has been computed, so none is shown. Every figure the engine returns is modelled, and its error against a real site is
            not yet quantified. The fields below are the schema of what the report will carry once records are imported.
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-lg font-semibold text-ghost">
            State: {r.state}. {r.n_records} approved record{r.n_records === 1 ? "" : "s"} from {r.n_sites} site{r.n_sites === 1 ? "" : "s"}.
          </p>
          <p className="mt-1 text-sm text-mute">
            {r.requirements ? "As the report states it" : "By the engine's documented thresholds"}, a variable is called calibrated only with at
            least {need.min_approved_observations_per_variable} approved, non-low-quality observations from {need.min_distinct_sites_per_variable}{" "}
            distinct sites. Below that, the figures below are indicative at most. They describe this engine&rsquo;s past error at the contributing
            sites and are not a guarantee for any other site.
          </p>
        </>
      )}
    </div>
  );
}

function Subsystems({ report }: { report: ResidualReport }) {
  if (report.n_records === 0) return null;
  return (
    <div className="mt-4 grid gap-4">
      {report.subsystems.map((s) => (
        <div key={s.name} className="overflow-x-auto rounded border border-line" role="region" aria-label={`Residuals: ${s.name}`} tabIndex={0}>
          <table className="w-full min-w-[640px] text-sm">
            <caption className="p-3 text-left text-sm text-ghost">
              <span className="font-semibold">{s.name}</span>: {s.state}, {s.approved_observations} approved observation
              {s.approved_observations === 1 ? "" : "s"} at {s.distinct_sites} site{s.distinct_sites === 1 ? "" : "s"}
            </caption>
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                <th scope="col" className="p-3">Variable</th>
                <th scope="col" className="p-3">State</th>
                <th scope="col" className="p-3">Observations</th>
                <th scope="col" className="p-3">Sites</th>
                <th scope="col" className="p-3">Still needed</th>
                <th scope="col" className="p-3">Mean absolute error</th>
              </tr>
            </thead>
            <tbody>
              {s.variables.map((v) => (
                <tr key={v.name} className="border-t border-line/60 align-top">
                  <th scope="row" className="p-3 text-left font-mono font-normal text-ghost">{v.name} <span className="text-faint">({v.unit})</span></th>
                  <td className="p-3 text-mute">{v.state}</td>
                  <td className="p-3 text-mute">{v.approved_observations}</td>
                  <td className="p-3 text-mute">{v.distinct_sites}</td>
                  <td className="p-3 text-mute">
                    {v.still_needed ? `${v.still_needed.observations} observation${v.still_needed.observations === 1 ? "" : "s"}, ${v.still_needed.sites} site${v.still_needed.sites === 1 ? "" : "s"}` : "not stated"}
                  </td>
                  <td className="p-3 text-mute">
                    {v.residuals === null ? "none yet" : v.residuals.suppressed ? "withheld: fewer than three sites" : fmt(v.residuals.mean_abs_error, v.unit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function Schema() {
  return (
    <details className="mt-4 rounded border border-line bg-panel-2 p-4">
      <summary className="cursor-pointer font-semibold text-ghost focus:outline-none focus:ring-2 focus:ring-power/60">
        The exact schema the report fills in ({RESIDUALS_SCHEMA})
      </summary>
      <div className="mt-3 space-y-5 text-sm text-mute">
        <p>
          Served by <span className="font-mono">GET {RESIDUALS_PATH}</span>, public and read-only. It is aggregate statistics over approved
          records only; no site, hall or record identifier, free text or single measurement is in it. A cell resting on fewer than three
          sites carries counts only. Errors are in each variable&rsquo;s own unit and are never combined: there is no single accuracy figure.
        </p>
        <div>
          <h4 className="font-semibold text-ghost">Top level</h4>
          <p className="mt-1 font-mono text-[13px] break-words">{RESIDUAL_TOP_FIELDS.join(", ")}</p>
          <p className="mt-1">
            <span className="font-mono">requirements</span> states the thresholds; the engine&rsquo;s documented ones are at least{" "}
            {RESIDUAL_REQUIREMENTS.min_approved_observations_per_variable} approved observations from at least{" "}
            {RESIDUAL_REQUIREMENTS.min_distinct_sites_per_variable} distinct sites per variable, with low-quality records not counting.
          </p>
        </div>
        <div>
          <h4 className="font-semibold text-ghost">Each variable, under subsystems.&lt;name&gt;.variables.&lt;variable&gt;</h4>
          <p className="mt-1 font-mono text-[13px] break-words">{RESIDUAL_VARIABLE_FIELDS.join(", ")}</p>
        </div>
        <div className="overflow-x-auto rounded border border-line" role="region" aria-label="Residual cell fields" tabIndex={0}>
          <table className="w-full min-w-[520px] text-sm">
            <caption className="p-3 text-left font-semibold text-ghost">Each residual cell</caption>
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                <th scope="col" className="p-3">Field</th>
                <th scope="col" className="p-3">Meaning and unit</th>
              </tr>
            </thead>
            <tbody>
              {RESIDUAL_CELL_FIELDS.map((f) => (
                <tr key={f.field} className="border-t border-line/60 align-top">
                  <th scope="row" className="p-3 text-left font-mono font-normal text-ghost">{f.field}</th>
                  <td className="p-3">{f.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto rounded border border-line" role="region" aria-label="Published variables and units" tabIndex={0}>
          <table className="w-full min-w-[420px] text-sm">
            <caption className="p-3 text-left font-semibold text-ghost">Variables the public report carries, and the unit of each error</caption>
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                <th scope="col" className="p-3">Variable</th>
                <th scope="col" className="p-3">Subsystem</th>
                <th scope="col" className="p-3">Unit</th>
              </tr>
            </thead>
            <tbody>
              {PUBLISHED_VARIABLES.map((v) => (
                <tr key={v.name} className="border-t border-line/60">
                  <th scope="row" className="p-3 text-left font-mono font-normal text-ghost">{v.name}</th>
                  <td className="p-3">{v.subsystem}</td>
                  <td className="p-3 font-mono">{v.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Withheld from the public report, as those figures are elsewhere on the public tier:{" "}
          <span className="font-mono">{WITHHELD_VARIABLES.join(", ")}</span>.
        </p>
      </div>
    </details>
  );
}

export function CalibrationTransparency({ live }: { live: ResidualRead }) {
  return (
    <section className="mt-10" aria-labelledby="ledger-gates-h" id="ledger-gates">
      <h2 id="ledger-gates-h" className="text-xl font-semibold text-ghost">
        What a site measurement must clear before it can count
      </h2>
      <p className="mt-2 text-[15px] text-mute">
        A measurement from a delivered system enters the shared calibration ledger only through a database view that applies {GATE_COUNT_WORD}{" "}
        gates, made up of {VIEW_CONDITION_COUNT} conditions in all (counting the shape of the record). All must hold at once; the list below
        follows the view as it stands today. Clearing them makes an observation exportable; it does not make it accurate.
      </p>
      <ol className="mt-4 space-y-3">
        {LEDGER_GATES.map((g, i) => (
          <li key={g.id} className="rounded border border-line bg-panel-2 p-4">
            <h3 className="text-[15px] font-semibold text-ghost">
              <span className="mr-2 font-mono text-power">{i + 1}</span>
              {g.title}
            </h3>
            <p className="mt-1 text-sm text-mute">{g.rule}</p>
            <p className="mt-2 text-[13px] leading-relaxed text-mute">
              <span className="text-faint">What passing it does not establish: </span>
              {g.limit}
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-sm text-mute">
        <span className="font-semibold text-ghost">{RECORD_SHAPE.title}.</span> {RECORD_SHAPE.rule} These are not decisions anyone takes, so
        they are not counted among the {GATE_COUNT_WORD} gates.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ghost">Limits that hold whatever the gates say</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px] text-mute">
        {LEDGER_LIMITS.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>

      <h3 className="mt-6 text-base font-semibold text-ghost" id="residuals">The engine&rsquo;s residual report</h3>
      <div className="mt-3">
        <Status read={live} />
      </div>
      {live.status === "read" ? <Subsystems report={live.report} /> : null}
      <Schema />
      <p className="mt-3 text-sm text-faint">
        The administrator sees the same gates, read record by record, before anything is exported. The reviewer name recorded is text typed
        under one shared password, not an authenticated identity.
      </p>
    </section>
  );
}
