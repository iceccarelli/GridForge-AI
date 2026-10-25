/**
 * The presenter scene, rendered against the REAL generated scenario file, the real journey and the real scene model.
 * What matters for a recorded, streamed page: it is a pure function of t, it never links anywhere, it says on every frame that
 * it is synthetic, and the site shell (which has account, billing and assistant links) is off for this route.
 */
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadScenarioFile } from "@/lib/observatory/scenario-data";
import { buildSceneModel } from "@/lib/observatory/scene-model";
import { buildJourney, frameAt, totalDuration } from "@/lib/observatory/journey";
import { parsePresenterParams } from "@/lib/observatory/presenter-params";
import { PresenterFrame, clock } from "@/components/observatory/presenter/PresenterFrame";
import { isBareRoute } from "@/components/SiteChrome";
import robots from "@/app/robots";

const file = loadScenarioFile();
const steps = buildJourney(file);
const total = totalDuration(steps);
const render = (t: number, captions = true) =>
  renderToStaticMarkup(React.createElement(PresenterFrame, { file, steps, frame: frameAt(steps, t), captions }));
const text = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** One time inside each step. */
const midpoints = (() => {
  let start = 0;
  return steps.map((s) => {
    const t = start + s.durationSec / 2;
    start += s.durationSec;
    return { step: s, t };
  });
})();

describe("parsePresenterParams", () => {
  it("reads t, freeze and captions, and ignores everything else", () => {
    expect(parsePresenterParams({ t: "12.5", freeze: "1", captions: "0", other: "x" })).toEqual({ t: 12.5, freeze: true, captions: false });
    expect(parsePresenterParams(new URLSearchParams("t=3&freeze=1"))).toEqual({ t: 3, freeze: true, captions: true });
    expect(parsePresenterParams(undefined)).toEqual({ t: 0, freeze: false, captions: true });
  });
  it.each(["-1", "abc", "NaN", "Infinity", "1e9", "", "1,5", "0x10"])("treats t=%j as 0", (t) => {
    expect(parsePresenterParams({ t }).t).toBe(0);
  });
  it("takes the first of a repeated parameter", () => {
    expect(parsePresenterParams({ t: ["4", "9"], freeze: ["1", "0"] })).toMatchObject({ t: 4, freeze: true });
  });
});

describe("the frame is a pure function of t", () => {
  it("renders identical markup for the same t, every time", () => {
    for (const { t } of midpoints) expect(render(t)).toBe(render(t));
  });
  it("shows the caption of the step that t falls in, verbatim", () => {
    for (const { step, t } of midpoints) {
      const html = render(t);
      expect(html).toContain(`data-step="${step.id}"`);
      expect(text(html)).toContain(step.caption.replace(/&/g, "&"));
    }
  });
  it("leaves the caption bar off when asked, and keeps everything else", () => {
    const html = render(midpoints[1].t, false);
    expect(html).not.toContain('data-presenter="caption"');
    expect(html).toContain('data-presenter="frame"');
  });
  it("holds the last step at and after the end", () => {
    expect(render(total)).toBe(render(total + 500));
    expect(render(total)).toContain(`data-step="${steps[steps.length - 1].id}"`);
  });
  it("formats the clock as mm:ss", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(75.9)).toBe("01:15");
    expect(clock(-3)).toBe("00:00");
  });
});

describe("what a streamed page must never carry", () => {
  const frames = midpoints.map(({ t }) => render(t));
  it("has no link or form at all, on any step", () => {
    for (const html of frames) {
      expect(html).not.toMatch(/<a[\s>]/i);
      expect(html).not.toMatch(/href=/i);
      expect(html).not.toMatch(/<form[\s>]/i);
      expect(html).not.toMatch(/<(button|input|select|textarea)[\s>]/i);
    }
  });
  it("names no account, admin, billing or purchase surface", () => {
    for (const html of frames) {
      expect(text(html)).not.toMatch(/checkout|dashboard|admin|billing|invoice|stripe|sign in|log in|buy now|subscribe|client portal/i);
    }
  });
  it("says on every step that the halls are synthetic, and never calls anything live", () => {
    for (const html of frames) {
      expect(text(html)).toMatch(/Synthetic demonstration/);
      // "not a live reading" is the one honest use; any other "live" would claim an observation this scene does not make.
      expect(text(html).replace(/not a live reading/gi, "")).not.toMatch(/\blive\b/i);
    }
  });
  it("shows an evidence class on every figure panel", () => {
    for (const { step, t } of midpoints.filter((m) => m.step.panel !== "context")) {
      expect(render(t), step.id).toMatch(/data-evidence="E\d"/);
    }
  });
  it("the context step carries no figure that could age (no digits in the context panel)", () => {
    const ctx = midpoints.find((m) => m.step.panel === "context");
    expect(ctx).toBeDefined();
    const html = render(ctx!.t);
    const panel = html.slice(html.indexOf('aria-label="Market and grid context"'));
    const body = text(panel.slice(0, panel.indexOf("</section>")));
    expect(body).not.toMatch(/\d/);
  });
});

describe("the site shell is off for the presenter route only", () => {
  it("is bare for the presenter and anything under it", () => {
    expect(isBareRoute("/observatory/presenter")).toBe(true);
    expect(isBareRoute("/observatory/presenter/x")).toBe(true);
  });
  it("is not bare for the public Observatory or any other page", () => {
    for (const p of ["/observatory", "/observatory/", "/observatory/presenters", "/", "/qualify", "/dashboard", null, undefined, ""]) {
      expect(isBareRoute(p as string | null | undefined), String(p)).toBe(false);
    }
  });
  it("is hidden from crawlers: robots disallow, and the page says noindex", async () => {
    const rules = robots().rules;
    const flat = JSON.stringify(rules);
    expect(flat).toContain("/observatory/presenter");
    const mod = await import("@/app/observatory/presenter/page");
    expect(mod.metadata.robots).toMatchObject({ index: false, follow: false });
    expect(mod.dynamic).toBe("force-dynamic");
  });
});

describe("the presenter's error, loading and not-found states carry no link either", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
  it.each(["app/observatory/presenter/error.tsx", "app/observatory/presenter/loading.tsx", "app/observatory/presenter/not-found.tsx"])("%s has no link, anchor or button", (f) => {
    const src = read(f);
    expect(src).not.toMatch(/next\/link|<a[\s>]|href=|<button|onClick|reset\(/);
  });
  it("an unknown path under the presenter is routed to the presenter's own not-found", () => {
    expect(read("app/observatory/presenter/[...rest]/page.tsx")).toMatch(/notFound\(\)/);
  });
});

// ---- review fixes: honesty and legibility of the broadcast frame ----------------------------------------------------------

const allFrames = midpoints.map(({ step, t }) => ({ step, html: render(t) }));
const withoutAsFound = (s: string) => s.replace(/over capacity as found/gi, "");

describe("honesty on every step: no false over-capacity, no 'unlimited', evidence beside capex", () => {
  it("never calls a stage over capacity because of its after-plan load (only 'over capacity as found' may appear), and shows no after-plan ratio", () => {
    for (const { step, html } of allFrames) {
      const t = withoutAsFound(text(html));
      expect(t, step.id).not.toMatch(/over capacity|exceeds capacity|OVER CAPACITY/i);
      expect(html, step.id).not.toContain("OVER CAPACITY");
      expect(text(html), step.id).not.toMatch(/→\s*\d+%/);
    }
  });
  it("the stage detail shows the after-plan load as a plain figure and says the engine does not state the capacity after the plan", () => {
    const path = allFrames.find((f) => f.step.panel === "path")!;
    expect(text(path.html)).toContain("The engine does not state this stage's capacity after the plan.");
    expect(text(path.html)).toContain("Load after the plan");
    expect(text(path.html)).toContain("Utilisation as found");
  });
  it("a constraint that passes says it does not limit the hall; never 'no figure given', 'unranked' or 'unlimited'", () => {
    for (const { step, html } of allFrames) expect(text(html), step.id).not.toMatch(/no figure given|unranked|unlimited/i);
  });
  it("on the outcomes steps the selected alternative's capex carries its evidence chip and, for placeholders, says so; a partial total is 'at least'", () => {
    const outcomesSteps = allFrames.filter((f) => f.step.panel === "outcomes");
    expect(outcomesSteps.length).toBeGreaterThan(0);
    for (const { step, html } of outcomesSteps) {
      const sel = html.slice(html.indexOf('data-selected="1"'));
      const card = sel.slice(0, sel.indexOf("</div></div>") > 0 ? sel.indexOf("</div></div>") : undefined);
      const cap = card.slice(card.indexOf("Capital cost"));
      const sc = file.scenarios.find((s) => s.id === step.scenarioId)!;
      const o = sc.outcomes.find((x) => x.id === (step.outcomeId || sc.headlineOutcome))!;
      expect(text(card), step.id).toContain(o.name);
      if (o.capexEur.value === null) {
        expect(text(cap), step.id).toContain("Not priced");
        continue;
      }
      expect(cap, step.id).toMatch(/data-evidence="E\d"/);
      if (o.capexPricing === "placeholder") expect(text(cap), step.id).toContain("library placeholder prices");
      if (o.capexPricing === "partly_supplied") expect(text(cap), step.id).toContain("some lines are library placeholder prices");
      if (!o.capexComplete || o.unpricedComponents.length > 0) {
        expect(text(cap), step.id).toContain("at least");
        expect(text(cap), step.id).not.toMatch(/range €/);
      }
      expect(text(cap), step.id).not.toMatch(/\bpriced\b(?! lines only)/i);
    }
  });
  it("an alternative that deploys nothing says there is nothing to date", () => {
    const nothing = file.scenarios.flatMap((s) => s.outcomes).filter((o) => o.racksAfterPlan === 0);
    expect(nothing.length).toBeGreaterThan(0);
    const t = (s: string) => text(s);
    for (const { step, html } of allFrames.filter((f) => f.step.panel === "outcomes")) {
      const sel = html.slice(html.indexOf('data-selected="1"'));
      const card = t(sel.slice(0, 2500));
      const o = nothing.find((x) => card.includes(x.name));
      if (o && step.outcomeId === o.id) expect(card, step.id).toContain("Nothing deploys, so there is nothing to date");
    }
  });
});

describe("the broadcast frame is legible and read-only at 720p and 1080p", () => {
  it("the diagram is one plain image with a label: no role=button, tab stop, pressed state, handler or 'Select a stage' text", () => {
    for (const { step, html } of allFrames) {
      expect(html, step.id).toContain('data-stage="2d-presenter"');
      expect(html, step.id).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Power path diagram:/);
      const svg = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
      expect(svg, step.id).not.toMatch(/role="button"|role="group"|tabindex|aria-pressed|onclick|onkeydown/i);
      expect(html, step.id).not.toMatch(/tabindex|aria-pressed|role="button"/i);
      expect(text(html), step.id).not.toMatch(/Select a stage/i);
      // aria-label on a plain div is ignored by assistive technology: every labelled div has a role
      for (const tag of html.match(/<div[^>]*\saria-label=[^>]*>/g) ?? []) expect(tag, step.id).toMatch(/\srole="/);
    }
  });
  it("uses a landscape layout (five columns), not the page's 4-column or 2-column layouts", () => {
    const html = allFrames[0].html;
    expect(html).toMatch(/data-viewbox-w="760"/);
    expect(html.split("<svg").length - 1).toBe(1);
  });
  it("no text in the diagram is under 10px (SVG units are 1:1 at 720p), no body text is under 14px, and chips are at least 11px", () => {
    for (const { step, html } of allFrames) {
      const sizes = [...html.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
      expect(sizes.length).toBeGreaterThan(20);
      for (const s of sizes) expect(s, `${step.id}: ${s}`).toBeGreaterThanOrEqual(10);
      expect(html, step.id).not.toMatch(/text-xs|text-\[10px\]|text-\[9px\]|text-\[8px\]/);
      for (const m of html.matchAll(/class="[^"]*text-\[(\d+)px\][^"]*"/g)) expect(Number(m[1]), step.id).toBeGreaterThanOrEqual(11);
    }
  });
  it("the caption has a fixed height (three lines, no layout shift) and no caption is long enough to be cut", () => {
    for (const { step, html } of allFrames) expect(html, step.id).toMatch(/data-presenter="caption"/);
    expect(render(midpoints[0].t)).toMatch(/class="h-\[6rem\][^"]*"[^>]*data-presenter="caption"/);
    for (const s of steps) expect(s.caption.length, s.id).toBeLessThanOrEqual(380);
    // the basis banner reserves one line at 1280px (about 170 characters at 14px); a longer one would push the frame
    for (const sc of file.scenarios) for (const o of sc.outcomes) expect(buildSceneModel(sc, o.id).basisBanner.length).toBeLessThanOrEqual(170);
  });
  it("the outcomes panel shows the selected alternative in full and every other as one compact line; nothing is dropped", () => {
    for (const { step, html } of allFrames.filter((f) => f.step.panel === "outcomes")) {
      const scenario = file.scenarios.find((s) => s.id === step.scenarioId)!;
      const names = scenario.outcomes.map((o) => o.name);
      for (const n of names) expect(text(html), `${step.id}: ${n}`).toContain(n.replace(/&/g, "&"));
      expect((html.match(/data-selected="1"/g) ?? []).length, step.id).toBe(1);
    }
  });
});
