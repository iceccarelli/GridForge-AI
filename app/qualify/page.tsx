import type { Metadata } from "next";
import { CapacityQualifier } from "@/components/CapacityQualifier";

export const metadata: Metadata = {
  title: "Capacity qualifier — what actually stops your hall | GridForge AI",
  description:
    "Seven numbers in, the binding constraint out. The same power-and-thermal engine that produces our paid capacity study, run against your hall.",
};

export default function QualifyPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-28 sm:px-8">
      <header className="mb-10 max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
          Free · directional · no contact details required
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
          Most halls do not fail on cooling. They fail on a 63 A tap-off.
        </h1>
        <p className="mt-4 text-mute">
          Thirteen constraints across electrical, thermal and physical domains decide how much AI
          compute an existing hall can carry. One of them binds first, and it is rarely the one
          people expect. Give the engine seven numbers you already know and it will tell you which —
          and which of your inputs nobody has actually measured.
        </p>
      </header>

      <CapacityQualifier />

      <section className="mt-12 grid gap-6 sm:grid-cols-3">
        {[
          {
            k: "What you get",
            v: "The binding constraint and why, deployable racks as the hall stands and after relief, the item that sets the date, and the list of inputs still assumed.",
          },
          {
            k: "What you do not",
            v: "Capital cost, programme duration in weeks, the full constraint ladder and the scenario comparison. Those are the paid engagement, and the engine withholds them server-side.",
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
    </main>
  );
}
