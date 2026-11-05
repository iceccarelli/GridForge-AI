/**
 * /intelligence and the subscriber dashboard: what the page promises is what the software delivers, and every figure says what kind of
 * number it is. The market and grid context is the Observatory's provenance-bearing data (source, time described, time retrieved,
 * basis, freshness); a feed that fails is "Unavailable" and shows nothing in its place; the signal stays MODELLED; a queue statistic is
 * not a connection probability; a wholesale price is context, not site headroom.
 */
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PLANS } from "@/lib/subscriptions";
import { SCORE_WEIGHTS, SITING_REGIONS, sitingScore } from "@/lib/siting";
import { SIGNAL_INPUTS } from "@/lib/intelligence-basis";
import { QUEUE_EVIDENCE_SOURCE } from "@/lib/queue-evidence";
import { IntelligenceClient, checkoutWasCancelled } from "@/components/IntelligenceClient";
import { IntelligenceSignalTable, rankRegions } from "@/components/IntelligenceSignalTable";
import { TITLES } from "@/components/observatory/ContextPanel";
import { IntelligenceContextView, parseContext, type Loaded } from "@/components/IntelligenceContext";
import { getLiveContext, createContextCache } from "@/lib/observatory/sources";
import { FIXTURE_NOW, fixtureContext } from "./observatory-ui-fixtures";
import { awattar, energyCharts, hourly, jsonResponse, routedFetch, H, T0 } from "./observatory-core-harness";

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

describe("the sales page promises what the dashboard does", () => {
  const page = text(renderToStaticMarkup(React.createElement(IntelligenceClient)));

  it("does not call a modelled or scheduled figure live", () => {
    for (const phrase of ["live siting dashboard", "live for you", "live + published", "computed live", "exact model subscribers use"]) {
      expect(page.toLowerCase(), phrase).not.toContain(phrase);
    }
    const features = PLANS.flatMap((p) => [p.tagline, ...p.features]).join(" ").toLowerCase();
    expect(features).not.toMatch(/\blive\b/);
  });

  it("lists every input of the signal with its kind, source and what it is not", () => {
    expect(SIGNAL_INPUTS.map((i) => i.id).sort()).toEqual(["btm", "mix", "price", "queue", "ranking"]);
    for (const i of SIGNAL_INPUTS) {
      expect(page, i.id).toContain(i.name);
      expect(page, i.id).toContain(i.kind);
      expect(page, i.id).toContain(i.notThis);
    }
    // The ranking is MODELLED and the queue wait is MEASURED and is not a connection probability or a load-connection time.
    expect(SIGNAL_INPUTS.find((i) => i.id === "ranking")!.kind).toBe("MODELLED");
    expect(SIGNAL_INPUTS.find((i) => i.id === "queue")!.notThis).toMatch(/not a load-connection time and not the probability/i);
    expect(SIGNAL_INPUTS.find((i) => i.id === "price")!.notThis).toMatch(/not headroom at any site/);
    expect(page).toContain("shows Unavailable for that figure and nothing in its place");
  });

  it("takes its numbers from the registries, not from typed literals", () => {
    const ranking = SIGNAL_INPUTS.find((i) => i.id === "ranking")!;
    expect(ranking.name).toContain(`${SITING_REGIONS.length} regions`);
    expect(ranking.source).toContain(`${Math.round(SCORE_WEIGHTS.speed * 100)}% speed`);
    const queue = SIGNAL_INPUTS.find((i) => i.id === "queue")!;
    expect(queue.source).toContain(QUEUE_EVIDENCE_SOURCE.attribution);
    expect(queue.asOf).toContain(QUEUE_EVIDENCE_SOURCE.measuredOn);
    for (const m of SITING_REGIONS.filter((r) => r.queueBasis === "measured").map((r) => r.market)) expect(queue.name).toContain(m);
    expect(SIGNAL_INPUTS.find((i) => i.id === "btm")!.asOf).toMatch(/assumed/);
  });

  it("names each market feed as the data layer's own provenance does", async () => {
    const { fn } = routedFetch({ market: awattar(hourly(T0 - (T0 % H), 24, 50)), grid: () => jsonResponse(energyCharts(Math.floor(T0 / 1000))) });
    const ctx = await getLiveContext({ fetch: fn, now: () => new Date(T0), env: {}, cache: createContextCache() });
    expect(ctx.dayAheadPrice.provenance.source).toContain("EPEX Spot day-ahead");
    expect(ctx.dayAheadPrice.provenance.source).toContain("aWATTar");
    expect(ctx.generationMix.provenance.source).toContain("Fraunhofer ISE");
    expect(ctx.generationMix.provenance.source).toContain("Energy-Charts");
    expect(SIGNAL_INPUTS.find((i) => i.id === "price")!.source).toContain("EPEX Spot day-ahead");
    expect(SIGNAL_INPUTS.find((i) => i.id === "price")!.source).toContain("aWATTar");
    expect(SIGNAL_INPUTS.find((i) => i.id === "mix")!.source).toContain("Fraunhofer ISE Energy-Charts");
  });

  it("says nothing about customers or payments in the copy this change adds", () => {
    const added = [...SIGNAL_INPUTS.flatMap((i) => [i.name, i.source, i.asOf, i.notThis]), ...PLANS.flatMap((p) => p.features.slice(0, 5))].join(" ");
    expect(added).not.toMatch(/customer|payment|paid|revenue|client/i);
  });

  it("points an existing subscriber to the dashboard", () => {
    expect(page).toContain("Already subscribed, or invited to a seat?");
    expect(renderToStaticMarkup(React.createElement(IntelligenceClient))).toContain('href="/account"');
  });

  it("gives each Subscribe button its plan's name", () => {
    const html = renderToStaticMarkup(React.createElement(IntelligenceClient));
    for (const p of PLANS) expect(html).toContain(`aria-label="Subscribe to ${p.name}"`);
  });

  it("recognises the return from a checkout that was not completed", () => {
    expect(checkoutWasCancelled("?sub=cancelled")).toBe(true);
    expect(checkoutWasCancelled("?sub=success")).toBe(false);
    expect(checkoutWasCancelled("")).toBe(false);
    // The marker is the one the checkout route really sets.
    expect(read("app/api/subscribe/route.ts")).toContain("/intelligence?sub=cancelled");
  });
});

describe("the modelled signal table", () => {
  const html = renderToStaticMarkup(React.createElement(IntelligenceSignalTable));
  const t = text(html);

  it("is labelled MODELLED and nothing in it is called live", () => {
    expect(t).toContain("MODELLED");
    expect(t).not.toMatch(/\blive\b/i);
    for (const r of SITING_REGIONS) {
      expect(r.powerCostProvenance, r.market).toBe("modeled");
      expect(r.renewableProvenance, r.market).toBe("modeled");
    }
  });

  it("tags every queue wait measured or hand-set, and never measured for a market without a measurement", () => {
    for (const r of SITING_REGIONS) {
      const cell = new RegExp(`data-queue-basis="${r.queueBasis}"`);
      expect(html).toMatch(cell);
    }
    expect((html.match(/data-queue-basis="measured"/g) ?? []).length).toBe(SITING_REGIONS.filter((r) => r.queueBasis === "measured").length);
    expect((html.match(/data-queue-basis="modeled"/g) ?? []).length).toBe(SITING_REGIONS.filter((r) => r.queueBasis !== "measured").length);
    expect(t).toContain("hand-set estimate");
    expect(t).toContain("not a load-connection time");
    expect(t).toContain(QUEUE_EVIDENCE_SOURCE.attribution);
    expect(t).toContain("not a verified-site portfolio");
    expect(t).toContain("BTM time is an assumed time-to-energized");
  });

  it("is an accessible table: caption, column and row headers", () => {
    expect(html).toContain("<caption");
    expect((html.match(/scope="col"/g) ?? []).length).toBe(6);
    expect((html.match(/scope="row"/g) ?? []).length).toBe(SITING_REGIONS.length);
  });

  it("ranks by the unchanged score, with the weights taken from one place", () => {
    expect(SCORE_WEIGHTS.speed + SCORE_WEIGHTS.cost + SCORE_WEIGHTS.queue).toBeCloseTo(1, 10);
    for (const r of SITING_REGIONS) {
      const expected = Math.round(Math.max(0, 100 - r.btmMonths * 5) * 0.45 + Math.max(0, 100 - r.powerCost) * 0.3 + (100 - r.congestion) * 0.25);
      expect(sitingScore(r), r.id).toBe(expected);
    }
    const ranked = rankRegions();
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
  });

  it("does not let a live feed overwrite a modelled row", () => {
    const account = read("app/account/page.tsx");
    expect(account).not.toContain("useMarket");
    expect(account).not.toMatch(/LIVE \+ MODELED/);
    expect(account).toContain("<IntelligenceSignalTable />");
    expect(account).toContain("<IntelligenceContext />");
  });
});

describe("the market and grid context", () => {
  const done = (state: Parameters<typeof parseContext> extends never ? never : ReturnType<typeof parseContext>): Loaded => ({ phase: "done", state });

  it("shows source, the time described, the retrieval time and the basis for each figure", () => {
    const t = text(renderToStaticMarkup(React.createElement(IntelligenceContextView, { loaded: done(parseContext(fixtureContext())), now: FIXTURE_NOW })));
    expect(t).toContain("FIXTURE day-ahead auction");
    expect(t).toContain("Source");
    expect(t).toContain("Describes");
    expect(t).toContain("Retrieved");
    expect(t).toContain("Basis");
    expect(t).toContain("CONTEXT, NOT SITE DATA");
    expect(t).toContain("not headroom at any site");
    expect(t).toContain("not a connection probability");
    expect(t).toContain("not a load-connection time");
  });

  it("says Unavailable for every card, and prints no number, when the feeds could not be read", () => {
    const html = renderToStaticMarkup(React.createElement(IntelligenceContextView, { loaded: done({ ok: false, reason: "the request failed" }), now: FIXTURE_NOW }));
    const t = text(html);
    expect((t.match(/Unavailable\./g) ?? []).length).toBe(4);
    expect(t).toContain("Nothing is shown in its place");
    // Titles name their market ("Lower 48"); take them out and no digit remains: no placeholder figure anywhere.
    let body = text(html.slice(html.indexOf('data-context="unavailable"')));
    for (const title of Object.values(TITLES)) body = body.replace(title, "");
    expect(body).not.toMatch(/\d/);
  });

  it("a single dead feed does not blank the others and shows no placeholder for itself", () => {
    const ctx = fixtureContext();
    ctx.dayAheadPrice = { value: null, freshness: "unavailable", provenance: { ...ctx.dayAheadPrice.provenance, observedAt: null, retrievedAt: null } };
    const t = text(renderToStaticMarkup(React.createElement(IntelligenceContextView, { loaded: done(parseContext(ctx)), now: FIXTURE_NOW })));
    expect(t).toContain("Unavailable.");
    expect(t).toContain("renewable"); // the mix card still renders
    expect(t).not.toContain("87.4");
  });

  it("a reading that has aged past its limit is called stale on an open tab, never fresh or live", () => {
    const later = new Date(FIXTURE_NOW.getTime() + 3 * 86400_000);
    const t = text(renderToStaticMarkup(React.createElement(IntelligenceContextView, { loaded: done(parseContext(fixtureContext())), now: later })));
    expect(t).toMatch(/Stale/);
    expect(t).not.toContain("Live reading");
  });

  it("reads a loading state without any figure", () => {
    const t = text(renderToStaticMarkup(React.createElement(IntelligenceContextView, { loaded: { phase: "loading" }, now: FIXTURE_NOW })));
    expect(t).toContain("Reading the market and grid feeds");
    expect(t).not.toMatch(/\d{2,}/);
  });

  it("treats anything but a complete context as unavailable", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { ok: false, reason: "context-unavailable" }, { ...fixtureContext(), queue: { value: [] } }, { ...fixtureContext(), generatedAt: 5 }]) {
      expect(parseContext(bad).ok, JSON.stringify(bad)?.slice(0, 40)).toBe(false);
    }
    expect(parseContext(fixtureContext()).ok).toBe(true);
  });
});

describe("discovery", () => {
  it("llms.txt and the sitemap list /intelligence, and llms.txt does not call it live or a portfolio", async () => {
    const { GET } = await import("@/app/llms.txt/route");
    const t = await (await GET()).text();
    const line = t.split("\n").find((l) => l.includes("/intelligence"));
    expect(line).toBeDefined();
    expect(line).toMatch(/modelled ranking/);
    expect(line).toMatch(/not a verified-site portfolio/);
    expect(line!.toLowerCase()).not.toMatch(/\blive\b/);
    expect(read("app/sitemap.ts")).toContain("/intelligence");
  });

  it("the page's content hash covers the files that render its copy", () => {
    const src = read("scripts/page-lastmod.mjs");
    const line = src.split("\n").find((l) => l.includes('"/intelligence"'))!;
    for (const f of ["components/IntelligenceClient.tsx", "lib/subscriptions.ts", "lib/intelligence-basis.ts"]) expect(line).toContain(f);
  });
});

describe("what the page cannot deliver is not promised", () => {
  it("the sales copy, the plan features and the PDF brief do not claim a live feed for the ranking", () => {
    expect(read("lib/brief.ts")).not.toMatch(/combine live feeds/);
    expect(read("lib/brief.ts")).toContain("no live feed is used");
    expect(read("components/DelayDemo.tsx")).not.toMatch(/live for you|live \+ published/);
  });

  it("the analyst is told no figure in its dataset is live", () => {
    const route = read("app/api/siting-analysis/route.ts");
    expect(route).toContain("no live feed is in it");
    expect(route).not.toContain("Germany's cost is live EPEX");
  });
});
