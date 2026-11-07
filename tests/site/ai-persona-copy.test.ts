/**
 * No user-visible words may present the AI scoping assistant, or a follow-up nobody has promised, as "our engineer". Covers the confirmation
 * email the assistant sends, the qualifier follow-up acknowledgement, and a scan of every app/, components/ and lib/ source file.
 * (The siting analyst's model prompt calls itself an engineer; its UI says "AI siting analyst ... It is an AI model", which is the disclosure.)
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentConfirmationText } from "@/lib/agent-mail";

const ROOT = path.resolve(__dirname, "../..");
function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    return e.isDirectory() ? (e.name === "node_modules" || e.name === ".next" ? [] : walk(rel)) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
}

describe("the assistant's confirmation email", () => {
  const text = agentConfirmationText("Start with the Density Screen.");
  it("says an AI took the conversation and that no engineer did", () => {
    expect(text).toMatch(/scoping assistant, an AI/);
    expect(text).toMatch(/No engineer took part/);
    expect(text).not.toMatch(/with our engineer/i);
  });
  it("keeps the next step, the confidentiality line and the signature", () => {
    expect(text).toContain("Start with the Density Screen.");
    expect(text).toContain("An NDA is available immediately on request.");
    expect(text.trim().endsWith("— Time to Power")).toBe(true);
  });
  it("is what the chat route sends", () => {
    const src = fs.readFileSync(path.join(ROOT, "app/api/chat/route.ts"), "utf8");
    expect(src).toContain("text: agentConfirmationText(next)");
  });
});

describe("no source file claims 'our engineer(s)' or a 'scoping engineer'", () => {
  it("scans app/, components/ and lib/", () => {
    const hits: string[] = [];
    for (const f of [...walk("app"), ...walk("components"), ...walk("lib")]) {
      const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
      lines.forEach((l, i) => { if (/(?<![a-z])our engineers?\b|scoping engineer/i.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 90)}`); });
    }
    expect(hits).toEqual([]);
  });
  it("the qualifier follow-up mail promises no engineer and no reply time", () => {
    const src = fs.readFileSync(path.join(ROOT, "app/api/qualify/[token]/follow-up/route.ts"), "utf8");
    expect(src).toContain("we make no promise about when we will reply");
  });
});
