/**
 * The save panel on the comparison page: what it promises before a click, and that it cannot be shown for an example.
 * Behaviour behind the buttons is tested through the real routes in buyer-page.test.ts.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TtpSaveToProject } from "@/components/TtpSaveToProject";
import { TtpCompare } from "@/components/TtpCompare";

describe("TtpSaveToProject", () => {
  const html = renderToStaticMarkup(React.createElement(TtpSaveToProject, { compare: { hall: { siteName: "x" } }, defaultName: "North Hall" }));

  it("asks for a project name, pre-filled from the hall, and an optional company", () => {
    expect(html).toContain('value="North Hall"');
    expect(html).toContain("Company (optional)");
    expect(html).toContain("Save to a project");
  });
  it("says the engine is asked again and what is stored is its answer, and that the buyer needs no account", () => {
    expect(html).toMatch(/engine is asked again on\s+save, and what is stored is its answer/);
    expect(html).toMatch(/They need no account/);
  });
  it("shows no link, token or buyer page before anything is saved", () => {
    expect(html).not.toMatch(/workspace\?project|\/p\//);
    expect(html).not.toContain("Create a read-only buyer link");
  });
});

describe("the comparison page before a result exists", () => {
  it("offers no save panel: nothing is shown until the engine has solved something", () => {
    const html = renderToStaticMarkup(React.createElement(TtpCompare));
    expect(html).not.toContain("Take this further");
    expect(html).not.toContain("Save to a project");
  });
});
