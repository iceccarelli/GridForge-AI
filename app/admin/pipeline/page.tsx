import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  ADMIN_COOKIE,
  adminConfigured,
  fetchApiAccounts,
  fetchDeliverables,
  fetchQualifications,
  fetchWatches,
  revocationList,
  summariseQualifications,
  supabaseConfigured,
  verifyAdminCookie,
} from "@/lib/admin";
import { EngagementPipeline } from "@/components/EngagementPipeline";
import { CostEvidenceReview } from "@/components/CostEvidenceReview";
import { adminRuns, evidenceQueue } from "@/lib/cost-evidence";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Engagements — GridForge AI",
  robots: { index: false, follow: false },
};

export default async function PipelinePage() {
  if (!adminConfigured()) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="panel max-w-md p-8 text-center">
          <div className="eyebrow mb-2">ADMIN — NOT CONFIGURED</div>
          <h1 className="mb-3 text-xl font-semibold">Set an admin password</h1>
          <p className="mb-4 text-sm text-mute">
            Add <code className="font-mono text-power">ADMIN_PASSWORD</code> to your environment,
            then reload.
          </p>
          <Link href="/" className="btn-secondary inline-block rounded-lg px-5 py-2.5 text-sm">
            Back to site
          </Link>
        </div>
      </main>
    );
  }

  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    redirect("/admin/login");
  }

  const [deliverables, qualifications, watches, apiAccounts, evidence, runs] = await Promise.all([
    fetchDeliverables(),
    fetchQualifications(),
    fetchWatches(),
    fetchApiAccounts(),
    evidenceQueue("all"),
    adminRuns(),
  ]);

  return (
    <>
    <EngagementPipeline
      deliverables={deliverables}
      qualifications={qualifications}
      watches={watches}
      apiAccounts={apiAccounts}
      revoked={revocationList(apiAccounts)}
      insights={summariseQualifications(qualifications)}
      supabaseReady={supabaseConfigured()}
    />
    {/* Supplier pricing: this page is behind the admin cookie check above, and so are the routes the panel calls. */}
    <div className="mx-auto w-full max-w-7xl px-5 pb-24 sm:px-8">
      <CostEvidenceReview
        initial={evidence.ok ? evidence.items : []}
        initialError={evidence.ok ? null : evidence.error}
        runs={
          runs.ok
            ? runs.runs.map((x) => ({
                id: x.id,
                deliverable_id: x.deliverable_id,
                created_at: x.created_at,
                legacy: x.legacy,
                run_fingerprint: x.run_fingerprint,
                accepted_evidence_ids: x.accepted_evidence_ids,
                used_evidence_ids: x.evidence_ids,
                ignored: Array.isArray(x.ignored) ? x.ignored : [],
                engine_version: x.engine_provenance?.engine_version ?? null,
                engine_fingerprint: x.engine_fingerprint,
                report_date: x.report_date,
                artifact_sha256: x.artifact_sha256,
                artifact_bytes: x.artifact_bytes === null ? null : Number(x.artifact_bytes),
                artifact: x.legacy || !x.artifact_storage_ref ? ("legacy_unavailable" as const) : ("stored" as const),
              }))
            : []
        }
      />
    </div>
    </>
  );
}
