/**
 * The chat widget is an AI model. A visitor must be told so wherever it introduces itself: the launcher (the accessible name a screen reader
 * announces), the dialog's name, its header, its first message, and the brief the model itself is given. "Scoping engineer" read as a person.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "@/lib/ai/prompts/system";

const pathname = vi.hoisted(() => ({ value: "/pricing" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value, useRouter: () => ({ push: () => {}, replace: () => {} }) }));

describe("the scoping assistant says it is an AI", () => {
  it("the launcher keeps its visible words and names the assistant, as an AI, to assistive technology", async () => {
    const { ScopingAgent } = await import("@/components/ScopingAgent");
    const html = renderToStaticMarkup(React.createElement(ScopingAgent));
    expect(html).toContain("Scope my site");
    const label = /aria-label="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(label).toContain("Scope my site"); // WCAG 2.5.3: the accessible name contains the visible label
    expect(label).toMatch(/scoping assistant \(AI\)/);
    expect(html).not.toMatch(/scoping engineer/i);
  });

  it("the open panel's dialog name, header and first message all say AI assistant, and none says engineer", async () => {
    const { default: Panel } = await import("@/components/ScopingAgentPanel");
    const html = renderToStaticMarkup(React.createElement(Panel, { open: true, onClose: () => {} }));
    expect(html).toContain('aria-label="Time to Power scoping assistant (AI)"');
    expect(html).toMatch(/Scoping assistant \(AI\)/);
    // the first message (the greeting) introduces itself as an AI, and does not claim to be a person
    expect(html).toMatch(/I(?:&#x27;|')m the Time to Power scoping assistant, an AI/);
    expect(html).toMatch(/not a human engineer/);
    expect(html).not.toMatch(/scoping engineer/i);
  });

  it("it still binds every number to the engine: the greeting promises a directional read from the engine, not from memory", async () => {
    const { default: Panel } = await import("@/components/ScopingAgentPanel");
    const html = renderToStaticMarkup(React.createElement(Panel, { open: true, onClose: () => {} }));
    expect(html).toMatch(/GridForge engine/);
    expect(html).toMatch(/directional read/);
  });

  it("the model's own brief tells it to be an AI and never to pass as a person", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/You are the Time to Power scoping assistant, an AI/);
    expect(prompt).toMatch(/never (?:claim|say|imply)[^.]*human/i);
    expect(prompt).not.toMatch(/scoping engineer/i);
  });
});
