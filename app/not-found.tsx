import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-[80vh] flex items-center justify-center px-6 blueprint">
      <div className="text-center max-w-md">
        <div className="data text-power text-7xl font-semibold tracking-tight">
          404
        </div>
        <h1 className="text-2xl font-semibold tracking-tight mt-4 mb-3">
          No power at this address.
        </h1>
        <p className="text-mute mb-8">
          The page you're looking for isn't on the grid. Let's get you back to a
          live circuit.
        </p>
        <Link
          href="/"
          className="btn-primary px-7 py-3.5 rounded-xl text-sm inline-flex items-center gap-2"
        >
          <ArrowLeft size={16} /> Back home
        </Link>
      </div>
    </div>
  );
}
