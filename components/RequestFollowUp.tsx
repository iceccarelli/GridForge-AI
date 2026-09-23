"use client";

import { useState } from "react";
import { Loader2, MailCheck, Send } from "lucide-react";

/**
 * "Come and talk to me" — the missing rung between a free read and a paid
 * engagement.
 *
 * `/q/<token>` already carries the engineering read out of the browser tab. It
 * offered exactly one next step: commission the Density Screen, cold, for
 * EUR 4,500. A director reading a private capacity read for the first time is not
 * always ready to sign a purchase order in the same sitting, and until this
 * existed the only alternative to buying was doing nothing — which is how a
 * qualified read became a lead we paid the engine to produce and then discarded.
 *
 * One request, addressed by the page's own token, answered once by a person. Not
 * a subscribe form: there is no ongoing sequence to opt into, and nothing here
 * repeats.
 */
export function RequestFollowUp({
  token,
  defaultEmail,
  alreadyRequested,
}: {
  token: string;
  defaultEmail?: string | null;
  alreadyRequested?: boolean;
}) {
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
    alreadyRequested ? "done" : "idle"
  );
  const [error, setError] = useState<string | null>(null);

  if (state === "done") {
    return (
      <p className="flex items-center gap-2 text-sm text-mute">
        <MailCheck className="h-4 w-4 text-power" />
        Follow-up requested. An engineer will respond directly — nothing further will be sent
        automatically.
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("busy");
    setError(null);
    try {
      const res = await fetch(`/api/qualify/${token}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, note: note || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not send that. Try again.");
        setState("error");
        return;
      }
      setState("done");
    } catch {
      setError("Could not reach the server. Try again.");
      setState("error");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="min-w-56 flex-1 rounded border border-line bg-panel px-3 py-2 text-sm text-ghost placeholder:text-faint"
        />
        <button
          type="submit"
          disabled={state === "busy"}
          className="inline-flex items-center justify-center gap-2 rounded border border-line px-4 py-2 text-sm font-semibold text-ghost hover:border-power/50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state === "busy" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Request a follow-up
        </button>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder="Anything you want the engineer to know first (optional)"
        className="w-full rounded border border-line bg-panel px-3 py-2 text-sm text-ghost placeholder:text-faint"
      />
      <p className="text-[11px] text-faint">
        This sends one message to an engineer, once. It is not a mailing list and starts no
        sequence.
      </p>
      {error ? <p className="text-[12px] text-flag">{error}</p> : null}
    </form>
  );
}
