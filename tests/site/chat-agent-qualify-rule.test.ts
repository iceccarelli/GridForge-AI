// The chat agent's instructions state the qualifier's real rule: at least three of seven figures, the rest named as assumptions. They used to tell the
// model to collect four specific figures first, which held a free call back for a fourth number the engine no longer asks for (the engine's schema
// has no `required` list; its own test files pin that).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSystemPrompt } from "@/lib/ai/prompts/system";

const tools = JSON.parse(readFileSync("public/reference/tools.json", "utf8")) as { tools: { name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }[] };
const qualify = tools.tools.find((t) => t.name === "gridforge_qualify")!;

describe("the chat agent's prompt matches the published qualify contract", () => {
  const prompt = buildSystemPrompt();

  it("states the three-of-seven rule and does not ask for a fourth figure first", () => {
    expect(qualify.inputSchema.required ?? []).toEqual([]);
    expect(prompt).toContain("at least three of those seven");
    expect(prompt).toContain("do not hold a call back for a fourth");
    expect(prompt).not.toMatch(/get platform, contracted MW, current site peak, busway ampacity and tap-off rating/);
  });

  it("names only figures the engine's schema really has", () => {
    for (const k of ["contracted_MW", "current_site_peak_MW", "current_it_load_MW", "busway_ampacity_A", "tapoff_max_A", "positions_available", "plant_supply_C"]) {
      expect(Object.keys(qualify.inputSchema.properties), k).toContain(k);
    }
  });
});
