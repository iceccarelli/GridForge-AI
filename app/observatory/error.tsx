"use client";

import Link from "next/link";

export default function ObservatoryError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-32 sm:px-6">
      <div role="alert" className="rounded-xl border border-flag/50 bg-flag/5 p-6">
        <h1 className="text-xl font-semibold text-ghost">The observatory could not be shown</h1>
        <p className="mt-2 text-sm text-mute">Something went wrong while drawing the page. No figures are displayed in its place.</p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <button type="button" onClick={reset} className="btn-secondary rounded-full px-5 py-2 text-sm">
            Try again
          </button>
          <Link href="/qualify" className="text-sm text-power underline underline-offset-4">
            Run the free qualifier on your hall
          </Link>
        </div>
      </div>
    </div>
  );
}
