"use client";

import { useState } from "react";
import { Navbar } from "@/components/Navbar";
import { getSupabase } from "@/lib/supabase-client";
import { Mail, Loader2, CheckCircle } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function sendLink() {
    if (!email.includes("@")) return;
    setStatus("sending");
    const { error } = await getSupabase().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/account` },
    });
    setStatus(error ? "error" : "sent");
  }

  return (
    <>
      <Navbar />
      <main className="bg-ink min-h-screen pt-32 pb-24 flex items-start justify-center">
        <div className="w-full max-w-md px-6">
          <div className="eyebrow text-power mb-3">GridForge Intelligence</div>
          <h1 className="text-3xl font-semibold tracking-tight mb-2">Sign in</h1>
          <p className="text-mute text-[15px] mb-8">
            Access live behind-the-meter siting intelligence. We&apos;ll email you a secure
            sign-in link — no password.
          </p>

          {status === "sent" ? (
            <div className="rounded-[var(--radius)] border border-power/30 bg-power/[0.04] p-6 flex gap-3">
              <CheckCircle className="text-power shrink-0" size={20} />
              <div>
                <div className="font-medium">Check your email</div>
                <p className="text-mute text-sm mt-1">
                  We sent a sign-in link to {email}. Click it to access your dashboard.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendLink()}
                placeholder="you@company.com"
                className="w-full bg-panel border border-line rounded-lg px-4 py-3 text-white placeholder:text-faint focus:border-power/50 focus:outline-none"
              />
              <button
                onClick={sendLink}
                disabled={status === "sending" || !email.includes("@")}
                className="w-full rounded-lg bg-power text-ink px-4 py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-40 hover:bg-power/90 transition-all"
              >
                {status === "sending" ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <>
                    <Mail size={16} /> Email me a sign-in link
                  </>
                )}
              </button>
              {status === "error" && (
                <p className="text-sm text-red-400">
                  Could not send the link. Check the address and try again.
                </p>
              )}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
