"use client";

// Save the comparison on screen to a project, then hand it to the person who approves the spend.
//
// The browser sends the REQUEST it already sent to /api/power/compare, never the result: the server asks the engine again
// and stores the engine's answer (app/api/power/compare/save/route.ts). The project token and the buyer link are shown
// here and nowhere else the server can read them back: the first is the project's only key, the second is stored as a hash.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

type Saved = { token: string; name: string; created: boolean; quotations: number | null };

function Secret({ label, value, note }: { label: string; value: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-mute">{label}</p>
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label={label}
        className="w-full rounded border border-line bg-ink px-3 py-2 font-mono text-[11px] text-ghost" />
      <div className="flex items-center gap-4 text-xs">
        <button type="button" className="underline text-mute"
          onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); } }}>
          {copied ? "Copied" : "Copy"}
        </button>
        <span className="text-faint">{note}</span>
      </div>
    </div>
  );
}

export function TtpSaveToProject({ compare, defaultName }: { compare: Record<string, unknown>; defaultName: string }) {
  const [name, setName] = useState(defaultName);
  const [company, setCompany] = useState("");
  const [existing, setExisting] = useState<string | null>(null);
  const [useQuotations, setUseQuotations] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [buyerLink, setBuyerLink] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);

  useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get("project");
      if (t) setExisting(t);
    } catch {
      /* no query string to read */
    }
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/power/compare/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          compare,
          project: existing ? { project_token: existing } : { project_name: name.trim(), ...(company.trim() ? { company: company.trim() } : {}) },
          // The server reads the project's accepted quotations itself; the browser only asks for them.
          ...(existing && useQuotations ? { use_accepted_quotations: true } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const problems = Array.isArray(body?.problems) ? (body.problems as { message: string }[]).map((p) => p.message).join(" ") : "";
        setError([body?.error ?? "The comparison could not be saved.", problems].filter(Boolean).join(" "));
        return;
      }
      setSaved({
        token: body.project_token ?? existing,
        name: body.project_name,
        created: body.created === true,
        quotations: typeof body.quotations?.applied === "number" ? body.quotations.applied : null,
      });
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  }

  async function makeLink() {
    if (!saved) return;
    setLinkBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(saved.token)}/share`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) setError(body?.error ?? "The buyer link could not be created.");
      else setBuyerLink(`${window.location.origin}${body.share_path}`);
    } catch {
      setError("Could not reach the server. No link was created.");
    } finally {
      setLinkBusy(false);
    }
  }

  const input = "w-full rounded border border-line bg-ink px-3 py-2 text-sm text-ghost";
  return (
    <section aria-label="Save to a project" className="panel flex flex-col gap-4 p-5">
      <p className="eyebrow">Take this further</p>
      {!saved ? (
        <form onSubmit={save} className="flex flex-col gap-3">
          <p className="max-w-3xl text-sm text-mute">
            Save this comparison to a project, then give the person who approves the spend a read-only page: the decision, what it rests
            on, the evidence class behind each date, and the next engagement to buy. They need no account. The engine is asked again on
            save, and what is stored is its answer.
          </p>
          {existing ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-mute">It will be added to the project you came from. <button type="button" className="underline" onClick={() => { setExisting(null); setUseQuotations(false); }}>Save to a new project instead</button></p>
              <label className="flex items-start gap-2 text-sm text-mute">
                <input type="checkbox" className="mt-1" checked={useQuotations} onChange={(e) => setUseQuotations(e.target.checked)} />
                <span>
                  Price it on this project&apos;s accepted supplier quotations. Only quotations a named reviewer has accepted count; anything they do not cover stays a
                  library estimate, and the buyer page says which is which. If none applies, nothing is saved.
                </span>
              </label>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-mute">Project name
                <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
              </label>
              <label className="flex flex-col gap-1 text-xs text-mute">Company (optional)
                <input className={input} value={company} onChange={(e) => setCompany(e.target.value)} maxLength={200} />
              </label>
            </div>
          )}
          <div>
            <button type="submit" disabled={busy || (!existing && !name.trim())} className="btn-secondary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-60">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {busy ? "Saving" : "Save to a project"}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ghost">{saved.created ? `Saved to “${saved.name}”.` : `This exact comparison was already saved to “${saved.name}”; nothing changed.`}</p>
          {saved.quotations ? <p className="text-sm text-mute">Priced on {saved.quotations} accepted supplier quotation{saved.quotations === 1 ? "" : "s"}; the buyer page lists them without supplier names or prices.</p> : null}
          <Secret
            label="Your project link (edit access)"
            value={`${typeof window === "undefined" ? "" : window.location.origin}/workspace?project=${saved.token}`}
            note="Keep it private: it is the only way back into the project, and anyone holding it can change the project."
          />
          {buyerLink ? (
            <>
              <Secret label="Buyer link (read-only)" value={buyerLink}
                note="Shown once; the server keeps only a hash. Replace or revoke it from the project." />
              <a href={buyerLink} target="_blank" rel="noopener noreferrer" className="text-sm text-power underline">Open it as the buyer sees it</a>
            </>
          ) : (
            <div>
              <button type="button" onClick={() => void makeLink()} disabled={linkBusy} className="btn-secondary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-60">
                {linkBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Create a read-only buyer link
              </button>
            </div>
          )}
        </div>
      )}
      {error ? <p role="alert" className="text-sm text-flag">{error}</p> : null}
    </section>
  );
}
