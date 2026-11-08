/**
 * Every GitHub Actions workflow, the Dependabot configuration and every ruleset must PARSE.
 *
 * A workflow file that is not valid YAML does not fail a job: GitHub starts no jobs at all and reports one failed run with no checks, so a pull
 * request can merge with none of its required checks having run. That is exactly what happened when a step name held "text: more text" (an
 * unquoted colon-space inside a plain scalar). The Python workflow tests read the files as text and could not see it, so this parses them with
 * a real YAML parser and checks the shape GitHub needs (a name, an `on`, jobs that each have steps or a reusable-workflow call).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const ROOT = process.cwd();
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const files = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();

describe("workflow files parse as YAML and have the shape GitHub needs", () => {
  it("finds the workflows", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  describe.each(files)("%s", (file) => {
    const text = fs.readFileSync(path.join(WORKFLOWS, file), "utf8");
    it("is valid YAML (no unquoted 'key: value' inside a plain scalar, no tabs)", () => {
      expect(() => yaml.load(text, { filename: file, json: false })).not.toThrow();
    });
    it("has a name, a trigger and jobs whose steps have a run or uses", () => {
      const doc = yaml.load(text) as Record<string, any>;
      expect(typeof doc.name, "name").toBe("string");
      expect(doc.on ?? doc[true as unknown as string], "on").toBeTruthy();
      const jobs = doc.jobs as Record<string, any>;
      expect(Object.keys(jobs).length, "jobs").toBeGreaterThan(0);
      for (const [id, job] of Object.entries(jobs)) {
        if (job.uses) continue; // a reusable-workflow call has no steps
        expect(Array.isArray(job.steps) && job.steps.length > 0, `${id} has steps`).toBe(true);
        for (const [i, step] of (job.steps as any[]).entries()) {
          expect(step.run || step.uses, `${file} ${id} step ${i + 1} (${step.name ?? "unnamed"}) has run or uses`).toBeTruthy();
          if (step.name !== undefined) expect(typeof step.name, `${id} step ${i + 1} name is a string`).toBe("string");
        }
      }
    });
  });

  it("dependabot.yml parses", () => {
    const doc = yaml.load(fs.readFileSync(path.join(ROOT, ".github", "dependabot.yml"), "utf8")) as Record<string, any>;
    expect(doc.version).toBe(2);
    expect(Array.isArray(doc.updates)).toBe(true);
  });

  it("the ruleset files are JSON", () => {
    for (const f of fs.readdirSync(path.join(ROOT, ".github", "rulesets")).filter((n) => n.endsWith(".json"))) {
      expect(() => JSON.parse(fs.readFileSync(path.join(ROOT, ".github", "rulesets", f), "utf8")), f).not.toThrow();
    }
  });
});
