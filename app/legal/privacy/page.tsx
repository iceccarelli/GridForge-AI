import type { Metadata } from "next";
import { LegalShell, Note } from "@/components/LegalShell";

export const metadata: Metadata = { title: "Privacy" };

export default function Privacy() {
  return (
    <LegalShell title="Privacy" updated="June 2026">
      <p>
        GridForge AI collects only the information you choose to share with us —
        typically your name, work email, company, and details about a prospective
        site — for the sole purpose of responding to your request and scoping
        engineering work.
      </p>
      <h2 className="text-xl font-semibold text-ghost pt-2">What we collect</h2>
      <p>
        Contact details and project information you submit through the audit form,
        plus standard server logs. We do not sell personal data, and we do not run
        third-party advertising trackers.
      </p>
      <h2 className="text-xl font-semibold text-ghost pt-2">How we use it</h2>
      <p>
        To reply to you, prepare proposals, and deliver engagements you commission.
        We retain enquiry data only as long as needed for those purposes or as
        required by law.
      </p>
      <h2 className="text-xl font-semibold text-ghost pt-2">Your rights</h2>
      <p>
        You can request access to, correction of, or deletion of your data at any
        time by emailing power@gridforge.ai. Where GDPR applies, you also have the
        right to object to processing and to lodge a complaint with a supervisory
        authority.
      </p>
      <Note />
    </LegalShell>
  );
}
