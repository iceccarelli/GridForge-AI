/**
 * The gf_* functions of 0015_projects.sql, restated against the in-memory fake.
 *
 * SUPPLEMENTAL, not verification. These mirror the SQL's behaviour (one transaction:
 * the record and its event, or neither) so the route tests can run without a database.
 * That the REAL functions are atomic is proven against PostgreSQL in
 * tests/test_projects_migration.py and, end to end through PostgREST, in
 * tests/site/verified-power-record.realdb.test.ts.
 */
import { PgError, type PostgrestFake, type Row } from "./postgrest-fake";

const EVENT_TYPES = new Set([
  "project_created", "btm_case_attached", "btm_case_revised", "rfq_generated",
  "supplier_response_received", "comparison_completed", "supplier_selected", "evidence_attached",
  "paid_product_attached", "observation_submitted", "observation_reviewed",
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
    if (db.rows("project_events").some((e) => e.event_type === "paid_product_attached" && (e.payload as any)?.stripe_session_id === p_event.payload.stripe_session_id)) {
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
    if (p.evidence_id && !db.rows("project_evidence").some((e) => e.id === p.evidence_id && e.project_id === p.project_id)) {
      throw new PgError("23503", "that evidence does not belong to this project", 409);
    }
    if (!(p.predicted_value > 0)) throw new PgError("23514", "predicted_value > 0", 400);
    if (db.rows("project_observations").some((o) => o.project_id === p.project_id && o.prediction_ref === p.prediction_ref
        && o.calibration_key === p.calibration_key && o.observed_on === p.observed_on)) {
      throw new PgError("23505", "project_observations unique", 409);
    }
    const r = db.insertRow("project_observations", {
      ...p, submitted_at: p.submitted_at ?? new Date().toISOString(),
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
    if (p.decision === "verified" && !o.evidence_id) throw new PgError("23514", "no evidence artifact", 400);
    if ((p.decision === "verified") !== (p.evidence_class != null)) throw new PgError("23514", "class iff verified", 400);
    const r = db.insertRow("project_observation_reviews", { observation_id: o.id, project_id: o.project_id, ...p });
    emit(o.project_id, p_event, { observation_id: o.id, decision: r.decision, evidence_class: r.evidence_class });
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
}
