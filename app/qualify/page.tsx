import type { Metadata } from "next";
import { OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { PageJsonLd } from "@/components/PageJsonLd";
import { breadcrumbJsonLd, qualifierJsonLd } from "@/lib/jsonld";
import { BindingConstraintInsights } from "@/components/BindingConstraintInsights";
import { CapacityQualifier } from "@/components/CapacityQualifier";
import { TtpPhoto } from "@/components/TtpPhoto";
import { loadWorkedResult, referenceLimitSentence } from "@/lib/worked-result";
import { QUALIFY_ASSUMED_FIELDS_FLAG, engineHas } from "@/lib/engine-capabilities";
import { engineConfigured } from "@/lib/qualify";
import { constraintReference } from "@/lib/constraints";
import { constraintSlugsByName } from "@/lib/constraint-links";

// Whether the reference-template selector is shown follows the DEPLOYED engine (its /v1/version `capabilities`), not the last build of this site.
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Free capacity check — what binds your hall",
  description:
    "Seven numbers in, the binding constraint out. The same power-and-thermal engine that produces our paid capacity study, run against your hall.",
  alternates: { canonical: "/qualify" },
  twitter: { card: "summary_large_image", images: pageImages("qualify") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("qualify"),
    title: "Free capacity check — what stops your hall taking AI racks",
    description:
      "Seven numbers in, the binding constraint out. No card, no call, no contact details required.",
    url: "/qualify",
  },
};

export default async function QualifyPage() {
  // The selector appears only when the live engine says it can label a template's figures as assumed; otherwise the form is exactly as it was.
  // It also needs the engine this deployment can actually call (the test /api/qualify applies): never offered where that route answers 503.
  const presetsAvailable = engineConfigured() && (await engineHas(QUALIFY_ASSUMED_FIELDS_FLAG));
  // About our synthetic reference hall only, read from the engine's committed output (lib/worked-result.ts); never a claim about halls in general.
  const limit = referenceLimitSentence(loadWorkedResult());
  // Constraint name -> page slug, from the published reference, so the answer's constraint names link to their pages. A name the map lacks is shown as text.
  const constraintSlugs = constraintSlugsByName(await constraintReference());
  return (
    <div className="mx-auto w-full max-w-6xl px-5 pb-24 pt-28 sm:px-8">
      <PageJsonLd
        data={[
          qualifierJsonLd(),
          breadcrumbJsonLd([
            { name: "Time to Power", path: "/" },
            { name: "Capacity qualifier", path: "/qualify" },
          ]),
        ]}
      />
      <header className="mb-10 max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
          Free · directional · no contact details required
        </p>
        <h1 className="page-title mt-3">Which limit binds first in your hall?</h1>
        <p className="mt-4 text-mute">
          {limit} Your hall may differ, which is what this check is for. Thirteen constraints across electrical, thermal and physical
          domains decide how much AI compute an existing hall can carry, and one of them binds first. Give the engine seven numbers you
          already know and it will tell you which, and which of your inputs nobody has actually measured.
        </p>
      </header>

      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-8 items-start">
        <div>
          <CapacityQualifier presetsAvailable={presetsAvailable} constraintSlugs={constraintSlugs} />

          <p className="mt-6 text-sm text-mute">
            Want to see what the paid study looks like before you ask?{" "}
            <a href="/reference" className="text-power underline">
              Read one in full
            </a>{" "}
            — the whole document, the deck, and the tables behind every number.
          </p>
          <p className="mt-3 text-sm text-mute">
            No figures to hand yet? The{" "}
            <a href="/power/compare" className="text-power underline">
              scenario comparison
            </a>{" "}
            can start from a reference template: synthetic input values, labelled as assumed, so you can watch the engine work before you
            gather your own hall&apos;s figures.
          </p>
        </div>

        <div className="hidden lg:flex flex-col gap-5">
          <TtpPhoto
            id="ttp-04"
            className="rounded-2xl overflow-hidden border border-line aspect-[3/2]"
          />
          <TtpPhoto
            id="ttp-05"
            className="rounded-2xl overflow-hidden border border-line aspect-[3/2]"
            hideCaption
          />
        </div>
      </div>

      <section className="mt-12 panel p-6 sm:p-8">
        <BindingConstraintInsights />
      </section>

      <section className="mt-12 grid gap-6 sm:grid-cols-3">
        {[
          {
            k: "What you get",
            v: "The binding constraint and why, deployable racks as the hall stands and after relief, the item that sets the date, and the list of inputs still assumed.",
          },
          {
            k: "Where the paid line is",
            v: "The free qualifier shows the binding constraint and the rack count. The free Time-to-Power comparison also shows scenarios with indicative capital cost and time to full capacity, each with its evidence class, and a time that rests on an assumed lead time is labelled as one, not as a date. What is paid is human-reviewed engagements, and metered engine usage beyond the free allowance. Engagements are screening-mode assessments, not an issued engineering opinion.",
          },
          {
            k: "Why it is honest",
            v: "Every figure carries an evidence class. A value you supply is customer data; a value we fall back to is an assumption, and it is named as one. A model applied to measured data stays a model.",
          },
        ].map((c) => (
          <div key={c.k} className="panel p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{c.k}</p>
            <p className="mt-2 text-sm text-mute">{c.v}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
