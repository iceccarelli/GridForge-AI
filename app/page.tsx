import type { Metadata } from "next";
import { HomeClient } from "@/components/HomeClient";

// A canonical tag can only be set from a Server Component's metadata export,
// and this page's content is a client component (state, scroll listeners,
// framer-motion) — same split as app/workspace/page.tsx. Title and
// description are left unset here on purpose: they inherit the root
// layout's default metadata, which already describes the home page.
export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { url: "/" },
};

export default function Page() {
  return <HomeClient />;
}
