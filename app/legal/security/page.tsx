import type { Metadata } from "next";
import { LegalShell, Note } from "@/components/LegalShell";

export const metadata: Metadata = { title: "Security" };

export default function Security() {
  return (
    <LegalShell title="Security" updated="June 2026">
      <p>
        We take the confidentiality of your site information seriously. Enquiries
        are transmitted over TLS and shared only with people working on your
        engagement.
      </p>
      <h2 className="text-xl font-semibold text-ghost pt-2">Confidentiality</h2>
      <p>
        Site, load, and interconnection details are treated as confidential. An NDA
        is available on request before you share anything sensitive.
      </p>
      <h2 className="text-xl font-semibold text-ghost pt-2">Disclosure</h2>
      <p>
        If you believe you've found a security issue with this site, please email
        power@gridforge.ai. We'll acknowledge responsible reports promptly.
      </p>
      <Note />
    </LegalShell>
  );
}
