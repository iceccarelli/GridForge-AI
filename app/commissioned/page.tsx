import type { Metadata } from "next";
import Link from "next/link";
import { deliverableBySession } from "@/lib/deliverables";
import { depositBySession, type DepositStatus } from "@/lib/deposits";
import { accessForSession } from "@/lib/purchase-access";
import { PRODUCT_BY_KIND } from "@/lib/products";

export const metadata: Metadata = {
  title: "Engagement commissioned",
  robots: { index: false, follow: false },
};

/**
 * Resolved per request from the Stripe session, so the customer can start the
 * intake here instead of waiting for an email.
 *
 * Email was the single point of failure between a four- to five-figure purchase
 * and its fulfilment: if Resend refused, or the message landed in spam, the only
 * route to the product the customer had just bought existed solely in a server
 * log. Stripe hands this page the session id, `deliverables.stripe_session_id` is
 * uniquely indexed, and the webhook has already written the row.
 *
 * What is disclosed here is the INTAKE token, never the document token. Since
 * migration 0012 those are different credentials: this one submits the hall's
 * numbers for an engagement that has already been paid for, which is the thing the
 * person who just paid is trying to do. Reading the released engineering opinion
 * still requires the token we only ever send to the customer directly — so a
 * session id in browser history or a referrer header is not a document credential.
 */
export const dynamic = "force-dynamic";

export default async function CommissionedPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id: sessionId } = await searchParams;
  const row = sessionId ? await deliverableBySession(sessionId) : null;
  const intakeToken = row?.intake_token ?? null;
  // An API plan or Hall Watch has no intake: its entitlement is an account/watch behind a private link.
  const access = !row && sessionId ? await accessForSession(sessionId) : { state: "unknown" as const };
  if (access.state !== "unknown") {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-verified">Payment received</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost">
          {access.name} is {access.state === "ready" ? "open" : "being set up"}.
        </h1>
        {access.state === "ready" ? (
          <div className="mt-6 rounded border border-power/40 bg-panel p-5">
            <p className="text-mute text-sm">
              {access.kind === "api"
                ? `Your account is ready${access.units ? ` with ${access.units.toLocaleString("en-IE")} units a month` : ""}. Mint your key there — it is shown once and never stored.`
                : "Your hall is watched from here. Give it the hall's numbers once and it is re-solved every quarter."}
            </p>
            <Link href={access.path} className="mt-4 inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink">
              {access.kind === "api" ? "Open your API access" : "Open your watch"}
            </Link>
            <p className="mt-3 text-[11px] text-faint">
              This link is private to you. A copy is also on its way to the email you paid with; keep it,
              because it is the only way back in.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid gap-3 text-mute">
            <p>
              Your payment has cleared and your {access.kind === "api" ? "account" : "watch"} is being recorded. Reload this page in
              a minute.
            </p>
            <p className="text-faint text-sm">Still nothing after a few minutes? Reply to the Stripe receipt and we will resend the link.</p>
          </div>
        )}
      </main>
    );
  }

  // A deposit opens no intake: a person scopes the work with the buyer. Say so, from the record.
  const deposit = !row && sessionId ? await depositBySession(sessionId) : null;
  if (deposit) {
    const product = PRODUCT_BY_KIND[deposit.kind];
    const stage: Record<DepositStatus, string> = {
      paid: "Payment received. We have not contacted you yet.",
      contacted: "We have contacted you to scope the engagement.",
      scoped: "The scope has been agreed. The work is under way.",
      delivered: "Delivered.",
    };
    return (
      <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-verified">Payment received</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost">
          {product?.name ?? "Your deposit"} is recorded. Next, we scope it with you.
        </h1>
        <div className="mt-6 grid gap-4 text-mute">
          <p>
            This engagement is scoped with you directly — there is no intake form to fill in first. A
            member of the team will contact you at the email you paid with to agree what is being
            studied and what we need from you.
          </p>
          {product ? (
            <p>
              <span className="text-faint">What you receive: </span>
              {product.deliverable}
            </p>
          ) : null}
          <p className="rounded border border-line bg-panel p-4 text-sm">
            <span className="text-faint">Status: </span>
            {stage[deposit.status]}
          </p>
          <p className="text-faint text-sm">
            No contact from us? Reply to the Stripe receipt and we will pick it up.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-verified">Payment received</p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost">
        The engagement is open. Next we need the hall&apos;s numbers.
      </h1>

      {intakeToken ? (
        <div className="mt-6 rounded border border-power/40 bg-panel p-5">
          <p className="text-mute text-sm">
            You can start now — no need to wait for the email.
          </p>
          <Link
            href={`/intake/${intakeToken}`}
            className="mt-4 inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink"
          >
            Open the intake
          </Link>
          <p className="mt-3 text-[11px] text-faint">
            This link is private to this engagement. A copy is on its way to the email you paid
            with, so you can also pick it up later or forward it to whoever holds the hall&apos;s
            figures.
          </p>
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 text-mute">
        <p>
          {intakeToken ? "The intake" : "An intake link is on its way to the email you paid with. It"}{" "}
          asks for the hall&apos;s own numbers: the connection and contracted capacity, what the site
          actually draws, the busway and tap-off ratings, the floor loading, the plant capacity and
          its supply temperature, and the transformer and UPS schedules.
        </p>
        <p>
          If you came from the free qualifier, the numbers you typed there are already filled in —
          check them rather than re-enter them. A Density Screen needs no more than the qualifier
          asked for; the rest it will assume and tell you it assumed.
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
        {intakeToken ? null : (
          <p className="text-faint text-sm">
            No email after a few minutes? Reply to the Stripe receipt and we will resend the link.
          </p>
        )}
      </div>
    </main>
  );
}
