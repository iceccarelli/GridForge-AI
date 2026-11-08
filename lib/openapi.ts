// An OpenAPI 3.1 description of the engine's public HTTP interface, generated from public/reference/tools.json — the file the
// engine itself writes and CI diffs — so the machine-readable contract cannot drift from the tool list, the input schemas or the
// unit weights. Nothing here is typed by hand except the envelope (auth header, error shape, headers) that was read off the live
// engine; no price appears: units are weights, and what a unit costs is on /pricing and in the engine's own /v1/version.

import engineDeployed from "@/lib/engine-deployed.json";
import honesty from "@/lib/openapi-honesty.json";
import { SITE_URL } from "@/lib/site";
import { DATA_ORIGINS, EVIDENCE_CLASS_CODES, ORIGINS, ROLES } from "@/lib/site-registry-fields";

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
  /** Every route with a unit weight, tool or no tool (public/reference/tools.json `rate_card`). /v1/deck is in it and is not a tool. */
  rate_card?: { endpoint: string; units: number; tool: string | null }[];
  mcp?: { endpoint: string; protocol: string; protocolVersion: string };
}

const RESPONSE_HEADERS = {
  "X-GridForge-Units": { description: "Units this request was weighted at (0 on an idempotent replay).", schema: { type: "string" } },
  "X-GridForge-Units-Month": { description: "Units used so far this UTC month, counted against this key's own scope (free allowance, pay-as-you-go cap or plan).", schema: { type: "string" } },
  "X-GridForge-Units-Remaining": { description: "Units left under the cap or plan allowance for the month. Present only when the key has one.", schema: { type: "string" } },
  "X-GridForge-Charge-Cents": { description: "Pay-as-you-go keys only: what this request adds to the invoice, in euro cents.", schema: { type: "string" } },
  "X-GridForge-Key-Expires": { description: "Present when the key has an expiry date.", schema: { type: "string" } },
  "X-GridForge-Idempotent-Replay": { description: "\"true\" when the response is a replay of an earlier request with the same Idempotency-Key. The engine also sends the same value as Idempotent-Replay.", schema: { type: "string" } },
};

/** What the engine really does with an Idempotency-Key, read off gridforge/api/server.py (REST and MCP) and gridforge/api/ledger.py. */
export const IDEMPOTENCY_KEY_MAX_CHARS: number = honesty.engine_constants.idempotency_key_max_chars;
/** How long a charged key is remembered: the response cache's TTL and the ledger's IDEMPOTENCY_WINDOW_SECONDS, both 24 hours. */
export const IDEMPOTENCY_WINDOW_HOURS: number = honesty.engine_constants.idempotency_window_hours;
/** The largest request body the engine reads (MAX_BODY_BYTES). */
export const MAX_BODY_BYTES: number = honesty.engine_constants.max_body_bytes;
/** The most halls the estimator accepts (MAX_ESTIMATE_HALLS). */
const MAX_ESTIMATE_HALLS: number = honesty.engine_constants.max_estimate_halls;
/** The most JSON-RPC messages in one /mcp batch (MAX_MCP_BATCH). */
export const MAX_MCP_BATCH: number = honesty.engine_constants.max_mcp_batch;

/**
 * The Idempotency-Key guarantee, stated once for /openapi.json, /developers and /llms.txt, and exactly as narrow as the server makes it.
 * The guarantee is about billing and about the answer, not about the work: a retry is never charged again and is answered with the same
 * result, but the engine may recompute it (it is deterministic) when the stored copy is no longer in memory.
 */
export function idempotencyStatement(opts: { estimator?: boolean } = {}): string {
  const estimator = opts.estimator ?? true;
  return (
    `Send an Idempotency-Key header (at most ${IDEMPOTENCY_KEY_MAX_CHARS} characters) on a POST, or on an /mcp tools/call. A longer key is refused: HTTP 400 on REST; over /mcp, JSON-RPC error -32602 with data.status 400 inside an HTTP 200. ` +
    (estimator
      ? `It takes effect only on a request that carries a valid API key, and never on /v1/estimate: a keyless call to a free operation is not deduplicated. `
      : `It takes effect only on a request that carries a valid API key: a keyless call to a free operation is not deduplicated. `) +
    `The key is scoped to your account and to the endpoint (over /mcp, the tool's endpoint), so the same string on another endpoint is a different request. ` +
    `For ${IDEMPOTENCY_WINDOW_HOURS} hours after the first successful answer, a retry with the same key and the same body is answered with that first result and is not charged again; ` +
    `the replay carries X-GridForge-Idempotent-Replay: true (also sent as Idempotent-Replay: true) and its units are 0. ` +
    `"The same body" is exact: on REST it is the same bytes, so a re-indented or re-ordered JSON body is a different body; over /mcp it is the same arguments in any key order. ` +
    `The same key with a different body is refused and nothing runs: HTTP 422 on REST; over /mcp, JSON-RPC error -32602 with data.status 422 inside an HTTP 200. ` +
    `In an /mcp batch each message is keyed as <key>#<position in the batch>; a batch that mixes replays with new messages carries X-GridForge-Idempotent-Replay: true at the HTTP level, and X-GridForge-Units is the units actually charged for its new messages, not 0. ` +
    `Only a successful answer is remembered: a refused or failed call was refunded, so retrying it runs it afresh. ` +
    `If the stored answer has been evicted from the engine's memory, or the engine has restarted, the engine recomputes it and still does not charge twice only when it keeps its ledger durably (GET /v1/version reports metering.ledger_durable: true; keys with a spending cap or a free allowance are refused with 503 without one). Without a durable ledger such a retry is a new, charged request. ` +
    `A recomputed answer is the same except for date-stamped fields (a generated date, provenance.report_date) and the code digest if the engine was redeployed inside the window. ` +
    `A replay still counts toward the rate limit. After ${IDEMPOTENCY_WINDOW_HOURS} hours the key is forgotten and a repeat is a new, chargeable request.`
  );
}

/**
 * The refusals a caller can meet, read off the engine's HTTP handler. One list, so /developers and the OpenAPI default
 * response say the same thing. A refused or failed call is never charged.
 */
export const ERROR_STATUSES: { status: number; meaning: string }[] = [
  { status: 400, meaning: "the body is not valid JSON or not a JSON object, or the Idempotency-Key is longer than the limit" },
  { status: 401, meaning: "a metered route was called without a key, or with one the engine does not accept" },
  { status: 402, meaning: "the key's monthly allowance or cap is spent; the call was refused and not charged. Buy more, do not retry" },
  { status: 413, meaning: `the body is larger than ${MAX_BODY_BYTES / 1024} KiB` },
  { status: 415, meaning: "the body was declared as anything other than application/json" },
  { status: 422, meaning: "the input is too thin or invalid, or an Idempotency-Key was reused with a different body; nothing was solved" },
  { status: 429, meaning: "the per-client request rate limit was exceeded; wait and retry (the limit is rate_limit_per_minute at /v1/version)" },
  { status: 500, meaning: "the engine failed on a valid request; the charge is refunded" },
  { status: 503, meaning: "paid endpoints are not configured on that deployment, or a charge could not be recorded durably" },
];

// ---------------------------------------------------------------------------------------------------------------------------
// The site and hall registry (migrations 0049-0051; routes under app/api/orgs, app/api/sites, app/api/halls; lib/sites.ts).
//
// These are WEBSITE routes, not engine routes: each path item names the website as its server, they are called with a signed-in person's
// Supabase access token (not an API key), they are never metered, and they answer 503 until the migrations are applied. The administrator
// routes (/api/admin/...) are deliberately NOT described here. Every response is Cache-Control: no-store.
// ---------------------------------------------------------------------------------------------------------------------------

const idParam = (name: string, what: string) => ({ name, in: "path", required: true, description: what, schema: { type: "string", format: "uuid" } });
const bearer = [{ SupabaseSession: [] }];
const NO_STORE = { "Cache-Control": { description: "Always no-store: every answer is for one signed-in person.", schema: { type: "string", enum: ["no-store"] } } };
const failure = (description: string) => ({ description, headers: NO_STORE, content: { "application/json": { schema: { $ref: "#/components/schemas/RegistryError" } } } });
const success = (description: string, schema: Record<string, unknown>) => ({ description, headers: NO_STORE, content: { "application/json": { schema } } });
const jsonBody = (schema: Record<string, unknown>) => ({ required: true, content: { "application/json": { schema } } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const envelope = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object", required: ["ok", ...required], properties: { ok: { type: "boolean", const: true }, ...props },
});

/** The refusals every registry route can meet, in the order the route checks them: sign-in, address, body, allowance, store. */
const COMMON = {
  "401": failure("No valid sign-in, or the session has expired. Sign in again."),
  "403": failure("The address on the session has not been confirmed (sign in with the emailed link), or the caller's role in the organisation does not allow this."),
  "429": failure("The per-account request allowance was exceeded; wait and retry. Counted per verified account, not per network address."),
  "503": failure("The registry is unavailable: Supabase is not configured, the migrations (0049-0052) are not applied, or the store could not be reached. Nothing was changed."),
};
const WRITE = {
  ...COMMON,
  "400": failure("The body, an id or a query value is not valid. Names the fields that are wrong (issues[].field, message) and never echoes their values."),
  "413": failure("The body is larger than 8 KiB."),
};
const NOT_FOUND = failure("No such item. A person who is not a member of the organisation gets exactly this answer, so nothing is learned about what exists.");
const CONFLICT = failure("The request conflicts with what is recorded (a name already used, a limit reached, a figure corrected first by someone else). `reason` says which.");

const SCHEMAS = {
  RegistryError: {
    type: "object", required: ["ok", "error"],
    properties: {
      ok: { type: "boolean", const: false },
      error: { type: "string" },
      reason: { type: "string", description: "A short stable code for the refusal, for example name_taken, last_owner, superseded, invalid_reference." },
      currentId: { type: "string", format: "uuid", description: "On a refused correction: the figure that replaced the one named." },
      issues: { type: "array", items: { type: "object", properties: { field: { type: "string" }, message: { type: "string" } } } },
    },
  },
  Organisation: {
    type: "object", required: ["id", "name", "role", "createdAt"],
    properties: {
      id: { type: "string", format: "uuid" }, name: { type: "string" }, role: { type: "string", enum: [...ROLES], description: "The caller's role in it." },
      createdAt: { type: "string", format: "date-time" },
      memberId: { type: "string", format: "uuid", description: "The caller's own membership, the id to pass to DELETE .../members?id= to leave." },
      addedBy: { type: "string", description: "Who added the caller. There is no acceptance step: an owner adds an address and its holder is a member when they next sign in." },
      addedAt: { type: "string", format: "date-time" },
    },
    description: "An organisation is a group of people who share a registry. It is NOT a billing entity and is unrelated to a subscription's seats.",
  },
  Member: {
    type: "object", required: ["id", "email", "role", "addedBy", "addedAt"],
    properties: { id: { type: "string", format: "uuid" }, email: { type: "string" }, role: { type: "string", enum: [...ROLES] }, addedBy: { type: "string" }, addedAt: { type: "string", format: "date-time" } },
  },
  Hall: {
    type: "object", required: ["id", "siteId", "label", "createdBy", "createdAt"],
    properties: { id: { type: "string", format: "uuid" }, siteId: { type: "string", format: "uuid" }, label: { type: "string" }, createdBy: { type: "string" }, createdAt: { type: "string", format: "date-time" } },
  },
  Site: {
    type: "object", required: ["id", "orgId", "name", "country", "dataOrigin"],
    properties: {
      id: { type: "string", format: "uuid" }, orgId: { type: "string", format: "uuid" }, orgName: { type: "string" }, name: { type: "string" },
      country: { type: ["string", "null"], pattern: "^[A-Z]{2}$" },
      dataOrigin: { type: "string", enum: [...DATA_ORIGINS], description: "What KIND of data the site holds, declared by whoever created it and fixed once written. It is a declaration, not verified. A project attached to a test or synthetic site is kept out of the calibration ledger." },
      createdBy: { type: "string" }, createdAt: { type: "string", format: "date-time" }, halls: { type: "array", items: ref("Hall") },
    },
  },
  HallInput: {
    type: "object", required: ["id", "fieldPath", "value", "unit", "evidenceClass", "origin", "asOf", "recordedBy", "recordedAt", "supersedesId", "superseded", "source"],
    properties: {
      id: { type: "string", format: "uuid" }, fieldPath: { type: "string", description: "A dotted lower-case path such as grid.firm_capacity_mva." },
      value: { type: ["number", "string", "boolean", "null"] }, unit: { type: ["string", "null"] },
      evidenceClass: { type: "string", enum: [...EVIDENCE_CLASS_CODES], description: "As DECLARED by the recorder. The database enforces the rules between origin and class; nothing verifies that a declared class is deserved." },
      origin: { type: "string", enum: [...ORIGINS], description: "Where the figure came from, as declared by the recorder." },
      asOf: { type: "string", format: "date" }, recordedBy: { type: "string" }, recordedAt: { type: "string", format: "date-time" },
      supersedesId: { type: ["string", "null"], format: "uuid" }, superseded: { type: "boolean" },
      source: {
        type: ["object", "null"], properties: {
          kind: { type: "string", enum: ["project_evidence", "intake_evidence"] }, id: { type: "string", format: "uuid" },
          filename: { type: ["string", "null"] }, reviewStatus: { type: ["string", "null"], description: "The file's review status now, read live." },
        },
      },
    },
  },
  TimelineEvent: {
    type: "object", required: ["occurredAt", "kind", "subject", "summary", "origin", "basis", "actor", "superseded", "sourceTable", "sourceId"],
    properties: {
      occurredAt: { type: "string", format: "date-time" },
      kind: { type: "string", description: "input_recorded, project_event, supplier_date, observation or project_attached." },
      subject: { type: "string" }, summary: { type: "string" }, origin: { type: "string" }, evidenceClass: { type: ["string", "null"] },
      basis: { type: "string", description: "What stands behind the event, in words. Nothing appears without one." },
      actor: { type: "string" }, projectId: { type: ["string", "null"], format: "uuid" }, superseded: { type: "boolean" },
      sourceTable: { type: "string" }, sourceId: { type: "string" },
    },
  },
};

const REGISTRY_PATHS: Record<string, Record<string, unknown>> = {
  "/api/orgs": {
    get: {
      operationId: "listOrganisations", summary: "The organisations the signed-in caller belongs to, with their role in each.",
      responses: { "200": success("The caller's organisations.", envelope({ orgs: { type: "array", items: ref("Organisation") } }, ["orgs"])), ...COMMON },
    },
    post: {
      operationId: "createOrganisation", summary: "Register an organisation; the caller becomes its owner.",
      requestBody: jsonBody({ type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 120 } } }),
      responses: {
        "201": success("Created.", envelope({ org: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" } } } }, ["org"])),
        ...WRITE, "409": CONFLICT,
      },
    },
  },
  "/api/orgs/{id}/members": {
    get: {
      operationId: "listOrganisationMembers", summary: "Who is in the organisation. Any member may read.",
      parameters: [idParam("id", "The organisation.")],
      responses: { "200": success("The active members.", envelope({ members: { type: "array", items: ref("Member") } }, ["members"])), ...COMMON, "400": failure("Not a valid id."), "404": NOT_FOUND },
    },
    post: {
      operationId: "addOrganisationMember", summary: "Add a person by the address they sign in with. Owners only. Nothing is emailed.",
      parameters: [idParam("id", "The organisation.")],
      requestBody: jsonBody({ type: "object", required: ["email", "role"], additionalProperties: false, properties: { email: { type: "string", format: "email", maxLength: 254 }, role: { type: "string", enum: [...ROLES] } } }),
      responses: { "201": success("Added.", envelope({ memberId: { type: "string", format: "uuid" } }, ["memberId"])), ...WRITE, "404": NOT_FOUND, "409": CONFLICT },
    },
    delete: {
      operationId: "removeOrganisationMember", summary: "An owner removes a member, or anyone removes themselves. The last owner can never be removed.",
      parameters: [idParam("id", "The organisation."), { name: "id", in: "query", required: true, description: "The membership to close (a member's `id`, or the caller's own `memberId`).", schema: { type: "string", format: "uuid" } }],
      responses: { "200": success("Removed.", envelope({})), ...WRITE, "404": NOT_FOUND, "409": CONFLICT },
    },
  },
  "/api/sites": {
    get: {
      operationId: "listSites", summary: "The sites, with their halls, of every organisation the caller belongs to, or of one of them.",
      parameters: [{ name: "org", in: "query", required: false, description: "Limit to one organisation.", schema: { type: "string", format: "uuid" } }],
      responses: { "200": success("The sites.", envelope({ sites: { type: "array", items: ref("Site") } }, ["sites"])), ...COMMON, "400": failure("Not a valid id."), "404": NOT_FOUND },
    },
    post: {
      operationId: "createSite", summary: "Add a site to an organisation. Editors and owners. `dataOrigin` is required and is fixed once written.",
      requestBody: jsonBody({
        type: "object", required: ["orgId", "name", "dataOrigin"], additionalProperties: false,
        properties: { orgId: { type: "string", format: "uuid" }, name: { type: "string", minLength: 1, maxLength: 120 }, country: { type: ["string", "null"], pattern: "^[A-Za-z]{2}$" }, dataOrigin: { type: "string", enum: [...DATA_ORIGINS] } },
      }),
      responses: { "201": success("Created.", envelope({ site: ref("Site") }, ["site"])), ...WRITE, "404": NOT_FOUND, "409": CONFLICT },
    },
  },
  "/api/sites/{id}/halls": {
    get: {
      operationId: "listHalls", summary: "The site and its halls. Any member of the site's organisation.",
      parameters: [idParam("id", "The site.")],
      responses: { "200": success("The site and its halls.", envelope({ site: ref("Site"), halls: { type: "array", items: ref("Hall") } }, ["site", "halls"])), ...COMMON, "400": failure("Not a valid id."), "404": NOT_FOUND },
    },
    post: {
      operationId: "createHall", summary: "Add a hall to a site. Editors and owners.",
      parameters: [idParam("id", "The site.")],
      requestBody: jsonBody({ type: "object", required: ["label"], additionalProperties: false, properties: { label: { type: "string", minLength: 1, maxLength: 120 } } }),
      responses: { "201": success("Created.", envelope({ hall: ref("Hall") }, ["hall"])), ...WRITE, "404": NOT_FOUND, "409": CONFLICT },
    },
  },
  "/api/halls/{id}/inputs": {
    get: {
      operationId: "listHallInputs",
      summary: "The hall's current recorded figures, or (history=1) every claim ever made, newest first.",
      description: "A field nobody has recorded is simply not listed. Each figure carries its declared origin and evidence class, its date, its source label and who recorded it.",
      parameters: [
        idParam("id", "The hall."),
        { name: "history", in: "query", required: false, description: "1 or true: every claim, including replaced ones, newest first, bounded.", schema: { type: "string", enum: ["1", "true"] } },
        { name: "field", in: "query", required: false, description: "With history: one dotted field path.", schema: { type: "string" } },
        { name: "limit", in: "query", required: false, description: "1 to 500; default 500.", schema: { type: "integer", minimum: 1, maximum: 500, default: 500 } },
      ],
      responses: {
        "200": success("The figures.", envelope({
          hall: { type: "object" }, inputs: { type: "array", items: ref("HallInput") },
          truncated: { type: "boolean", description: "More claims exist than were returned." }, history: { type: "boolean" },
        }, ["hall", "inputs", "truncated", "history"])),
        ...COMMON, "400": failure("Not a valid id or field path."), "404": NOT_FOUND,
      },
    },
    post: {
      operationId: "recordHallInput",
      summary: "Append one claim about a field. Nothing is overwritten: a correction names the claim it replaces (`supersedes`). Editors and owners.",
      description: "Origin and class are the recorder's declaration. The database refuses the combinations that would let a declared figure pass for a measured one: a measured, observed or quoted figure needs a source file; an assumed or modelled one cannot claim above E3; a missing figure has no value, no source and class E0; a class above E3 needs a reviewed and verified project file.",
      parameters: [idParam("id", "The hall.")],
      requestBody: jsonBody({
        type: "object", required: ["fieldPath", "value", "evidenceClass", "origin", "asOf"], additionalProperties: false,
        properties: {
          fieldPath: { type: "string", maxLength: 120 }, value: { type: ["number", "string", "boolean", "null"] }, unit: { type: ["string", "null"], maxLength: 24 },
          evidenceClass: { type: "string", enum: [...EVIDENCE_CLASS_CODES] }, origin: { type: "string", enum: [...ORIGINS] },
          projectEvidenceId: { type: ["string", "null"], format: "uuid" }, intakeEvidenceFileId: { type: ["string", "null"], format: "uuid" },
          asOf: { type: "string", format: "date" }, supersedes: { type: ["string", "null"], format: "uuid" },
        },
      }),
      responses: {
        "201": success("Recorded.", envelope({ id: { type: "string", format: "uuid" }, input: ref("HallInput") }, ["id", "input"])),
        ...WRITE, "404": NOT_FOUND, "409": CONFLICT,
        "422": failure("The cited file or earlier figure cannot be used for this hall (it does not exist, is not this hall's, or was reviewed and rejected)."),
      },
    },
  },
  "/api/halls/{id}/timeline": {
    get: {
      operationId: "getHallTimeline",
      summary: "What happened at the hall, newest first: figures recorded, the log of its attached projects, supplier delivery dates and observations submitted.",
      description: "Read only. Every event says what it is and what stands behind it. No project link token, storage location or log payload is in it.",
      parameters: [
        idParam("id", "The hall."),
        { name: "limit", in: "query", required: false, description: "1 to 500; default 100.", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        { name: "cursor", in: "query", required: false, description: "The `nextCursor` of the previous page, passed back verbatim. It is opaque: do not parse or construct it.", schema: { type: "string", minLength: 2, maxLength: 600 } },
      ],
      responses: {
        "200": success("One page of events.", envelope({
          hall: { type: "object" }, truncated: { type: "boolean" }, nextCursor: { type: ["string", "null"], description: "Null on the last page." }, events: { type: "array", items: ref("TimelineEvent") },
        }, ["hall", "truncated", "nextCursor", "events"])),
        ...COMMON, "400": failure("Not a valid id, or the cursor is not valid (reason invalid_cursor): start again from the newest."), "404": NOT_FOUND,
      },
    },
  },
  "/api/halls/{id}/projects": {
    post: {
      operationId: "attachProjectToHall",
      summary: "Attach an existing project to the hall by its link token. Editors and owners.",
      description: "The project's link token is the credential for that engagement and is never returned. Attaching makes the project's history, supplier dates and observations appear on the hall's timeline, and writes a project_attached_to_hall event to the project's own log. A project is in at most one hall at a time. A project attached to a test or synthetic site is not eligible for the calibration ledger.",
      parameters: [idParam("id", "The hall.")],
      requestBody: jsonBody({ type: "object", required: ["projectToken"], additionalProperties: false, properties: { projectToken: { type: "string", minLength: 8, maxLength: 200 } } }),
      responses: {
        "200": success("The project was already attached to this hall.", envelope({ projectId: { type: "string", format: "uuid" }, projectName: { type: "string" }, alreadyAttached: { type: "boolean", const: true } }, ["projectId", "projectName", "alreadyAttached"])),
        "201": success("Attached.", envelope({ projectId: { type: "string", format: "uuid" }, projectName: { type: "string" }, alreadyAttached: { type: "boolean", const: false } }, ["projectId", "projectName", "alreadyAttached"])),
        ...WRITE, "404": failure("No such hall, or no project has that link token."), "409": failure("The project already belongs to another hall; it has to be detached from it first (reason project_in_other_hall)."),
      },
    },
    delete: {
      operationId: "detachProjectFromHall",
      summary: "Take a project out of the hall. Owners only. Recorded, and logged in the project's own log.",
      description: "The hall's timeline stops showing the project's log from then on; the attachment and this detachment stay in the history. The project can then be attached to another hall.",
      parameters: [idParam("id", "The hall."), { name: "project", in: "query", required: true, description: "The project's id (not its link token).", schema: { type: "string", format: "uuid" } }],
      responses: { "200": success("Detached.", envelope({})), ...WRITE, "404": failure("No such hall, or the project is not attached to it.") },
    },
  },
};

/** The registry's paths, for the tests: these are the only non-engine paths in the document. */
export const REGISTRY_PATH_NAMES: string[] = Object.keys(REGISTRY_PATHS);

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

// ---------------------------------------------------------------------------------------------------------------------------
// The engine routes that are not tools: the free discovery reads, /v1/deck, and the MCP transport.
//
// Read off gridforge/api/server.py (ROUTES, GET_ROUTES, do_GET, do_POST). tests/site/agent-surface-parity.test.ts compares this list with
// the engine's own route tables and with lib/engine-deployed.json, so a route cannot be added, dropped or re-tiered on the engine without
// this document changing with it. /v1/revoke (operator only: 404 to everyone else) and /v1/admin/* are deliberately NOT described.
// ---------------------------------------------------------------------------------------------------------------------------

/** Engine routes this document leaves out on purpose, with the reason. The parity test requires every other deployed route to be described. */
export const ENGINE_UNDOCUMENTED: Record<string, string> = {
  "/v1/revoke": "Operator tier only. It answers 404, not 401, to anyone without the operator key, so a public contract must not advertise it.",
};

interface ExtraRoute {
  path: string;
  method: "get" | "post";
  operationId: string;
  summary: string;
  description: string;
  /** "key": a valid API key is required (401 without one). "none": no key needed. */
  auth: "key" | "none";
  response: Record<string, unknown>;
  /** Extra statuses beyond the default error response. */
  extraResponses?: Record<string, unknown>;
  parameters?: Record<string, unknown>[];
  /** An optional key: the route answers without one, and says more with one. */
  optionalKey?: boolean;
}

const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "object", properties, additionalProperties: true, ...extra });
const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const int = (description?: string) => ({ type: "integer", ...(description ? { description } : {}) });
const bool = (description?: string) => ({ type: "boolean", ...(description ? { description } : {}) });

const CALIBRATION_REF = { $ref: "#/components/schemas/CalibrationBlock" };

const DISCOVERY_ROUTES: ExtraRoute[] = [
  {
    path: "/health", method: "get", operationId: "health", auth: "none",
    summary: "Liveness check.",
    description: "Returns {ok, service, version}. Free, no key, and bounded by a generous separate rate limit.",
    response: obj({ ok: bool(), service: str(), version: str() }),
  },
  {
    path: "/v1/version", method: "get", operationId: "version", auth: "none",
    summary: "What this engine serves, how it meters, and its provenance.",
    description:
      "The engine's own statement of itself: version and provenance, the routes it serves (`endpoints`), the unit weight of every route (`unit_rates`), " +
      "the pay-as-you-go terms (`payg`: unit_price_cents, currency, min_invoice_cents, free_allowance_units, billing_rule), the Idempotency-Key rule, " +
      "the rate limit, and where the machine interfaces and the calibration record are. This is the authoritative source of every price and limit; this document states none. Free, no key.",
    response: obj({
      version: str(), provenance: obj({ schema: str(), engine_version: str(), code_sha256: str(), cost_library_sha256: str(), calibration_sha256: str(), digest: str(), report_date: str() }),
      auth_configured: bool(), signed_keys: bool(), rate_limit_per_minute: int(), schema: str(), idempotency: str(), idempotency_key_max_chars: int(),
      tier: str(), endpoints: { type: "array", items: str() }, unit_rates: { type: "object", additionalProperties: int() },
      payg: obj({ unit_price_cents: int(), currency: str(), min_invoice_cents: int(), free_allowance_units: int(), billing_rule: str() }),
      metering: obj({ durable: bool(), ledger_durable: bool(), over_quota_status: int(), note: str() }),
      machine_interface: obj({ tools: str(), mcp: str(), protocolVersion: str() }), calibration: str(),
    }),
  },
  {
    path: "/v1/tools", method: "get", operationId: "tools", auth: "none",
    summary: "The tool catalogue: OpenAI function-calling shape and MCP shape, the rate card and the auth rule.",
    description:
      "Returns `tools` (name, description, endpoint, method, tier, units, returns, inputSchema), `openai`, `mcp` (endpoint, protocol, protocolVersion, tools), `auth`, `payg`, " +
      "`rate_card` (every weighted route, including /v1/deck which is not a tool) and `evidence_note`. This document and the site's /reference/tools.json are generated from the same catalogue. Free, no key.",
    response: obj({
      tools: { type: "array", items: { type: "object" } }, openai: { type: "array", items: { type: "object" } },
      mcp: obj({ endpoint: str(), protocol: str(), protocolVersion: str(), tools: { type: "array", items: { type: "object" } } }),
      auth: obj({ header: str(), note: str() }), payg: obj({}), rate_card: { type: "array", items: obj({ endpoint: str(), units: int(), tool: { type: ["string", "null"] } }) },
      evidence_note: str(),
    }),
  },
  {
    path: "/v1/platforms", method: "get", operationId: "platforms", auth: "none",
    summary: "The rack platform library, short form.",
    description:
      "The platforms in the library: id, name, status, rack_kW, gpus_per_rack. The figures are taken from the cited sources and held in the library as assumptions with bands (one entry is a generic archetype with no manufacturer); none is a measurement. Platforms whose manufacturer has not published a rack power are absent by design and listed under " +
      "`deliberately_absent` with the reason; no rack power is estimated for them. The full set of figures with sources is the site's /reference/platforms.json. Free, no key.",
    response: obj({ platforms: { type: "array", items: obj({ id: str(), name: str(), status: str(), rack_kW: { type: "number" }, gpus_per_rack: int() }) }, deliberately_absent: { type: "object", additionalProperties: str() }, note: str() }),
  },
  {
    path: "/v1/intake/template", method: "get", operationId: "intakeTemplate", auth: "none",
    summary: "The blank intake document with every field.",
    description: "The form a sparse intake is completed from: any field left out of a request is filled from library defaults and reported as an assumption in the response. Free, no key.",
    response: { type: "object", additionalProperties: true },
  },
  {
    path: "/v1/calibration", method: "get", operationId: "calibration", auth: "none",
    summary: "How far the model has been reconciled against instrumented sites.",
    description:
      "The accuracy record, public precisely because the answer can be \"none\": `state` is uncalibrated, indicative or calibrated, with the counts behind it (observations, sites, halls, " +
      "outputs asserted and outputs with site observations) and a `policy`. Only the published ledger is read; an observation a client supplied never reaches it. If the ledger fails its integrity check " +
      "the route answers 503 with state \"unavailable\" rather than an empty or partial record. Free, no key.",
    response: { allOf: [CALIBRATION_REF, obj({ ledger_sources: int(), policy: str() })] },
    extraResponses: { "503": { description: "The calibration ledger failed its integrity check and is not being served.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } },
  },
  {
    path: "/v1/calibration/residuals", method: "get", operationId: "calibrationResiduals", auth: "none",
    summary: "Aggregate residual statistics over approved observation records only.",
    description:
      "Per subsystem and per variable: how many approved observations and distinct sites there are, the state, and how many more are still needed. A draft or rejected record changes nothing here, " +
      "not even a count; no site, hall, record id, free text or measurement is in the payload. With nothing approved it says `uncalibrated` with `n_records` 0. " +
      "A store whose hash chain is broken answers 503, never an empty or partial answer. Free, no key.",
    response: { $ref: "#/components/schemas/ResidualReport" },
    extraResponses: { "503": { description: "The calibration record store failed its integrity check and is not being served.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } },
  },
  {
    path: "/v1/usage", method: "get", operationId: "usage", auth: "key",
    summary: "This key's metered usage for the current UTC month.",
    description: "The statement for the key that is sent: units used this month, by endpoint and by scope, the monthly quota and units remaining, and (pay-as-you-go keys) the accrued amount in euro cents. Answers 401 without a key. It is never itself metered.",
    response: obj({ account: str(), key: str(), scope: str(), month: str(), units: int(), calls: int(), by_endpoint: { type: "object", additionalProperties: int() }, monthly_quota: { type: ["integer", "null"] }, units_remaining: { type: ["integer", "null"] }, unit_rates: { type: "object", additionalProperties: int() } }),
  },
];

/**
 * GET /v1/estimate?endpoint=&hall_count= — the same estimator as the POST tool, as a query (server.py do_GET). The site's own snippets
 * and cost estimator call this form. Free and never metered; a key is optional and, when sent, adds where that key stands.
 */
const ESTIMATE_GET: ExtraRoute = {
  path: "/v1/estimate", method: "get", operationId: "estimateGet", auth: "none", optionalKey: true,
  summary: "What a call would cost, before it is made (query form).",
  description:
    "Name an engine route in `endpoint` and, for /v1/portfolio, the number of halls in `hall_count`: the answer is the units, the unit price and the cost in euro cents BEFORE anything is spent. " +
    "The units are read by the same function the meter uses, so an estimate cannot drift from a bill. Free, never metered, no key needed; with a valid key it also says where that key stands " +
    "(scope, cap, used, remaining, whether the call fits). The POST form with a `body` is the gridforge_estimate tool; this GET form takes no body, so it prices a call by its endpoint (and hall count) only.",
  parameters: [
    { name: "endpoint", in: "query", required: true, description: "The engine route to price, e.g. /v1/study. Any route that has a unit rate.", schema: { type: "string" } },
    { name: "hall_count", in: "query", required: false, description: `Halls in a /v1/portfolio request (one unit each). A whole number from 1 to ${MAX_ESTIMATE_HALLS}.`, schema: { type: "integer", minimum: 1, maximum: MAX_ESTIMATE_HALLS } },
  ],
  response: obj({
    endpoint: str(), units: int(), unit_price_cents: int(), currency: str(), estimated_cents: int(), billable: bool(), free: bool(), basis: str(), note: str(),
    scope: str("Only with a valid key."), cap_units: { type: ["integer", "null"] }, used_units: int(), remaining_units: { type: ["integer", "null"] }, fits: bool(),
    would_cost_after_allowance: int("Cents this call would add that the key's own allowance does not cover. Only with a valid key."),
    key_error: str("Present when a key was sent and not recognised."),
  }),
  extraResponses: {
    "422": { description: "`endpoint` is not a route with a unit rate (the answer lists the available ones), or `hall_count` is not a whole number in range.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  },
};

/** The most halls the estimator accepts in `hall_count` (MAX_ESTIMATE_HALLS in server.py). */
export const MAX_ESTIMATE_HALLS_DOC: number = MAX_ESTIMATE_HALLS;

/** For the other surfaces that list the free reads: the estimator's query form. */
export const ENGINE_ESTIMATE_GET = { path: "/v1/estimate", query: "?endpoint=<route>&hall_count=<n>", summary: ESTIMATE_GET.summary };

/** The free-to-read engine routes, for the other surfaces (llms.txt, /developers) that list them: one description, here. */
export const ENGINE_DISCOVERY: { path: string; method: "GET"; summary: string; keyRequired: boolean }[] = DISCOVERY_ROUTES.map((r) => ({
  path: r.path, method: "GET", summary: r.summary, keyRequired: r.auth === "key",
}));

/** The engine routes this document describes besides the tools' own: /v1/deck, the free discovery reads and the MCP transport. */
export const ENGINE_NON_TOOL_PATHS: string[] = ["/v1/deck", ...DISCOVERY_ROUTES.map((r) => r.path), "/mcp"];

const JSON_RPC_REQUEST = {
  type: "object",
  required: ["jsonrpc", "method"],
  properties: {
    jsonrpc: { type: "string", const: "2.0" },
    id: { type: ["string", "integer", "null"] },
    method: { type: "string", description: "initialize, tools/list, tools/call, ping, or a notification." },
    params: { type: "object" },
  },
};

function operationFor(route: ExtraRoute, units: number | null): Record<string, unknown> {
  const keyed = route.auth === "key";
  return {
    operationId: route.operationId,
    summary: route.summary,
    description: route.description,
    tags: [keyed ? "metered" : "free"],
    ...(units !== null ? { "x-gridforge-units": units } : {}),
    ...(route.parameters ? { parameters: route.parameters } : {}),
    // An optional key is the empty requirement beside the key one: the route works without it.
    security: keyed ? [{ ApiKeyAuth: [] }] : route.optionalKey ? [{}, { ApiKeyAuth: [] }] : [],
    responses: {
      "200": { description: "The answer.", content: { "application/json": { schema: route.response } } },
      ...(route.extraResponses ?? {}),
      default: {
        description: `A refusal: ${ERROR_STATUSES.map((e) => `${e.status}, ${e.meaning}`).join("; ")}.`,
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  };
}

/** Where, in a tool's 200 response, the engine puts its honesty fields (lib/openapi-honesty.json). */
function responseSchemaFor(endpoint: string): Record<string, unknown> {
  const spec = (honesty.responses as Record<string, { top_level: string[]; after_relief?: string[]; intake_gaps?: boolean }>)[endpoint];
  if (!spec) return { type: "object" };
  const properties: Record<string, unknown> = {};
  for (const f of spec.top_level) {
    if (f === "calibration") properties[f] = CALIBRATION_REF;
    else if (f === "notice") properties[f] = str("The engine's standing notice: directional, modelled output, not an issued engineering opinion.");
    else if (f === "grade") properties[f] = str("How far the comparison can be relied on: screening or indicative. Never stronger than its weakest input.");
    else if (f === "caveats") properties[f] = { type: "array", items: str(), description: "Plain-language limits on the answer, including what the context blocks are and are not." };
    else if (f === "request_digest") properties[f] = str("A digest of the request, so the same inputs can be recognised later.");
    else if (f === "provenance") properties[f] = { type: "object", description: "What produced this answer: engine version and the digests of the code, the cost library and the calibration record." };
    else if (f === "schema") properties[f] = str("The response schema id, e.g. gridforge/ttp-compare/1.");
    else if (f === "intake") {
      properties[f] = obj({
        completeness: { type: "number" }, can_issue_a_study: bool(), warnings: { type: "array", items: str() },
        gaps: spec.intake_gaps
          ? {
              type: "array",
              description: "The assumption disclosure: every input the request did not supply, what the engine assumed in its place (`assumed`) and why it matters (`why_it_binds`).",
              items: { $ref: "#/components/schemas/AssumptionGap" },
            }
          : { type: "array" },
      });
    } else if (f === "after_relief" && spec.after_relief) {
      properties[f] = obj({
        date_basis: str("What the date rests on; \"assumed\" means the item that sets it carries an assumed lead time, so it is not a date."),
        date_evidence_class: { type: ["string", "null"], description: "The evidence class (E0 to E7) of the date; null when there is no date." },
        date_label: str("The date, or the reason there is none, in words."),
      });
    } else properties[f] = {};
  }
  return { type: "object", properties, additionalProperties: true };
}

export function buildOpenApi(file: ToolsFile, serverUrl: string, siteOrigin: string = SITE_URL): Record<string, unknown> {
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
        "x-gridforge-mcp-tool": t.name,
        security: free ? [] : [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            description: idempotencyStatement(),
            schema: { type: "string", maxLength: IDEMPOTENCY_KEY_MAX_CHARS },
          },
          ...(free
            ? []
            : [
                {
                  name: "X-GridForge-Project",
                  in: "header",
                  required: false,
                  description: "A label you choose (at most 64 characters of letters, digits and . _ : -) so your own usage can be split by project. Anything else is ignored, never rejected.",
                  schema: { type: "string", maxLength: 64 },
                },
              ]),
        ],
        requestBody: { required: true, content: { "application/json": { schema: t.inputSchema } } },
        responses: {
          "200": {
            description: "The result. Every numeric field carries an evidence class and provenance.",
            headers: RESPONSE_HEADERS,
            content: { "application/json": { schema: responseSchemaFor(t.endpoint) } },
          },
          default: {
            description: `A refusal: ${ERROR_STATUSES.map((e) => `${e.status}, ${e.meaning}`).join("; ")}. A rejected or failed request is not charged.`,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    };
  }
  // The engine routes that are not tools. /v1/deck takes its weight from the rate card; it is REST only (there is no MCP tool for it).
  const deckUnits = file.rate_card?.find((r) => r.endpoint === "/v1/deck")?.units;
  if (deckUnits !== undefined) {
    const screen = file.tools.find((t) => t.endpoint === "/v1/screen");
    paths["/v1/deck"] = {
      post: {
        ...operationFor(
          {
            path: "/v1/deck", method: "post", operationId: "deck", auth: "key",
            summary: "Walkthrough deck for a hall.",
            description:
              "An intake in, the client-session walkthrough deck out as HTML (`format`, `title`, `slides`, `document`, `document_full`). Needs a key and is weighted in units. " +
              "It is a REST route only: there is no MCP tool for it, because it is a document for a human session, not an agent step. Screening-mode output, not an issued engineering opinion.\n\n" + file.evidence_note,
            response: obj({ format: str(), title: str(), slides: int(), document: str(), document_full: str() }),
          },
          deckUnits,
        ),
        "x-gridforge-units": deckUnits,
        parameters: [
          { name: "Idempotency-Key", in: "header", required: false, description: idempotencyStatement(), schema: { type: "string", maxLength: IDEMPOTENCY_KEY_MAX_CHARS } },
          { name: "X-GridForge-Project", in: "header", required: false, description: "A label you choose (at most 64 characters of letters, digits and . _ : -) so your own usage can be split by project.", schema: { type: "string", maxLength: 64 } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  intake: { type: "object", additionalProperties: true, description: "A GridForge intake document. GET /v1/intake/template for the blank form; a sparse one is completed from library defaults and reported as assumptions. The intake fields may instead be sent at the top level." },
                  objective: screen ? (screen.inputSchema as { properties?: Record<string, unknown> }).properties?.objective ?? { type: "string" } : { type: "string" },
                },
                additionalProperties: true,
              },
            },
          },
        },
      },
    };
  }
  for (const r of DISCOVERY_ROUTES) {
    paths[r.path] = { [r.method]: operationFor(r, null) };
  }
  const estimatePath = paths["/v1/estimate"] as Record<string, unknown> | undefined;
  if (estimatePath) estimatePath.get = operationFor(ESTIMATE_GET, null);
  paths[file.mcp?.endpoint ?? "/mcp"] = {
    post: {
      operationId: "mcp",
      summary: "Model Context Protocol over JSON-RPC 2.0.",
      description:
        `One POST endpoint, protocol version ${file.mcp?.protocolVersion ?? "unknown"}. initialize, tools/list and tools/call. The transport is open: ${file.tools.length} tools are listed and each keeps its own tier, ` +
        `so ${file.tools.filter((t) => t.units === 0).map((t) => t.name).join(" and ")} answer without a key and every other tool is refused with JSON-RPC error -32001 until a key is sent. ` +
        `A batch holds at most ${MAX_MCP_BATCH} messages. The Idempotency-Key header applies to tools/call. ` +
        `The tool names, schemas and unit weights are the operations in this document (see x-gridforge-mcp-tool).`,
      tags: ["mcp"],
      // The transport is open and a key is optional: it is read per tool, and the paid tools are refused without one.
      security: [{}, { ApiKeyAuth: [] }],
      parameters: [{ name: "Idempotency-Key", in: "header", required: false, description: idempotencyStatement(), schema: { type: "string", maxLength: IDEMPOTENCY_KEY_MAX_CHARS } }],
      requestBody: { required: true, content: { "application/json": { schema: { oneOf: [JSON_RPC_REQUEST, { type: "array", maxItems: MAX_MCP_BATCH, items: JSON_RPC_REQUEST }] } } } },
      responses: {
        "200": { description: "A JSON-RPC response, or an array of them for a batch. A tool's refusal is a JSON-RPC error object inside a 200.", content: { "application/json": { schema: { type: ["object", "array"] } } } },
        "202": { description: "Accepted: the request held only notifications, so there is no body." },
        "400": { description: "Not a valid JSON-RPC request, an empty batch, or a batch over the limit.", content: { "application/json": { schema: { type: "object" } } } },
        default: { description: "The HTTP-level refusals listed under the other operations (413, 415, 429).", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
  };
  // The registry routes belong to the website, not the engine: each path item carries its own server and a tag, and they never take the API key.
  for (const [route, item] of Object.entries(REGISTRY_PATHS)) {
    const operations: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(item)) {
      operations[method] = { ...(op as Record<string, unknown>), tags: ["registry"], security: bearer };
    }
    paths[route] = { servers: [{ url: siteOrigin, description: "The website (not the engine)." }], ...operations };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Time to Power engine",
      version: engineDeployed.engine_version,
      description:
        "Capacity and density screening for existing AI data halls. Generated from the engine's own tool list. Screening-mode output: not an issued engineering opinion. " +
        `The deployed engine serves ${engineDeployed.endpoints.length} endpoints; this document describes ${engineDeployed.endpoints.length - Object.keys(ENGINE_UNDOCUMENTED).length} of them plus /mcp. ${Object.keys(ENGINE_UNDOCUMENTED).join(", ")} is operator-only and deliberately undocumented. ` +
        "It does not quote equipment, state megawatts available from a utility, or act as an EPC, utility or trader. " +
        file.auth.note +
        " Every figure is modelled from the inputs supplied and carries an evidence class; where the calibration block (GET /v1/calibration, and on the responses that carry it) says uncalibrated, it means uncalibrated. " +
        "This document states no price: it gives each operation's weight in units, and the unit price, free allowance, minimum invoice and cap behaviour are the engine's own `payg` object at GET /v1/version. " +
        idempotencyStatement() +
        " The paths under /api/orgs, /api/sites and /api/halls are the website's signed-in site and hall registry: they are served by the website (see each path's server), take a signed-in person's session token instead of an API key, are never metered, and answer 503 until their database migrations are applied.",
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: file.auth.header, description: `The key goes in ${file.auth.header}; the engine also accepts the same key as Authorization: Bearer <key>.` },
        SupabaseSession: { type: "http", scheme: "bearer", description: "The access token of a signed-in session whose email address is confirmed. The caller's address is read from the token, never from a request." },
      },
      schemas: {
        ...SCHEMAS,
        CalibrationBlock: {
          type: "object",
          description: "How far the engine has been reconciled against instrumented sites, carried on the responses that name it. Where `state` is uncalibrated, it means uncalibrated: the figures are modelled and their accuracy is unquantified.",
          required: ["state", "statement"],
          properties: {
            state: { type: "string", enum: [...honesty.calibration_states] },
            statement: { type: "string" },
            observations: { type: "integer" }, observations_total: { type: "integer" }, observations_without_source_ref: { type: "integer" },
            sites: { type: "integer" }, halls: { type: "integer" },
            keys_asserted: { type: "integer" }, keys_with_site_observations: { type: "integer" }, keys_calibrated: { type: "integer" }, coverage: { type: "number" },
            keys: { type: "array", items: { type: "object" } }, uncalibrated_keys: { type: "array", items: { type: "string" } },
          },
          additionalProperties: true,
        },
        AssumptionGap: {
          type: "object",
          description: "One input the request did not supply and what the engine assumed in its place.",
          required: [...honesty.assumption_gap_fields],
          properties: {
            path: { type: "string" }, input: { type: "string" }, unit: { type: ["string", "null"] }, required: { type: "boolean" },
            assumed: { type: "string", description: "What the engine used instead, in words." }, why_it_binds: { type: "string" }, how_to_get_it: { type: "string" },
          },
        },
        ResidualReport: {
          type: "object",
          description: "Aggregate residual statistics over approved observation records only. Nothing in it identifies a site, hall or record.",
          required: ["schema", "state", "n_records"],
          properties: {
            schema: { type: "string" }, state: { type: "string" }, n_records: { type: "integer" }, n_sites: { type: "integer" }, headline: { type: "string" },
            requirements: { type: "object" }, subsystem_states: { type: "object", additionalProperties: { type: "string" } }, subsystems: { type: "object" },
          },
          additionalProperties: true,
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            schema_version: { type: "string" }, error: { type: "string" },
            reason: { type: "string", description: "On a 402: free_allowance_exhausted, spending_cap_reached or plan_quota_exhausted." },
            units_required: { type: "integer" }, units_used: { type: "integer" }, monthly_quota: { type: "integer" }, cap_units: { type: "integer" },
            month: { type: "string" }, resets_at: { type: "string", format: "date-time", description: "On a 402: when the allowance renews (start of next UTC month)." },
            fix: { type: "string", description: "What to do next, in words." },
            retryable: { type: "boolean" },
          },
          additionalProperties: true,
        },
      },
    },
  };
}
