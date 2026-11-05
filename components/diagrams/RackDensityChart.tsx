import {
  SYNTHETIC_HALL,
  TAP_OFF_AFTER_A,
  TAP_OFF_BEFORE_A,
  densitySeries,
  maxRackKw,
  type DensityPoint,
} from "@/lib/rack-math";

// Rack density against racks the hall can place, for one synthetic hall. Server-rendered SVG: no script, no animation, and every plotted
// value is also in the table beneath it, so the figure is never the only way to read it. The axes start at zero and the three lines are
// distinguished by dash pattern as well as colour.

const W = 480;
const H = 320;
const M = { l: 48, r: 14, t: 16, b: 44 };
const X_MAX = 150;
const Y_MAX = 130;

const x = (kw: number) => M.l + (kw / X_MAX) * (W - M.l - M.r);
const y = (racks: number) => H - M.b - (racks / Y_MAX) * (H - M.t - M.b);

/** A step-after path: racks are whole numbers that change at each density sample. */
function path(points: DensityPoint[], key: "powerOnly" | "before" | "after"): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.rackKw).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
}

export function RackDensityChart() {
  const series = densitySeries();
  const h = SYNTHETIC_HALL;
  const cap63 = maxRackKw(TAP_OFF_BEFORE_A, h.busVoltageV, h.powerFactor);
  const cap250 = maxRackKw(TAP_OFF_AFTER_A, h.busVoltageV, h.powerFactor);
  const xs = [0, 25, 50, 75, 100, 125, 150];
  const ys = [0, 30, 60, 90, 120];
  return (
    <figure className="panel p-4 sm:p-6">
      <figcaption className="mb-4 max-w-2xl">
        <div className="eyebrow mb-2">SYNTHETIC HALL, ARITHMETIC ONLY</div>
        <h3 className="text-lg font-semibold text-ghost">Total power says how many racks you could feed. It does not say whether you can feed one.</h3>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby="rdc-t rdc-d"
        className="h-auto w-full max-w-2xl"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <title id="rdc-t">Racks the hall can place against rack power, for a synthetic hall</title>
        <desc id="rdc-d">
          {`A hall with ${h.usableItKw} kW usable IT power and ${h.positions} free positions. By power alone the count falls from ${series[0].powerOnly} racks at ${series[0].rackKw} kW. With ${TAP_OFF_BEFORE_A} A tap-off units no rack above ${cap63.toFixed(1)} kW can be fed, so the count is zero beyond that. With ${TAP_OFF_AFTER_A} A units racks up to ${cap250.toFixed(0)} kW can be fed.`}
        </desc>
        {ys.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="#1E2942" strokeWidth={1} />
            <text x={M.l - 8} y={y(v) + 4} textAnchor="end" fontSize={12} fill="#8A94A6">{v}</text>
          </g>
        ))}
        {xs.map((v) => (
          <text key={v} x={x(v)} y={H - M.b + 18} textAnchor="middle" fontSize={12} fill="#8A94A6">{v}</text>
        ))}
        <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" fontSize={12} fill="#8A94A6">Rack power, kW</text>
        <text transform={`translate(12 ${(M.t + H - M.b) / 2}) rotate(-90)`} textAnchor="middle" fontSize={12} fill="#8A94A6">Racks placed</text>

        <line x1={x(cap63)} x2={x(cap63)} y1={M.t} y2={H - M.b} stroke="#FFB020" strokeWidth={1} strokeDasharray="2 4" />
        <text x={x(cap63) + 5} y={M.t + 12} fontSize={11} fill="#FFB020">{`${TAP_OFF_BEFORE_A} A limit ${cap63.toFixed(0)} kW`}</text>

        <path d={path(series, "powerOnly")} fill="none" stroke="#8A94A6" strokeWidth={2} strokeDasharray="6 4" />
        <path d={path(series, "after")} fill="none" stroke="#00E5FF" strokeWidth={2.5} />
        <path d={path(series, "before")} fill="none" stroke="#FFB020" strokeWidth={3} />
      </svg>

      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-mute" aria-label="Legend">
        <li><span aria-hidden className="mr-2 inline-block h-0 w-6 border-t-2 border-dashed border-mute align-middle" />By power alone (usable kW ÷ rack kW)</li>
        <li><span aria-hidden className="mr-2 inline-block h-0 w-6 border-t-[3px] border-queue align-middle" />With {TAP_OFF_BEFORE_A} A tap-off units</li>
        <li><span aria-hidden className="mr-2 inline-block h-0 w-6 border-t-2 border-power align-middle" />With {TAP_OFF_AFTER_A} A tap-off units</li>
      </ul>

      <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-faint">
        Synthetic hall: {h.usableItKw} kW usable IT power, {h.positions} free rack positions, {h.busVoltageV} V three-phase, power factor {h.powerFactor}. The
        figures are invented to make one point and describe no real hall. The relation is I = P ÷ (√3 · V · pf). Modelled (E1); nothing here is
        measured. The engine solves thirteen constraints together, so a real hall&rsquo;s curve is never this simple.
      </p>

      <details className="mt-3">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-[13px] text-power">The plotted values, as a table</summary>
        <div className="mt-3 max-h-72 overflow-auto">
          <table className="w-full text-left text-[13px] text-mute">
            <caption className="sr-only">Racks placed by rack power, synthetic hall</caption>
            <thead>
              <tr className="text-faint">
                <th scope="col" className="py-1 pr-4">Rack kW</th>
                <th scope="col" className="py-1 pr-4">By power alone</th>
                <th scope="col" className="py-1 pr-4">{TAP_OFF_BEFORE_A} A</th>
                <th scope="col" className="py-1">{TAP_OFF_AFTER_A} A</th>
              </tr>
            </thead>
            <tbody>
              {series.map((p) => (
                <tr key={p.rackKw} className="border-t border-line">
                  <th scope="row" className="py-1 pr-4 font-normal">{p.rackKw}</th>
                  <td className="py-1 pr-4">{p.powerOnly}</td>
                  <td className="py-1 pr-4">{p.before}</td>
                  <td className="py-1">{p.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
