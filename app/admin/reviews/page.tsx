import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ADMIN_COOKIE, adminConfigured, verifyAdminCookie } from "@/lib/admin";
import { REVIEW_CLASS } from "@/lib/project-observations";
import { reviewQueue } from "@/lib/project-review-queue";
import { ProjectEvidenceReview } from "@/components/ProjectEvidenceReview";
import { claimQueue } from "@/lib/project-quotation-claims";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Evidence review — GridForge AI",
  robots: { index: false, follow: false },
};

// The queue of project observations and supplier delivery records awaiting a human decision. Admin cookie only (the same
// gate as /admin/pipeline); each decision is posted to the existing admin review routes, which check the cookie again.
export default async function EvidenceReviewPage() {
  if (!adminConfigured()) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="panel max-w-md p-8 text-center">
          <div className="eyebrow mb-2">ADMIN — NOT CONFIGURED</div>
          <h1 className="mb-3 text-xl font-semibold">Set an admin password</h1>
          <p className="mb-4 text-sm text-mute">
            Add <code className="font-mono text-power">ADMIN_PASSWORD</code> to your environment, then reload.
          </p>
          <Link href="/" className="btn-secondary inline-block rounded-lg px-5 py-2.5 text-sm">
            Back to site
          </Link>
        </div>
      </div>
    );
  }
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) redirect("/admin/login");

  const q = await reviewQueue();
  // Supplier quotations attached to uploaded files (migration 0054). Until it is applied the queue says so; nothing else changes.
  const quotes = await claimQueue("pending");
  return (
    <div className="mx-auto w-full max-w-5xl px-5 pb-24 pt-28 sm:px-8">
      <header className="mb-8 max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">Admin</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost">Evidence review</h1>
        <p className="mt-4 text-mute">
          Each item is decided once, by a named person, and the decision cannot be changed. Nothing here is verified automatically and
          there is no bulk action. <Link href="/admin/pipeline" className="text-power underline">Engagements</Link>
        </p>
        <p className="mt-3 text-sm text-mute">
          Each observation lists every gate the calibration export applies, read from the records behind it: met, not met, or cannot be
          read. The list explains; the export view decides, and a person still runs the import. The gates are described in full on{" "}
          <Link href="/evidence#ledger-gates" className="text-power underline">the public evidence page</Link>.
        </p>
      </header>
      <ProjectEvidenceReview
        observations={q.ok ? q.observations : []}
        actuals={q.ok ? q.actuals : []}
        files={q.ok ? q.files : []}
        verified={q.ok ? q.verified : undefined}
        counts={q.ok ? q.counts : undefined}
        reviewClass={REVIEW_CLASS}
        initialError={q.ok ? null : q.error}
        quotations={quotes.ok ? quotes.claims : undefined}
        quotationsError={quotes.ok ? null : quotes.status === 503 ? null : quotes.error}
      />
    </div>
  );
}
