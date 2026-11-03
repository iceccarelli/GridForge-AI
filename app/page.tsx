import type { Metadata } from "next";
import { JsonLd } from "@/components/JsonLd";
import { SectionNav } from "@/components/SectionNav";
import { Audiences } from "@/components/home/Audiences";
import { Hero } from "@/components/home/Hero";
import { Developers, Evidence, FaqSection, FinalCta, Founder, Problem, Proof, Qualifier, Services, Technology } from "@/components/home/Sections";
import { OG_BASE } from "@/lib/site";

// A Server Component. The page is HTML assembled on the server; only the parts that need the browser are client code, and each of them is
// either a small control (the checkout button, the section navigation, the allowance form) or a tool that mounts when scrolled near (see
// components/home/LazyIsland.tsx). It used to be one client component, so every section's markup also shipped as JavaScript and hydrated.
// A canonical tag can only be set from a Server Component's metadata export, which is the other reason this must not be "use client".
// Title and description are left unset on purpose: they inherit the root layout's default metadata, which already describes the home page.
export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    ...OG_BASE,
    url: "/",
    title: "Time to Power — Power-Capacity Intelligence for AI Infrastructure",
    description:
      "The bottleneck isn't chips — it's power. A Density Screen tells you what binds one hall, how many racks it carries, and the inputs nobody has measured.",
  },
};

export default function Page() {
  return (
    <div className="overflow-hidden">
      <JsonLd />
      <SectionNav />
      <Hero />
      <Audiences />
      <Problem />
      <Proof />
      <Qualifier />
      <Developers />
      <Services />
      <Technology />
      <Evidence />
      <Founder />
      <FaqSection />
      <FinalCta />
    </div>
  );
}
