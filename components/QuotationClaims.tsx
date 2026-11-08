"use client";

// Supplier quotations the OWNER of a project holds, recorded beside the uploaded document and listed with where each stands.
//
//   1. attach the quotation document (the existing project evidence upload; stored unverified)
//   2. record what it says (price, unit, supplier, dates, lead time, scope) -> stored UNVERIFIED and NOT COUNTED
//   3. a reviewer verifies the file and accepts the record; only then is it handed to the engine
//
// This screen sells nothing and quotes nothing: the quotations are the customer's own, from their own suppliers. It never shows a storage path,
// never offers a control that sets a state, and says "not yet counted" for everything a reviewer has not accepted.

import { useCallback, useEffect, useId, useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import { EvidenceUpload } from "@/components/ai/EvidenceUpload";
import {
  LEAD_TIME_NOTE,
  LIMITS,
  NO_EQUIPMENT_STATEMENT,
  QUOTABLE_ITEMS,
  QUOTE_TYPES,
  QUOTE_TYPE_LABEL,
  basisLabel,
  itemFor,
  type QuoteType,
} from "@/lib/cost-evidence-claims";
import type { ClaimView } from "@/lib/project-quotation-claims";

const eur = new Intl.NumberFormat("en-IE", { maximumFractionDigits: 2 });
const input = "w-full rounded border border-line bg-ink px-2 py-1.5 text-[12px] text-ghost focus:outline-none focus:ring-2 focus:ring-power/60";

export interface QuotationFile {
  id: string;
  filename: string;
  review_status: string;
  source_category?: string;
}

/** What a lead time quoted on a record may be called: the submitter's claim, never an engine-verified figure. */
export function leadTimeText(c: Pick<ClaimView, "lead_time_weeks" | "state" | "file" | "counted">): string | null {
  if (c.lead_time_weeks === null) return null;
  const w = `${c.lead_time_weeks} weeks`;
  if (c.counted && c.file.hash_confirmed) return `${w} quoted: stated by the person who submitted it; the record is accepted and its file verified, but the engine does not use a quoted lead time in the date`;
  return `${w} quoted: customer-supplied, unverified; not used by the engine`;
}

/** What the badge says. "Counted" would claim more than is known: an accepted quotation is OFFERED to the engine, and only the engine says it APPLIED one. */
export function claimBadge(c: Pick<ClaimView, "id" | "counted">, applied?: readonly string[]): { text: string; positive: boolean } {
  if (applied?.includes(c.id)) return { text: "applied by the engine", positive: true };
  if (c.counted) return { text: "offered to the engine", positive: true };
  return { text: "not yet counted", positive: false };
}

export function ClaimsList({ claims, empty, applied }: { claims: ClaimView[]; empty?: string; applied?: readonly string[] }) {
  if (claims.length === 0) return <p className="text-faint">{empty ?? "No supplier quotation has been recorded for this project."}</p>;
  return (
    <ul className="space-y-2" aria-label="Supplier quotations of this project">
      {claims.map((c) => {
        const lead = leadTimeText(c);
        const badge = claimBadge(c, applied);
        return (
          <li key={c.id} data-claim-id={c.id} data-state={c.state} data-counted={c.counted ? "yes" : "no"} className="rounded border border-line p-2.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 break-words text-ghost">
                {c.supplier} <span className="text-faint">· {c.item}</span>
              </p>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ${badge.positive ? "border-verified/50 text-verified" : "border-queue/50 text-queue"}`}
              >
                {badge.text}
              </span>
            </div>
            <p className="mt-1 break-words">
              <span className="data text-ghost">€{eur.format(c.price_eur)}</span> {c.unit === "EUR" ? "lump" : c.unit.replace("EUR", "per").replace("/", " ")}
              {c.quoted_quantity !== null ? ` covering ${c.quoted_quantity} ${c.quoted_quantity_unit ?? ""}` : ""} · {QUOTE_TYPE_LABEL[c.quote_type].split(" (")[0].toLowerCase()} · quoted{" "}
              {c.quoted_on ?? "—"}, valid until {c.valid_until ?? "—"}
            </p>
            <p className="mt-1 break-words text-faint">{c.scope}</p>
            {lead ? <p className="mt-1 break-words text-faint">Lead time {lead}.</p> : null}
            <p className="mt-1 break-words text-faint" data-file-status={c.file.review_status}>
              Document: {c.file.filename} · {c.file.status_text}
              {c.file.hash_confirmed ? " · digest confirmed" : ""}
            </p>
            {c.review ? (
              <p className="mt-1 break-words text-faint">
                Reviewed by {c.review.reviewer ?? "—"}
                {c.review.basis_label ? ` · counted as a ${c.review.basis_label}` : ""}
                {c.review.reason ? ` · “${c.review.reason}”` : ""}
              </p>
            ) : null}
            {c.reason ? <p className="mt-1 break-words text-queue">{c.reason}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

interface FormState {
  file_id: string;
  cost_key: string;
  unit: string;
  price: string;
  quantity: string;
  quote_type: QuoteType | "";
  supplier: string;
  quoted_on: string;
  valid_until: string;
  lead: string;
  scope: string;
  notes: string;
  reference: string;
  by: string;
}
const EMPTY: FormState = { file_id: "", cost_key: "", unit: "", price: "", quantity: "", quote_type: "", supplier: "", quoted_on: "", valid_until: "", lead: "", scope: "", notes: "", reference: "", by: "" };

/** The browser's form to the route's body. Numbers are numbers or absent; nothing is defaulted. */
export function claimBody(f: FormState): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  const price = Number(f.price);
  if (!f.file_id) return { ok: false, error: "Choose the uploaded quotation document." };
  if (!f.cost_key) return { ok: false, error: "Choose the part of the works this quotation prices." };
  if (!f.unit) return { ok: false, error: "Choose the unit the price is in." };
  if (f.price.trim() === "" || !Number.isFinite(price) || price <= 0) return { ok: false, error: "Enter the price as a number above zero." };
  if (!f.quote_type) return { ok: false, error: "Say whether it is a firm or an indicative quotation." };
  const q = num(f.quantity);
  const lead = num(f.lead);
  if ((q !== undefined && !Number.isFinite(q)) || (lead !== undefined && !Number.isFinite(lead))) return { ok: false, error: "A quantity and a lead time are numbers." };
  return {
    ok: true,
    body: {
      file_id: f.file_id,
      cost_key: f.cost_key,
      unit: f.unit,
      price_eur: price,
      ...(q !== undefined ? { quoted_quantity: q } : {}),
      quote_type: f.quote_type,
      supplier: f.supplier,
      quoted_on: f.quoted_on,
      valid_until: f.valid_until,
      ...(lead !== undefined ? { lead_time_weeks: lead } : {}),
      scope: f.scope,
      ...(f.notes.trim() ? { notes: f.notes } : {}),
      ...(f.reference.trim() ? { reference: f.reference } : {}),
      submitted_by: f.by,
    },
  };
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-faint">{label}</label>
      {children}
      {hint ? <p className="mt-0.5 text-[11px] text-faint">{hint}</p> : null}
    </div>
  );
}

/** The whole supplier-quotation section for an open project: statement, document upload, claim form and the list. */
export function QuotationSection({ projectToken, files, onChanged }: { projectToken: string; files: QuotationFile[]; onChanged?: () => void }) {
  const uid = useId();
  const [claims, setClaims] = useState<ClaimView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [f, setF] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields?: string[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [localFiles, setLocalFiles] = useState<QuotationFile[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectToken)}/cost-evidence`, { cache: "no-store" });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || !b.ok) {
        setClaims(null);
        setLoadError(b?.error ?? "The quotations could not be read.");
        return;
      }
      setLoadError(null);
      setClaims(b.claims as ClaimView[]);
    } catch {
      setClaims(null);
      setLoadError("Could not reach the server. Nothing is shown rather than something guessed.");
    }
  }, [projectToken]);
  useEffect(() => {
    void load();
  }, [load]);

  const all = [...files, ...localFiles.filter((l) => !files.some((x) => x.id === l.id))].filter((x) => x.review_status !== "rejected");
  const item = itemFor(f.cost_key);
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const v = e.target.value;
    setF((p) => {
      const next = { ...p, [k]: v } as FormState;
      if (k === "cost_key") {
        const it = itemFor(v);
        next.unit = it && it.units.length === 1 ? it.units[0] : it && it.units.includes(p.unit) ? p.unit : "";
        next.quantity = "";
      }
      if (k === "unit" && v !== "EUR") next.quantity = "";
      return next;
    });
    setDone(null);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setDone(null);
    const built = claimBody(f);
    if (!built.ok) {
      setError({ message: built.error });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectToken)}/cost-evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.body),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || !b.ok) {
        const fields = Array.isArray(b?.details) ? (b.details as { field: string; problem: string }[]).map((d) => (d.field ? `${d.field}: ${d.problem}` : d.problem)) : undefined;
        setError({ message: b?.error ?? (r.status === 429 ? "Too many submissions just now. Try again shortly." : "The quotation could not be saved. Nothing was recorded."), fields });
        return;
      }
      setDone(b.note ?? "Recorded and not yet counted.");
      setF((p) => ({ ...EMPTY, by: p.by, file_id: p.file_id }));
      await load();
      onChanged?.();
    } catch {
      setError({ message: "Could not reach the server. Nothing was recorded." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="quotation-section">
      <p className="text-faint" data-testid="no-equipment-statement">{NO_EQUIPMENT_STATEMENT}</p>
      {loadError ? (
        <p role="alert" className="flex gap-2 text-flag">
          <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden /> {loadError}
        </p>
      ) : (
        <ClaimsList claims={claims ?? []} empty={claims === null ? "Reading the quotations…" : undefined} />
      )}

      <EvidenceUpload
        projectToken={projectToken}
        onSaved={() => onChanged?.()}
        defaultCategory="supplier_document"
        heading="1 · ATTACH THE QUOTATION DOCUMENT"
        onUploaded={(file) => {
          setLocalFiles((p) => [...p, { id: file.id, filename: file.filename, review_status: "unverified", source_category: "supplier_document" }]);
          setF((p) => ({ ...p, file_id: file.id }));
        }}
      />

      <form onSubmit={submit} className="space-y-1.5 border-t border-line pt-3" aria-labelledby={`${uid}-h`} data-testid="quotation-form" noValidate>
        <div id={`${uid}-h`} className="eyebrow text-[10px]">2 · RECORD WHAT THE QUOTATION SAYS</div>
        <p className="text-faint">
          What you enter here is your statement about the document. It is stored unverified and changes no number until a reviewer has verified the file and
          accepted the record. A quotation counts only until its validity date.
        </p>
        <Field id={`${uid}-file`} label="Quotation document">
          <select id={`${uid}-file`} value={f.file_id} onChange={set("file_id")} className={input} required>
            <option value="">{all.length ? "Choose an uploaded file…" : "Upload the document first"}</option>
            {all.map((x) => (
              <option key={x.id} value={x.id}>{x.filename} ({x.review_status})</option>
            ))}
          </select>
        </Field>
        <Field id={`${uid}-key`} label="What it prices">
          <select id={`${uid}-key`} value={f.cost_key} onChange={set("cost_key")} className={input} required>
            <option value="">Choose…</option>
            {QUOTABLE_ITEMS.map((i) => (
              <option key={i.key} value={i.key}>{i.label}</option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field id={`${uid}-price`} label="Price (EUR)">
            <input id={`${uid}-price`} value={f.price} onChange={set("price")} inputMode="decimal" className={input} required />
          </Field>
          <Field id={`${uid}-unit`} label="Price is">
            <select id={`${uid}-unit`} value={f.unit} onChange={set("unit")} className={input} required disabled={!item}>
              <option value="">{item ? "Choose…" : "Choose what it prices"}</option>
              {item?.units.map((u) => (
                <option key={u} value={u}>{u === "EUR" ? "a lump sum (EUR)" : u}</option>
              ))}
            </select>
          </Field>
        </div>
        {item && f.unit === "EUR" && item.quantityUnit ? (
          <Field id={`${uid}-qty`} label={`Quantity the lump covers (${item.quantityUnit})`} hint="Without it the engine uses the lump once per step, unscaled, and marks the result limited.">
            <input id={`${uid}-qty`} value={f.quantity} onChange={set("quantity")} inputMode="decimal" className={input} />
          </Field>
        ) : null}
        <Field id={`${uid}-type`} label="Kind of quotation">
          <select id={`${uid}-type`} value={f.quote_type} onChange={set("quote_type")} className={input} required>
            <option value="">Choose…</option>
            {QUOTE_TYPES.map((t) => (
              <option key={t} value={t}>{QUOTE_TYPE_LABEL[t]}</option>
            ))}
          </select>
        </Field>
        <Field id={`${uid}-sup`} label="Supplier name (as on the document)">
          <input id={`${uid}-sup`} value={f.supplier} onChange={set("supplier")} maxLength={LIMITS.supplier} className={input} required />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field id={`${uid}-on`} label="Quoted on">
            <input id={`${uid}-on`} type="date" value={f.quoted_on} onChange={set("quoted_on")} className={input} required />
          </Field>
          <Field id={`${uid}-until`} label="Valid until (a future date)">
            <input id={`${uid}-until`} type="date" value={f.valid_until} onChange={set("valid_until")} className={input} required />
          </Field>
        </div>
        <Field id={`${uid}-lead`} label="Lead time quoted (weeks, optional)" hint={LEAD_TIME_NOTE}>
          <input id={`${uid}-lead`} value={f.lead} onChange={set("lead")} inputMode="decimal" className={input} />
        </Field>
        <Field id={`${uid}-scope`} label="What the quotation covers">
          <input id={`${uid}-scope`} value={f.scope} onChange={set("scope")} maxLength={LIMITS.scope} className={input} required />
        </Field>
        <Field id={`${uid}-notes`} label="Scope and comparability notes (optional)" hint={`Exclusions, civils, commissioning, what is not included. At most ${LIMITS.notes} characters.`}>
          <textarea id={`${uid}-notes`} value={f.notes} onChange={set("notes")} maxLength={LIMITS.notes} rows={3} className={input} />
        </Field>
        <Field id={`${uid}-ref`} label="Supplier's quotation reference (optional)">
          <input id={`${uid}-ref`} value={f.reference} onChange={set("reference")} maxLength={LIMITS.reference} className={input} />
        </Field>
        <Field id={`${uid}-by`} label="Your name" hint="Recorded as typed. It is not a verified identity.">
          <input id={`${uid}-by`} value={f.by} onChange={set("by")} maxLength={LIMITS.submittedBy} className={input} required />
        </Field>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex min-h-9 items-center gap-1.5 rounded border border-power/60 px-3 py-1 text-[12px] text-power focus:outline-none focus:ring-2 focus:ring-power/60 disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
          {busy ? "Saving" : "Record the quotation"}
        </button>
        <div role="status" aria-live="polite" className="text-[11px]">
          {error ? (
            <div role="alert" className="text-flag">
              <p>{error.message}</p>
              {error.fields?.length ? <ul className="mt-1 list-disc pl-4">{error.fields.map((m) => (<li key={m}>{m}</li>))}</ul> : null}
            </div>
          ) : done ? (
            <p className="text-ghost">{done}</p>
          ) : null}
        </div>
      </form>
      <p className="text-faint">
        Counted as: a firm quotation is offered to the engine as a {basisLabel("firm_quote")} and an indicative one as a {basisLabel("budgetary_quote")}, if a
        reviewer accepts it on that basis. The reviewer decides the basis on the document.
      </p>
    </div>
  );
}
