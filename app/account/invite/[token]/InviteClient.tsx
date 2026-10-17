"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { getSupabase } from "@/lib/supabase-client";
import { PENDING_INVITE_KEY } from "@/lib/team-client";

type View =
  | { kind: "loading" }
  | { kind: "offer"; ownerEmail: string; plan: string; expiresAt: string }
  | { kind: "refused"; message: string; reason?: string }
  | { kind: "unavailable" }
  | { kind: "accepted"; ownerEmail: string }
  | { kind: "declined" };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function InviteClient({ token }: { token: string }) {
  const router = useRouter();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [me, setMe] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(action: "preview" | "accept" | "decline", accessToken: string) {
    const res = await fetch("/api/team/invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
      body: JSON.stringify({ token, action }),
    });
    return { res, j: await res.json().catch(() => ({})) };
  }

  useEffect(() => {
    let on = true;
    (async () => {
      const { data } = await getSupabase().auth.getSession();
      const session = data.session;
      if (!session?.user?.email) {
        // Not signed in: remember the invitation across the sign-in link, then sign in. The address that signs in must be the
        // invited one; the server checks that, not this page.
        try { localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ token, at: Date.now() })); } catch { /* private mode */ }
        router.replace("/account/login");
        return;
      }
      setMe(session.user.email);
      try {
        const { res, j } = await post("preview", session.access_token);
        if (!on) return;
        if (res.ok) setView({ kind: "offer", ownerEmail: j.ownerEmail, plan: j.plan, expiresAt: j.expiresAt });
        else if (res.status === 503 || res.status === 429) setView({ kind: "unavailable" });
        else setView({ kind: "refused", message: typeof j.error === "string" ? j.error : "This invitation cannot be used.", reason: j.reason });
      } catch {
        if (on) setView({ kind: "unavailable" });
      }
    })();
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function respond(action: "accept" | "decline") {
    setBusy(true);
    try {
      const { data } = await getSupabase().auth.getSession();
      if (!data.session) { router.replace("/account/login"); return; }
      const { res, j } = await post(action, data.session.access_token);
      if (res.ok) {
        try { localStorage.removeItem(PENDING_INVITE_KEY); } catch { /* ignore */ }
        setView(action === "accept" ? { kind: "accepted", ownerEmail: j.ownerEmail } : { kind: "declined" });
      } else if (res.status === 503 || res.status === 429) {
        setView({ kind: "unavailable" });
      } else {
        setView({ kind: "refused", message: typeof j.error === "string" ? j.error : "This invitation cannot be used.", reason: j.reason });
      }
    } catch {
      setView({ kind: "unavailable" });
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    await getSupabase().auth.signOut();
    router.replace("/account/login");
  }

  return (
    <main className="bg-ink min-h-screen pt-32 pb-24 flex items-start justify-center">
      <div className="w-full max-w-lg px-6">
        <div className="eyebrow text-power mb-3">GridForge Intelligence</div>
        <h1 className="text-3xl font-semibold tracking-tight mb-6">Your invitation</h1>

        {view.kind === "loading" && <Loader2 className="animate-spin text-power" />}

        {view.kind === "offer" && (
          <div className="rounded-[var(--radius)] border border-line bg-panel p-6">
            <p className="text-[15px]">
              <span className="font-medium text-white">{view.ownerEmail}</span> has offered you a seat on their{" "}
              {cap(view.plan)} subscription.
            </p>
            <p className="text-mute text-[13px] mt-2">
              You would sign in as <span className="text-white">{me}</span> and get the same live siting dashboard. The owner can
              remove the seat at any time. This offer expires {new Date(view.expiresAt).toISOString().slice(0, 10)}.
            </p>
            <div className="flex gap-3 mt-5">
              <button onClick={() => respond("accept")} disabled={busy}
                className="rounded-lg bg-power text-ink px-5 py-2.5 text-sm font-semibold disabled:opacity-50 hover:bg-power/90 transition-all">
                {busy ? <Loader2 size={14} className="animate-spin" /> : "Accept the seat"}
              </button>
              <button onClick={() => respond("decline")} disabled={busy}
                className="rounded-lg border border-line text-mute px-5 py-2.5 text-sm hover:text-white disabled:opacity-50 transition-all">
                Decline
              </button>
            </div>
          </div>
        )}

        {view.kind === "accepted" && (
          <div className="rounded-[var(--radius)] border border-power/30 bg-power/[0.04] p-6">
            <div className="font-medium">You have a seat.</div>
            <p className="text-mute text-sm mt-1">You are using {view.ownerEmail}&apos;s subscription as {me}.</p>
            <Link href="/account" className="mt-4 inline-flex rounded-lg bg-power text-ink px-5 py-2.5 text-sm font-semibold hover:bg-power/90 transition-all">Open the dashboard</Link>
          </div>
        )}

        {view.kind === "declined" && (
          <div className="rounded-[var(--radius)] border border-line bg-panel p-6">
            <div className="font-medium">Invitation declined.</div>
            <p className="text-mute text-sm mt-1">Nothing was added to your account and the owner&apos;s seat is free again.</p>
          </div>
        )}

        {view.kind === "refused" && (
          <div className="rounded-[var(--radius)] border border-line bg-panel p-6" role="alert">
            <div className="eyebrow text-mute mb-1">Cannot be used</div>
            <p className="text-[14px]">{view.message}</p>
            {view.reason === "invalid" && (
              <p className="text-mute text-[13px] mt-2">
                You are signed in as {me}. An invitation works only for the address it was sent to.{" "}
                <button onClick={switchAccount} className="text-power hover:underline">Sign in with a different address</button>
              </p>
            )}
          </div>
        )}

        {view.kind === "unavailable" && (
          <div className="rounded-[var(--radius)] border border-line bg-panel p-6" role="alert">
            <div className="eyebrow text-mute mb-1">Temporarily unavailable</div>
            <p className="text-[14px]">We could not check this invitation just now. Nothing has changed — reload in a moment.</p>
          </div>
        )}
      </div>
    </main>
  );
}
