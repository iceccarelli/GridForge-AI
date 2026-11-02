// An OpenAPI 3.1 description of the engine's public HTTP interface, generated from public/reference/tools.json — the file the
// engine itself writes and CI diffs — so the machine-readable contract cannot drift from the tool list, the input schemas or the
// unit weights. Nothing here is typed by hand except the envelope (auth header, error shape, headers) that was read off the live
// engine; no price appears: units are weights, and what a unit costs is on /pricing and in the engine's own /v1/version.

import engineDeployed from "@/lib/engine-deployed.json";

export interface ToolRow {
  name: string;
  description: string;
  endpoint: string;
  method: string;
  tier: string;
  units: number;
  returns: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolsFile {
  tools: ToolRow[];
  auth: { header: string; note: string };
  evidence_note: string;
}

const RESPONSE_HEADERS = {
  "X-GridForge-Units": { description: "Units this request was weighted at.", schema: { type: "string" } },
  "X-GridForge-Units-Month": { description: "Units used so far this UTC month.", schema: { type: "string" } },
  "X-GridForge-Units-Remaining": { description: "Units left under the cap for the month.", schema: { type: "string" } },
  "X-GridForge-Idempotent-Replay": { description: "Present when the response is a replay of an earlier request with the same Idempotency-Key.", schema: { type: "string" } },
};

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

export function buildOpenApi(file: ToolsFile, serverUrl: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const t of file.tools) {
    const free = t.units === 0;
    paths[t.endpoint] = {
      [t.method.toLowerCase()]: {
        operationId: t.name,
        summary: firstSentence(t.description),
        description: `${t.description}\n\nReturns: ${t.returns}\n\n${file.evidence_note}`,
        tags: [free ? "free" : "metered"],
        "x-gridforge-units": t.units,
        "x-gridforge-tier": t.tier,
        security: free ? [] : [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            description: "Repeat a request safely: the same key replays the first response and is not charged twice.",
            schema: { type: "string", maxLength: 150 },
          },
        ],
        requestBody: { required: true, content: { "application/json": { schema: t.inputSchema } } },
        responses: {
          "200": {
            description: "The result. Every numeric field carries an evidence class and provenance.",
            headers: RESPONSE_HEADERS,
            content: { "application/json": { schema: { type: "object" } } },
          },
          default: {
            description: "A refusal (for example 401 without a key where one is needed, or 422 for input too thin or invalid). A rejected or failed request is not charged.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Time to Power engine",
      version: engineDeployed.engine_version,
      description:
        "Capacity and density screening for existing AI data halls. Generated from the engine's own tool list. Screening-mode output: not an issued engineering opinion. " +
        file.auth.note,
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: file.auth.header } },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { schema_version: { type: "string" }, error: { type: "string" } },
          additionalProperties: true,
        },
      },
    },
  };
}
