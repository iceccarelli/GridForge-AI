import type { Metadata } from "next";
import { OG_BASE } from "@/lib/site";
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
        release. Scoped engagements (including the Single-Hall Feasibility Study
        and Portfolio Screen) begin with an engagement reservation deposit;
        work starts only after scope, fee (within the published band) and
        turnaround are agreed in writing.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">2. Fees, currencies and VAT</h2>
      <p>
        All published prices and unit rates are stated in euros (EUR) exclusive
        of applicable value-added tax (VAT) or sales tax. Where required by law,
        applicable VAT is calculated and added at Stripe checkout, or accounted
        for under the B2B reverse-charge mechanism where a valid VAT
        identification number is supplied.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">3. Metered API and MCP usage</h2>
      <p>
        The free qualifier and estimator require no API key. Metered operations
        on the GridForge Engine are billed per unit at the published catalogue
        rate (€2 per unit after the 25-unit one-time free allowance on eligible
        accounts). Pay-as-you-go usage is settled monthly in arrears for net
        successful units (charges minus automatic refunds for failed, rejected
        or invalid calls). Monthly balances below the €5 minimum invoice carry
        forward; usage stops at the account spend cap (HTTP 402) until raised
        or settled.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">4. Refunds, credits and billing holds</h2>
      <p>
        Engagement reservation deposits are credited in full toward the agreed
        engagement fee, and are refundable in full if we decline the engagement
        or if you cancel before scope is confirmed. Where a prior Density Screen
        was purchased and kept in good standing for the same hall, its fee
        credits toward the Single-Hall Study as stated in the catalogue; a
        refunded or disputed purchase carries no credit. A full refund or open
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
