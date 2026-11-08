// The questions a buyer types, answered from the page's own data. One list per page feeds BOTH the visible question section and the
// FAQPage structured data (components/QuestionList.tsx), so the markup can never assert an answer the page does not show, which is the
// rule structured data has to meet and the rule this site holds itself to anyway.
//
// Every answer is assembled from fields the constraint reference or the platform library already publishes, and no figure is typed here.
// A lead time is always called indicative and a library range, never a quotation or a promise.

import type { ConstraintDoc, PlatformEntry } from "@/lib/constraints";
import { derive } from "@/lib/platform-pages";

export interface QA {
  q: string;
  a: string;
}

/** End a sentence: keep existing terminal punctuation, else add a full stop. */
const sentence = (s: string): string => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

export function constraintQuestions(c: ConstraintDoc): QA[] {
  const out: QA[] = [
    { q: `What does the ${c.name.toLowerCase()} limit in an AI data hall?`, a: sentence(c.limits) },
    { q: `How do I know whether ${c.name.toLowerCase()} is what binds my hall?`, a: sentence(c.binds_when) },
  ];
  if (c.relation) out.push({ q: `What is the relation behind ${c.name.toLowerCase()}?`, a: sentence(c.relation) });
  const lead = c.lead_time_weeks
    ? ` The relief's indicative lead time is ${c.lead_time_weeks.low} to ${c.lead_time_weeks.high} weeks, a range from the engine's reference library and not a quotation; a supplier's quotation replaces it.`
    : "";
  out.push({
    q: `How is ${c.name.toLowerCase()} relieved, and how long does it take?`,
    a: `${sentence(c.relief)}${c.relief_risk ? ` ${sentence(c.relief_risk)}` : ""}${lead}`,
  });
  out.push({ q: `What is the most common mistake about ${c.name.toLowerCase()}?`, a: sentence(c.misconception) });
  if (c.worked_example) {
    const w = c.worked_example;
    out.push({ q: w.question, a: `${w.working} gives ${w.answer}. ${sentence(w.consequence)}` });
  }
  return out;
}

export function platformQuestions(p: PlatformEntry): QA[] {
  const d = derive(p);
  const src = p.sources.length ? ` Source: ${p.sources.join("; ")}.` : "";
  const out: QA[] = [
    {
      q: `How much power does one ${p.name} rack draw?`,
      a: `${p.rack_kW} kW per rack, with a peak of ${p.peak_rack_kW} kW, as stated in the cited source and held in the library as an assumption.${src}`,
    },
    {
      q: `How much of the heat of a ${p.name} rack does liquid cooling capture?`,
      a: `${(p.liquid_fraction * 100).toFixed(0)}% of the rack's power, about ${d.liquid_kW.toFixed(1)} kW, is captured by liquid; that share is a library assumption, with a band. The remaining ${p.residual_air_kW} kW is residual air load that the hall's air system still has to remove.`,
    },
    {
      q: `What flow and inlet temperature does a ${p.name} rack need?`,
      a: `${p.flow_l_per_min_per_rack} litres per minute per rack on the technology loop, with a maximum liquid inlet temperature of ${p.max_inlet_liquid_C} °C.`,
    },
    {
      q: `What floor loading does a ${p.name} rack impose?`,
      a: `${p.floor_loading_kg_per_m2.toLocaleString("en-IE")} kg/m²: a rack mass of ${p.rack_mass_kg.toLocaleString("en-IE")} kg over a footprint of ${p.rack_footprint_m2} m².`,
    },
  ];
  if (p.rack_feed_current_A) {
    out.push({
      q: `What feed current does a ${p.name} rack need?`,
      a: `${p.rack_feed_current_A} A per rack at 400 V three-phase: an assumed feed current, the library's reference condition, to be confirmed against an OEM drawing. The current rises as the busway voltage falls (a 208 V hall needs about ${Math.round((p.rack_feed_current_A * 400) / 208)} A), so the tap-off rating that matters is the one at your own voltage.`,
    });
  }
  return out;
}
