"use client";

import React, { useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import type { EvidenceRow, EvidenceState } from "@/lib/cost-evidence";
import {
  COMPARABILITIES,
  REVIEW_BASES,
  STATE_META,
  eligibility,
  reviewBody,
  withdrawBody,
  type ReviewForm,
} from "@/lib/evidence-review";

/**
 * The administrator's cost-evidence review queue, inside the existing pipeline page.
 *
 * Every read and write goes through the existing /api/admin/cost-evidence routes, which check the admin cookie on each
 * call. This screen offers only the controls the server will accept (accept/reject a VALIDATED line, withdraw an
 * ACCEPTED one) and shows the state of every other line without a control. It never implies that a received or
 * validated quotation influences a run: only `accepted` does, and the label says so.
 */

const STATES: EvidenceState[] = ["validated", "invalid", "accepted", "rejected", "superseded", "withdrawn"];
const eurFmt = new Intl.NumberFormat("en-IE", { maximumFractionDigits: 2 });

export interface AuditRun {
  id: string;
  deliverable_id: string;
  created_at: string;
  legacy: boolean;
  run_fingerprint: string | null;
  accepted_evidence_ids: string[] | null;
  used_evidence_ids: string[];
  ignored: unknown[];
  engine_version: string | null;
  engine_fingerprint: string | null;
  report_date: string | null;
  artifact_sha256: string | null;
  artifact_bytes: number | null;
  artifact: "stored" | "legacy_unavailable";
}

export function CostEvidenceReview({
  initial,
  initialError,
  runs = [],
}: {
  initial: EvidenceRow[];
  initialError?: string | null;
  runs?: AuditRun[];
}) {
  const [items, setItems] = useState(initial);
  const [filter, setFilter] = useState<"pending" | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [open, setOpen] = useState<string | null>(null);

  async function reload(next: "pending" | "all") {
    const r = await fetch(`/api/admin/cost-evidence?state=${next}`, { cache: "no-store" });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || !b.ok) throw new Error(b?.error ?? "The queue could not be read.");
    setItems(b.items);
  }

  async function changeFilter(next: "pending" | "all") {
    setFilter(next);
    setError(null);
    try {
      await reload(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The queue could not be read.");
    }
  }

  async function send(id: string, action: "review" | "withdraw", body: Record<string, unknown>) {
    setBusy(id);
    setError(null);
    try {
      const r = await fetch(`/api/admin/cost-evidence/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || !b.ok) {
        setError(b?.error ?? "The decision could not be saved. Nothing was recorded.");
        // A refused decision may mean someone else decided first: show what the database now says.
        await reload(filter).catch(() => undefined);
        return;
      }
      setOpen(null);
      await reload(filter);
    } catch {
      setError("Could not reach the server. Nothing was recorded.");
    } finally {
      setBusy(null);
    }
  }

  const counts = Object.fromEntries(STATES.map((s) => [s, items.filter((i) => i.state === s).length]));

  return (
    <section className="mb-12" aria-label="Cost evidence review">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ghost">Supplier quotations — cost evidence</h2>
          <p className="mt-1 max-w-3xl text-xs text-faint">
            A quotation influences a run only once a named person has accepted it. Received and validated lines are
            shown here but change no number. Prices below are confidential and synthetic where marked.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          {(["all", "pending"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => changeFilter(f)}
              aria-pressed={filter === f}
              className={`rounded border px-3 py-1 ${filter === f ? "border-power/60 text-power" : "border-line text-mute"}`}
            >
              {f === "all" ? "All lines" : "Awaiting decision"}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
        {STATES.map((s) => `${s} ${counts[s]}`).join(" · ")}
      </p>

      {error ? (
        <div role="alert" className="mb-3 flex gap-3 rounded border border-flag/40 bg-flag/10 p-3 text-sm text-ghost">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-flag" />
          <p>{error}</p>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
          {filter === "pending" ? "Nothing is awaiting a decision." : "No quotation lines have been received."}
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((i) => (
            <EvidenceCard
              key={i.id}
              item={i}
              busy={busy === i.id}
              open={open === i.id}
              onToggle={() => setOpen(open === i.id ? null : i.id)}
              onSend={send}
              onInvalid={setError}
            />
          ))}
        </ul>
      )}
      <RunAudit runs={runs} />
    </section>
  );
}

/** Every recorded run, with the integrity facts an auditor needs. The document is downloaded through the verified
 * admin route, which re-hashes it first. */
function RunAudit({ runs }: { runs: AuditRun[] }) {
  return (
    <div className="mt-10" aria-label="Evidence run audit">
      <h3 className="text-sm font-semibold text-ghost">Evidence runs — audit</h3>
      {runs.length === 0 ? (
        <p className="mt-2 text-xs text-faint">No evidence run has been recorded.</p>
      ) : (
        <ul className="mt-2 space-y-2 text-xs text-mute">
          {runs.map((r) => (
            <li key={r.id} className="rounded border border-line p-3" data-run-id={r.id} data-artifact={r.artifact}>
              <p>
                <span className="text-ghost">{new Date(r.created_at).toLocaleString()}</span>
                {r.legacy ? <span className="ml-2 font-mono uppercase text-queue">legacy · no document kept</span> : null}
                {" · "}engagement <span className="font-mono">{r.deliverable_id}</span>
              </p>
              <p className="mt-1">
                {r.accepted_evidence_ids ? `${r.accepted_evidence_ids.length} offered · ` : ""}
                {r.used_evidence_ids.length} used · {r.ignored.length} ignored
                {r.engine_version ? ` · engine ${r.engine_version}` : ""}
                {r.report_date ? ` · dated ${r.report_date}` : ""}
              </p>
              {r.run_fingerprint ? <p className="mt-1 font-mono text-[10px] break-all text-faint">run {r.run_fingerprint}</p> : null}
              {r.artifact === "stored" ? (
                <p className="mt-1">
                  <a className="underline" href={`/api/admin/cost-evidence/runs/${r.id}/artifact`}>
                    Download (verified)
                  </a>
                  <span className="font-mono text-[10px] break-all text-faint">
                    {" "}· sha256 {r.artifact_sha256} · {r.artifact_bytes} bytes
                  </span>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EvidenceCard({
  item: i,
  busy,
  open,
  onToggle,
  onSend,
  onInvalid,
}: {
  item: EvidenceRow;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onSend: (id: string, action: "review" | "withdraw", body: Record<string, unknown>) => void;
  onInvalid: (msg: string) => void;
}) {
  const meta = STATE_META[i.state];
  const can = eligibility(i);
  const [form, setForm] = useState<ReviewForm>({
    decision: "accepted",
    reviewer: "",
    basis: "",
    comparability: "",
    region: "",
    includes: "",
    reason: "",
  });
  const [wd, setWd] = useState({ by: "", reason: "" });
  const set = (k: keyof ReviewForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <li className="rounded border border-line bg-panel-2 p-4 text-sm" data-evidence-id={i.id} data-state={i.state}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-ghost">
            {i.supplier} <span className="font-mono text-xs text-faint">· {i.cost_key}</span>
            {i.synthetic ? <span className="ml-2 font-mono text-[10px] uppercase text-queue">synthetic</span> : null}
          </p>
          <p className="mt-1 text-xs text-mute">{i.scope}</p>
        </div>
        <span
          title={meta.meaning}
          className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ${meta.tone}`}
        >
          {meta.label}
        </span>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-mute sm:grid-cols-2 lg:grid-cols-3">
        <Row k="Value">
          {i.value === null ? "—" : eurFmt.format(Number(i.value))} {i.currency} / {i.unit}
        </Row>
        <Row k="Stated quantity">
          {i.quoted_quantity === null ? "per-unit price" : `${i.quoted_quantity} ${i.quoted_quantity_unit ?? ""} (lump)`}
        </Row>
        <Row k="Validity">
          received {i.received_on ?? "—"} · until {i.valid_until ?? "—"}
        </Row>
        <Row k="Reference">{i.reference || "—"}</Row>
        <Row k="Answers">{specificationLine(i.specification)}</Row>
        <Row k="Response digest">
          <span className="font-mono break-all">{i.response_digest}</span>
        </Row>
        <Row k="Validation">
          {i.validation_status} · comparability {i.comparability}
        </Row>
        <Row k="Evidence id">
          <span className="font-mono break-all">{i.id}</span>
        </Row>
      </dl>

      {i.problems?.length ? (
        <p className="mt-2 text-xs text-flag">Problems: {i.problems.join("; ")}</p>
      ) : null}
      {i.limitations?.length ? (
        <p className="mt-1 text-xs text-queue">Limitations: {i.limitations.join("; ")}</p>
      ) : null}

      {i.reviewed_at ? (
        <p className="mt-2 text-xs text-mute">
          Reviewed by <span className="text-ghost">{i.reviewer}</span> on {i.reviewed_at.slice(0, 10)}
          {i.reviewed_basis ? ` · basis ${i.reviewed_basis}` : ""}
          {i.reviewed_comparability ? ` · comparability ${i.reviewed_comparability}` : ""}
          {i.reviewed_region ? ` · region ${i.reviewed_region}` : ""}
          {i.includes_keys?.length ? ` · also covers ${i.includes_keys.join(", ")}` : ""}
          {i.review_reason ? ` · “${i.review_reason}”` : ""}
        </p>
      ) : null}
      {i.retired_kind ? (
        <p className="mt-1 text-xs text-mute">
          {i.retired_kind === "superseded" ? "Superseded" : "Withdrawn"} by{" "}
          <span className="text-ghost">{i.retired_by ?? "—"}</span>
          {i.retired_at ? ` on ${i.retired_at.slice(0, 10)}` : ""}
          {i.superseded_by ? ` · replaced by ${i.superseded_by}` : ""}
          {i.retirement_reason ? ` · “${i.retirement_reason}”` : ""}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] text-faint">{meta.meaning}</p>

      {can.blocked ? <p className="mt-2 text-xs text-queue">{can.blocked}</p> : null}

      {can.accept || can.reject || can.withdraw ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="rounded border border-power/60 px-3 py-1 text-xs font-semibold text-power hover:bg-power/10"
          >
            {can.withdraw ? "Withdraw…" : "Review…"}
          </button>
        </div>
      ) : null}

      {open && can.withdraw ? (
        <form
          className="mt-3 grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const b = withdrawBody(wd);
            if (!b.ok) return onInvalid(b.error);
            onSend(i.id, "withdraw", b.body);
          }}
        >
          <Field label="Your name (required)">
            <input value={wd.by} onChange={(e) => setWd({ ...wd, by: e.target.value })} maxLength={120} className={INPUT} />
          </Field>
          <Field label="Reason">
            <input value={wd.reason} onChange={(e) => setWd({ ...wd, reason: e.target.value })} maxLength={500} className={INPUT} />
          </Field>
          <button type="submit" disabled={busy} className={`${BTN} sm:col-span-2`}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Withdraw this accepted quotation
          </button>
        </form>
      ) : null}

      {open && (can.accept || can.reject) ? (
        <form
          className="mt-3 grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const b = reviewBody(form);
            if (!b.ok) return onInvalid(b.error);
            onSend(i.id, "review", b.body);
          }}
        >
          <Field label="Decision">
            <select value={form.decision} onChange={set("decision")} className={INPUT}>
              {can.accept ? <option value="accepted">Accept</option> : null}
              <option value="rejected">Reject</option>
            </select>
          </Field>
          <Field label="Your name (required)">
            <input value={form.reviewer} onChange={set("reviewer")} maxLength={120} className={INPUT} />
          </Field>
          {form.decision === "accepted" ? (
            <>
              <Field label="Basis (required)">
                <select value={form.basis} onChange={set("basis")} className={INPUT}>
                  <option value="">Choose…</option>
                  {REVIEW_BASES.map((b) => (
                    <option key={b} value={b}>
                      {b.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Comparability (required)">
                <select value={form.comparability} onChange={set("comparability")} className={INPUT}>
                  <option value="">Choose…</option>
                  {COMPARABILITIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Region">
                <input value={form.region} onChange={set("region")} maxLength={80} className={INPUT} />
              </Field>
              <Field label="Also covers cost keys (comma separated)">
                <input value={form.includes} onChange={set("includes")} className={INPUT} />
              </Field>
            </>
          ) : null}
          <Field label="Reason">
            <input value={form.reason} onChange={set("reason")} maxLength={500} className={INPUT} />
          </Field>
          <button type="submit" disabled={busy} className={`${BTN} sm:col-span-2`}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {form.decision === "accepted" ? "Accept this quotation" : "Reject this quotation"}
          </button>
        </form>
      ) : null}
    </li>
  );
}

const INPUT = "mt-1 block w-full rounded border border-line bg-transparent px-2 py-1 text-sm text-ghost";
const BTN =
  "inline-flex items-center justify-center gap-2 rounded border border-power/60 px-3 py-1.5 text-xs font-semibold text-power hover:bg-power/10 disabled:opacity-60";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="inline text-faint">{k}: </dt>
      <dd className="inline">{children}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-faint">
      {label}
      {children}
    </label>
  );
}

function specificationLine(s: Record<string, unknown> | null): string {
  if (!s) return "—";
  const parts = [s.project, s.hall, s.constraint, s.sized_for_racks != null ? `sized for ${s.sized_for_racks} racks` : null];
  return parts.filter((p) => p !== undefined && p !== null && p !== "").join(" · ") || "—";
}
