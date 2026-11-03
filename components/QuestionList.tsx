import { PageJsonLd } from "@/components/PageJsonLd";
import type { QA } from "@/lib/qa";

/**
 * The questions section of a page, visible, with the FAQPage structured data built from the very same array. A question that is in the
 * markup is on the page; there is no way to add one to the one without the other.
 */
export function QuestionList({ id, heading = "Common questions", items }: { id: string; heading?: string; items: QA[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-12" aria-labelledby={id}>
      <PageJsonLd
        data={[
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: items.map((i) => ({ "@type": "Question", name: i.q, acceptedAnswer: { "@type": "Answer", text: i.a } })),
          },
        ]}
      />
      <h2 id={id} className="text-xl font-semibold text-ghost">
        {heading}
      </h2>
      <dl className="mt-4 space-y-5">
        {items.map((i) => (
          <div key={i.q}>
            <dt className="font-semibold text-ghost">{i.q}</dt>
            <dd className="mt-1 text-[15px] leading-relaxed text-mute">{i.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
