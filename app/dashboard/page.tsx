"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, FileText, Loader2, LogOut, Radar } from "lucide-react";
import { getSupabase } from "@/lib/supabase-client";
import { eurFromCents } from "@/lib/products";
import { CommissionScreen } from "@/components/CommissionScreen";
import { QUALIFY_LINK } from "@/lib/nav";

/**
 * The client portal. Real rows or an honest empty state — nothing else.
 *
 * What stood here was 718 lines of fiction. Three invented customers ("Texas AI
 * training cluster — Phase 1", "Northern Virginia expansion", "Frankfurt pilot
 * site") with capacities and milestone dates; a pilot claiming 99.1% efficiency,
 * 99.87% uptime and $1.84M saved; metric tiles reading 105 MW active capacity and
 * $2.9M energy savings YTD, each with a sparkline generated from a seeded PRNG so
 * the invented numbers would move convincingly; four sample reports with Final and
 * Draft statuses. It was reached through a hardcoded password in the navbar.
 *
 * A PREVIEW ribbon sat over it, and that is not a defence. This practice has no
 * delivered projects, no uptime record and no savings to report, and the rest of
 * the repository enforces exactly that: lib/site.ts carries a standing rule
 * against fabricated customers and metrics, and tests/test_one_company.py holds
 * the public surfaces to it. /dashboard predated those guards and escaped them.
 * A screenshot of that page is a claim about a track record that does not exist,
 * and the ribbon does not travel with the screenshot.
 *
 * So it now shows what the database holds for the signed-in customer, which today
 * is usually nothing, and says so. "No engagements yet" is the truth and it is
 * also a better sales page than an invented one, because the thing next to it is
 * a button that opens a real engagement.
 */

interface Engagement {
  kind: string;
  name: string;
  status: string;
  title: string | null;
  amountCents: number | null;
  createdAt: string;
  releasedAt: string | null;
  turnaroundDays: number | null;
  documentToken: string | null;
  intakeToken: string | null;
}

interface Watch {
  token: string;
  status: string;
  cadence: string;
  siteName: string | null;
  hallId: string | null;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

type State =
  | { phase: "loading" }
  | { phase: "anonymous" }
  | { phase: "error"; message: string }
  | { phase: "ready"; email: string; engagements: Engagement[]; watches: Watch[] };

/** What each status means to the person who paid, in their words rather than ours. */
const STATUS_COPY: Record<string, string> = {
  awaiting_intake: "We need your hall's numbers before this can be produced.",
  generating: "Generating from your numbers.",
  draft: "Generated, and with a senior engineer for review. We do not release an engineering opinion nobody has read.",
  released: "Released. The document is ready to read.",
  engine_unavailable:
    "Your numbers are saved, but the engine could not produce the document. Nothing is lost and nothing was invented — we are picking this up.",
};

function day(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-IE", { year: "numeric", month: "short", day: "numeric" });
}

export default function Dashboard() {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    let token: string | undefined;
    try {
      const { data } = await getSupabase().auth.getSession();
      token = data.session?.access_token;
    } catch {
      setState({ phase: "error", message: "Sign-in is not available on this deployment." });
      return;
    }
    if (!token) {
      setState({ phase: "anonymous" });
      return;
    }
    try {
      const res = await fetch("/api/engagements", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setState({ phase: "anonymous" });
        return;
      }
      if (!res.ok || !body?.ok) {
        setState({
          phase: "error",
          message: body?.error ?? "We could not read your engagements just now.",
        });
        return;
      }
      setState({
        phase: "ready",
        email: body.email,
        engagements: body.engagements ?? [],
        watches: body.watches ?? [],
      });
    } catch {
      setState({ phase: "error", message: "We could not reach the engagement store." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOut() {
    try {
      await getSupabase().auth.signOut();
    } catch {
      /* signing out of a session we cannot reach is still signing out */
    }
    setState({ phase: "anonymous" });
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-28 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
            Client portal
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ghost">
            Your engagements
          </h1>
        </div>
        {state.phase === "ready" ? (
          <div className="flex items-center gap-4 text-sm">
            <span className="text-faint">{state.email}</span>
            <Link
              href="/account"
              className="text-mute transition-colors hover:text-white"
              title="GridForge Intelligence subscription, if you have one"
            >
              Intelligence portal →
            </Link>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-2 rounded-xl border border-line px-4 py-2 text-mute transition-colors hover:border-power/40 hover:text-white"
            >
              <LogOut size={15} /> Sign out
            </button>
          </div>
        ) : null}
      </div>

      {state.phase === "loading" ? (
        <div className="mt-16 flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-power" />
        </div>
      ) : null}

      {state.phase === "anonymous" ? (
        <div className="mt-8 rounded border border-line bg-panel p-6">
          <h2 className="text-lg font-semibold text-ghost">Sign in to see your engagements.</h2>
          <p className="mt-2 max-w-xl text-sm text-mute">
            We send a link to your email — there is no password. Use the address you paid
            with, which is the address every engagement is recorded against.
          </p>
          <Link
            href="/account/login"
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-power px-5 py-2.5 text-sm font-semibold text-ink"
          >
            Send me a sign-in link <ArrowRight size={15} />
          </Link>
          <p className="mt-4 text-[12px] text-faint">
            A released document also opens from the private link we emailed you, with no
            sign-in at all.
          </p>
        </div>
      ) : null}

      {state.phase === "error" ? (
        <div className="mt-8 rounded border border-flag/40 bg-panel p-6">
          <h2 className="text-lg font-semibold text-ghost">
            We could not load this just now.
          </h2>
          <p className="mt-2 max-w-xl text-sm text-mute">{state.message}</p>
          <button
            onClick={() => {
              setState({ phase: "loading" });
              void load();
            }}
            className="mt-5 inline-flex items-center gap-2 rounded-xl border border-line px-5 py-2.5 text-sm text-ghost hover:border-power/50"
          >
            Try again
          </button>
        </div>
      ) : null}

      {state.phase === "ready" ? (
        <>
          {state.engagements.length === 0 && state.watches.length === 0 ? (
            <div className="mt-8 rounded border border-line bg-panel p-8">
              <h2 className="text-xl font-semibold text-ghost">No engagements yet.</h2>
              <p className="mt-3 max-w-xl text-mute">
                Nothing has been commissioned against {state.email}. When something is, it
                appears here with its status, and the document appears with it once a senior
                engineer has released it.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-4">
                <CommissionScreen productId="density_screen" context="portal-empty" />
                <Link href={QUALIFY_LINK.href} className="text-sm text-power hover:underline">
                  Or {QUALIFY_LINK.label.toLowerCase()} →
                </Link>
              </div>
            </div>
          ) : null}

          {state.engagements.length > 0 ? (
            <section className="mt-8">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
                Engagements
              </h2>
              <div className="mt-4 grid gap-4">
                {state.engagements.map((e, i) => (
                  <article key={i} className="rounded border border-line bg-panel p-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <h3 className="text-lg font-semibold text-ghost">
                        {e.title ?? e.name}
                      </h3>
                      <span className="font-mono text-sm text-power">
                        {e.amountCents === null ? "—" : eurFromCents(e.amountCents)}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
                      {e.name} · commissioned {day(e.createdAt)}
                      {e.releasedAt ? ` · released ${day(e.releasedAt)}` : ""}
                    </p>
                    <p className="mt-3 text-sm text-mute">
                      {STATUS_COPY[e.status] ?? e.status}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-3">
                      {e.documentToken ? (
                        <Link
                          href={`/deliverable/${e.documentToken}`}
                          className="inline-flex items-center gap-2 rounded-xl bg-power px-4 py-2 text-sm font-semibold text-ink"
                        >
                          <FileText size={15} /> Read the document
                        </Link>
                      ) : null}
                      {e.intakeToken ? (
                        <Link
                          href={`/intake/${e.intakeToken}`}
                          className="inline-flex items-center gap-2 rounded-xl border border-power/50 px-4 py-2 text-sm font-medium text-power"
                        >
                          Submit the hall&apos;s numbers <ArrowRight size={15} />
                        </Link>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {state.watches.length > 0 ? (
            <section className="mt-10">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
                Hall Watch
              </h2>
              <div className="mt-4 grid gap-4">
                {state.watches.map((w) => (
                  <article key={w.token} className="rounded border border-line bg-panel p-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <h3 className="text-lg font-semibold text-ghost">
                        {[w.siteName, w.hallId].filter(Boolean).join(" · ") || "Hall Watch"}
                      </h3>
                      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
                        {w.status} · {w.cadence}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-mute">
                      Last re-solved {day(w.lastRunAt)} · next {day(w.nextRunAt)}
                    </p>
                    <Link
                      href={`/watch/${w.token}`}
                      className="mt-4 inline-flex items-center gap-2 rounded-xl border border-line px-4 py-2 text-sm text-ghost hover:border-power/50"
                    >
                      <Radar size={15} /> Open the watch
                    </Link>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
