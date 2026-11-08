// Server-only: the site and hall registry (migrations 0049-0051) - organisations, who is in them, their sites and halls, the figures
// recorded about a hall, and the hall's timeline.
//
// WHO MAY DO WHAT is decided twice and the database has the last word. This module identifies the caller with the sign-in provider
// (lib/portal.ts identify) and REFUSES AN UNVERIFIED ADDRESS; it then passes that address to a gf_* function, and the function checks the
// caller's role in the organisation that owns the thing, inside the database. A caller who is not an active member of an organisation
// reaches nothing of it: not its sites, halls, members, inputs or timeline, whatever ids they send. The caller's address is never
// read from a request body, a query string or a header other than the bearer token.
//
// FAILS CLOSED. Supabase not configured, the migrations not applied, the store unreachable or an answer this file does not understand
// are all a 503 that says nothing was changed; none is ever an empty success.
//
// WHAT IS RETURNED is built field by field below, never the row as it came: no project link token, package token, storage location or
// file digest is in any response, because none is ever selected into the shapes here (and the SQL views do not carry them either).
//
// HONESTY. A figure's ORIGIN (measured | observed | vendor | quotation | modelled | assumed | missing) and its evidence CLASS (E0..E7)
// are the recorder's declaration. The database enforces the rules between them (a measured, observed or quoted figure needs a source file;
// an assumption or a model cannot claim above E3; a missing input has no value). Nothing here, and nothing in the database, verifies that
// a declared class is deserved; a response says what was declared and by whom.

import { NextResponse } from "next/server";
import { z } from "zod";
import { identify } from "@/lib/portal";
import { creds, rpc } from "@/lib/pgrest";
import { guardRequest } from "@/lib/rate-limit";
import { readBoundedJson } from "@/lib/http-body";
import { noticeCrossDomainAttach } from "@/lib/notifications";
import {
  DATA_ORIGINS, EVIDENCE_CLASS_CODES, FIELD_PATH_PATTERN, ORIGINS, ORIGINS_CAPPED_AT_E3, ORIGINS_NEEDING_A_SOURCE, ROLES, UNIT_PATTERN,
} from "@/lib/site-registry-fields";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

const MAX_BODY_BYTES = 8 * 1024;

/** The same wording /api/team and /api/scenarios give an unconfirmed address. */
export const CONFIRM_EMAIL = "Confirm your email address by signing in with the emailed link, then try again.";
const UNAVAILABLE = "The site registry is unavailable just now. Nothing was changed.";

// --------------------------------------------------------------------------------------------------------------- responses

/** Every response of this registry is for one person and must never be stored by a shared cache. */
export function reply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => reply({ ok: false, error, ...extra }, status);

// --------------------------------------------------------------------------------------------------------------- the door

export type Caller = { ok: true; email: string } | { ok: false; response: NextResponse };

/**
 * Who is asking? The verified bearer token's address and nothing else.
 *   not configured -> 503 | no/expired session -> 401 | an address Supabase has not confirmed -> 403 | confirmed -> in.
 */
export async function registryCaller(req: Request): Promise<Caller> {
  if (!creds()) return { ok: false, response: refuse(503, UNAVAILABLE) };
  const who = await identify(req);
  if (!who.ok) return { ok: false, response: refuse(who.status, who.error) };
  if (!who.verified) return { ok: false, response: refuse(403, CONFIRM_EMAIL) };
  return { ok: true, email: who.email };
}

/** Count this request against the caller's allowance (after the door and after the body is known to be well-formed). null = admitted. */
export async function admit(req: Request, caller: { email: string }, kind: "read" | "write"): Promise<NextResponse | null> {
  // Counted per VERIFIED ACCOUNT, not per address: the caller was identified first, and an office behind one NAT must not lock itself out.
  const policy = kind === "read" ? "registry_read" : "registry_write";
  const g = await guardRequest(req, policy, { account: { verifiedEmail: caller.email, policy }, accountOnly: true });
  if (g.denied) g.denied.headers.set("Cache-Control", "no-store");
  return g.denied;
}

export type Body<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

/** A bounded JSON body that satisfies the schema. A refusal names the fields and says why, never echoing the values. */
export async function readBody<S extends z.ZodType>(req: Request, schema: S): Promise<Body<z.infer<S>>> {
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return { ok: false, response: refuse(read.status, read.status === 413 ? read.error : "Invalid payload") };
  const parsed = schema.safeParse(read.value);
  if (!parsed.success) {
    return {
      ok: false,
      response: refuse(400, "Some fields are not valid.", {
        issues: parsed.error.issues.slice(0, 12).map((i) => ({ field: i.path.join(".") || "(body)", message: i.message })),
      }),
    };
  }
  return { ok: true, value: parsed.data };
}

// --------------------------------------------------------------------------------------------------------------- schemas

/** Same rule as the database's gf_registry_name_ok: trimmed of Unicode whitespace, 1..120 characters, no control, zero-width or bidirectional character. */
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u061c\u202a-\u202e\u2060-\u2069\ufeff\u2028\u2029]/;
const EDGE_SPACE = /^[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+|[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+$/g;
const name = (what: string) =>
  z.string().transform((v) => v.replace(EDGE_SPACE, "")).pipe(
    z.string().min(1, `${what} is required.`).max(120, `${what} is at most 120 characters.`).refine((v) => !BAD_CHARS.test(v), `${what} has a control or direction-changing character.`)
  );

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date as YYYY-MM-DD.").refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "That date does not exist.");

const id = z.string().regex(UUID, "Not a valid id.");

export const OrgBody = z.strictObject({ name: name("The organisation name") });

export const MemberBody = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/, "Enter a valid email address."),
  role: z.enum(ROLES),
});

export const SiteBody = z.strictObject({
  orgId: id,
  name: name("The site name"),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, "Use a two-letter country code, for example DE.").nullable().optional(),
  dataOrigin: z.enum(DATA_ORIGINS, { error: "Say whether this site holds production, test or synthetic data." }),
});

export const HallBody = z.strictObject({ label: name("The hall label") });

export const CursorQuery = z.string().min(2).max(600);

/**
 * `confirmNonProductionSite` is the caller's explicit acknowledgement that attaching a project to a TEST or SYNTHETIC site permanently keeps
 * the project's observations out of the shared calibration ledger (0052). It must be the boolean true (not "true", not 1); anything but a
 * boolean is a 400, and a site that is not production refuses without a true value (attachProject below). It is not needed, and changes
 * nothing, for a production site.
 */
export const AttachBody = z.strictObject({
  projectToken: z.string().trim().min(8, "Paste the project's link token.").max(200),
  confirmNonProductionSite: z.boolean({ error: "confirmNonProductionSite must be true or false." }).optional(),
});

export const InputBody = z
  .strictObject({
    // Stored lower case: two spellings are one field.
    fieldPath: z.string().trim().max(120).transform((v) => v.toLowerCase()).pipe(z.string().regex(FIELD_PATH_PATTERN, "Use a dotted path such as grid.firm_capacity_mva.")),
    value: z.union([z.number(), z.string().min(1).max(200), z.boolean()]).nullable(),
    unit: z.string().min(1).max(24).regex(UNIT_PATTERN, "That unit has a character a unit cannot have.").nullable().optional(),
    evidenceClass: z.enum(EVIDENCE_CLASS_CODES),
    origin: z.enum(ORIGINS),
    projectEvidenceId: id.nullable().optional(),
    intakeEvidenceFileId: id.nullable().optional(),
    asOf: isoDate,
    supersedes: id.nullable().optional(),
  })
  .superRefine((b, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const sources = Number(Boolean(b.projectEvidenceId)) + Number(Boolean(b.intakeEvidenceFileId));
    if (b.origin === "missing") {
      if (b.value !== null) add("value", "A missing input has no value.");
      if (b.evidenceClass !== "E0") add("evidenceClass", "A missing input is class E0.");
      if (sources) add("origin", "A missing input has no source.");
    } else if (b.value === null) {
      add("value", "Give a value, or record the input as missing.");
    }
    if (typeof b.value === "number" && Math.abs(b.value) > 1e15) add("value", "That number is out of range.");
    if (b.unit && b.value !== null && typeof b.value !== "number") add("unit", "A unit belongs only to a number.");
    if (sources > 1) add("projectEvidenceId", "Cite one source file, not two.");
    if (ORIGINS_NEEDING_A_SOURCE.includes(b.origin) && sources !== 1) add("origin", `A ${b.origin} figure needs a source file.`);
    if (ORIGINS_CAPPED_AT_E3.includes(b.origin) && b.evidenceClass > "E3") add("evidenceClass", `An ${b.origin} figure cannot claim a class above E3.`);
    if (b.origin === "vendor" && sources === 0 && b.evidenceClass > "E3") add("evidenceClass", "A vendor figure with no file behind it cannot claim a class above E3.");
    if (b.intakeEvidenceFileId && !b.projectEvidenceId && b.evidenceClass > "E3") add("evidenceClass", "A purchased engagement's file is not reviewable, so it supports a declared class of E3 at most.");
  });

// --------------------------------------------------------------------------------------------------------------- the database's answers

type Answer = { ok: true; data: Record<string, any> } | { ok: false; response: NextResponse };

const NOT_FOUND: [number, string] = [404, "No such item."];

const REFUSALS: Record<string, [number, string]> = {
  invalid_actor: [401, "Sign in again."],
  not_found: NOT_FOUND,
  // Not being a member of an organisation is answered EXACTLY as the organisation not existing: a stranger learns nothing from the difference.
  not_a_member: NOT_FOUND,
  forbidden: [403, "Your role in that organisation does not allow this."],
  invalid_name: [400, "That name is not valid."],
  invalid_label: [400, "That label is not valid."],
  invalid_country: [400, "Use a two-letter country code, for example DE."],
  invalid_data_origin: [400, "Say whether this site holds production, test or synthetic data."],
  invalid_role: [400, "That role is not valid."],
  invalid_email: [400, "Enter a valid email address."],
  invalid_cursor: [400, "That page marker is not valid. Start again from the newest."],
  name_taken: [409, "That name is already used in this organisation."],
  label_taken: [409, "That label is already used at this site."],
  already_member: [409, "That person is already a member."],
  last_owner: [409, "An organisation always needs an owner. Add another owner first."],
  limit: [409, "A limit on the number of items has been reached."],
  field_limit: [409, "A hall holds at most 500 different fields."],
  correction_limit: [409, "This field already has 50 recorded values and corrections, the most one field holds."],
  field_already_recorded: [409, "This field already has a recorded value. Record a correction that replaces it."],
  superseded: [409, "Someone corrected this figure first. Reload and try again."],
  // ONE answer for a file or an earlier figure that cannot be used, whether it does not exist, is not this hall's, or belongs to someone else.
  invalid_reference: [422, "That file or earlier figure cannot be used for this hall."],
  source_rejected: [422, "That file was reviewed and rejected, so it cannot be cited."],
  project_not_found: [404, "No project has that link token."],
  project_in_other_hall: [409, "That project already belongs to a hall. It has to be detached from it first."],
  not_attached: [404, "That project is not attached to this hall."],
};

const CONSTRAINTS: Record<string, string> = {
  hall_inputs_origin_source: "A measured, observed or quoted figure needs a source file.",
  hall_inputs_missing_shape: "A missing input has no value, no source and class E0; any other input needs a value.",
  hall_inputs_assumed_class: "An assumed or modelled figure cannot claim an evidence class above E3.",
  hall_inputs_vendor_class: "A vendor figure with no file behind it cannot claim a class above E3.",
  hall_inputs_unreviewed_source: "A declared class above E3 needs a project file that has been reviewed and verified. Declare E3 or lower until then.",
  hall_inputs_one_source: "Cite one source file, not two.",
  hall_inputs_field_path: "Use a dotted path such as grid.firm_capacity_mva.",
  hall_inputs_value_shape: "The value must be a finite number, a short text or true/false.",
  hall_inputs_unit: "That unit has a character a unit cannot have, or belongs to a value that is not a number.",
  hall_inputs_evidence_class: "The evidence class must be E0 to E7.",
  hall_inputs_origin: "That origin is not one of the seven.",
  hall_inputs_as_of: "That date is too old to be a figure's date.",
  hall_inputs_as_of_future: "A figure cannot be as of a date in the future.",
};

/** One database call. A transport failure, a missing function (migration not applied) and a malformed answer are all a 503. */
async function ask(fn: string, args: Record<string, unknown>): Promise<Answer> {
  const r = await rpc<Record<string, any> | null>(fn, args);
  if (!r.ok) return { ok: false, response: refuse(503, UNAVAILABLE) };
  const d = r.data;
  if (!d || typeof d !== "object" || typeof d.ok !== "boolean") return { ok: false, response: refuse(503, UNAVAILABLE) };
  if (d.ok) return { ok: true, data: d };
  let reason = String(d.reason ?? "");
  if (reason === "not_a_member") reason = "not_found";          // the same answer, reason included
  if (reason === "invalid_input") {
    return { ok: false, response: refuse(400, CONSTRAINTS[String(d.constraint ?? "")] ?? "Some fields are not valid.", { reason }) };
  }
  const [status, message] = REFUSALS[reason] ?? [409, "That could not be done."];
  return { ok: false, response: refuse(status, message, { reason, ...(isId(d.current_id) ? { currentId: d.current_id } : {}) }) };
}

/** The organisations the caller is an active member of, from the database, for the route layer's own check. */
async function memberOrgIds(actor: string): Promise<Out<Set<string>>> {
  const r = await myOrgs(actor);
  return r.ok ? { ok: true, value: new Set(r.value.map((o) => o.id)) } : r;
}

/** Hand back `value` only if the organisation it belongs to is one the caller is a member of. Anything else is a 403 and `value` is dropped. */
async function inMyOrgs<T>(actor: string, orgId: string, value: T): Promise<Out<T>> {
  const mine = await memberOrgIds(actor);
  if (!mine.ok) return mine;
  if (!mine.value.has(orgId)) return { ok: false, response: refuse(NOT_FOUND[0], NOT_FOUND[1], { reason: "not_found" }) };
  return { ok: true, value };
}

const rows = <T>(v: unknown, f: (x: any) => T): T[] => (Array.isArray(v) ? v.map(f) : []);

// --------------------------------------------------------------------------------------------------------------- shapes (whitelists)

type Out<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

/** `addedBy`/`addedAt`/`memberId`: who added the caller to this organisation, when, and the membership row they can leave by (no acceptance step exists). */
export interface OrgView { id: string; name: string; role: string; createdAt: string; memberId?: string; addedBy?: string; addedAt?: string }
export interface MemberView { id: string; email: string; role: string; addedBy: string; addedAt: string }
export interface SiteView { id: string; orgId: string; orgName?: string; name: string; country: string | null; dataOrigin: string; createdBy?: string; createdAt?: string; halls?: HallView[] }
export interface HallView { id: string; siteId: string; label: string; createdBy: string; createdAt: string }
export interface InputView {
  id: string; fieldPath: string; value: number | string | boolean | null; unit: string | null; evidenceClass: string; origin: string; asOf: string;
  recordedBy: string; recordedAt: string; supersedesId: string | null; superseded: boolean;
  source: { kind: "project_evidence" | "intake_evidence"; id: string; filename: string | null; reviewStatus: string | null } | null;
}
export interface TimelineEventView {
  occurredAt: string; kind: string; subject: string; summary: string; origin: string; evidenceClass: string | null; basis: string;
  actor: string; projectId: string | null; superseded: boolean; sourceTable: string; sourceId: string;
}

const orgView = (o: any): OrgView => ({
  id: o.id, name: o.name, role: o.role, createdAt: o.created_at,
  ...(o.member_id ? { memberId: o.member_id, addedBy: o.added_by, addedAt: o.added_at } : {}),
});
const memberView = (m: any): MemberView => ({ id: m.id, email: m.email, role: m.role, addedBy: m.added_by, addedAt: m.added_at });
const hallView = (h: any): HallView => ({ id: h.id, siteId: h.site_id, label: h.label, createdBy: h.created_by, createdAt: h.created_at });
const siteView = (s: any): SiteView => ({
  id: s.id, orgId: s.org_id, ...(s.org_name !== undefined ? { orgName: s.org_name } : {}), name: s.name, country: s.country ?? null, dataOrigin: s.data_origin,
  ...(s.created_by !== undefined ? { createdBy: s.created_by, createdAt: s.created_at } : {}),
  ...(Array.isArray(s.halls) ? { halls: s.halls.map(hallView) } : {}),
});
const inputView = (i: any): InputView => ({
  id: i.id, fieldPath: i.field_path, value: i.value ?? null, unit: i.unit ?? null, evidenceClass: i.evidence_class, origin: i.origin, asOf: i.as_of,
  recordedBy: i.recorded_by, recordedAt: i.recorded_at, supersedesId: i.supersedes_id ?? null, superseded: Boolean(i.superseded),
  source: i.source ? { kind: i.source.kind, id: i.source.id, filename: i.source.filename ?? null, reviewStatus: i.source.review_status ?? null } : null,
});
const eventView = (e: any): TimelineEventView => ({
  occurredAt: e.occurred_at, kind: e.kind, subject: e.subject, summary: e.summary, origin: e.origin, evidenceClass: e.evidence_class ?? null, basis: e.basis,
  actor: e.actor, projectId: e.project_id ?? null, superseded: Boolean(e.superseded), sourceTable: e.source_table, sourceId: e.source_id,
});

// --------------------------------------------------------------------------------------------------------------- operations
// Each takes the VERIFIED address from registryCaller and returns either the data or the NextResponse to send.

const done = <T>(a: Answer, f: (d: Record<string, any>) => T): Out<T> => (a.ok ? { ok: true, value: f(a.data) } : a);

export async function myOrgs(actor: string) {
  return done(await ask("gf_my_orgs", { p_actor: actor }), (d) => rows(d.orgs, orgView));
}
export async function createOrg(actor: string, b: z.infer<typeof OrgBody>) {
  return done(await ask("gf_create_org", { p_actor: actor, p_name: b.name }), (d) => ({ id: String(d.org_id), name: String(d.name) }));
}
export async function orgMembers(actor: string, org: string) {
  const r = done(await ask("gf_org_members", { p_actor: actor, p_org: org }), (d) => rows(d.members, memberView));
  return r.ok ? inMyOrgs(actor, org, r.value) : r;
}
export async function addMember(actor: string, org: string, b: z.infer<typeof MemberBody>) {
  return done(await ask("gf_org_add_member", { p_actor: actor, p_org: org, p_email: b.email, p_role: b.role }), (d) => ({ memberId: String(d.member_id) }));
}
export async function removeMember(actor: string, org: string, member: string) {
  return done(await ask("gf_org_remove_member", { p_actor: actor, p_org: org, p_member: member }), () => ({}));
}
export async function listSites(actor: string, org: string | null): Promise<Out<SiteView[]>> {
  const r = done(await ask("gf_list_sites", { p_actor: actor, p_org: org }), (d) => rows(d.sites, siteView));
  if (!r.ok || r.value.length === 0) return r;
  // The database already returned only the caller's organisations; the route layer checks it again and drops anything else.
  const mine = await memberOrgIds(actor);
  if (!mine.ok) return mine;
  return { ok: true, value: r.value.filter((s) => mine.value.has(s.orgId)) };
}
export async function createSite(actor: string, b: z.infer<typeof SiteBody>) {
  return done(
    await ask("gf_create_site", { p_actor: actor, p_org: b.orgId, p_name: b.name, p_country: b.country || null, p_data_origin: b.dataOrigin }),
    (d) => ({ id: String(d.site_id), site: siteView(d.site) })
  );
}
export async function listHalls(actor: string, site: string) {
  const r = done(await ask("gf_list_halls", { p_actor: actor, p_site: site }), (d) => ({ site: siteView(d.site), halls: rows(d.halls, hallView) }));
  return r.ok ? inMyOrgs(actor, r.value.site.orgId, r.value) : r;
}
export async function createHall(actor: string, site: string, b: z.infer<typeof HallBody>) {
  return done(await ask("gf_create_hall", { p_actor: actor, p_site: site, p_label: b.label }), (d) => ({ id: String(d.hall_id), hall: hallView(d.hall) }));
}
export async function recordInput(actor: string, hall: string, b: z.infer<typeof InputBody>) {
  return done(
    await ask("gf_record_hall_input", {
      p_actor: actor, p_hall: hall, p_field_path: b.fieldPath, p_value: b.value, p_unit: b.unit ?? null, p_evidence_class: b.evidenceClass,
      p_origin: b.origin, p_project_evidence: b.projectEvidenceId ?? null, p_intake_evidence: b.intakeEvidenceFileId ?? null, p_as_of: b.asOf,
      p_supersedes: b.supersedes ?? null,
    }),
    (d) => ({ id: String(d.id), input: inputView(d.input) })
  );
}
export async function hallInputs(actor: string, hall: string, opts: { history: boolean; field?: string | null; limit?: number }) {
  const r = done(await ask("gf_hall_inputs", { p_actor: actor, p_hall: hall, p_history: opts.history, p_field: opts.field ?? null, p_limit: opts.limit ?? 500 }), (d) => ({
    truncated: Boolean(d.truncated),
    hall: { id: d.hall.id, label: d.hall.label, siteId: d.hall.site_id, siteName: d.hall.site_name, orgId: d.hall.org_id, dataOrigin: d.hall.data_origin, country: d.hall.country ?? null },
    inputs: rows(d.inputs, inputView),
  }));
  return r.ok ? inMyOrgs(actor, r.value.hall.orgId, r.value) : r;
}
export async function hallTimeline(actor: string, hall: string, limit: number, cursor: string | null) {
  const r = done(await ask("gf_hall_timeline", { p_actor: actor, p_hall: hall, p_limit: limit, p_cursor: cursor }), (d) => ({
    nextCursor: typeof d.next_cursor === "string" ? d.next_cursor : null,
    hall: { id: d.hall.id, label: d.hall.label, siteName: d.hall.site_name, orgId: d.hall.org_id, dataOrigin: d.hall.data_origin },
    truncated: Boolean(d.truncated),
    events: rows(d.events, eventView),
  }));
  return r.ok ? inMyOrgs(actor, r.value.hall.orgId, r.value) : r;
}
export async function detachProject(actor: string, hall: string, project: string) {
  return done(await ask("gf_detach_project_from_hall", { p_actor: actor, p_hall: hall, p_project: project }), () => ({}));
}
/** The most the operator notice may hold an attach response. */
export const ATTACH_NOTICE_BUDGET_MS = 3000;

/** What the caller is told when they have not confirmed attaching to a site that is not production. Says plainly what is permanent. */
export const NON_PRODUCTION_ATTACH_MESSAGE =
  "This hall belongs to a test or synthetic site. Attaching a project to it PERMANENTLY excludes that project's observations from the shared " +
  "calibration ledger (the calibration ledger gate): detaching the project later does not undo it. If you mean that, repeat the request with " +
  "confirmNonProductionSite: true. If this is real data, attach the project to a production site instead.";

/**
 * THE CONFIRMATION IS ENFORCED HERE, in the website route, NOT by the database function: gf_attach_project_to_hall (0050) knows nothing of it, and a
 * service-role caller that bypassed this module would attach without it. The backstop behind it is the ledger view (0052), which keeps the observations of
 * a project that was ever attached to a non-production site out of the ledger whatever route attached it.
 *
 * Attach a project to a hall. The caller must be an authenticated OWNER or EDITOR of the hall's organisation (the database checks it, and
 * the project's link token alone is not enough). When the hall's site is test or synthetic the caller must also have said
 * confirmNonProductionSite: true; without it this answers 422 BEFORE anything is written, because the attachment cannot be undone as far as
 * the calibration ledger is concerned. A caller who could not attach anyway (a viewer, a stranger) is answered by the database exactly as
 * before (403 / 404), never by this check, so the check reveals nothing they could not already read. On a new attachment the operator may be
 * told, best effort, that the attacher's email domain differs from the project's buyer's (lib/notifications.ts); that never affects the result.
 */
export async function attachProject(actor: string, hall: string, b: z.infer<typeof AttachBody>): Promise<Out<{ projectId: string; projectName: string; alreadyAttached: boolean }>> {
  // The hall's site and organisation, from the same read every member is allowed (gf_hall_inputs). A site's origin is fixed once written.
  const where = await hallInputs(actor, hall, { history: false, limit: 1 });
  if (!where.ok) return where;
  if (where.value.hall.dataOrigin !== "production" && b.confirmNonProductionSite !== true) {
    const mine = await myOrgs(actor);
    if (!mine.ok) return mine;
    const role = mine.value.find((o) => o.id === where.value.hall.orgId)?.role;
    if (role === "owner" || role === "editor") {
      return { ok: false, response: refuse(422, NON_PRODUCTION_ATTACH_MESSAGE, { reason: "non_production_site_unconfirmed", dataOrigin: where.value.hall.dataOrigin }) };
    }
    // Not a role that may attach: fall through, and the database refuses (403) as it always did.
  }
  const r = done(await ask("gf_attach_project_to_hall", { p_actor: actor, p_hall: hall, p_project_token: b.projectToken }), (d) => ({
    projectId: String(d.project_id), projectName: String(d.project_name), alreadyAttached: Boolean(d.already_attached),
  }));
  if (r.ok && !r.value.alreadyAttached) {
    // Best effort and silent when notifications are not configured. It never changes the answer and never holds it for more than the budget: the
    // notice does several store reads and a mail call, and a slow one must not delay (or, on a platform that stops work after the response, kill) the attach.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        noticeCrossDomainAttach({ projectId: r.value.projectId, hallId: hall, actorEmail: actor }).catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ATTACH_NOTICE_BUDGET_MS); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return r;
}

// --------------------------------------------------------------------------------------------------------------- the route frame

/** A read: the door, then the allowance, then `run` with the verified address. */
export async function serveRead(req: Request, run: (email: string) => Promise<NextResponse>): Promise<NextResponse> {
  const c = await registryCaller(req);
  if (!c.ok) return c.response;
  const denied = await admit(req, c, "read");
  if (denied) return denied;
  return run(c.email);
}

/** A write: the door, then a body that satisfies the schema (a refused request spends nobody's allowance), then the allowance, then `run`. */
export async function serveWrite<S extends z.ZodType>(
  req: Request,
  schema: S | null,
  run: (email: string, body: z.infer<S>) => Promise<NextResponse>
): Promise<NextResponse> {
  const c = await registryCaller(req);
  if (!c.ok) return c.response;
  let value: z.infer<S> = undefined as z.infer<S>;
  if (schema) {
    const b = await readBody(req, schema);
    if (!b.ok) return b.response;
    value = b.value;
  }
  const denied = await admit(req, c, "write");
  if (denied) return denied;
  return run(c.email, value);
}

/** A route id from the path, or the 400 to send. */
export function pathId(raw: string): { ok: true; id: string } | { ok: false; response: NextResponse } {
  return isId(raw) ? { ok: true, id: raw } : { ok: false, response: refuse(400, "A valid id is required.") };
}
