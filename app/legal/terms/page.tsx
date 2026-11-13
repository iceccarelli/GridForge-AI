import type { Metadata } from "next";
import { OG_BASE } from "@/lib/site";
import { PAYG } from "@/lib/products";
import { eurExact } from "@/lib/payg-pricing";
import { pageImages } from "@/lib/page-cards";
import { LegalShell, Note } from "@/components/LegalShell";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "The terms on which Time to Power sells screening opinions, engineering studies, subscriptions and metered API access.",
  alternates: { canonical: "/legal/terms" },
  twitter: { card: "summary_large_image", images: pageImages("terms") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("terms"), url: "/legal/terms", title: "Terms", description: "The terms on which Time to Power sells screening opinions, engineering studies, subscriptions and metered API access.", },
};

export default function Terms() {
  // The metered rate, the free allowance and the minimum invoice are the catalogue's (PAYG in lib/products.ts, mirrored by the engine),
  // never typed here: a contract page that disagrees with checkout is worse than no page.
  const rate = `${eurExact(PAYG.unitPriceCents)} per unit after the ${PAYG.freeAllowanceUnits}-unit monthly free allowance`;
  const minimumInvoice = `${eurExact(PAYG.minInvoiceCents)} minimum invoice`;
  return (
    <LegalShell title="Terms of use" updated="November 2026">
      <p>
        This website and the GridForge Engine are provided for commercial
        power-capacity screening and engineering assessments of existing data
        halls. Planning-grade screening outputs identify binding electrical,
        thermal, hydraulic and physical constraints from declared or measured
        inputs; they are not an issued, stamped engineering opinion unless
        expressly contracted under a separate written engagement agreement.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">1. Products, deliverables and engagements</h2>
      <p>
        Self-serve deliverables (including the Density Screen and Procurement
        Specification) are generated from the hall figures submitted through
        your private intake link and reviewed by a named engineer before
        release. Scoped engagements (including the Capacity &amp; Density Envelope
        Study and the Portfolio Screen) begin with an engagement reservation deposit;
        work starts only after scope, fee (within the published band) and
        turnaround are agreed in writing.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">2. Fees, currencies and VAT</h2>
      <p>
        All published prices and unit rates are stated in euros (EUR). How tax
        applies to a purchase is not yet stated on this page; ask before you
        buy.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">3. Metered API and MCP usage</h2>
      <p>
        The free qualifier and estimator require no API key. Metered operations
        on the GridForge Engine are billed per unit at the published catalogue
        rate ({rate} on eligible
        accounts). Pay-as-you-go usage is settled monthly in arrears for net
        successful units (charges minus automatic refunds for failed, rejected
        or invalid calls). Monthly balances below the {minimumInvoice} carry
        forward; usage stops at the account spend cap (HTTP 402) until raised
        or settled.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">4. Refunds, credits and billing holds</h2>
      <p>
        Engagement reservation deposits are credited toward the agreed engagement
        fee. Refund terms are not yet stated on this page; ask before you buy.
        A Density Screen you have already paid for can be credited once against
        the same fee after we confirm it is the same buyer (the email address
        typed at checkout is not verified); a refunded or disputed purchase
        carries no credit. A full refund or open
        chargeback suspends access to the corresponding deliverable,
        subscription or API account while the hold stands.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">5. Market figures and reference designs</h2>
      <p>
        Interconnection-queue statistics, retail electricity prices and
        equipment lead-time ranges on this site are attributed to their cited
        public sources or stated as labelled library assumptions (E0/E1).
        Reference templates and Observatory scenarios are synthetic reference
        designs, not measurements of a customer asset.
      </p>
      <Note />
    </LegalShell>
  );
}
