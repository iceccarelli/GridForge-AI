"use client";

// The administrator's gate for supplier quotations a project holder attached to an uploaded document (migration 0054).
//
// Two decisions, in this order, each made once by a named person:
//   1. VERIFY THE FILE (the "Verify file" section above: the server reads the stored bytes back and checks the SHA-256 against the digest
//      recorded at upload).
//   2. ACCEPT or REJECT THE RECORD here: what the project holder says the document quotes. Accepting is offered only on a verified file, and the
//      database refuses it otherwise; this screen only declines to offer what the server would refuse.
// The quotation's claims are shown beside the file's name, type, size and digest and its standing. A storage path is never shown. The reviewer
// name is the text typed under one shared admin password: recorded as typed, not an authenticated identity. Decisions are final.

import { useId, useState } from "react";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import type { ClaimView } from "@/lib/project-quotation-claims";
import { COMPARABILITIES, REVIEW_BASES, reviewBody, type ReviewForm } from "@/lib/evidence-review";
import { QUOTE_TYPE_LABEL, basisLabel, NO_EQUIPMENT_STATEMENT } from "@/lib/cost-evidence-claims";

export type QueuedClaim = ClaimView & { project_id: string };

const eur = new Intl.NumberFormat("en-IE", { maximumFractionDigits: 2 });
const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const field = "min-h-11 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ghost focus:border-power/60 focus:outline-none focus:ring-2 focus:ring-power/60";

/** Whether the accept control is offered, and if not, why. The server enforces the same rule (GF009) whatever this says. */
export function acceptGate(c: Pick<QueuedClaim, "state" | "valid_until" | "file">, fileDecidedHere: "verified" | "rejected" | undefined, today = new Date().toISOString().slice(0, 10)): { accept: boolean; reason: string | null } {
  if (c.state !== "validated") return { accept: false, reason: null };
  if (c.valid_until && c.valid_until < today) return { accept: false, reason: `Expired on ${c.valid_until}: it can be rejected but not accepted.` };
  if (c.file.review_status === "rejected" || fileDecidedHere === "rejected") return { accept: false, reason: "Its file was rejected, so the quotation cannot be accepted." };
  if (c.file.hash_confirmed || fileDecidedHere === "verified") return { accept: true, reason: null };
  return { accept: false, reason: "Its file has not been verified yet. Verify the file in the section above, then accept the quotation." };
}

export function QuotationReview({
  items,
  decidedFiles = {},
  initialError,
  more = 0,
  moreIsLowerBound = false,
}: {
  items: QueuedClaim[];
  /** Files decided in this browser session (id -> decision), so the gate follows a verification made just above without a reload. */
  decidedFiles?: Record<string, "verified" | "rejected">;
  initialError?: string | null;
  /** How many further pending quotations the queue holds beyond the page shown (the oldest are shown first). */
  more?: number;
  moreIsLowerBound?: boolean;
}) {
  const [decided, setDecided] = useState<Record<string, { decision: "accepted" | "rejected"; reviewer: string }>>({});
  const pending = items.filter((c) => c.state === "validated" && !decided[c.id]);
  return (
    <section aria-labelledby="quot-h" data-testid="quotation-review">
      <h2 id="quot-h" className="text-sm font-semibold text-ghost">Verify supplier quotations ({pending.length})</h2>
      <p className="mt-1 max-w-3xl text-xs text-faint">
        A project holder attached a supplier quotation to an uploaded document and stated what it says. Until a person has verified the file and accepted
        the record, it changes no number anywhere. Accepting also says what kind of quotation it is, which sets the cost basis the engine applies; nothing
        is inferred from the holder&apos;s claim. {NO_EQUIPMENT_STATEMENT}
      </p>
      <p className="mt-1 max-w-3xl text-xs text-faint">
        The name you type is recorded as typed. The admin console has one shared password, so it is not an authenticated identity. Each decision is
        final: a rejected record stays rejected and a better quotation is submitted and accepted afresh.
      </p>
      {initialError ? (
        <div role="alert" className="mt-3 flex gap-3 rounded border border-flag/40 bg-flag/10 p-3 text-sm text-ghost">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-flag" aria-hidden />
          <p>{initialError}</p>
        </div>
      ) : null}
      {Object.entries(decided).length ? (
        <div role="status" aria-live="polite" className="mt-3 rounded border border-line bg-panel-2 p-3 text-sm text-mute">
          {Object.entries(decided).map(([id, d]) => (
            <p key={id} className="flex items-start gap-2">
              <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-verified" aria-hidden />
              <span>Recorded: quotation {d.decision} by {d.reviewer}. It is final and no longer in this queue.</span>
            </p>
          ))}
        </div>
      ) : null}
      {more > 0 ? (
        <p role="note" className="mt-3 text-xs text-mute" data-testid="queue-more">
          {moreIsLowerBound ? "At least " : ""}{more} more pending quotation{more === 1 ? " is" : "s are"} not shown. The oldest are shown first; decide these, then reload to bring in the next ones.
        </p>
      ) : null}
      <div className="mt-4 grid gap-4">
        {!initialError && pending.length === 0 ? <p className="text-sm text-mute">No supplier quotation is awaiting a decision.</p> : null}
        {pending.map((c) => (
          <ClaimCard key={c.id} item={c} fileDecidedHere={decidedFiles[c.file.id]} onDone={(d) => setDecided((x) => ({ ...x, [c.id]: d }))} />
        ))}
      </div>
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="inline text-faint">{k}: </dt>
      <dd className="inline break-words">{children}</dd>
    </div>
  );
}

function ClaimCard({ item: c, fileDecidedHere, onDone }: { item: QueuedClaim; fileDecidedHere: "verified" | "rejected" | undefined; onDone: (d: { decision: "accepted" | "rejected"; reviewer: string }) => void }) {
  const uid = useId();
  const gate = acceptGate(c, fileDecidedHere);
  const [form, setForm] = useState<ReviewForm>({ decision: "rejected", reviewer: "", basis: c.suggested_basis, comparability: c.comparability, region: "", includes: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof ReviewForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const decision = gate.accept ? form.decision : "rejected";

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const built = reviewBody({ ...form, decision });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/admin/cost-evidence/${encodeURIComponent(c.id)}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(built.body) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || !b.ok) {
        setError(b?.error ?? "The decision could not be saved. Nothing was recorded.");
        return;
      }
      onDone({ decision, reviewer: form.reviewer.trim() });
    } catch {
      setError("Could not reach the server. Nothing was recorded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded border border-line bg-panel-2 p-4 text-sm" data-claim-id={c.id} data-file-status={c.file.review_status} aria-labelledby={`${uid}-t`}>
      <h3 id={`${uid}-t`} className="break-words text-ghost">
        {c.supplier} <span className="text-xs text-faint">· {c.item}</span>
      </h3>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-mute sm:grid-cols-2">
        <Row k="Price">€{eur.format(c.price_eur)} {c.unit === "EUR" ? "lump sum" : `per ${c.unit.slice(4)}`}{c.quoted_quantity !== null ? ` covering ${c.quoted_quantity} ${c.quoted_quantity_unit ?? ""}` : ""}</Row>
        <Row k="Claimed kind">{QUOTE_TYPE_LABEL[c.quote_type]}</Row>
        <Row k="Quoted on">{c.quoted_on ?? "—"}</Row>
        <Row k="Valid until">{c.valid_until ?? "—"}</Row>
        <Row k="Lead time quoted">{c.lead_time_weeks === null ? "not stated" : `${c.lead_time_weeks} weeks (the submitter's claim; the engine's cost overlay does not use it)`}</Row>
        <Row k="Reference">{c.reference || "—"}</Row>
        <Row k="Covers">{c.scope}</Row>
        <Row k="Comparability">{c.comparability}{c.limitations.length ? ` · ${c.limitations.join(" ")}` : ""}</Row>
        <Row k="Submitted by">{c.submitted_by} (as typed) on {c.submitted_at.slice(0, 10)}</Row>
        <Row k="Project">{c.project_id}</Row>
      </dl>
      {c.notes ? <p className="mt-2 whitespace-pre-wrap break-words text-xs text-mute">Notes: {c.notes}</p> : null}

      <div className="mt-3 rounded border border-line p-3 text-xs text-mute" data-testid="claim-file">
        <p className="text-ghost break-words">Document: {c.file.filename}</p>
        <p className="mt-1 break-words">{c.file.media_type} · {fmtBytes(c.file.byte_size)} · SHA-256 <span className="font-mono break-all">{c.file.sha256}</span></p>
        <p className="mt-1">
          Standing: <strong className={c.file.hash_confirmed || fileDecidedHere === "verified" ? "text-verified" : "text-queue"}>{fileDecidedHere === "verified" ? "verified just now (reload to confirm)" : c.file.status_text}</strong>
          {c.file.hash_confirmed ? " · the confirmed digest equals the one recorded at upload" : ""}
        </p>
      </div>

      <form onSubmit={send} className="mt-3 grid gap-3 sm:grid-cols-2" aria-busy={busy}>
        {gate.reason ? <p className="text-xs text-queue sm:col-span-2" data-testid="gate-reason">{gate.reason}</p> : null}
        <div>
          <label htmlFor={`${uid}-d`} className="mb-1 block text-xs text-faint">Decision</label>
          <select id={`${uid}-d`} value={decision} onChange={set("decision")} className={field}>
            {gate.accept ? <option value="accepted">Accept this quotation</option> : null}
            <option value="rejected">Reject this quotation</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-r`} className="mb-1 block text-xs text-faint">Your name (required, recorded as typed)</label>
          <input id={`${uid}-r`} value={form.reviewer} onChange={set("reviewer")} maxLength={120} className={field} autoComplete="off" />
        </div>
        {decision === "accepted" ? (
          <>
            <div>
              <label htmlFor={`${uid}-b`} className="mb-1 block text-xs text-faint">Basis the engine applies</label>
              <select id={`${uid}-b`} value={form.basis} onChange={set("basis")} className={field}>
                {REVIEW_BASES.map((b) => (<option key={b} value={b}>{basisLabel(b)}</option>))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-c`} className="mb-1 block text-xs text-faint">Comparability</label>
              <select id={`${uid}-c`} value={form.comparability} onChange={set("comparability")} className={field}>
                {COMPARABILITIES.map((x) => (<option key={x} value={x}>{x}</option>))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-g`} className="mb-1 block text-xs text-faint">Region (optional)</label>
              <input id={`${uid}-g`} value={form.region} onChange={set("region")} maxLength={80} className={field} />
            </div>
            <div>
              <label htmlFor={`${uid}-i`} className="mb-1 block text-xs text-faint">Also covers cost keys (comma separated, optional)</label>
              <input id={`${uid}-i`} value={form.includes} onChange={set("includes")} className={field} />
            </div>
          </>
        ) : null}
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-x`} className="mb-1 block text-xs text-faint">Reason</label>
          <input id={`${uid}-x`} value={form.reason} onChange={set("reason")} maxLength={500} className={field} />
        </div>
        <div className="sm:col-span-2">
          <button type="submit" disabled={busy} className="btn-secondary inline-flex min-h-11 items-center gap-2 px-4 py-2 text-sm disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {decision === "accepted" ? "Accept this quotation" : "Reject this quotation"}
          </button>
          {error ? <p role="alert" className="mt-2 text-xs text-flag">{error}</p> : null}
        </div>
      </form>
    </article>
  );
}
