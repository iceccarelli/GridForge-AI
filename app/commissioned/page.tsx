import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Engagement commissioned | GridForge AI",
  robots: { index: false, follow: false },
};

export default function CommissionedPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-verified">Payment received</p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost">
        The engagement is open. Next we need the hall&apos;s numbers.
      </h1>
      <div className="mt-6 grid gap-4 text-mute">
        <p>
          An intake link is on its way to the email you paid with. It asks for thirteen numbers a
          facilities engineer already has: the connection and contracted capacity, what the site
          actually draws, the busway and tap-off ratings, the floor loading, the plant capacity and
          its supply temperature, and the transformer and UPS schedules.
        </p>
        <p>
          Anything you cannot supply is filled from a library default and named as an assumption in
          the document. Nothing is invented silently, and the list of assumptions is part of what
          you receive — it is the data request to hand your own engineers.
        </p>
        <p>
          Once submitted, the document is generated and reviewed by a senior engineer before it is
          released to you. We do not publish an engineering opinion nobody has read.
        </p>
        <p className="text-faint text-sm">
          No email after a few minutes? Reply to the Stripe receipt and we will resend the link.
        </p>
      </div>
    </main>
  );
}
