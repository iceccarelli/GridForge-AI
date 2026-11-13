/**
 * Every form control in these components has a programmatic label.
 *
 * A placeholder is not a label: it disappears as the person types and is not reliably announced. 27 controls in five components had only a
 * placeholder (or a visible caption that was a sibling `<label>` with no `htmlFor`, which names nothing). A control now counts as labelled when
 *
 *   - its own tag carries `aria-label` or `aria-labelledby`, or
 *   - its own tag carries an `id` that a `<label htmlFor>` in the same file names (the same expression), or
 *   - it sits inside a `<label>...</label>` (an implicit label), or
 *   - it is `type="hidden"`.
 *
 * The scan is textual, deliberately simple, and limited to the files listed here: it cannot tell that a label's TEXT is good, only that the
 * association exists. `EXEMPT` lists any control left unlabelled on purpose; it is empty, and an entry needs a reason.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FILES = [
  "components/RequestFollowUp.tsx",
  "components/PowerDeployCaseUpdate.tsx",
  "components/PowerDeployProcurement.tsx",
  "components/ai/ProjectPanel.tsx",
  "components/AdminDashboard.tsx",
];

/** `{ file, line, why }`: a control that is intentionally unlabelled. None. */
const EXEMPT: { file: string; line: number; why: string }[] = [];

interface Control { name: string; tag: string; index: number; line: number }

/** The opening tag of every <input>, <select> and <textarea>: from `<name` to the `>` that is outside any `{...}` attribute expression or quoted string. */
function controls(src: string): Control[] {
  const out: Control[] = [];
  const re = /<(input|select|textarea)\b/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let i = m.index + m[0].length;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        const close = src.indexOf(c, i + 1);
        if (close === -1) break;
        i = close;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ name: m[1], tag: src.slice(m.index, i + 1), index: m.index, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

function insideLabel(src: string, index: number): boolean {
  const before = src.slice(0, index);
  return before.lastIndexOf("<label") > before.lastIndexOf("</label>") && before.lastIndexOf("<label") !== -1;
}

function labelled(src: string, c: Control): boolean {
  if (/\btype="hidden"/.test(c.tag)) return true;
  if (/\baria-label=/.test(c.tag) || /\baria-labelledby=/.test(c.tag)) return true;
  const id = /\bid=(\{`[^`]*`\}|\{"[^"]*"\}|"[^"]*")/.exec(c.tag)?.[1];
  if (id && src.includes(`htmlFor=${id}`)) return true;
  return insideLabel(src, c.index);
}

const unlabelled = (file: string, src: string) =>
  controls(src).filter((c) => !labelled(src, c) && !EXEMPT.some((e) => e.file === file && e.line === c.line));

describe("the scan itself", () => {
  const wrap = (body: string) => `export const X = () => (<form>${body}</form>);`;
  it("flags a bare control and a control whose sibling label names nothing", () => {
    expect(unlabelled("x", wrap(`<input value={a} onChange={(e) => set(e.target.value)} placeholder="p" />`))).toHaveLength(1);
    expect(unlabelled("x", wrap(`<label>Name</label><input id="n" />`))).toHaveLength(1);
    expect(unlabelled("x", wrap(`<label htmlFor="other">Name</label><input id="n" />`))).toHaveLength(1);
    expect(unlabelled("x", wrap(`<select value={a} onChange={(e) => f(e.target.value as "a" | "b")}><option>x</option></select>`))).toHaveLength(1);
  });
  it("accepts aria-label, a matching htmlFor/id pair (literal or template), an implicit wrapping label and a hidden input", () => {
    expect(unlabelled("x", wrap(`<input aria-label="Name" value={a} onChange={(e) => s(e.target.value)} />`))).toHaveLength(0);
    expect(unlabelled("x", wrap(`<textarea aria-labelledby="cap" />`))).toHaveLength(0);
    expect(unlabelled("x", wrap(`<label htmlFor="n">Name</label><input id="n" />`))).toHaveLength(0);
    expect(unlabelled("x", wrap("<label htmlFor={`${uid}-n`}>Name</label><input id={`${uid}-n`} onChange={(e) => s(e.target.value)} />"))).toHaveLength(0);
    expect(unlabelled("x", wrap(`<label><span>Date</span><input type="date" /></label>`))).toHaveLength(0);
    expect(unlabelled("x", wrap(`<input type="hidden" name="h" />`))).toHaveLength(0);
  });
  it("a control after a closed label is not inside it", () => {
    expect(unlabelled("x", wrap(`<label>Closed</label><input value={a} />`))).toHaveLength(1);
  });
});

describe("form controls in the audited components", () => {
  for (const file of FILES) {
    it(`${file}: every <input>, <select> and <textarea> has a programmatic label`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(controls(src).length, `${file}: the scan found no controls`).toBeGreaterThan(0);
      const bad = unlabelled(file, src).map((c) => `line ${c.line}: <${c.name}> ${c.tag.replace(/\s+/g, " ").slice(0, 110)}`);
      expect(bad, `${file} has unlabelled controls`).toEqual([]);
    });
  }

  it("scans every control it is pointed at (so a parser that went blind fails here)", () => {
    const total = FILES.reduce((n, f) => n + controls(fs.readFileSync(path.join(process.cwd(), f), "utf8")).length, 0);
    expect(total).toBeGreaterThanOrEqual(30);
  });

  it("every exemption names a control that still exists and says why", () => {
    for (const e of EXEMPT) {
      expect(e.why.length).toBeGreaterThan(10);
      expect(controls(fs.readFileSync(path.join(process.cwd(), e.file), "utf8")).some((c) => c.line === e.line)).toBe(true);
    }
  });
});
