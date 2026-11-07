// An OpenAPI 3.1 description of the engine's public HTTP interface, generated from public/reference/tools.json — the file the
// engine itself writes and CI diffs — so the machine-readable contract cannot drift from the tool list, the input schemas or the
// unit weights. Nothing here is typed by hand except the envelope (auth header, error shape, headers) that was read off the live
// engine; no price appears: units are weights, and what a unit costs is on /pricing and in the engine's own /v1/version.

import engineDeployed from "@/lib/engine-deployed.json";
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
}

const RESPONSE_HEADERS = {
  "X-GridForge-Units": { description: "Units this request was weighted at.", schema: { type: "string" } },
  "X-GridForge-Units-Month": { description: "Units used so far this UTC month.", schema: { type: "string" } },
  "X-GridForge-Units-Remaining": { description: "Units left under the cap for the month.", schema: { type: "string" } },
  "X-GridForge-Idempotent-Replay": { description: "Present when the response is a replay of an earlier request with the same Idempotency-Key.", schema: { type: "string" } },
};

/** The longest Idempotency-Key the engine accepts (its /v1/version `idempotency_key_max_chars`). */
export const IDEMPOTENCY_KEY_MAX_CHARS = 150;

/**
 * The refusals a caller can meet, read off the engine's HTTP handler. One list, so /developers and the OpenAPI default
 * response say the same thing. A refused or failed call is never charged.
 */
export const ERROR_STATUSES: { status: number; meaning: string }[] = [
  { status: 401, meaning: "a metered route was called without a key, or with one the engine does not accept" },
  { status: 402, meaning: "the key's monthly allowance or cap is spent; the call was refused and not charged. Buy more, do not retry" },
  { status: 415, meaning: "the body was declared as anything other than application/json" },
  { status: 422, meaning: "the input is too thin or invalid; nothing was solved" },
  { status: 429, meaning: "the per-client request rate limit was exceeded; wait and retry (the limit is rate_limit_per_minute at /v1/version)" },
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
        security: free ? [] : [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            description: "Repeat a request safely: the same key replays the first response and is not charged twice.",
            schema: { type: "string", maxLength: IDEMPOTENCY_KEY_MAX_CHARS },
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
            description: `A refusal: ${ERROR_STATUSES.map((e) => `${e.status}, ${e.meaning}`).join("; ")}. A rejected or failed request is not charged.`,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    };
  }
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
        file.auth.note +
        " The paths under /api/orgs, /api/sites and /api/halls are the website's signed-in site and hall registry: they are served by the website (see each path's server), take a signed-in person's session token instead of an API key, are never metered, and answer 503 until their database migrations are applied.",
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: file.auth.header },
        SupabaseSession: { type: "http", scheme: "bearer", description: "The access token of a signed-in session whose email address is confirmed. The caller's address is read from the token, never from a request." },
      },
      schemas: {
        ...SCHEMAS,
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
