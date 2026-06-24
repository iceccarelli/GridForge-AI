"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, ArrowRight } from "lucide-react";

export default function AdminLogin() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace("/admin");
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Login failed.");
      }
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={submit} className="panel p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-1 text-power">
          <Lock size={16} />
          <span className="eyebrow">FOUNDER ACCESS</span>
        </div>
        <h1 className="text-xl font-semibold mb-5">Pipeline login</h1>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="field w-full px-4 py-3 rounded-xl mb-3"
          placeholder="Admin password"
          aria-label="Admin password"
        />
        {error && <p className="text-flag text-xs mb-3">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="btn-primary w-full px-6 py-3 rounded-xl text-sm disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {busy ? "Checking…" : "Enter"}
          {!busy && <ArrowRight size={16} />}
        </button>
      </form>
    </main>
  );
}
