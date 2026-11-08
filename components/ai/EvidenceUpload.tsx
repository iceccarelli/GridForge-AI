"use client";

import { useId, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import {
  EVIDENCE_ACCEPT,
  EVIDENCE_CATEGORIES,
  EVIDENCE_CATEGORY_LABEL,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  EVIDENCE_MAX_TOTAL_BYTES,
  EVIDENCE_NOTE_MAX,
  buildEvidenceRequest,
  bytesLabel,
  checkEvidenceFile,
} from "@/lib/project-evidence-upload";

/**
 * Attach one source file to the open project.
 *
 * This is the only screen that feeds the project's evidence inventory, which is what an observation or a supplier's
 * actual-delivery record cites as its source. A file lands `unverified` and unclassified, and stays so until an administrator
 * reviews it: nothing on this control can set a review status or an evidence class (see buildEvidenceRequest), and the route
 * ignores any attempt to. The file is stored with its SHA-256; its contents are not read.
 *
 * A native file input inside a labelled form: keyboard and screen-reader operable, no drag-and-drop required.
 */
export function EvidenceUpload({
  projectToken,
  onSaved,
  defaultCategory = "other",
  heading = "ATTACH A FILE",
  onUploaded,
}: {
  projectToken: string;
  onSaved: () => void;
  /** The category the picker starts on (a supplier quotation's document starts on "Supplier document"). The visitor can still change it. */
  defaultCategory?: (typeof EVIDENCE_CATEGORIES)[number];
  heading?: string;
  /** The stored file's id and name, for a caller that wants to refer to the file just attached (the quotation form does). */
  onUploaded?: (file: { id: string; filename: string }) => void;
}) {
  const uid = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<string>(defaultCategory);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const input = "w-full rounded border border-line bg-ink px-2 py-1.5 text-[12px] text-ghost focus:outline-none focus:ring-2 focus:ring-power/60";

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setDone(null);
    setFile(f);
    setError(f ? checkEvidenceFile(f) : null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setDone(null);
    if (!file) {
      setError("Choose a file first.");
      fileRef.current?.focus();
      return;
    }
    const refused = checkEvidenceFile(file);
    if (refused) {
      setError(refused);
      return;
    }
    const req = buildEvidenceRequest(projectToken, file, { category, note });
    if ("error" in req) {
      setError(req.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(req.url, { method: "POST", headers: req.headers, body: file });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setError(body?.error ?? (res.status === 429 ? "Too many uploads just now. Try again shortly." : "The file could not be attached. Nothing was saved."));
        return;
      }
      setDone(`${body.evidence?.filename ?? file.name} was attached. It is unverified and unclassified until an administrator reviews it.`);
      if (typeof body.evidence?.id === "string") onUploaded?.({ id: body.evidence.id, filename: String(body.evidence.filename ?? file.name) });
      setFile(null);
      setNote("");
      if (fileRef.current) fileRef.current.value = "";
      onSaved();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-1.5 border-t border-line pt-3" aria-labelledby={`${uid}-h`} data-testid="evidence-upload">
      <div id={`${uid}-h`} className="eyebrow text-[10px]">{heading}</div>
      <label className="block text-faint" htmlFor={`${uid}-file`}>Source file (PDF, CSV or JSON)</label>
      <input
        id={`${uid}-file`}
        ref={fileRef}
        type="file"
        accept={EVIDENCE_ACCEPT}
        onChange={pick}
        aria-describedby={`${uid}-hint ${uid}-status`}
        className={`${input} file:mr-2 file:rounded file:border file:border-line file:bg-ink file:px-2 file:py-1 file:text-ghost`}
      />
      <p id={`${uid}-hint`} className="text-faint">
        Up to {bytesLabel(EVIDENCE_MAX_BYTES)} per file. A project keeps at most {EVIDENCE_MAX_FILES} files and{" "}
        {bytesLabel(EVIDENCE_MAX_TOTAL_BYTES)} in all. The same file cannot be attached twice. Stored unverified; we keep it with its
        checksum and do not read it.
      </p>
      <label className="block text-faint" htmlFor={`${uid}-cat`}>What kind of file is it</label>
      <select id={`${uid}-cat`} value={category} onChange={(e) => setCategory(e.target.value)} className={input}>
        {EVIDENCE_CATEGORIES.map((c) => (
          <option key={c} value={c}>{EVIDENCE_CATEGORY_LABEL[c]}</option>
        ))}
      </select>
      <label className="block text-faint" htmlFor={`${uid}-note`}>Note (optional)</label>
      <input id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={EVIDENCE_NOTE_MAX} className={input} />
      <button
        type="submit"
        disabled={busy}
        className="inline-flex min-h-9 items-center gap-1.5 rounded border border-power/60 px-3 py-1 text-[12px] text-power focus:outline-none focus:ring-2 focus:ring-power/60 disabled:opacity-50"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
        {busy ? "Uploading" : "Attach file"}
      </button>
      <div id={`${uid}-status`} role="status" aria-live="polite" className="text-[11px]">
        {error ? <p role="alert" className="text-flag">{error}</p> : done ? <p className="text-ghost">{done}</p> : null}
      </div>
    </form>
  );
}
