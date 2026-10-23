import type { Metadata } from "next";
import { LegalShell, Note } from "@/components/LegalShell";
import { SITE, OG_IMAGES } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What this site does with what you give it: what is collected, where it is stored, who processes it, and how long it is kept.",
  alternates: { canonical: "/legal/privacy" },
  openGraph: { url: "/legal/privacy", title: "Privacy", description: "What this site does with what you give it: what is collected, where it is stored, who processes it, and how long it is kept.", images: OG_IMAGES },
};

/**
 * A factual description of what this site does with what you give it, written from the code in this repository and
 * nothing else. It makes no compliance claim and no retention promise, because the code implements neither: there is no
 * scheduled deletion of any table. It is marked for the operator's legal review and is not legal advice.
 */
const SERVICES: { name: string; role: string; receives: string }[] = [
  {
    name: "Supabase",
    role: "Database and sign-in.",
    receives:
      "Everything the site stores: qualifier runs, enquiries and chat leads, engagements, projects, API accounts, usage records, notification records, and the email address used for passwordless sign-in.",
  },
  {
    name: "Stripe",
    role: "Payments and invoices.",
    receives:
      "Your email, company name where given, and the card details you type on Stripe's own checkout page. Card details never reach this site's servers. Stripe sends back payment status, invoices and the identifiers we store against your account.",
  },
  {
    name: "Resend",
    role: "Transactional email.",
    receives:
      "The recipient address and the text of the message: links to your private pages (API access, engagement, deliverable, watch), receipts, notices and enquiry confirmations.",
  },
  {
    name: "Anthropic",
    role: "The AI scoping chat, the siting analyst and the extraction of lead details from a chat.",
    receives:
      "What you type into the chat or the siting analyst, the conversation so far, and the results of the engine calls the assistant makes on your behalf. A chat can also be processed to pull out structured lead fields (capacity, location, name, company, email) if you give them.",
  },
  {
    name: "Vercel",
    role: "Hosts the website and its server routes.",
    receives: "Every request to the site, including the request logs a host keeps, and the data in forms you submit while it passes through.",
  },
  {
    name: "Fly.io",
    role: "Hosts the capacity engine (configured in this repository with Amsterdam as its primary region).",
    receives:
      "The figures sent to the engine to be solved: the seven qualifier numbers and the platform, the intake of a paid engagement, and calls made with an API key or by an AI client over MCP. The engine's usage ledger records the account, endpoint, units, and the optional project label you send.",
  },
];

export default function Privacy() {
  return (
    <LegalShell title="Privacy" updated="October 2026">
      <p>
        This page describes, factually, what the Time to Power site does with the information you give it and which services
        it passes that information to. It is written from the site&apos;s own code. It is a draft for the operator&apos;s legal
        review, not legal advice, and it states no legal conclusion.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">What is stored</h2>
      <ul className="list-disc space-y-2 pl-6">
        <li>
          <strong className="text-ghost">The free capacity check.</strong> The numbers you enter, the optional site name, hall
          id, metro, country, platform, your name, company and email if you give them, and the engine&apos;s result (racks,
          binding constraint, completeness) are stored in the database. The result has a private link: anyone who holds it can
          read that stored read. An anonymised, aggregated comparison across stored reads is shown to others only above a
          minimum number of halls.
        </li>
        <li>
          <strong className="text-ghost">Enquiries and chat.</strong> The audit form and the scoping chat can store a lead:
          capacity, location, urgency, message, name, company and email, as you gave them.
        </li>
        <li>
          <strong className="text-ghost">Engagements and projects.</strong> What you buy, the intake you submit, the documents
          produced for you, the projects and comparisons you save, and the accepted supplier quotations recorded against them.
        </li>
        <li>
          <strong className="text-ghost">API accounts.</strong> Your email, company, plan, the identifier of your current key
          (never the key itself), billing identifiers from Stripe, and a ledger of metered calls with the endpoint, units and any
          project label you send.
        </li>
        <li>
          <strong className="text-ghost">Server logs.</strong> The site keeps its own logs to a deliberate minimum: error
          categories, with email addresses and private link tokens removed. Your host keeps its own request logs.
        </li>
      </ul>

      <h2 className="text-xl font-semibold text-ghost pt-2">Services that receive it</h2>
      <p>These are the third-party services this site&apos;s code sends data to, and what each one receives.</p>
      <div className="space-y-4">
        {SERVICES.map((s) => (
          <div key={s.name} className="panel p-4">
            <p className="font-semibold text-ghost">
              {s.name} <span className="font-normal text-mute">: {s.role}</span>
            </p>
            <p className="mt-1 text-sm text-mute">{s.receives}</p>
          </div>
        ))}
      </div>
      <p>
        If an operator has configured one, a notification about a high-scoring enquiry, including the company, capacity, location and
        email you gave, can also be posted to an internal Slack channel. Released documents, which you open from a private
        link, load their fonts from Google Fonts, so opening one makes a request from your browser to Google.
      </p>
      <p>
        The code of this site includes no advertising or analytics scripts. Nothing in it sells personal data.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">In your browser</h2>
      <p>
        Signing in stores a session in your browser. The workspace keeps your conversation and the last project link you used in
        your browser&apos;s local storage. After a Stripe checkout for pay-as-you-go, a cookie that lasts one hour carries you
        back to your account page and is then cleared. Private links (API access, engagement, deliverable, watch, project) are
        the credential for what they open: anyone holding one can open it.
      </p>

      <h2 className="text-xl font-semibold text-ghost pt-2">Keeping and deleting</h2>
      <p>
        No automatic deletion is built into the site: records stay until they are removed. To ask what is held about you, to
        have it corrected or removed, write to {SITE.email}.
      </p>
      <Note />
    </LegalShell>
  );
}
