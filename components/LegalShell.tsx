import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export function LegalShell({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-32 pb-24">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-mute hover:text-white mb-8"
      >
        <ArrowLeft size={15} /> Back to GridForge AI
      </Link>
      <div className="eyebrow mb-3">LEGAL</div>
      <h1 className="text-4xl font-semibold tracking-tight mb-2">{title}</h1>
      <p className="data text-xs text-faint mb-10">Last updated {updated}</p>
      <div className="space-y-6 text-[15px] text-ghost/80 leading-relaxed legal-body">
        {children}
      </div>
    </div>
  );
}

export function Note() {
  return (
    <div className="panel p-5 border-queue/30 mt-10">
      <div className="eyebrow eyebrow-queue mb-2">TEMPLATE NOTICE</div>
      <p className="text-sm text-mute">
        This is a good-faith starting point, not legal advice. Before launch,
        complete the registered entity details and have it reviewed by counsel
        in your operating jurisdictions (Canada / EU / US as applicable).
      </p>
    </div>
  );
}
