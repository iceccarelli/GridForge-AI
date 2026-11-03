import { FAQ } from "@/lib/site";

// Native <details>: keyboard operable, announced as expandable by every screen reader, works with no script and no framework, and is
// part of the server-rendered HTML a crawler reads. The previous accordion shipped client code (state and an animation library) for this.

export function Faq() {
  return (
    <div className="divide-y divide-line border-y border-line">
      {FAQ.map((f) => (
        <details key={f.q} className="group py-5">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 text-left [&::-webkit-details-marker]:hidden">
            <span className="text-lg font-medium text-ghost">{f.q}</span>
            <span aria-hidden className="shrink-0 text-mute transition-transform group-open:rotate-180">⌄</span>
          </summary>
          <p className="pr-8 pt-3 leading-relaxed text-mute">{f.a}</p>
        </details>
      ))}
    </div>
  );
}
