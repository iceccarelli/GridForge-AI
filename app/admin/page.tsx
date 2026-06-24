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

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Pipeline — GridForge AI",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  // No password set at all — show setup notice rather than a broken login.
  if (!adminConfigured()) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
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
      </main>
    );
  }

  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    redirect("/admin/login");
  }

  const leads = await fetchLeads();
  return <AdminDashboard initial={leads} supabaseReady={supabaseConfigured()} />;
}
