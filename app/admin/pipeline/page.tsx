import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  ADMIN_COOKIE,
  adminConfigured,
  fetchDeliverables,
  fetchQualifications,
  summariseQualifications,
  supabaseConfigured,
  verifyAdminCookie,
} from "@/lib/admin";
import { EngagementPipeline } from "@/components/EngagementPipeline";

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

  const [deliverables, qualifications] = await Promise.all([
    fetchDeliverables(),
    fetchQualifications(),
  ]);

  return (
    <EngagementPipeline
      deliverables={deliverables}
      qualifications={qualifications}
      insights={summariseQualifications(qualifications)}
      supabaseReady={supabaseConfigured()}
    />
  );
}
