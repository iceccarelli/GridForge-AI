/**
 * The developer and reference surfaces as a technical user meets them: a snippet must run as pasted, a scrolling code block must be
 * reachable from the keyboard, nothing may sit on top of the code it belongs to, the refusals a caller can meet are stated once
 * (lib/openapi.ts ERROR_STATUSES) and agree between /developers and /openapi.json, and the controls a phone user presses are
 * at least 44 px (min-h-11), as the rest of the site already does.
 *
 * Found by driving the production build at 375 and 1440 px (axe: scrollable-region-focusable on /api-access; the Copy button
 * covering the endpoint URL in the MCP install block; a "Point an agent at it" snippet whose arguments were the literal `{ ... }`).
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import McpInstall from "@/components/McpInstall";
import SetupSnippets from "@/components/SetupSnippets";
import { DelayDemo } from "@/components/DelayDemo";
import { ERROR_STATUSES, buildOpenApi, type ToolsFile } from "@/lib/openapi";
import { parseToolRates } from "@/lib/payg-pricing";
import { FULL_ENGINE, stubEngine } from "./engine-stub";
import fs from "node:fs";

const ENGINE = "https://gridforge-engine.fly.dev";
const tools = JSON.parse(fs.readFileSync("public/reference/tools.json", "utf8")) as ToolsFile;

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const pres = (html: string) => [...html.matchAll(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/g)].map((m) => ({ attrs: m[1], text: decode(m[2].replace(/<!-- -->/g, "")) }));

async function page(load: () => Promise<{ default: (p?: never) => Promise<React.ReactElement> | React.ReactElement }>) {
  const stop = stubEngine(FULL_ENGINE);
  try {
    return renderToStaticMarkup(await (await load()).default()).replace(/<!-- -->/g, "");
  } finally {
    stop();
  }
}

describe("/developers snippets run as pasted", () => {
  it("every JSON body in a curl example is valid JSON, and no example is left with an elided `...` placeholder", async () => {
    const html = await page(() => import("@/app/developers/page"));
    const blocks = pres(html).filter((b) => b.text.includes("curl"));
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const b of blocks) {
      const body = b.text.match(/-d '([\s\S]*)'\s*$/);
      expect(body, b.text).toBeTruthy();
      expect(() => JSON.parse(body![1]), b.text).not.toThrow();
      expect(b.text).not.toMatch(/\.\.\./);
    }
  });

  it("the MCP example calls the free qualifier with the same seven numbers as the REST example, and sends no key", async () => {
    const html = await page(() => import("@/app/developers/page"));
    const mcp = pres(html).find((b) => b.text.includes(`${ENGINE}/mcp`) && b.text.includes('"tools/call"'))!;
    const rpc = JSON.parse(mcp.text.match(/-d '([\s\S]*)'\s*$/)![1]);
    expect(rpc.params.name).toBe("gridforge_qualify");
    const rest = pres(html).find((b) => b.text.includes(`${ENGINE}/v1/qualify`))!;
    expect(rpc.params.arguments).toEqual(JSON.parse(rest.text.match(/-d '([\s\S]*)'\s*$/)![1]));
    expect(mcp.text).not.toMatch(/x-api-key/i);
  });

  it("every scrolling code block is keyboard-focusable and named", async () => {
    const html = await page(() => import("@/app/developers/page"));
    for (const b of pres(html)) {
      expect(b.attrs, b.text.slice(0, 40)).toMatch(/tabindex="0"/);
      expect(b.attrs, b.text.slice(0, 40)).toMatch(/aria-label="[^"]+"/);
    }
  });
});

describe("the account setup snippets", () => {
  it("every command block is focusable and named, and its Copy control is 44 px", () => {
    const rates = parseToolRates(tools).map((r) => ({ ...r, availability: "available" as const }));
    const html = renderToStaticMarkup(React.createElement(SetupSnippets, { engine: ENGINE, rates, estimateAvailable: true }));
    const blocks = pres(html);
    expect(blocks.length).toBe(3);
    for (const b of blocks) {
      expect(b.attrs).toMatch(/tabindex="0"/);
      expect(b.attrs).toMatch(/aria-label="Command: /);
    }
    expect(html).not.toMatch(/min-h-9\b/);
  });
});

describe("the MCP install block", () => {
  const html = renderToStaticMarkup(React.createElement(McpInstall, { engine: ENGINE, availability: "available" }));

  it("does not lay the Copy button over the snippet it copies", () => {
    const button = html.match(/<button[^>]*aria-label="Copy the[^"]*"[^>]*>/)![0];
    expect(button).not.toMatch(/\babsolute\b/);
    expect(button).toMatch(/min-h-11/);
    // the button comes before the code in reading order, in a row of its own
    expect(html.indexOf(button)).toBeLessThan(html.indexOf("<pre"));
  });
});

describe("refusals are stated once", () => {
  it("lists every status the engine can answer a caller with, 402 and 429 included", () => {
    const statuses = ERROR_STATUSES.map((e) => e.status);
    for (const s of [401, 402, 415, 422, 429, 503]) expect(statuses).toContain(s);
  });

  it("/developers and the OpenAPI default response both carry them", async () => {
    const html = await page(() => import("@/app/developers/page"));
    const doc = buildOpenApi(tools, ENGINE) as any;
    const description: string = doc.paths["/v1/screen"].post.responses.default.description;
    for (const e of ERROR_STATUSES) {
      expect(description).toContain(`${e.status}, ${e.meaning}`);
      expect(html).toContain(`>${e.status}</dt>`);
    }
    expect(html).toContain("Idempotency-Key");
    expect(html).toContain(tools.auth.header);
  });
});

describe("controls a phone user presses are 44 px", () => {
  it("the cost-of-delay demo's slider and market select", () => {
    const html = renderToStaticMarkup(React.createElement(DelayDemo));
    expect(html.match(/<input[^>]*type="range"[^>]*>/)![0]).toMatch(/\bh-11\b/);
    expect(html.match(/<select[^>]*>/)![0]).toMatch(/min-h-11/);
  });

  it("the BTM bar's label is not squeezed into a sliver of its row", () => {
    const html = renderToStaticMarkup(React.createElement(DelayDemo));
    const bar = html.match(/<div[^>]*border-power\/30[^>]*style="width:[^"]*"[^>]*>/)![0];
    expect(bar).toMatch(/min-w-\[min\(100%,15rem\)\]/);
  });

  it("the comparison form's inputs and selects, the deployment form's fields, and the next-step links", async () => {
    // These two forms need the app router to render, so their markup is read from source: every field class carries the height.
    for (const file of ["components/TtpCompare.tsx", "components/PowerDeployCaseForm.tsx"]) {
      const src = fs.readFileSync(file, "utf8");
      const fields = [...src.matchAll(/className="([^"]*(?:\bfield\b|border-line bg-panel px-3 py-2)[^"]*)"/g)];
      expect(fields.length, file).toBeGreaterThan(0);
      for (const f of fields) expect(f[1], `${file}: ${f[1]}`).toMatch(/min-h-11/);
    }
    const { PathList } = await import("@/components/for/PathList");
    const list = renderToStaticMarkup(React.createElement(PathList, { path: [{ kind: "qualifier", why: "x" }], label: "Next" }));
    expect(list.match(/<a [^>]*class="([^"]*)"/)![1]).toMatch(/min-h-11/);
  });

  it("the reference file chips and the related-constraint links", async () => {
    const ref = await page(() => import("@/app/reference/page"));
    const chips = [...ref.matchAll(/<a [^>]*href="\/reference\/[^"]*\.(?:md|json|csv|zip)"[^>]*class="([^"]*font-mono[^"]*)"/g)];
    expect(chips.length).toBeGreaterThanOrEqual(10);
    for (const c of chips) expect(c[1]).toMatch(/min-h-11/);

    const mod = await import("@/app/constraints/[slug]/page");
    const el = await mod.default({ params: Promise.resolve({ slug: "busway-ampacity" }) } as never);
    const html = renderToStaticMarkup(el).replace(/<!-- -->/g, "");
    const related = [...html.matchAll(/<a [^>]*class="([^"]*)"[^>]*href="\/constraints\/(?!busway-ampacity)[^"]+"/g)];
    expect(related.length).toBeGreaterThan(0);
    for (const r of related) expect(r[1]).toMatch(/min-h-11/);
  });
});
