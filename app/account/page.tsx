"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { getSupabase } from "@/lib/supabase-client";
import { Loader2, LogOut } from "lucide-react";

export default function AccountPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSupabase().auth.getSession().then(({ data }) => {
      if (data.session?.user?.email) {
        setEmail(data.session.user.email);
      } else {
        router.replace("/account/login");
      }
      setLoading(false);
    });
  }, [router]);

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/account/login");
  }

  if (loading) {
    return (
      <>
        <Navbar />
        <main className="bg-ink min-h-screen pt-32 flex justify-center">
          <Loader2 className="animate-spin text-power" />
        </main>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <main className="bg-ink min-h-screen pt-28 pb-24">
        <div className="max-w-5xl mx-auto px-6">
          <div className="flex items-center justify-between mb-8">
            <div>
              <div className="eyebrow text-power mb-2">GridForge Intelligence</div>
              <h1 className="text-3xl font-semibold tracking-tight">Your dashboard</h1>
              <p className="text-mute text-sm mt-1">{email}</p>
            </div>
            <button
              onClick={signOut}
              className="data text-xs uppercase tracking-[0.1em] text-mute hover:text-white inline-flex items-center gap-1.5"
            >
              <LogOut size={14} /> Sign out
            </button>
          </div>

          <div className="rounded-[var(--radius)] border border-line bg-panel p-8">
            <div className="eyebrow text-mute mb-2">Subscription required</div>
            <h2 className="text-xl font-semibold tracking-tight">
              Activate GridForge Intelligence
            </h2>
            <p className="text-mute text-[14px] leading-relaxed mt-2 max-w-xl">
              Live behind-the-meter siting intelligence: where you can energize fastest,
              real-time market signals, and interconnection-queue insight. Choose a plan to
              unlock your dashboard.
            </p>
            <a
              href="/intelligence"
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-power text-ink px-5 py-3 text-sm font-semibold hover:bg-power/90 transition-all"
            >
              View plans
            </a>
          </div>
        </div>
      </main>
    </>
  );
}
