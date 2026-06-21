import type { Metadata } from "next";
import { LegalShell, Note } from "@/components/LegalShell";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  return (
    <LegalShell title="Terms of use" updated="June 2026">
      <p>
        This website is provided for information about GridForge AI's engineering
        services. Nothing here is a binding offer, warranty, or guarantee of any
        specific outcome, efficiency figure, or timeline.
      </p>
      <h2 className="text-xl font-semibold text-ghost pt-2">Market figures</h2>
      <p>
        Statistics on this site describe the broader AI data-center power market
        and are attributed to their public sources. They are not representations of
        GridForge AI's own track record.
      </p>
      <h2 className="text-xl font-semibold text-ghost pt-2">Reference designs</h2>
      <p>
        Architectures shown are engineering reference designs, not delivered
        customer projects. The client portal is an interactive preview populated
        with sample data.
      </p>
      <h2 className="text-xl font-semibold text-ghost pt-2">Engagements</h2>
      <p>
        Any engineering engagement is governed by a separate written agreement
        signed by both parties. In case of conflict, that agreement controls.
      </p>
      <Note />
    </LegalShell>
  );
}
