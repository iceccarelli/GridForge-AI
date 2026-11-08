"use client";

import React, { useId, useState } from "react";
import { CircleAlert, CircleCheck, CircleHelp, CircleX, Loader2 } from "lucide-react";
import { STATUS_LABEL, blockingGates, type GateResult } from "@/lib/calibration-gates";
import type { ActualItem, EvidenceRef, FileItem, ObservationItem, QueueCount, VerifiedItem } from "@/lib/project-review-queue";
import { QuotationReview, type QueuedClaim } from "@/components/QuotationReview";
import {
  ALREADY_REVIEWED,
  SELF_REVIEW_MESSAGE,
  actualReviewBody,
  fileReviewBody,
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
 * verified by itself. The "Verify file" section decides the uploaded FILES themselves: verifying one makes the server read the stored
 * file back and check its SHA-256 against the digest recorded at upload; this screen never sends a digest.
 */

/** `already`: the server said someone else had already decided it; nothing was recorded by this reviewer. */
type Done = { id: string; decision: Decision | null; reviewer: string; already?: boolean };

/** "Showing N of M": said whenever the screen is not showing everything awaiting a decision. */
function CountNote({ c, decidedHere }: { c: QueueCount; decidedHere: number }) {
  const left = Math.max(0, c.pending - decidedHere);
  if (left <= c.shown - decidedHere && !c.truncated) return null;
  return (
    <p className="mt-2 text-xs text-mute" role="note">
      Showing {Math.max(0, c.shown - decidedHere)} of {c.truncated ? `at least ${left}` : left} awaiting a decision, newest first.
      Decide these, then reload to bring in the next ones.
      {c.truncated ? " Only the newest records were examined; older ones are not counted here." : ""}
    </p>
  );
}

const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + "Z";
};
/** Mirrors VERIFIED_SHOW_MAX in lib/project-review-queue.ts (a server module this client component must not import); a test pins them equal. */
export const VERIFIED_SHOWN = 50;
/** Mirrors VERIFIED_SCAN in lib/project-review-queue.ts. */
export const VERIFIED_SCAN = 100;
const field = "min-h-11 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ghost focus:border-power/60 focus:outline-none focus:ring-2 focus:ring-power/60";

export function ProjectEvidenceReview({
  observations,
  actuals,
  files = [],
  verified,
  reviewClass,
  initialError,
  counts,
  quotations,
  quotationsError,
}: {
  observations: ObservationItem[];
  actuals: ActualItem[];
  /** Uploaded files nobody has decided on yet (lib/project-review-queue.ts pendingFiles). */
  files?: FileItem[];
  counts?: { observations: QueueCount; actuals: QueueCount; files?: QueueCount };
  /** Observations already verified, with their export checklist. `null`: they could not be read. Undefined: not supplied, section hidden. */
  verified?: VerifiedItem[] | null;
  /** The one evidence class a reviewer may assign to a measured observation (lib/project-observations.ts REVIEW_CLASS). */
  reviewClass: string;
  initialError?: string | null;
  /** Supplier quotations a project holder attached to an uploaded file, awaiting the reviewer (lib/project-quotation-claims.ts claimQueue). Undefined: section hidden. */
  quotations?: QueuedClaim[];
  /** Why the quotations could not be read, if they could not (shown instead of an empty queue). */
  quotationsError?: string | null;
}) {
  const [done, setDone] = useState<Done[]>([]);
  const decided = new Set(done.map((d) => d.id));
  const pendingObs = observations.filter((o) => !decided.has(o.id));
  const pendingAct = actuals.filter((a) => !decided.has(a.id));
  const decidedObs = observations.length - pendingObs.length;
  const decidedAct = actuals.length - pendingAct.length;
  const pendingFil = files.filter((f) => !decided.has(f.id));
  const decidedFil = files.length - pendingFil.length;

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
                {d.already
                  ? "This record had already been decided by someone else, so nothing was recorded from you. It has been removed from your queue."
                  : `Recorded: ${d.decision} by ${d.reviewer}. It is final and no longer in this queue.`}
              </span>
            </p>
          ))}
        </div>
      ) : null}

      {initialError ? null : (
      <>
      <section aria-labelledby="file-h">
        <h2 id="file-h" className="text-sm font-semibold text-ghost">
          Verify file ({pendingFil.length})
        </h2>
        <p className="mt-1 max-w-3xl text-xs text-faint">
          An uploaded file is unverified until a person decides on it. Verifying makes the server read the stored file back and check that
          its SHA-256 still equals the one recorded at upload; a file that no longer matches cannot be verified. That check establishes one
          thing: the stored bytes are unchanged since upload. This screen does not open the file and the system never reads or interprets its
          contents, so by verifying you vouch, on what you know of its source (the name, type, size and digest shown), that it is the document
          it claims to be. An observation can be verified only against a verified file. Each file is decided once, with a name and a reason,
          and the decision cannot be changed: there is no way to withdraw a mistaken verdict. There is no bulk action.
        </p>
        <p className="mt-1 max-w-3xl text-xs text-faint">
          The name you type is recorded as typed. The admin console has one shared password, so it is not an authenticated identity.
        </p>
        {counts?.files ? <CountNote c={counts.files} decidedHere={decidedFil} /> : null}
        <div className="mt-4 grid gap-4">
          {pendingFil.length === 0 ? <p className="text-sm text-mute">No file is awaiting a decision.</p> : null}
          {pendingFil.map((f) => (
            <FileCard key={f.id} item={f} onDone={(d) => setDone((x) => [...x, d])} />
          ))}
        </div>
      </section>

      {quotations === undefined && !quotationsError ? null : (
        <QuotationReview
          items={quotations ?? []}
          initialError={quotationsError}
          decidedFiles={Object.fromEntries(done.filter((d) => d.decision).map((d) => [d.id, d.decision as "verified" | "rejected"]))}
        />
      )}

      <section aria-labelledby="obs-h">
        <h2 id="obs-h" className="text-sm font-semibold text-ghost">
          Measured observations awaiting a decision ({pendingObs.length})
        </h2>
        <p className="mt-1 max-w-3xl text-xs text-faint">
          A person reports what a delivered system actually delivered, against the prediction it was built on. Verifying assigns class{" "}
          {reviewClass} (the only class a reviewer assigns) and adds nothing to the calibration ledger: importing a verified observation into
          it is a separate, deliberate step.
        </p>
        {counts ? <CountNote c={counts.observations} decidedHere={decidedObs} /> : null}
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
        {counts ? <CountNote c={counts.actuals} decidedHere={decidedAct} /> : null}
        <div className="mt-4 grid gap-4">
          {pendingAct.length === 0 ? <p className="text-sm text-mute">Nothing is awaiting a decision.</p> : null}
          {pendingAct.map((a) => (
            <Card key={a.id} item={a} onDone={(d) => setDone((x) => [...x, d])} reviewClass={reviewClass} />
          ))}
        </div>
      </section>

      {verified === undefined ? null : (
        <section aria-labelledby="ver-h">
          <h2 id="ver-h" className="text-sm font-semibold text-ghost">
            Verified observations: what still blocks the export {verified ? `(${verified.length})` : ""}
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-faint">
            Read-only. The calibration export view applies every gate listed on each record; a verification alone does not make a row
            exportable. Each gate is read from its own record: one that could not be read is shown as such and never as met. Nothing here
            imports anything, and the export view, not this list, decides. Among the {VERIFIED_SCAN} most recently submitted observations, the {VERIFIED_SHOWN} most recently verified are shown.
          </p>
          <div className="mt-4 grid gap-4">
            {verified === null ? (
              <p role="alert" className="text-sm text-flag">The verified observations could not be read, so no checklist is shown.</p>
            ) : verified.length === 0 ? (
              <p className="text-sm text-mute">None among the {VERIFIED_SCAN} most recently submitted observations.</p>
            ) : (
              verified.map((v) => <VerifiedCard key={v.id} item={v} />)
            )}
          </div>
        </section>
      )}
      </>
      )}
    </div>
  );
}

const STATUS_ICON = {
  met: <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-verified" />,
  not_met: <CircleX aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-flag" />,
  unreadable: <CircleHelp aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-mute" />,
} as const;

/**
 * The one-line summary. "Every gate" is said only when nothing was checked in part: the forecast's digest and predicted value are
 * recomputed by the export view alone (the digest is over Postgres's own jsonb text, which cannot be reproduced faithfully from the
 * JSON PostgREST returns), so a forecast gate that passes here is never a full pass.
 */
export function headline(gates: readonly GateResult[], blocking: readonly GateResult[]): string {
  if (blocking.length > 0) return `Export gates: ${blocking.length} of ${gates.length} blocking the export`;
  if (gates.some((g) => g.partial)) return "No gate blocks here; the forecast digest and predicted value are checked only by the export view.";
  return "Export gates: every gate read and met here (the export view still decides)";
}

/**
 * Every gate the calibration export view enforces, for one observation: met, not met or cannot be read, with the reason. The status is
 * written out as a word as well as shown by an icon. A gate that could not be read is a blocker, like one that is not met.
 */
export function GateChecklist({ gates, label }: { gates: readonly GateResult[]; label: string }) {
  const blocking = blockingGates(gates);
  return (
    <details open className="rounded border border-line bg-ink/40 p-3 text-sm">
      <summary className="cursor-pointer text-xs font-semibold text-ghost focus:outline-none focus:ring-2 focus:ring-power/60">
        {headline(gates, blocking)}
      </summary>
      <ul aria-label={label} className="mt-2 grid gap-2">
        {gates.map((g) => (
          <li key={g.id} className="flex gap-2">
            {STATUS_ICON[g.status]}
            <span className="min-w-0">
              <span className="text-ghost">{g.title}</span>
              <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
                {STATUS_LABEL[g.status]}
                {g.partial ? " · checked in part" : ""}
              </span>
              <span className="block text-xs text-mute">{g.reason}</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function VerifiedCard({ item }: { item: VerifiedItem }) {
  const uid = useId();
  return (
    <article className="rounded border border-line bg-panel-2 p-4" aria-labelledby={`${uid}-t`}>
      <h3 id={`${uid}-t`} className="text-sm font-semibold text-ghost">
        {item.metric} · {item.architecture}
      </h3>
      <p className="mt-0.5 text-xs text-faint">
        {item.project ? `${item.project.name}${item.project.site ? ` · ${item.project.site}` : ""}${item.project.company ? ` · ${item.project.company}` : ""}` : "Project not found"}
        {" · "}predicted {item.predicted_value} {item.unit}, reported {item.observed_value} {item.unit} on {item.observed_on}
      </p>
      <p className="mt-0.5 text-xs text-faint">
        Verified as {item.review.evidence_class ?? "no class"} by {item.review.reviewer} (a typed name) on {when(item.review.reviewed_at)}
      </p>
      <div className="mt-3">
        {item.gates ? <GateChecklist gates={item.gates} label="Export gates" /> : <p className="text-sm text-mute">The export gates were not read for this record.</p>}
      </div>
    </article>
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
          This file is still unverified. The database refuses to verify a record whose file is unverified, so decide the file first (the
          "Verify file" section above); rejecting a record is always possible.
        </p>
      ) : null}
    </div>
  );
}

/** The one request this screen makes: a decision, posted to the route that owns it. Every card goes through here. */
async function postDecision(url: string, payload: Record<string, unknown>): Promise<{ status: number; ok: boolean; body: any }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) };
}

function FileCard({ item, onDone }: { item: FileItem; onDone: (d: Done) => void }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<Decision | "">("");
  const [reviewer, setReviewer] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!decision) {
      setError("Choose verify or reject.");
      return;
    }
    const input = { decision, reviewer, reason };
    // A file has no submitter to compare with: the project token holder is not a named person.
    const problems = reviewProblems(input, "");
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await postDecision(reviewUrl("file", item.id), fileReviewBody(input));
      const b = res.body;
      if (res.status === 409 && ALREADY_REVIEWED.test(String(b?.error ?? ""))) {
        onDone({ id: item.id, decision: null, reviewer: reviewer.trim(), already: true });
        return;
      }
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
        {item.filename}
      </h3>
      <p className="mt-0.5 text-xs text-faint">
        {item.project ? `${item.project.name}${item.project.site ? ` · ${item.project.site}` : ""}${item.project.company ? ` · ${item.project.company}` : ""}` : "Project not found"}
        {" · "}uploaded {when(item.uploaded_at)}
      </p>
      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">
        <Fact k="Type · size" v={`${item.media_type} · ${fmtBytes(item.byte_size)}`} />
        <Fact k="SHA-256 at upload" v={<span className="font-mono text-xs break-all">{item.sha256}</span>} />
        <Fact k="Category" v={item.source_category.replace(/_/g, " ")} />
        {item.note ? <Fact k="Note" v={item.note} /> : null}
      </dl>
      <p className="mt-2 text-xs text-faint">
        Calibration export: an observation citing this file reaches the export only while this file has a decision of verified. A
        rejected or undecided file keeps it out, and the decision cannot be changed.
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="mt-3 inline-flex min-h-11 items-center rounded border border-power/60 px-4 py-2 text-sm font-semibold text-power hover:bg-power/10 focus:outline-none focus:ring-2 focus:ring-power/60"
        >
          Review this file
        </button>
      ) : (
        <form onSubmit={submit} className="mt-4 grid gap-3 border-t border-line pt-4" noValidate>
          <fieldset className="grid gap-2">
            <legend className="text-xs text-faint">Decision (final: recorded once and not changeable)</legend>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ghost">
              <input type="radio" name={`${uid}-d`} checked={decision === "verified"} onChange={() => setDecision("verified")} />
              Verify — the server checks the stored bytes still match the digest from upload, and I vouch for what the file is
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ghost">
              <input type="radio" name={`${uid}-d`} checked={decision === "rejected"} onChange={() => setDecision("rejected")} />
              Reject — I do not vouch for this file, or it cannot be relied on
            </label>
          </fieldset>
          <div>
            <label htmlFor={`${uid}-who`} className="text-xs text-faint">Your name (the person taking this decision)</label>
            <input id={`${uid}-who`} className={field} value={reviewer} onChange={(e) => setReviewer(e.target.value)} maxLength={120} autoComplete="name" />
            <p className="mt-1 text-[11px] text-faint">
              Self-declared: the admin console has one shared password, so this is the name you type, recorded as typed.
            </p>
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
              disabled={busy}
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
      const res = await postDecision(reviewUrl(item.kind, item.id), body);
      const b = res.body;
      if (res.status === 409 && ALREADY_REVIEWED.test(String(b?.error ?? ""))) {
        // Decided elsewhere (another reviewer or tab): this card is stale. Drop it with an honest message; nothing was recorded here.
        onDone({ id: item.id, decision: null, reviewer: reviewer.trim(), already: true });
        return;
      }
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

      {item.kind === "observation" && item.gates ? (
        <div className="mt-3">
          <GateChecklist gates={item.gates} label="Export gates" />
        </div>
      ) : null}

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
