/**
 * The gf_* functions of 0015_projects.sql (and 0024/0025 for the rate limit, comparisons and share links), restated against the in-memory fake.
 *
 * SUPPLEMENTAL, not verification. These mirror the SQL's behaviour (one transaction:
 * the record and its event, or neither) so the route tests can run without a database.
 * That the REAL functions are atomic is proven against PostgreSQL in
 * tests/test_projects_migration.py and, end to end through PostgREST, in
 * tests/site/verified-power-record.realdb.test.ts.
 */
import { createHash } from "node:crypto";
import { PgError, type PostgrestFake, type Row } from "./postgrest-fake";

const EVENT_TYPES = new Set([
  "project_created", "btm_case_attached", "btm_case_revised", "rfq_generated",
  "supplier_response_received", "comparison_completed", "supplier_selected", "evidence_attached",
  "paid_product_attached", "observation_submitted", "observation_reviewed",
  "supplier_actual_submitted", "supplier_actual_reviewed",
  "cost_evidence_received", "cost_evidence_reviewed", "cost_evidence_retired", "cost_evidence_run",
  "comparison_saved", "share_issued", "share_revoked", "calibration_permission_recorded", "evidence_reviewed",
]);

export function installProjectRpcs(db: PostgrestFake): void {
  const emit = (project_id: unknown, e: any, extra: Row = {}) => {
    if (!EVENT_TYPES.has(e?.event_type)) throw new PgError("23514", "project_events_event_type_check", 400);
    if (!e.actor) throw new PgError("23502", "null value in column actor of relation project_events", 400);
    if (db.failEvents) throw new PgError("XX000", "simulated event write failure", 500);
    return db.insertRow("project_events", {
      project_id, event_type: e.event_type, occurred_at: e.occurred_at ?? new Date().toISOString(),
      actor: e.actor, payload: { ...(e.payload ?? {}), ...extra },
    });
  };

  db.rpcs.set("gf_attach_purchase", ({ p_project, p_object_type, p_object_id, p_event }) => {
    if (!db.rows("projects").some((x) => x.id === p_project)) throw new PgError("23503", "project_id foreign key", 409);
    // This Stripe session was already attached: the SQL catches the unique violation and answers created:false.
    if (db.rows("project_events").some((e) => e.event_type === "paid_product_attached" && (e.payload as any)?.session_ref === p_event.payload.session_ref)) {
      return { created: false };
    }
    if (p_object_type) {
      const links = db.rows("project_links");
      const exact = links.some((l) => l.project_id === p_project && l.object_type === p_object_type && l.object_id === p_object_id);
      if (exact) return { created: false };
      if (links.some((l) => l.object_type === p_object_type && l.object_id === p_object_id)) {
        throw new PgError("23505", "project_links_one_project_per_object", 409);
      }
      db.insertRow("project_links", { project_id: p_project, object_type: p_object_type, object_id: p_object_id });
    }
    emit(p_project, p_event);
    return { created: true };
  });
  db.rpcs.set("gf_submit_observation", ({ p, p_event }) => {
    if (!p.evidence_id) throw new PgError("23502", "an observation needs an attached evidence artifact", 400);
    if (p.installed_attested !== true) throw new PgError("23514", "the installed architecture must be attested", 400);
    if (!String(p.installed_basis ?? "").trim()) throw new PgError("23514", "installed_basis required", 400);
    if (!db.rows("project_evidence").some((e) => e.id === p.evidence_id && e.project_id === p.project_id)) {
      throw new PgError("23503", "that evidence does not belong to this project", 409);
    }
    if (!(p.predicted_value > 0)) throw new PgError("23514", "predicted_value > 0", 400);
    // 0038: a MW output is a physical, finite, positive number of MW; a measurement has one of three kinds.
    if (!(p.observed_value > 0 && p.observed_value <= 10000)) throw new PgError("23514", "project_observations_value_sane", 400);
    if (p.unit !== "MW") throw new PgError("23514", "project_observations_unit_mw", 400);
    if (p.measurement_kind != null && !["metered", "bms_trend", "commissioning_record"].includes(p.measurement_kind)) {
      throw new PgError("23514", "measurement_kind must be metered, bms_trend or commissioning_record", 400);
    }
    if (db.rows("project_observations").some((o) => o.project_id === p.project_id && o.prediction_ref === p.prediction_ref
        && o.calibration_key === p.calibration_key && o.observed_on === p.observed_on)) {
      throw new PgError("23505", "project_observations unique", 409);
    }
    // 0047: the origin is one of four words and an absent one is "unclassified", never production.
    const origin = p.data_origin ?? "unclassified";
    if (!["production", "test", "synthetic", "unclassified"].includes(origin)) throw new PgError("23514", "project_observations_data_origin_check", 400);
    // 0046: the forecast must predate the outcome (created before 00:00 UTC of the observed date), and must exist.
    const fc: any = db.rows("power_deployment_cases").find((x) => x.case_token === p.case_token && x.revision === p.case_revision);
    if (!fc || typeof fc.created_at !== "string" || typeof fc.case_digest !== "string" || Date.parse(fc.created_at) >= Date.parse(`${p.observed_on}T00:00:00Z`)) {
      throw new PgError("GF004", "the forecast must predate the outcome", 400);
    }
    if (p.observed_on > new Date().toISOString().slice(0, 10)) throw new PgError("GF004", "the outcome cannot be dated in the future", 400);
    const own = (fc.result?.architectures ?? []).find((a: any) => a.label === p.architecture);
    if (!(typeof own?.available_MW === "number" && own.available_MW === p.predicted_value)) {
      throw new PgError("GF004", "the predicted value must be the number the stored forecast holds", 400);
    }
    // Migration 0053: the application sends the SALTED site reference (lib/site-ref.ts) and the database stores it when it is well formed;
    // otherwise (absent, or malformed) it derives the old unsalted one from the label, as 0038/0047 did. The prediction's engine digest is
    // read from the case revision, never taken from the caller.
    const label = String(db.rows("projects").find((x) => x.id === p.project_id)?.site_label ?? "").trim().toLowerCase();
    if (p.site_ref !== undefined && p.site_ref !== null && !(typeof p.site_ref === "string" && /^site_[0-9a-f]{12}$/.test(p.site_ref))) {
      throw new PgError("23514", "site_ref must be site_ followed by 12 lowercase hex characters", 400);          // present but malformed: refused, never replaced
    }
    const unsalted = label ? `site_${createHash("sha256").update(label).digest("hex").slice(0, 12)}` : null;
    const site_ref = p.site_ref && label ? p.site_ref : unsalted;                                              // stored as given only for a project that has a label
    const cs: any = db.rows("power_deployment_cases").find((x) => x.case_token === p.case_token && x.revision === p.case_revision);
    const prov = cs?.engine_provenance ?? null;
    const { site_ref: _s, engine_provenance_digest: _d, report_date: _r, ...given } = p;
    void _s; void _d; void _r;
    const r = db.insertRow("project_observations", {
      ...given, data_origin: origin, measurement_kind: p.measurement_kind ?? null, site_ref,
      engine_provenance_digest: typeof prov?.digest === "string" ? prov.digest : null,
      report_date: typeof prov?.report_date === "string" ? prov.report_date : null,
      submitted_at: p.submitted_at ?? new Date().toISOString(),
      delta_value: p.observed_value - p.predicted_value,
      delta_pct: (p.observed_value / p.predicted_value - 1) * 100,
    });
    emit(r.project_id, p_event, { observation_id: r.id, prediction_ref: r.prediction_ref, calibration_key: r.calibration_key,
      predicted_value: r.predicted_value, observed_value: r.observed_value, delta_pct: r.delta_pct });
    return r;
  });
  db.rpcs.set("gf_review_observation", ({ p, p_event }) => {
    const o = db.rows("project_observations").find((x) => x.id === p.observation_id);
    if (!o) throw new PgError("23503", "no such observation", 409);
    // 0038: not the submitter; verified only against verified evidence; E5 and nothing else.
    const who = String(p.reviewer ?? "").trim().toLowerCase();
    if (who && (who === String(o.submitted_by ?? "").trim().toLowerCase() || who === String(o.submitted_by_ref ?? "").toLowerCase())) {
      throw new PgError("GF001", "a submission cannot be reviewed by the person who submitted it", 400);
    }
    const evid: any = db.rows("project_evidence").find((e) => e.id === o.evidence_id);
    if (p.decision === "verified") {
      if (evid?.review_status !== "verified") throw new PgError("GF002", "the supporting evidence artifact is not verified", 400);
      if (p.evidence_class !== "E5") throw new PgError("GF003", "a reviewer may assign only E5", 400);
    }
    if ((p.decision === "verified") !== (p.evidence_class != null)) throw new PgError("23514", "class iff verified", 400);
    const r = db.insertRow("project_observation_reviews", {
      observation_id: o.id, project_id: o.project_id, ...p, evidence_sha256: p.decision === "verified" ? evid.sha256 : null,
    });
    emit(o.project_id, p_event, { observation_id: o.id, decision: r.decision, evidence_class: r.evidence_class });
    return r;
  });
  // Supplier Reality. The derived `supplier_reality` VIEW is mirrored here row-for-row on submit; the
  // real view is exercised only by the real-database suites, which is what proves its arithmetic.
  const weeks = (a: string | null, b: string | null) =>
    a && b ? Math.round(((Date.parse(b) - Date.parse(a)) / 86_400_000 / 7) * 10) / 10 : null;
  db.rpcs.set("gf_submit_supplier_actual", ({ p, p_event }) => {
    const pk = db.rows("procurement_packages").find((x) => x.id === p.package_id && x.project_id === p.project_id);
    if (!pk) throw new PgError("23503", "no such package in this project", 409);
    if (!pk.selected_supplier || !pk.selected_response_id) throw new PgError("23514", "no supplier selected", 400);
    const rs = db.rows("procurement_responses").find((x) => x.id === pk.selected_response_id);
    if (!db.rows("project_evidence").some((e) => e.id === p.evidence_id && e.project_id === pk.project_id)) {
      throw new PgError("23503", "that evidence does not belong to this project", 409);
    }
    const all = db.rows("supplier_actuals").filter((x) => x.package_id === pk.id);
    if (p.supersedes_id) {
      if (!all.some((x) => x.id === p.supersedes_id)) throw new PgError("23503", "no such record to correct", 409);
      if (all.some((x) => x.supersedes_id === p.supersedes_id)) throw new PgError("23505", "supplier_actuals_one_correction", 409);
    } else if (all.some((x) => !x.supersedes_id)) {
      throw new PgError("23505", "supplier_actuals_one_initial", 409);
    }
    const v = ((rs as any)?.response?.values ?? {}) as Record<string, unknown>;
    const num = (x: unknown) => (typeof x === "number" ? x : null);
    const r: any = db.insertRow("supplier_actuals", {
      po_date: null, dispatch_date: null, on_site_date: null, install_complete_date: null, energised_date: null,
      actual_cost: null, actual_cost_currency: null, cost_scope: null, cost_scope_note: null, supersedes_id: null, note: null,
      ...p, package_id: pk.id, selected_response_id: rs?.id, supplier: rs?.supplier, case_token: pk.case_token,
      case_revision: pk.case_revision, architecture: pk.architecture,
      quoted_capex_eur: num(v.capex_eur), quoted_lead_time_weeks: num(v.lead_time_weeks),
      quoted_install_weeks: num(v.install_weeks), quoted_snapshot: v,
      submitted_at: p.submitted_at ?? new Date().toISOString(),
    });
    const cmp = r.cost_scope === "same_as_quote" && r.actual_cost_currency === "EUR" && r.quoted_capex_eur !== null;
    db.insertRow("supplier_reality", {
      actual_id: r.id, project_id: r.project_id, package_id: r.package_id, supplier: r.supplier,
      supersedes_id: r.supersedes_id, quoted_lead_time_weeks: r.quoted_lead_time_weeks,
      actual_lead_time_weeks: weeks(r.po_date, r.on_site_date),
      lead_time_basis: r.quoted_lead_time_weeks === null ? "unknown: the quote gave no lead time"
        : !r.po_date ? "unknown: PO date not supplied" : !r.on_site_date ? "unknown: on-site date not supplied" : "fake: weeks PO to on-site",
      quoted_install_weeks: r.quoted_install_weeks, actual_install_weeks: weeks(r.on_site_date, r.energised_date),
      install_basis: r.quoted_install_weeks === null ? "unknown: the quote gave no installation time"
        : !r.on_site_date ? "unknown: on-site date not supplied" : !r.energised_date ? "unknown: first-energised date not supplied" : "fake: weeks on-site to energised",
      quoted_capex_eur: r.quoted_capex_eur, actual_cost: r.actual_cost, actual_cost_currency: r.actual_cost_currency,
      cost_scope: r.cost_scope, cost_delta_eur: cmp ? r.actual_cost - r.quoted_capex_eur : null,
      cost_basis: r.actual_cost === null ? "unknown: no actual cost supplied" : cmp ? "EUR, same scope as quote" : "not compared",
    });
    emit(r.project_id, p_event, { actual_id: r.id, package_id: r.package_id, supplier: r.supplier, evidence_id: r.evidence_id });
    return r;
  });
  db.rpcs.set("gf_review_supplier_actual", ({ p, p_event }) => {
    const a = db.rows("supplier_actuals").find((x) => x.id === p.actual_id);
    if (!a) throw new PgError("23503", "no such record", 409);
    const supplied = ["po_date", "dispatch_date", "on_site_date", "install_complete_date", "energised_date", "actual_cost"]
      .filter((f) => a[f] !== null && a[f] !== undefined);
    const vf: string[] = p.verified_fields ?? [];
    const who = String(p.reviewer ?? "").trim().toLowerCase();
    if (who && (who === String(a.submitted_by ?? "").trim().toLowerCase() || who === String(a.submitted_by_ref ?? "").toLowerCase())) {
      throw new PgError("GF001", "a submission cannot be reviewed by the person who submitted it", 400);
    }
    const evid: any = db.rows("project_evidence").find((e) => e.id === a.evidence_id);
    if (p.decision === "verified" && evid?.review_status !== "verified") {
      throw new PgError("GF002", "the supporting evidence artifact is not verified", 400);
    }
    if (!vf.every((f) => supplied.includes(f))) throw new PgError("23514", "verify only supplied facts", 400);
    if ((p.decision === "verified") !== (vf.length > 0)) throw new PgError("23514", "verified iff fields", 400);
    if (p.decision === "rejected" && !String(p.reason ?? "").trim()) throw new PgError("23514", "rejection needs reason", 400);
    if (db.rows("supplier_actual_reviews").some((x) => x.actual_id === a.id)) throw new PgError("23505", "unique actual_id", 409);
    const r = db.insertRow("supplier_actual_reviews", {
      ...p, project_id: a.project_id, verified_fields: vf, evidence_sha256: p.decision === "verified" ? evid.sha256 : null,
    });
    emit(a.project_id, p_event, { actual_id: a.id, decision: r.decision, verified_fields: vf });
    return r;
  });
  // --- 0047_calibration_consent_and_origin.sql
  db.rpcs.set("gf_record_calibration_permission", ({ p, p_event }) => {
    if (p.scope_type !== "project") throw new PgError("23514", "calibration_permissions_scope_type_check", 400);
    if (!["granted", "revoked"].includes(p.kind)) throw new PgError("23514", "calibration_permissions_kind_check", 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(p.granted_by_email ?? "").trim())) throw new PgError("23514", "calibration_permissions_granted_by_email_check", 400);
    if (!/^[0-9a-f]{64}$/.test(String(p.document_sha256 ?? ""))) throw new PgError("23514", "calibration_permissions_document_sha256_check", 400);
    if (!db.rows("projects").some((x) => x.id === p.scope_id)) throw new PgError("23503", "no such project", 409);
    const own = db.rows("calibration_permissions").filter((x) => x.scope_id === p.scope_id);
    if (p.kind === "revoked" && own[own.length - 1]?.kind !== "granted") throw new PgError("GF006", "nothing to revoke", 409);
    const r = db.insertRow("calibration_permissions", {
      seq: db.rows("calibration_permissions").length + 1, scope_type: "project", scope_id: p.scope_id, kind: p.kind,
      granted_by_email: String(p.granted_by_email).trim().toLowerCase(), granted_at: new Date().toISOString(),
      document_sha256: p.document_sha256, note: p.note ? String(p.note).trim() || null : null,
    });
    emit(p.scope_id, p_event, { permission_id: r.id, kind: r.kind, document_sha256: r.document_sha256 });
    return r;
  });
  // --- 0048_evidence_verification.sql
  db.rpcs.set("gf_review_evidence", ({ p, p_event }) => {
    const e: any = db.rows("project_evidence").find((x) => x.id === p.evidence_id);
    if (!e) throw new PgError("23503", "no such evidence", 409);
    if (e.review_status !== "unverified") throw new PgError("GF008", "this file has already been reviewed", 409);
    if (!["verified", "rejected"].includes(p.decision)) throw new PgError("23514", "decision", 400);
    if (!String(p.reviewer ?? "").trim() || String(p.reviewer).length > 120) throw new PgError("23514", "reviewer", 400);
    if (!String(p.reason ?? "").trim() || String(p.reason).length > 500) throw new PgError("23514", "reason", 400);
    if (p.decision === "verified" && p.sha256_confirmed !== e.sha256) throw new PgError("GF007", "the confirmed SHA-256 does not match", 409);
    if (db.rows("project_evidence_reviews").some((x) => x.evidence_id === e.id)) throw new PgError("23505", "unique evidence_id", 409);
    const r = db.insertRow("project_evidence_reviews", {
      evidence_id: e.id, project_id: e.project_id, decision: p.decision, reviewer: p.reviewer, reason: p.reason,
      sha256_confirmed: p.sha256_confirmed ?? null, reviewed_at: new Date().toISOString(),
    });
    e.review_status = p.decision;
    emit(e.project_id, p_event, { evidence_id: e.id, decision: r.decision, sha256_confirmed: r.sha256_confirmed });
    return r;
  });
  db.rpcs.set("gf_create_project", ({ p, p_event }) => {
    const r = db.insertRow("projects", { ...p, status: p.status ?? "draft" });
    emit(r.id, p_event);
    return r;
  });
  db.rpcs.set("gf_attach_case", ({ p_project, p_case_token, p_event }) => {
    const links = db.rows("project_links");
    if (links.some((l) => l.project_id === p_project && l.object_type === "power_deployment_case" && l.object_id === p_case_token)) {
      return { created: false };
    }
    if (links.some((l) => l.object_type === "power_deployment_case" && l.object_id === p_case_token)) {
      throw new PgError("23505", "project_links_one_project_per_object", 409);
    }
    const l = db.insertRow("project_links", { project_id: p_project, object_type: "power_deployment_case", object_id: p_case_token });
    emit(p_project, p_event);
    return { created: true, link_id: l.id };
  });
  db.rpcs.set("gf_append_case_revision", ({ p, p_event }) => {
    const row = db.insertRow("power_deployment_cases", p);
    let n = 0;
    for (const l of db.rows("project_links").filter((x) => x.object_type === "power_deployment_case" && x.object_id === p.case_token)) {
      emit(l.project_id, p_event, { case_token: p.case_token, revision: p.revision, changed_fields: p.changed_fields });
      n += 1;
    }
    return { row, events: n };
  });
  db.rpcs.set("gf_create_package", ({ p, p_event }) => {
    const r = db.insertRow("procurement_packages", p);
    db.insertRow("project_links", { project_id: r.project_id, object_type: "procurement_package", object_id: r.package_token });
    emit(r.project_id, p_event);
    const { document_md: _m, document_html: _h, ...rest } = r;
    void _m; void _h;
    return rest;
  });
  db.rpcs.set("gf_add_response", ({ p, p_event }) => {
    const r = db.insertRow("procurement_responses", p);
    emit(r.project_id, p_event, { response_id: r.id, received_at: r.received_at });
    return r;
  });
  db.rpcs.set("gf_add_comparison", ({ p, p_event }) => {
    const r = db.insertRow("procurement_comparisons", p);
    emit(r.project_id, p_event, { comparison_id: r.id });
    return r;
  });
  db.rpcs.set("gf_select_supplier", ({ p_package, p, p_event }) => {
    const r = db.rows("procurement_packages").find((x) => x.id === p_package && !x.selected_supplier);
    if (!r) return null;
    Object.assign(r, p);
    emit(r.project_id, p_event);
    const { document_md: _m, document_html: _h, ...rest } = r;
    void _m; void _h;
    return rest;
  });
  db.rpcs.set("gf_add_evidence", ({ p, p_event }) => {
    const r = db.insertRow("project_evidence", { evidence_class: null, review_status: "unverified", ...p });
    emit(r.project_id, p_event, { evidence_id: r.id });
    return r;
  });

  // --- 0025_project_comparisons_and_shares.sql
  db.rpcs.set("gf_save_comparison", ({ p, p_event, p_new_project, p_new_event }) => {
    let pid = p.project_id;
    // 0026: a comparison may name only accepted, real, EUR quotations of its own project (checked here before anything is written).
    const evidenceIds: string[] = [...new Set<string>(p.evidence_ids ?? [])];
    if (evidenceIds.length) {
      const accepted = evidenceIds.filter((id) => {
        const s = db.rows("cost_evidence_state").find((x) => x.id === id);
        return !!s && s.state === "accepted" && s.project_id === pid && s.currency === "EUR" && !s.synthetic &&
          db.rows("project_links").some((l) => l.project_id === pid && l.object_type === "deliverable" && l.object_id === s.deliverable_id);
      });
      if (p_new_project || accepted.length !== evidenceIds.length) {
        throw new PgError("23514", "a comparison can only rest on accepted quotations of its own project", 400);
      }
    }
    if (p_new_project) {
      const proj = db.insertRow("projects", { ...p_new_project, status: p_new_project.status ?? "draft" });
      emit(proj.id, p_new_event);
      pid = proj.id;
    } else if (!db.rows("projects").some((x) => x.id === pid)) {
      throw new PgError("23503", "project_comparisons_project_id_fkey", 409);
    }
    const same = db.rows("project_comparisons").find((c) => c.project_id === pid && c.request_digest === p.request_digest && c.provenance_digest === p.provenance_digest);
    if (same) return { created: false, project_id: pid, comparison_id: same.id };
    for (const f of ["request", "result", "schema", "request_digest", "provenance_digest", "engine_version"]) {
      if (p[f] === undefined || p[f] === null || p[f] === "") throw new PgError("23502", `null value in column ${f}`, 400);
    }
    if (!["indicative", "screening"].includes(p.grade)) throw new PgError("23514", "project_comparisons_grade_check", 400);
    const r = db.insertRow("project_comparisons", { project_id: pid, ...p, evidence_ids: evidenceIds, saved_at: p.saved_at ?? new Date().toISOString() });
    emit(pid, p_event, { comparison_id: r.id });
    return { created: true, project_id: pid, comparison_id: r.id };
  });
  db.rpcs.set("gf_issue_share", ({ p_project, p_token_hash, p_event }) => {
    if (!db.rows("projects").some((x) => x.id === p_project)) throw new PgError("23503", "no such project", 409);
    if (!/^[0-9a-f]{64}$/.test(String(p_token_hash))) throw new PgError("23514", "project_shares_token_hash_check", 400);
    const active = db.rows("project_shares").filter((s) => s.project_id === p_project && !s.revoked_at);
    for (const a of active) a.revoked_at = new Date().toISOString();
    const r = db.insertRow("project_shares", { project_id: p_project, token_hash: p_token_hash, revoked_at: null });
    emit(p_project, p_event, { share_id: r.id, replaced_previous: active.length > 0 });
    return { share_id: r.id, created_at: r.created_at, replaced_previous: active.length > 0 };
  });
  db.rpcs.set("gf_revoke_share", ({ p_project, p_event }) => {
    if (!db.rows("projects").some((x) => x.id === p_project)) throw new PgError("23503", "no such project", 409);
    const a = db.rows("project_shares").find((s) => s.project_id === p_project && !s.revoked_at);
    if (!a) return { revoked: false };
    a.revoked_at = new Date().toISOString();
    emit(p_project, p_event, { share_id: a.id });
    return { revoked: true };
  });
}
