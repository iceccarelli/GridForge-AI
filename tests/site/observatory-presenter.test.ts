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
