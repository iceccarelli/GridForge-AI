"use client";

import React, { useId, useState } from "react";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import type { ActualItem, EvidenceRef, ObservationItem } from "@/lib/project-review-queue";
import {
  SELF_REVIEW_MESSAGE,
  actualReviewBody,
  isSelfReview,
  observationReviewBody,
  reviewProblems,
  reviewUrl,
  type Decision,
} from "@/lib/project-review-ui";

/**
 * The administrator's queue of project observations and supplier delivery records awaiting a human decision.
 *
 * It lists only what has not been decided, one record at a time, each beside the evidence file it cites. There is no bulk action
 * and no default decision: the reviewer picks verify or reject, names themselves and gives a reason. Every decision goes through the
 * existing admin routes, which check the admin cookie and refuse cross-site writes on each call, and the database enforces the
 * rest (one decision per record, never the submitter, never verified on an unverified file). This screen never marks anything
 * verified by itself.
 */

type Done = { id: string; decision: Decision; reviewer: string };

const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + "Z";
};
const field = "min-h-11 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ghost focus:border-power/60 focus:outline-none focus:ring-2 focus:ring-power/60";

export function ProjectEvidenceReview({
  observations,
  actuals,
  reviewClass,
  initialError,
}: {
  observations: ObservationItem[];
  actuals: ActualItem[];
  /** The one evidence class a reviewer may assign to a measured observation (lib/project-observations.ts REVIEW_CLASS). */
  reviewClass: string;
  initialError?: string | null;
}) {
  const [done, setDone] = useState<Done[]>([]);
  const decided = new Set(done.map((d) => d.id));
  const pendingObs = observations.filter((o) => !decided.has(o.id));
  const pendingAct = actuals.filter((a) => !decided.has(a.id));

  return (
    <div className="grid gap-10">
      {initialError ? (
        <div role="alert" className="flex gap-3 rounded border border-flag/40 bg-flag/10 p-3 text-sm text-ghost">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-flag" />
          <p>{initialError}</p>
        </div>
      ) : null}

      {done.length ? (
        <div role="status" aria-live="polite" className="rounded border border-line bg-panel-2 p-3 text-sm text-mute">
          {done.map((d) => (
            <p key={d.id} className="flex items-start gap-2">
              <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-verified" />
              <span>
                Recorded: {d.decision} by {d.reviewer}. It is final and no longer in this queue.
              </span>
            </p>
          ))}
        </div>
      ) : null}

      {initialError ? null : (
      <>
      <section aria-labelledby="obs-h">
        <h2 id="obs-h" className="text-sm font-semibold text-ghost">
          Measured observations awaiting a decision ({pendingObs.length})
        </h2>
        <p className="mt-1 max-w-3xl text-xs text-faint">
          A person reports what a delivered system actually delivered, against the prediction it was built on. Verifying assigns class{" "}
          {reviewClass} (the only class a reviewer assigns) and adds nothing to the calibration ledger: importing a verified observation into
          it is a separate, deliberate step.
        </p>
        <div className="mt-4 grid gap-4">
          {pendingObs.length === 0 ? <p className="text-sm text-mute">Nothing is awaiting a decision.</p> : null}
          {pendingObs.map((o) => (
            <Card key={o.id} item={o} onDone={(d) => setDone((x) => [...x, d])} reviewClass={reviewClass} />
          ))}
        </div>
      </section>

      <section aria-labelledby="act-h">
        <h2 id="act-h" className="text-sm font-semibold text-ghost">
          Supplier delivery records awaiting a decision ({pendingAct.length})
        </h2>
        <p className="mt-1 max-w-3xl text-xs text-faint">
          What a selected supplier actually did, against what it quoted. Verifying names exactly which facts you vouch for. It changes no
          cost, ranking or calibration figure.
        </p>
        <div className="mt-4 grid gap-4">
          {pendingAct.length === 0 ? <p className="text-sm text-mute">Nothing is awaiting a decision.</p> : null}
          {pendingAct.map((a) => (
            <Card key={a.id} item={a} onDone={(d) => setDone((x) => [...x, d])} reviewClass={reviewClass} />
          ))}
        </div>
      </section>
      </>
      )}
    </div>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-faint">{k}</dt>
      <dd className="min-w-0 break-words text-ghost">{v}</dd>
    </>
  );
}

function EvidenceBlock({ e }: { e: EvidenceRef | null }) {
  if (!e) return <p className="text-sm text-flag">The evidence file this cites could not be found.</p>;
  return (
    <div className="rounded border border-line bg-ink/40 p-3 text-sm">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Evidence file</p>
      <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-[9rem_1fr]">
        <Fact k="File" v={e.filename} />
        <Fact k="Type · size" v={`${e.media_type} · ${fmtBytes(e.byte_size)}`} />
        <Fact k="SHA-256" v={<span className="font-mono text-xs break-all">{e.sha256}</span>} />
        <Fact k="Category" v={e.source_category.replace(/_/g, " ")} />
        <Fact k="File status" v={e.review_status} />
      </dl>
      {e.review_status !== "verified" ? (
        <p className="mt-2 text-xs text-mute">
          This file is still unverified. The database refuses to verify a record whose file is unverified, and no screen in this system marks
          a file verified, so a verify attempt will be refused for now; rejecting is always possible.
        </p>
      ) : null}
    </div>
  );
}

function Card({ item, onDone, reviewClass }: { item: ObservationItem | ActualItem; onDone: (d: Done) => void; reviewClass: string }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<Decision | "">("");
  const [reviewer, setReviewer] = useState("");
  const [reason, setReason] = useState("");
  const [facts, setFacts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isObs = item.kind === "observation";
  const self = isSelfReview(reviewer, item.submitted_by);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!decision) {
      setError("Choose verify or reject.");
      return;
    }
    const input = { decision, reviewer, reason };
    const problems = reviewProblems(input, item.submitted_by, { factsChosen: isObs ? undefined : facts.length });
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    const body = item.kind === "observation" ? observationReviewBody(input, reviewClass) : actualReviewBody(input, facts);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(reviewUrl(item.kind, item.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok || !b.ok) {
        setError(res.status === 401 ? "Your admin session has ended. Sign in again; nothing was recorded." : b?.error ?? "The decision could not be saved. Nothing was recorded.");
        return;
      }
      onDone({ id: item.id, decision, reviewer: reviewer.trim() });
    } catch {
      setError("Could not reach the server. Nothing was recorded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded border border-line bg-panel-2 p-4" aria-labelledby={`${uid}-t`}>
      <h3 id={`${uid}-t`} className="text-sm font-semibold text-ghost">
        {item.kind === "observation" ? `${item.metric} · ${item.architecture}` : `${item.supplier} · ${item.architecture}`}
      </h3>
      <p className="mt-0.5 text-xs text-faint">
        {item.project ? `${item.project.name}${item.project.site ? ` · ${item.project.site}` : ""}${item.project.company ? ` · ${item.project.company}` : ""}` : "Project not found"}
        {" · "}submitted by {item.submitted_by} on {when(item.submitted_at)}
      </p>

      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">
        {item.kind === "observation" ? (
          <>
            <Fact k="Predicted" v={`${item.predicted_value} ${item.unit}`} />
            <Fact k="Reported as observed" v={`${item.observed_value} ${item.unit} (${item.delta_pct >= 0 ? "+" : ""}${item.delta_pct.toFixed(1)}%) on ${item.observed_on}`} />
            <Fact k="Measurement kind" v={item.measurement_kind ?? "not stated"} />
            <Fact k="Method" v={item.method} />
            <Fact k="Basis it is installed" v={item.installed_basis} />
            {item.note ? <Fact k="Note" v={item.note} /> : null}
          </>
        ) : (
          <>
            {item.facts.map((f) => (
              <Fact key={f.field} k={f.field.replace(/_/g, " ")} v={f.value} />
            ))}
            {item.actual_cost_currency ? <Fact k="Cost currency" v={item.actual_cost_currency} /> : null}
            {item.cost_scope ? <Fact k="Cost scope vs quote" v={`${item.cost_scope.replace(/_/g, " ")}${item.cost_scope_note ? `: ${item.cost_scope_note}` : ""}`} /> : null}
            <Fact k="Quoted capex" v={item.quoted_capex_eur === null ? "not quoted" : `EUR ${item.quoted_capex_eur}`} />
            <Fact k="Method" v={item.method} />
            {item.corrects_earlier_record ? <Fact k="Correction" v="replaces an earlier record" /> : null}
            {item.note ? <Fact k="Note" v={item.note} /> : null}
          </>
        )}
      </dl>

      <div className="mt-3">
        <EvidenceBlock e={item.evidence} />
      </div>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="mt-3 inline-flex min-h-11 items-center rounded border border-power/60 px-4 py-2 text-sm font-semibold text-power hover:bg-power/10 focus:outline-none focus:ring-2 focus:ring-power/60"
        >
          Review this {isObs ? "observation" : "record"}
        </button>
      ) : (
        <form onSubmit={submit} className="mt-4 grid gap-3 border-t border-line pt-4" noValidate>
          <fieldset className="grid gap-2">
            <legend className="text-xs text-faint">Decision (final: recorded once and not changeable)</legend>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ghost">
              <input type="radio" name={`${uid}-d`} checked={decision === "verified"} onChange={() => setDecision("verified")} />
              Verify{isObs ? ` — assign class ${reviewClass}` : ""}
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ghost">
              <input type="radio" name={`${uid}-d`} checked={decision === "rejected"} onChange={() => setDecision("rejected")} />
              Reject{isObs ? " — carries no class" : " — verifies nothing"}
            </label>
          </fieldset>

          {item.kind === "actual" && decision === "verified" ? (
            <fieldset className="grid gap-1">
              <legend className="text-xs text-faint">The facts you vouch for (only facts this record supplies)</legend>
              {item.facts.map((f) => (
                <label key={f.field} className="flex min-h-11 items-center gap-2 text-sm text-ghost">
                  <input
                    type="checkbox"
                    checked={facts.includes(f.field)}
                    onChange={(e) => setFacts((x) => (e.target.checked ? [...x, f.field] : x.filter((y) => y !== f.field)))}
                  />
                  {f.field.replace(/_/g, " ")} ({f.value})
                </label>
              ))}
            </fieldset>
          ) : null}

          <div>
            <label htmlFor={`${uid}-who`} className="text-xs text-faint">Your name (the person taking this decision)</label>
            <input id={`${uid}-who`} className={field} value={reviewer} onChange={(e) => setReviewer(e.target.value)} maxLength={120} autoComplete="name" aria-describedby={self ? `${uid}-self` : undefined} />
            <p className="mt-1 text-[11px] text-faint">
              Self-declared: the admin console has one shared password, so this is the name you type, recorded as typed.
            </p>
            {self ? (
              <p id={`${uid}-self`} role="alert" className="mt-1 text-xs text-flag">
                {SELF_REVIEW_MESSAGE}
              </p>
            ) : null}
          </div>
          <div>
            <label htmlFor={`${uid}-why`} className="text-xs text-faint">Reason (required, up to 500 characters)</label>
            <textarea id={`${uid}-why`} className={`${field} min-h-24`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </div>

          {error ? (
            <p role="alert" className="flex gap-2 text-sm text-flag">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy || self}
              className="inline-flex min-h-11 items-center gap-2 rounded bg-power px-5 py-2 text-sm font-semibold text-ink focus:outline-none focus:ring-2 focus:ring-power/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {busy ? "Recording" : "Record decision"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="inline-flex min-h-11 items-center rounded border border-line px-4 py-2 text-sm text-mute">
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
