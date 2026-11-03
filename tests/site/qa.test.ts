import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuestionList } from "@/components/QuestionList";
import type { ConstraintReference, PlatformEntry } from "@/lib/constraints";
import { pageablePlatforms } from "@/lib/platform-pages";
import { constraintQuestions, platformQuestions } from "@/lib/qa";

const ref = JSON.parse(readFileSync("public/reference/constraints.json", "utf8")) as ConstraintReference;
const platforms = pageablePlatforms((JSON.parse(readFileSync("public/reference/platforms.json", "utf8")) as { platforms: PlatformEntry[] }).platforms);
const BANNED = /guarantee|market leader|trusted by|certified|we will deliver|within \d+ weeks of (order|payment)/i;

describe("constraint questions", () => {
  it("every constraint answers at least five questions, from its own fields, with no figure of its own", () => {
    for (const c of ref.constraints) {
      const qa = constraintQuestions(c);
      expect(qa.length, c.slug).toBeGreaterThanOrEqual(5);
      expect(new Set(qa.map((x) => x.q)).size).toBe(qa.length);
      for (const x of qa) {
        expect(x.q.endsWith("?"), x.q).toBe(true);
        expect(x.a.length, x.q).toBeGreaterThan(30);
        expect(x.a, x.q).not.toMatch(BANNED);
        expect(x.a, x.q).not.toMatch(/undefined|null|\[object/);
      }
      expect(qa[0].a).toContain(c.limits.replace(/\.$/, "").slice(0, 40));
      expect(qa.some((x) => x.a.includes(c.misconception.slice(0, 40)))).toBe(true);
    }
  });

  it("the lead time is the library's range and is called indicative, a library range, not a quotation", () => {
    const withLead = ref.constraints.filter((c) => c.lead_time_weeks);
    expect(withLead.length).toBeGreaterThan(5);
    for (const c of withLead) {
      const relief = constraintQuestions(c).find((x) => x.q.includes("relieved"))!;
      expect(relief.a).toContain(`${c.lead_time_weeks!.low} to ${c.lead_time_weeks!.high} weeks`);
      expect(relief.a).toMatch(/indicative.*not a quotation/);
    }
  });

  it("the worked example becomes a question with its own working and answer", () => {
    const c = ref.constraints.find((x) => x.worked_example)!;
    const w = c.worked_example!;
    const q = constraintQuestions(c).find((x) => x.q === w.question)!;
    expect(q.a).toContain(w.working);
    expect(q.a).toContain(w.answer);
  });
});

describe("platform questions", () => {
  it("answer with the library's own figures", () => {
    for (const p of platforms) {
      const text = platformQuestions(p).map((x) => `${x.q} ${x.a}`).join("\n");
      expect(text).toContain(`${p.rack_kW} kW`);
      expect(text).toContain(`${p.flow_l_per_min_per_rack} litres per minute`);
      expect(text).toContain(`${p.max_inlet_liquid_C} °C`);
      expect(text).toContain(`${p.floor_loading_kg_per_m2.toLocaleString("en-IE")} kg/m²`);
      expect(text).toContain(`${(p.liquid_fraction * 100).toFixed(0)}%`);
      expect(text).not.toMatch(BANNED);
      for (const s of p.sources) expect(text).toContain(s);
    }
  });

  it("the feed-current answer scales with voltage, as the engine now does", () => {
    const p = platforms.find((x) => x.rack_feed_current_A)!;
    const a = platformQuestions(p).find((x) => x.q.includes("feed current"))!.a;
    expect(a).toContain(`${p.rack_feed_current_A} A per rack at 400 V three-phase`);
    expect(a).toContain(`${Math.round((p.rack_feed_current_A! * 400) / 208)} A`);
  });
});

describe("QuestionList: the markup and the page are one list", () => {
  it("every question and answer in the FAQPage is visible in the HTML, and vice versa", () => {
    const items = constraintQuestions(ref.constraints[0]);
    const html = renderToStaticMarkup(React.createElement(QuestionList, { id: "q", items }));
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1].replace(/\\u003c/g, "<"));
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity).toHaveLength(items.length);
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
    for (const e of ld.mainEntity) {
      expect(visible).toContain(e.name.replace(/\s+/g, " "));
      expect(visible).toContain(e.acceptedAnswer.text.replace(/\s+/g, " "));
    }
    expect(html).toContain('aria-labelledby="q"');
  });

  it("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(React.createElement(QuestionList, { id: "q", items: [] }))).toBe("");
  });
});
