"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Mail, UserMinus, X } from "lucide-react";

export type TeamOverview = {
  owner: string;
  plan: string;
  seats: number | null;
  used: number;
  reserved: number;
  available: number | null;
  members: { id: string; email: string; addedAt: string; seatActive: boolean }[];
  invitations: { id: string; email: string; createdAt: string; expiresAt: string }[];
};

type Load = { state: "loading" } | { state: "ready"; team: TeamOverview } | { state: "unavailable" } | { state: "error"; message: string };

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/**
 * The billing owner's seats: how many are used, who holds them, what is pending, and the controls to change that.
 *
 * Presentation only. Every number is the server's, and every action is re-authorised there: hiding a button here protects
 * nothing, and a member who reached these endpoints directly would be refused (403) by the same checks.
 */
export default function TeamPanel({ headers }: { headers: () => Promise<Record<string, string>> }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/team", { headers: await headers(), cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.team) setLoad({ state: "ready", team: j.team });
      else if (res.status === 503) setLoad({ state: "unavailable" });
      else setLoad({ state: "error", message: typeof j.error === "string" ? j.error : "Could not load seats." });
    } catch {
      setLoad({ state: "unavailable" });
    }
  }, [headers]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function act(key: string, run: () => Promise<Response>, done: string | ((j: { delivery?: string }) => string)) {
    setBusy(key);
    setNote(null);
    try {
      const res = await run();
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setNote({ ok: true, text: typeof done === "function" ? done(j) : done });
        if (key === "invite") setEmail("");
      } else {
        setNote({ ok: false, text: typeof j.error === "string" ? j.error : "That did not work." });
      }
    } catch {
      setNote({ ok: false, text: "Could not reach the server. Nothing was changed." });
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    void act("invite", async () => fetch("/api/team/invitations", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await headers()) }, body: JSON.stringify({ email }),
    }), (j) => j.delivery === "sent"
      ? "Invitation sent. It works for that address only, once, and expires in 7 days."
      : "Invitation created and holding a seat, but the email has not gone out yet. It is queued and retried automatically; you can revoke it meanwhile.");
  };
  const revoke = (id: string) => act("r:" + id, async () => fetch("/api/team/invitations?id=" + encodeURIComponent(id), { method: "DELETE", headers: await headers() }), "Invitation revoked.");
  const remove = (id: string, who: string) => {
    if (!window.confirm(`Remove ${who}? They lose access to the dashboard on their next request.`)) return;
    void act("m:" + id, async () => fetch("/api/team/members?id=" + encodeURIComponent(id), { method: "DELETE", headers: await headers() }), "Member removed.");
  };

  if (load.state === "loading") {
    return <div className="rounded-[var(--radius)] border border-line bg-panel p-6"><Loader2 className="animate-spin text-power" size={18} /></div>;
  }
  if (load.state !== "ready") {
    return (
      <div className="rounded-[var(--radius)] border border-line bg-panel p-6">
        <div className="eyebrow text-mute mb-1">Team seats</div>
        <p className="text-mute text-[13px]">
          {load.state === "unavailable"
            ? "We could not load your seats just now. Nothing has changed — reload in a moment."
            : load.message}
        </p>
      </div>
    );
  }

  const t = load.team;
  const unlimited = t.seats === null;
  const full = !unlimited && (t.available ?? 0) <= 0;
  const suspended = t.members.filter((m) => !m.seatActive).length;

  return (
    <div className="rounded-[var(--radius)] border border-line bg-panel p-6" id="team">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="eyebrow text-power mb-1">Team seats</div>
          <h2 className="text-lg font-semibold tracking-tight">Who can use this subscription</h2>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tracking-tight" aria-label="Seats in use">
            {t.used}{unlimited ? "" : <span className="text-faint"> / {t.seats}</span>}
          </div>
          <div className="data text-[10px] text-faint">
            {unlimited ? "seats in use · no seat limit" : `seats in use · ${t.available} available`}
            {t.reserved > 0 ? ` · ${t.reserved} held by open invitation${t.reserved === 1 ? "" : "s"}` : ""}
          </div>
        </div>
      </div>
      <p className="text-mute text-[13px] mb-5">
        You, the billing owner, hold one seat and always keep control of the subscription. Everyone you invite signs in with their own
        email address and gets the same live dashboard; only you can add or remove seats.
      </p>

      {suspended > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-queue/40 bg-queue/10 px-4 py-3 text-[13px]">
          Your plan now has fewer seats than members. The {suspended} most recently added {suspended === 1 ? "seat is" : "seats are"} suspended
          and have no access until you remove a member or move to a larger plan.
        </div>
      )}

      <ul className="divide-y divide-line/60 rounded-lg border border-line">
        <li className="flex items-center justify-between px-4 py-3 text-sm">
          <span className="text-white">{t.owner}</span>
          <span className="data text-[10px] uppercase text-power">Billing owner</span>
        </li>
        {t.members.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className={m.seatActive ? "text-white" : "text-faint line-through"}>{m.email}</span>
            <span className="flex items-center gap-3">
              <span className="data text-[10px] uppercase text-faint">{m.seatActive ? `Member · since ${day(m.addedAt)}` : "Suspended"}</span>
              <button onClick={() => remove(m.id, m.email)} disabled={busy !== null} aria-label={`Remove ${m.email}`}
                className="text-faint hover:text-red-400 disabled:opacity-40"><UserMinus size={15} /></button>
            </span>
          </li>
        ))}
        {t.invitations.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="text-mute">{i.email}</span>
            <span className="flex items-center gap-3">
              <span className="data text-[10px] uppercase text-faint">Invited · expires {day(i.expiresAt)}</span>
              <button onClick={() => revoke(i.id)} disabled={busy !== null} aria-label={`Revoke invitation to ${i.email}`}
                className="text-faint hover:text-red-400 disabled:opacity-40"><X size={15} /></button>
            </span>
          </li>
        ))}
      </ul>

      <form onSubmit={invite} className="mt-5 flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="invite-email">Email address to invite</label>
        <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={full || busy !== null}
          placeholder={full ? "Every seat is taken" : "colleague@company.com"}
          className="flex-1 min-w-[14rem] bg-ink border border-line rounded-lg px-3.5 py-2.5 text-[13px] text-white placeholder:text-faint focus:border-power/50 focus:outline-none disabled:opacity-50" />
        <button type="submit" disabled={full || busy !== null || !email.trim()}
          className="rounded-lg bg-power text-ink px-5 py-2.5 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-40 hover:bg-power/90 transition-all">
          {busy === "invite" ? <Loader2 size={14} className="animate-spin" /> : <><Mail size={14} /> Send invitation</>}
        </button>
      </form>
      {full && (
        <p className="data text-[10px] text-faint mt-2">
          {t.seats === 1
            ? "The Developer plan has one seat, the billing owner's. A larger plan adds seats."
            : "Remove a member or revoke an invitation to free a seat."}
        </p>
      )}
      {note && <p role="status" className={`text-[13px] mt-3 ${note.ok ? "text-power" : "text-red-400"}`}>{note.text}</p>}
    </div>
  );
}
