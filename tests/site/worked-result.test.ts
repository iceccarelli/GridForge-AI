/**
 * The worked result on the home page's first screen is read from the committed ENGINE OUTPUT (public/reference/model_pack.json), never typed.
 *
 * These tests read that JSON themselves, by their own path through it, and fail if the rendered panel, the qualifier's sentence or the
 * evidence wording disagree with it; and they change the file (in a temporary copy) to prove the panel follows the file rather than a literal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildWorkedResult, loadWorkedResult, referenceLimitSentence, workedResultEvidenceLine, workedResultLines } from "@/lib/worked-result";

vi.mock("next/font/local", () => ({ default: () => ({ variable: "font-var", className: "font-cls" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: () => {}, replace: () => {} }) }));

const ROOT = path.resolve(__dirname, "../..");
const PACK = JSON.parse(fs.readFileSync(path.join(ROOT, "public/reference/model_pack.json"), "utf8"));
const scenario = (id: string) => PACK.scenarios.find((s: { id: string }) => s.id === id);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function panelText() {
  const { WorkedResult } = await import("@/components/home/WorkedResult");
  return text(renderToStaticMarkup(React.createElement(WorkedResult)));
}

describe("the worked-result panel agrees with model_pack.json", () => {
  it("shows the as-found racks and the first limit of the reference hall, as the file states them", async () => {
    const grid = scenario("full_dlc");
    const t = await panelText();
    expect(t).toContain("Synthetic reference hall — not a customer site");
    expect(t).toContain(`${grid.as_found.racks} racks of NVIDIA GB300 NVL72`);
    expect(t).toContain(`First limit: ${grid.as_found.binding_name}.`);
  });

  it("shows the racks after the relief ladder (full direct liquid cooling) and with on-site supply, as the file states them", async () => {
    const t = await panelText();
    expect(scenario("full_dlc").architecture).toBe("full_dlc");
    expect(t).toContain(`${scenario("full_dlc").after_ladder.racks} racks (full direct liquid cooling)`);
    expect(t).toMatch(new RegExp(`With on-site supply\\s+${scenario("full_dlc_btm").after_ladder.racks} racks\\.`));
  });

  it("words the evidence class from the file: the weakest class on the headline load, decision-grade flag and the cost basis label", async () => {
    const classes = ["full_dlc", "full_dlc_btm"].map((id) => Number(/^E(\d)/.exec(scenario(id).after_ladder.it_load_kW.evidence)![1]));
    const weakest = `E${Math.min(...classes)}`;
    const verbs: Record<string, string> = { E0: "assumed", E1: "modelled", E2: "simulated", E3: "estimated" };
    const t = await panelText();
    expect(t).toContain(`Evidence class ${weakest} (${verbs[weakest]})`);
    expect(t).toContain(scenario("full_dlc").economics.decision_grade ? "Decision-grade." : "Planning-grade, not decision-grade.");
    expect(t).toContain(Object.values(scenario("full_dlc").economics.cost_basis_mix as Record<string, { label: string }>)[0].label);
  });

  it("is a synthetic hall and the file says so: the panel never presents it as a customer's", async () => {
    expect(PACK.synthetic).toBe(true);
    expect(PACK.notice).toMatch(/SYNTHETIC REFERENCE DATA — not a customer asset/);
    const t = await panelText();
    expect(t).not.toMatch(/customer (site|hall) (of|at)|trusted by|your hall carries/i);
  });

  it("is on the rendered home page and the qualifier states the reference hall's own limit, with the file's tap-off rating", async () => {
    const Page = (await import("@/app/page")).default;
    const home = text(renderToStaticMarkup(React.createElement(Page)));
    expect(home).toContain("Synthetic reference hall — not a customer site");
    const amps = /tap-offs rated (\d+) A/.exec(scenario("full_dlc").as_found.basis)![1];
    expect(home).toContain(`In our synthetic reference hall the first limit is the rack feed / tap-off rating (${amps} A tap-offs), an electrical limit, not cooling.`);
    expect(scenario("full_dlc").constraints.find((c: { id: string }) => c.id === scenario("full_dlc").as_found.binding).domain).toBe("electrical");
  });
});

describe("the panel follows the file, not a literal", () => {
  function copyWith(mutate: (pack: any) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "worked-"));
    fs.mkdirSync(path.join(root, "public/reference"), { recursive: true });
    const pack = JSON.parse(JSON.stringify(PACK));
    mutate(pack);
    fs.writeFileSync(path.join(root, "public/reference/model_pack.json"), JSON.stringify(pack));
    fs.copyFileSync(path.join(ROOT, "public/reference/platforms.json"), path.join(root, "public/reference/platforms.json"));
    return root;
  }

  it("a changed rack count, binding constraint and evidence class change the sentences", () => {
    const root = copyWith((p) => {
      const g = p.scenarios.find((s: any) => s.id === "full_dlc");
      g.as_found.racks = 3;
      g.as_found.binding_name = "Transformer capacity";
      g.as_found.binding = "transformer_capacity";
      g.constraints.find((c: any) => c.id === "transformer_capacity").domain = "thermal";
      g.after_ladder.racks = 41;
      g.after_ladder.it_load_kW.evidence = "E2_SIMULATION";
      p.scenarios.find((s: any) => s.id === "full_dlc_btm").after_ladder.racks = 77;
      p.scenarios.find((s: any) => s.id === "full_dlc_btm").after_ladder.it_load_kW.evidence = "E3_ENGINEERING_ESTIMATE";
    });
    const w = loadWorkedResult(root);
    const lines = workedResultLines(w).map((l) => l.text).join(" | ");
    expect(lines).toContain("3 racks of NVIDIA GB300 NVL72. First limit: Transformer capacity.");
    expect(lines).toContain("41 racks (full direct liquid cooling)");
    expect(lines).toContain("77 racks.");
    expect(workedResultEvidenceLine(w)).toContain("Evidence class E2 (simulated)");
    // A first limit that is thermal is not described as "not cooling".
    expect(referenceLimitSentence(w)).not.toMatch(/not cooling/);
    expect(referenceLimitSentence(w)).toContain("transformer capacity");
  });

  it("a singular rack count reads 'rack', and a decision-grade file says so", () => {
    const root = copyWith((p) => {
      p.scenarios.find((s: any) => s.id === "full_dlc").as_found.racks = 1;
      p.scenarios.find((s: any) => s.id === "full_dlc").economics.decision_grade = true;
    });
    const w = loadWorkedResult(root);
    expect(workedResultLines(w)[0].text).toContain("1 rack of");
    expect(workedResultEvidenceLine(w)).toContain("Decision-grade.");
  });

  it("refuses to build from a file that is not marked synthetic, lacks a scenario or has no evidence class: the build fails instead of showing something else", () => {
    expect(() => buildWorkedResult({ ...PACK, synthetic: false })).toThrow(/not marked synthetic/);
    expect(() => buildWorkedResult({ ...PACK, scenarios: PACK.scenarios.filter((s: any) => s.id !== "full_dlc_btm") })).toThrow(/scenario "full_dlc_btm"/);
    const noEvidence = JSON.parse(JSON.stringify(PACK));
    delete noEvidence.scenarios.find((s: any) => s.id === "full_dlc").after_ladder.it_load_kW.evidence;
    expect(() => buildWorkedResult(noEvidence)).toThrow(/evidence/);
    expect(() => loadWorkedResult(path.join(os.tmpdir(), "no-such-root-for-worked-result"))).toThrow();
  });

  it("no number of racks, rating or constraint name is typed into the components that show them", () => {
    for (const f of ["components/home/WorkedResult.tsx", "components/home/Hero.tsx", "components/home/Sections.tsx", "app/qualify/page.tsx"]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/63(&nbsp;|\s)A|tap-off rating|\b(28|62|26)\s+racks/);
    }
  });
});
