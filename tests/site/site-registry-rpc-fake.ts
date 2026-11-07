/**
 * Migrations 0049-0051 (organisations, sites, halls, hall inputs, the timeline) as an in-memory PostgREST, so the route scenarios run where
 * there is no database. It restates the SQL; it is SUPPLEMENTAL. That the real functions do what this says is proven against PostgreSQL by
 * tests/test_site_registry_migration.py, tests/test_hall_inputs_migration.py and tests/test_hall_timeline_migration.py, and the SAME route
 * scenarios run against real PostgreSQL through real PostgREST in site-registry.realdb.test.ts.
 */
import { PgError, type PostgrestFake, type Row } from "./postgrest-fake";

const RANK: Record<string, number> = { owner: 3, editor: 2, viewer: 1 };
const norm = (e: unknown) => String(e ?? "").trim().toLowerCase();
const validEmail = (e: string) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e) && e.length <= 254;
const FIELD = /^[a-z][a-z0-9_]*(\[[0-9]{1,3}\])?(\.[a-z][a-z0-9_]*(\[[0-9]{1,3}\])?){0,5}$/;
const UNIT = /^[A-Za-z0-9%/._^*+() \u00b5\u00b0\u00b2\u00b3\u00b7\u03a9-]+$/;
const BAD = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u061c\u202a-\u202e\u2060-\u2069\ufeff\u2028\u2029]/;
const EDGE = /^[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+|[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+$/g;
const trim = (v: unknown) => String(v ?? "").replace(EDGE, "");
const nameOk = (n: string) => n.length >= 1 && n.length <= 120 && !BAD.test(n);
const NEEDS_SOURCE = ["measured", "observed", "quotation"];

export function installRegistryRpcs(db: PostgrestFake): void {
  for (const t of ["organisations", "organisation_members", "sites", "halls", "hall_inputs", "hall_project_attachments", "hall_project_detachments", "projects", "project_evidence", "project_events"]) db.createTable(t);
  const T = (n: string) => db.rows(n);
  db.rowDefaults.set("project_events", () => ({ occurred_at: new Date().toISOString(), payload: {} }));   // the column defaults of 0015
  db.rowDefaults.set("hall_project_attachments", () => ({ attached_at: new Date().toISOString() }));
  let seq = 0;

  const member = (org: unknown, email: string) => T("organisation_members").find((m) => m.org_id === org && m.email === email && !m.removed_at);
  const access = (org: unknown, actor: unknown, min: string): string => {
    const a = norm(actor);
    if (!validEmail(a)) return "invalid_actor";
    if (!org || !T("organisations").some((o) => o.id === org)) return "not_found";
    const m = member(org, a);
    if (!m) return "not_a_member";
    return RANK[m.role as string] < RANK[min] ? "forbidden" : "ok";
  };
  const no = (reason: string, extra: Row = {}) => ({ ok: false, reason, ...extra });
  const hallOrg = (hallId: unknown) => {
    const h = T("halls").find((x) => x.id === hallId);
    const s = h && T("sites").find((x) => x.id === h.site_id);
    return { h, s };
  };

  db.rpcs.set("gf_create_org", ({ p_actor, p_name }) => {
    const a = norm(p_actor);
    const n = trim(p_name);
    if (!validEmail(a)) return no("invalid_actor");
    if (!nameOk(n)) return no("invalid_name");
    if (T("organisations").filter((o) => o.created_by === a).length >= 20) return no("limit");
    if (T("organisations").some((o) => o.created_by === a && String(o.name).toLowerCase() === n.toLowerCase())) return no("name_taken");
    const o = db.insertRow("organisations", { name: n, created_by: a });
    db.insertRow("organisation_members", { org_id: o.id, email: a, role: "owner", added_by: a, added_at: new Date().toISOString(), removed_at: null });
    return { ok: true, org_id: o.id, name: o.name };
  });

  db.rpcs.set("gf_my_orgs", ({ p_actor }) => {
    const a = norm(p_actor);
    if (!validEmail(a)) return no("invalid_actor");
    const orgs = T("organisation_members").filter((m) => m.email === a && !m.removed_at).map((m) => {
      const o = T("organisations").find((x) => x.id === m.org_id)!;
      return { id: o.id, name: o.name, role: m.role, created_at: o.created_at, member_id: m.id, added_by: m.added_by, added_at: m.added_at };
    });
    return { ok: true, orgs: orgs.sort((x, y) => String(x.name).toLowerCase().localeCompare(String(y.name).toLowerCase())) };
  });

  db.rpcs.set("gf_org_members", ({ p_actor, p_org }) => {
    const g = access(p_org, p_actor, "viewer");
    if (g !== "ok") return no(g);
    return { ok: true, members: T("organisation_members").filter((m) => m.org_id === p_org && !m.removed_at).map((m) => ({ id: m.id, email: m.email, role: m.role, added_by: m.added_by, added_at: m.added_at })) };
  });

  db.rpcs.set("gf_org_add_member", ({ p_actor, p_org, p_email, p_role }) => {
    const g = access(p_org, p_actor, "owner");
    if (g !== "ok") return no(g);
    const e = norm(p_email);
    if (!validEmail(e)) return no("invalid_email");
    if (!RANK[String(p_role)]) return no("invalid_role");
    if (member(p_org, e)) return no("already_member");
    const m = db.insertRow("organisation_members", { org_id: p_org, email: e, role: p_role, added_by: norm(p_actor), added_at: new Date().toISOString(), removed_at: null });
    return { ok: true, member_id: m.id };
  });

  db.rpcs.set("gf_org_remove_member", ({ p_actor, p_org, p_member }) => {
    const g = access(p_org, p_actor, "viewer");
    if (g !== "ok") return no(g);
    const a = norm(p_actor);
    const m = T("organisation_members").find((x) => x.id === p_member && x.org_id === p_org && !x.removed_at);
    if (!m) return no("not_found");
    if (m.email !== a && member(p_org, a)!.role !== "owner") return no("forbidden");
    if (m.role === "owner" && !T("organisation_members").some((x) => x.org_id === p_org && x.role === "owner" && !x.removed_at && x.id !== m.id)) return no("last_owner");
    m.removed_at = new Date().toISOString();
    return { ok: true };
  });

  db.rpcs.set("gf_create_site", ({ p_actor, p_org, p_name, p_country, p_data_origin }) => {
    const g = access(p_org, p_actor, "editor");
    if (g !== "ok") return no(g);
    const n = trim(p_name);
    const c = p_country == null ? null : String(p_country).trim().toUpperCase();
    if (!nameOk(n)) return no("invalid_name");
    if (c !== null && !/^[A-Z]{2}$/.test(c)) return no("invalid_country");
    if (!["production", "test", "synthetic"].includes(String(p_data_origin))) return no("invalid_data_origin");
    if (T("sites").some((s) => s.org_id === p_org && String(s.name).toLowerCase() === n.toLowerCase())) return no("name_taken");
    const site = db.insertRow("sites", { org_id: p_org, name: n, country: c, data_origin: p_data_origin, created_by: norm(p_actor) });
    return { ok: true, site_id: site.id, site: { id: site.id, org_id: site.org_id, name: site.name, country: site.country, data_origin: site.data_origin, created_by: site.created_by, created_at: site.created_at, halls: [] } };
  });

  db.rpcs.set("gf_list_sites", ({ p_actor, p_org }) => {
    const a = norm(p_actor);
    if (p_org) {
      const g = access(p_org, p_actor, "viewer");
      if (g !== "ok") return no(g);
    } else if (!validEmail(a)) return no("invalid_actor");
    const sites = T("sites").filter((s) => (!p_org || s.org_id === p_org) && member(s.org_id, a)).map((s) => ({
      id: s.id, org_id: s.org_id, org_name: T("organisations").find((o) => o.id === s.org_id)!.name, name: s.name, country: s.country,
      data_origin: s.data_origin, created_by: s.created_by, created_at: s.created_at,
      halls: T("halls").filter((h) => h.site_id === s.id).sort((x, y) => String(x.label).toLowerCase().localeCompare(String(y.label).toLowerCase()))
        .map((h) => ({ id: h.id, site_id: h.site_id, label: h.label, created_by: h.created_by, created_at: h.created_at })),
    }));
    return { ok: true, sites };
  });

  db.rpcs.set("gf_create_hall", ({ p_actor, p_site, p_label }) => {
    const s = T("sites").find((x) => x.id === p_site);
    const g = access(s?.org_id, p_actor, "editor");
    if (g !== "ok") return no(g);
    const l = trim(p_label);
    if (!nameOk(l)) return no("invalid_label");
    if (T("halls").some((h) => h.site_id === s!.id && String(h.label).toLowerCase() === l.toLowerCase())) return no("label_taken");
    const hall = db.insertRow("halls", { site_id: s!.id, label: l, created_by: norm(p_actor) });
    return { ok: true, hall_id: hall.id, hall: { id: hall.id, site_id: hall.site_id, label: hall.label, created_by: hall.created_by, created_at: hall.created_at } };
  });

  db.rpcs.set("gf_list_halls", ({ p_actor, p_site }) => {
    const s = T("sites").find((x) => x.id === p_site);
    const g = access(s?.org_id, p_actor, "viewer");
    if (g !== "ok") return no(g);
    return {
      ok: true,
      site: { id: s!.id, org_id: s!.org_id, name: s!.name, country: s!.country, data_origin: s!.data_origin },
      halls: T("halls").filter((h) => h.site_id === s!.id).map((h) => ({ id: h.id, site_id: h.site_id, label: h.label, created_by: h.created_by, created_at: h.created_at })),
    };
  });

  const superseded = (id: unknown) => T("hall_inputs").some((x) => x.supersedes_id === id);
  const sourceOf = (i: Row) => {
    if (i.project_evidence_id) {
      const e = T("project_evidence").find((x) => x.id === i.project_evidence_id);
      return { kind: "project_evidence", id: i.project_evidence_id, filename: e?.filename ?? null, review_status: e?.review_status ?? "unverified" };
    }
    if (i.intake_evidence_file_id) return { kind: "intake_evidence", id: i.intake_evidence_file_id, filename: null, review_status: null };
    return null;
  };

  const inputJson = (i: Row) => ({
    id: i.id, field_path: i.field_path, value: i.value, unit: i.unit, evidence_class: i.evidence_class, origin: i.origin, as_of: i.as_of,
    recorded_by: i.recorded_by, recorded_at: i.created_at, supersedes_id: i.supersedes_id, superseded: superseded(i.id), source: sourceOf(i),
  });

  db.rpcs.set("gf_record_hall_input", (a) => {
    const { h, s } = hallOrg(a.p_hall);
    const g = access(s?.org_id, a.p_actor, "editor");
    if (g !== "ok") return no(g);
    const path = String(a.p_field_path ?? "").trim().toLowerCase();
    const bad = (constraint: string) => no("invalid_input", { constraint });
    const v = a.p_value;
    const sources = Number(a.p_project_evidence != null) + Number(a.p_intake_evidence != null);
    if (!/^E[0-7]$/.test(String(a.p_evidence_class))) return bad("hall_inputs_evidence_class");
    if (!["measured", "observed", "vendor", "quotation", "modelled", "assumed", "missing"].includes(String(a.p_origin))) return bad("hall_inputs_origin");
    if (!FIELD.test(path) || path.length > 120) return bad("hall_inputs_field_path");
    if (v !== null && v !== undefined && !(typeof v === "boolean" || (typeof v === "string" && v.length >= 1 && v.length <= 200) || (typeof v === "number" && Math.abs(v) <= 1e15))) return bad("hall_inputs_value_shape");
    if (a.p_unit != null && (!UNIT.test(String(a.p_unit)) || String(a.p_unit).length > 24 || ((v === null || v === undefined || typeof v !== "number") && a.p_origin !== "missing"))) return bad("hall_inputs_unit");
    if ((a.p_origin === "missing") !== (v === null || v === undefined) || (a.p_origin === "missing" && (a.p_evidence_class !== "E0" || sources))) return bad("hall_inputs_missing_shape");
    if (sources > 1) return bad("hall_inputs_one_source");
    if (NEEDS_SOURCE.includes(String(a.p_origin)) && sources !== 1) return bad("hall_inputs_origin_source");
    if (["assumed", "modelled"].includes(String(a.p_origin)) && !["E0", "E1", "E2", "E3"].includes(String(a.p_evidence_class))) return bad("hall_inputs_assumed_class");
    if (a.p_origin === "vendor" && sources === 0 && String(a.p_evidence_class) > "E3") return bad("hall_inputs_vendor_class");
    if (!a.p_as_of) return bad("hall_inputs_as_of");
    if (String(a.p_as_of) > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) return bad("hall_inputs_as_of_future");
    const folded = (constraint: string) => no("invalid_reference", { constraint });
    const rows = T("hall_inputs").filter((x) => x.hall_id === h!.id);
    if (a.p_supersedes) {
      if (rows.filter((x) => x.field_path === path).length >= 50) return no("correction_limit", { constraint: "hall_inputs_correction_limit" });
    } else if (!rows.some((x) => x.field_path === path && !x.supersedes_id) && rows.filter((x) => !x.supersedes_id).length >= 500) {
      return no("field_limit", { constraint: "hall_inputs_field_limit" });
    }
    if (a.p_supersedes) {
      const prev = T("hall_inputs").find((x) => x.id === a.p_supersedes);
      if (!prev) return folded("hall_inputs_supersedes_id_fkey");
      if (prev.hall_id !== h!.id || prev.field_path !== path) return folded("hall_inputs_supersedes_scope");
    }
    if (a.p_project_evidence) {
      const e = T("project_evidence").find((x) => x.id === a.p_project_evidence);
      if (!e) return folded("hall_inputs_project_evidence_id_fkey");
      const p = T("projects").find((x) => x.id === e.project_id);
      if (!p || p.hall_id !== h!.id) return folded("hall_inputs_source_not_in_hall");
      if (e.review_status === "rejected") return no("source_rejected", { constraint: "hall_inputs_source_rejected" });
      if (String(a.p_evidence_class) > "E3" && e.review_status !== "verified") return bad("hall_inputs_unreviewed_source");
    }
    if (a.p_intake_evidence) return folded("hall_inputs_intake_evidence_file_id_fkey");        // the fake holds no purchased engagements: every such id is unknown
    const head = rows.find((x) => x.field_path === path && !superseded(x.id));
    if (!a.p_supersedes && rows.some((x) => x.field_path === path && !x.supersedes_id)) {
      return no("field_already_recorded", { constraint: "hall_inputs_one_root", current_id: head?.id ?? null });
    }
    if (a.p_supersedes && superseded(a.p_supersedes)) return no("superseded", { constraint: "hall_inputs_one_successor", current_id: head?.id ?? null });
    const row = db.insertRow("hall_inputs", {
      seq: ++seq, hall_id: h!.id, field_path: path, value: v ?? null, unit: a.p_unit ?? null, evidence_class: a.p_evidence_class, origin: a.p_origin,
      project_evidence_id: a.p_project_evidence ?? null, intake_evidence_file_id: a.p_intake_evidence ?? null, as_of: a.p_as_of, recorded_by: norm(a.p_actor),
      supersedes_id: a.p_supersedes ?? null,
    });
    return { ok: true, id: row.id, input: inputJson(row) };
  });

  db.rpcs.set("gf_hall_inputs", ({ p_actor, p_hall, p_history, p_field, p_limit }) => {
    const { h, s } = hallOrg(p_hall);
    const g = access(s?.org_id, p_actor, "viewer");
    if (g !== "ok") return no(g);
    const lim = Math.min(Math.max(p_limit ?? 500, 1), 500);
    const f = p_field == null ? null : String(p_field).trim().toLowerCase();
    const all = T("hall_inputs").filter((i) => i.hall_id === h!.id && (p_history || !superseded(i.id)) && (f === null || i.field_path === f))
      .sort((x, y) => (p_history ? (y.seq as number) - (x.seq as number) : 0) || String(x.field_path).localeCompare(String(y.field_path)) || (x.seq as number) - (y.seq as number));
    return {
      ok: true,
      hall: { id: h!.id, label: h!.label, site_id: s!.id, site_name: s!.name, org_id: s!.org_id, data_origin: s!.data_origin, country: s!.country },
      truncated: all.length > lim,
      inputs: all.slice(0, lim).map(inputJson),
    };
  });

  const emit = (projectId: unknown, type: string, hallId: unknown, siteId: unknown) =>
    db.insertRow("project_events", { project_id: projectId, event_type: type, actor: "hall_registry", occurred_at: new Date().toISOString(), payload: { hall_id: hallId, site_id: siteId } });

  db.rpcs.set("gf_attach_project_to_hall", ({ p_actor, p_hall, p_project_token }) => {
    const { h, s } = hallOrg(p_hall);
    const g = access(s?.org_id, p_actor, "editor");
    if (g !== "ok") return no(g);
    const p = T("projects").find((x) => x.project_token === p_project_token);
    if (!p) return no("project_not_found");
    if (p.hall_id) return p.hall_id === h!.id ? { ok: true, already_attached: true, project_id: p.id, project_name: p.project_name } : no("project_in_other_hall");
    const att = db.insertRow("hall_project_attachments", { project_id: p.id, site_id: s!.id, hall_id: h!.id, attached_by: norm(p_actor), attached_at: new Date().toISOString() });
    p.site_id = s!.id;
    p.hall_id = h!.id;
    emit(p.id, "project_attached_to_hall", h!.id, s!.id);
    return { ok: true, already_attached: false, project_id: p.id, project_name: p.project_name, attachment_id: att.id };
  });

  db.rpcs.set("gf_detach_project_from_hall", ({ p_actor, p_hall, p_project }) => {
    const { h, s } = hallOrg(p_hall);
    const g = access(s?.org_id, p_actor, "owner");
    if (g !== "ok") return no(g);
    const p = T("projects").find((x) => x.id === p_project);
    if (!p || p.hall_id !== h!.id) return no("not_attached");
    const att = [...T("hall_project_attachments")].reverse().find((x) => x.project_id === p.id && x.hall_id === h!.id && !T("hall_project_detachments").some((d) => d.attachment_id === x.id));
    if (!att) return no("not_attached");
    db.insertRow("hall_project_detachments", { attachment_id: att.id, project_id: p.id, site_id: s!.id, hall_id: h!.id, detached_by: norm(p_actor), detached_at: new Date().toISOString() });
    p.site_id = null;
    p.hall_id = null;
    emit(p.id, "project_detached_from_hall", h!.id, s!.id);
    return { ok: true };
  });

  db.rpcs.set("gf_hall_timeline", ({ p_actor, p_hall, p_limit, p_cursor }) => {
    const { h, s } = hallOrg(p_hall);
    const g = access(s?.org_id, p_actor, "viewer");
    if (g !== "ok") return no(g);
    const lim = Math.min(Math.max(p_limit ?? 200, 1), 500);
    let cur: { occurred_at: string; source_table: string; source_id: string; subject: string } | null = null;
    if (p_cursor != null) {
      try { cur = JSON.parse(String(p_cursor)); } catch { return no("invalid_cursor"); }
      if (!cur || typeof cur !== "object" || !cur.occurred_at || !cur.source_table || !cur.source_id || !cur.subject || Number.isNaN(Date.parse(cur.occurred_at))) return no("invalid_cursor");
    }
    const ev: Row[] = [];
    const proj = (id: unknown) => T("projects").find((x) => x.id === id);
    for (const i of T("hall_inputs").filter((x) => x.hall_id === h!.id)) {
      ev.push({
        hall_id: h!.id, occurred_at: i.created_at, kind: "input_recorded", subject: i.field_path,
        summary: i.origin === "missing" ? `${i.field_path}: recorded as missing (as of ${i.as_of})` : `${i.field_path} = ${i.value}${i.unit ? " " + i.unit : ""} (as of ${i.as_of})`,
        origin: i.origin, evidence_class: i.evidence_class, basis: `declared by ${i.recorded_by}`, actor: i.recorded_by, project_id: null,
        superseded: superseded(i.id), source_table: "hall_inputs", source_id: i.id,
      });
    }
    for (const a of T("hall_project_attachments").filter((x) => x.hall_id === h!.id)) {
      ev.push({ hall_id: h!.id, occurred_at: a.attached_at, kind: "project_attached", subject: "attached", summary: `Project "${proj(a.project_id)?.project_name}" attached to this hall`, origin: "recorded", evidence_class: null,
        basis: "recorded attachment; the project's link token was the credential", actor: a.attached_by, project_id: a.project_id, superseded: false, source_table: "hall_project_attachments", source_id: a.id });
    }
    for (const d of T("hall_project_detachments").filter((x) => x.hall_id === h!.id)) {
      ev.push({ hall_id: h!.id, occurred_at: d.detached_at, kind: "project_detached", subject: "detached", summary: `Project "${proj(d.project_id)?.project_name}" detached from this hall`, origin: "recorded", evidence_class: null,
        basis: "recorded detachment by an owner of the organisation", actor: d.detached_by, project_id: d.project_id, superseded: false, source_table: "hall_project_detachments", source_id: d.id });
    }
    for (const p of T("projects").filter((x) => x.hall_id === h!.id)) {
      for (const e of T("project_events").filter((x) => x.project_id === p.id && !["project_attached_to_hall", "project_detached_from_hall"].includes(String(x.event_type)))) {
        ev.push({
          hall_id: h!.id, occurred_at: e.occurred_at, kind: "project_event", subject: e.event_type, summary: `Project "${p.project_name}": ${e.event_type}`, origin: "recorded",
          evidence_class: null, basis: "log entry of an attached project; not a measurement", actor: e.actor, project_id: p.id, superseded: false, source_table: "project_events", source_id: e.id,
        });
      }
    }
    // The total order key, compared as strings (the fake's clock is ISO text): occurred_at, source_table, source_id, subject.
    const key = (e: { occurred_at: unknown; source_table: unknown; source_id: unknown; subject: unknown }) => [new Date(String(e.occurred_at)).toISOString(), String(e.source_table), String(e.source_id), String(e.subject)];
    const cmp = (a: string[], b: string[]) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
    const sorted = ev.filter((e) => !cur || cmp(key(e as any), key(cur)) < 0).sort((x, y) => cmp(key(y as any), key(x as any)));
    const page = sorted.slice(0, lim);
    const last = page[page.length - 1];
    return {
      ok: true, hall: { id: h!.id, label: h!.label, site_name: s!.name, org_id: s!.org_id, data_origin: s!.data_origin },
      truncated: sorted.length > lim,
      next_cursor: sorted.length > lim && last ? JSON.stringify({ occurred_at: key(last as any)[0], source_table: last.source_table, source_id: last.source_id, subject: last.subject }) : null,
      events: page.map(({ hall_id: _h, ...rest }) => rest),
    };
  });

  // A project row the site writes elsewhere may carry hall columns; the fake only needs them to exist.
  void PgError;
}
