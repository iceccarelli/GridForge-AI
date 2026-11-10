import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  verifyAdminCookie,
  adminConfigured,
  supabaseConfigured,
  fetchLeads,
  ADMIN_COOKIE,
} from "@/lib/admin";
import { AdminDashboard } from "@/components/AdminDashboard";
import { StripeHealthPanel } from "@/components/StripeHealthPanel";
import { subscriptionOverview } from "@/lib/subscribers";
import {
  CAPABILITY_REGISTRY,
  priceableButNotOnWeb,
  unmonetized,
  productsMissingFromRegistry,
  intelligencePlansMissingFromRegistry,
} from "@/lib/capability-registry";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Pipeline — GridForge AI",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  // No password set at all — show setup notice rather than a broken login.
  if (!adminConfigured()) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="panel p-8 max-w-md text-center">
          <div className="eyebrow mb-2">ADMIN — NOT CONFIGURED</div>
          <h1 className="text-xl font-semibold mb-3">Set an admin password</h1>
          <p className="text-mute text-sm mb-4">
            Add <code className="font-mono text-power">ADMIN_PASSWORD</code> to your environment
            (and <code className="font-mono text-power">SUPABASE_URL</code> /
            <code className="font-mono text-power"> SUPABASE_SERVICE_ROLE_KEY</code> to read leads),
            then reload.
          </p>
          <Link href="/" className="btn-secondary px-5 py-2.5 rounded-lg text-sm inline-block">
            Back to site
          </Link>
        </div>
      </div>
    );
  }

  const store = await cookies();
  if (!(await verifyAdminCookie(store.get(ADMIN_COOKIE)?.value))) {
    redirect("/admin/login");
  }

  const leads = await fetchLeads();
  const subs = await subscriptionOverview();
  const gaps = [
    ...productsMissingFromRegistry().map((id) => `product ${id} has no registry entry`),
    ...intelligencePlansMissingFromRegistry().map((id) => `plan ${id} has no registry entry`),
    ...priceableButNotOnWeb().map((c) => `${c.capability_id} is priced but not on the website`),
    ...unmonetized().map((c) => `${c.capability_id} has no commercial path`),
  ];
  return (
    <>
      <div className="mx-auto w-full max-w-7xl px-5 pt-24 sm:px-8">
        <Link href="/admin/pipeline" className="text-sm text-mute underline hover:text-ghost">
          Engagements and qualified halls →
        </Link>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <StripeHealthPanel />
          <div className="rounded border border-line bg-panel-2 p-4" data-admin="intelligence-subscriptions">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
              Intelligence subscriptions
            </h3>
            {subs === null ? (
              <p className="mt-2 text-[12px] text-flag">
                Unavailable: the subscription store could not be read. This is not a count of zero.
              </p>
            ) : subs.counts.length === 0 ? (
              <p className="mt-2 text-[12px] text-ghost">The store was read and holds no subscription rows.</p>
            ) : (
              <>
                <p className="mt-2 text-[12px] text-ghost">
                  {subs.entitling} entitling (active or past due), before seats.
                  {subs.newestAt ? ` Newest row written ${subs.newestAt}.` : ""}
                </p>
                <ul className="mt-2 space-y-1 text-[12px] text-mute">
                  {subs.counts.map((c) => (
                    <li key={`${c.plan}-${c.status}`}>
                      {c.plan} · {c.status}: {c.rows}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-2 text-[11px] text-faint">Counts only, no addresses. GET /api/admin/subscriptions</p>
          </div>
          <div className="rounded border border-line bg-panel-2 p-4">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
              Capability registry — {CAPABILITY_REGISTRY.length} capabilities
            </h3>
            {gaps.length === 0 ? (
              <p className="mt-2 text-[12px] text-ghost">
                No orphaned products, unpriced-and-invisible capabilities, or unmonetized engine
                capability found.
              </p>
            ) : (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] text-flag">
                {gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-faint">
              Full map: GET /api/admin/capability-audit
            </p>
          </div>
        </div>
      </div>
      <AdminDashboard initial={leads} supabaseReady={supabaseConfigured()} />
    </>
  );
}
