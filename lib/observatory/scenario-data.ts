// STUB (replaced by the data workstream): loads and validates public/observatory/scenarios.json.
import type { ScenarioFile } from "@/lib/observatory/types";

/** Validate untrusted JSON against the contract; throws on any drift (the page must not render a malformed file). */
export function parseScenarioFile(_raw: unknown): ScenarioFile {
  throw new Error("parseScenarioFile: not implemented");
}

/** Server-only: read the committed file and validate it. */
export function loadScenarioFile(): ScenarioFile {
  throw new Error("loadScenarioFile: not implemented");
}
