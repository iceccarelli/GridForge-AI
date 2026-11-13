// The headroom ladder as a figure: one row per step, in the order the engine relieves the limits, with the racks the hall carries after that step.
// Server-rendered SVG: no script, no animation. Every plotted value is in the table that follows the figure on the page (the caption says so),
// so the figure is never the only way to read it. The bar starts at zero; a thin mark shows the count before the step; a step that adds nothing
// is drawn as a short amber tick, not as an absent bar; a step the engine did not take is outlined, not filled. Meaning does not rest on colour
// alone: every row also carries its numbers as text.
//
// The viewBox is narrow on purpose. On a 375 px screen the figure is drawn at about 0.95 of its units, so text of 13 units is about 12 px there;
// a wider viewBox would shrink the labels below what can be read on a phone. Long labels wrap onto a second line instead.

export interface LadderBarStep {
  step: number;
  name: string;
  before: number;
  after: number;
  taken: boolean;
}

const W = 320;
const FONT = 13;
const LINE = 17;
const WRAP = 36;
const PAD = 8;
const NUMBERS_W = 64;
const TOP = 6;
const BAR_H = 10;
const GAP = 26;

/** Break a label at spaces into lines of at most `max` characters (a word longer than that stays whole). */
export function wrapLabel(text: string, max: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + word.length <= max) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

export function LadderBars({ steps, idPrefix, heading, eyebrow }: { steps: LadderBarStep[]; idPrefix: string; heading: string; eyebrow: string }) {
  const max = Math.max(1, ...steps.map((s) => s.after), ...steps.map((s) => s.before));
  const barW = W - PAD * 2 - NUMBERS_W;
  const x = (racks: number) => PAD + (racks / max) * barW;
  const rows = steps.map((s) => ({ s, lines: wrapLabel(`${s.step}. ${s.name}`, WRAP) }));
  let y = TOP;
  const placed = rows.map((r) => {
    const top = y;
    y += LINE * r.lines.length + BAR_H + GAP - 10;
    return { ...r, top };
  });
  const H = y + 4;
  const desc = steps
    .map((s) => `Step ${s.step}, ${s.name}: ${s.before} racks before, ${s.after} after${s.taken ? "" : " (not taken)"}.`)
    .join(" ");
  return (
    <figure className="panel p-4 sm:p-6">
      <figcaption className="mb-4 max-w-2xl">
        <div className="eyebrow mb-2 !text-xs">{eyebrow}</div>
        <h3 className="text-lg font-semibold text-ghost">{heading}</h3>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${idPrefix}-t ${idPrefix}-d`} className="h-auto w-full max-w-md" style={{ fontFamily: "var(--font-mono)" }}>
        <title id={`${idPrefix}-t`}>Racks the hall carries after each step of the headroom ladder</title>
        <desc id={`${idPrefix}-d`}>{desc}</desc>
        {placed.map(({ s, lines, top }) => {
          const barY = top + LINE * lines.length + 2;
          const flat = s.after === 0;
          return (
            <g key={s.step}>
              {lines.map((l, i) => (
                <text key={i} x={PAD} y={top + 13 + LINE * i} fontSize={FONT} fill="#F5F7FA">{l}</text>
              ))}
              <line x1={PAD} x2={PAD + barW} y1={barY + BAR_H / 2} y2={barY + BAR_H / 2} stroke="#1E2942" strokeWidth={1} />
              {flat ? (
                <rect x={PAD} y={barY} width={4} height={BAR_H} fill="#FFB020" />
              ) : s.taken ? (
                <rect x={PAD} y={barY} width={Math.max(2, x(s.after) - PAD)} height={BAR_H} fill="#00E5FF" />
              ) : (
                <rect x={PAD + 0.5} y={barY + 0.5} width={Math.max(2, x(s.after) - PAD - 1)} height={BAR_H - 1} fill="none" stroke="#00E5FF" strokeWidth={1} strokeDasharray="3 3" />
              )}
              {s.before > 0 ? <line x1={x(s.before)} x2={x(s.before)} y1={barY - 3} y2={barY + BAR_H + 3} stroke="#8A94A6" strokeWidth={2} /> : null}
              <text x={W - PAD} y={barY + BAR_H} textAnchor="end" fontSize={FONT} fill="#8A94A6">{`${s.before} → ${s.after}`}</text>
            </g>
          );
        })}
      </svg>
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-mute" aria-label="Legend">
        <li><span aria-hidden className="mr-2 inline-block h-2.5 w-6 bg-power align-middle" />Racks after the step</li>
        <li><span aria-hidden className="mr-2 inline-block h-3 w-0.5 bg-mute align-middle" />Racks before it</li>
        <li><span aria-hidden className="mr-2 inline-block h-2.5 w-1 bg-queue align-middle" />Zero racks after the step</li>
        <li><span aria-hidden className="mr-2 inline-block h-2.5 w-6 border border-dashed border-power align-middle" />Next limit, not relieved in this example</li>
      </ul>
    </figure>
  );
}
