import type { Metadata } from "next";
import { OG_IMAGES } from "@/lib/site";
import { HomeClient } from "@/components/HomeClient";

// A canonical tag can only be set from a Server Component's metadata export,
// and this page's content is a client component (state, scroll listeners,
// framer-motion) — same split as app/workspace/page.tsx. Title and
// description are left unset here on purpose: they inherit the root
// layout's default metadata, which already describes the home page.
export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    url: "/",
    images: OG_IMAGES,
    title: "Time to Power — Power-Capacity Intelligence for AI Infrastructure",
    description:
      "The bottleneck isn't chips — it's power. A Density Screen tells you what binds one hall, how many racks it carries, and the inputs nobody has measured.",
  },
};

export default function Page() {
  return <HomeClient />;
}
