import Link from "next/link";
import { AVAILABILITY_UNCONFIRMED, NOT_YET_AVAILABLE } from "@/lib/payg-pricing";

/**
 * What /power/compare and /power/deploy show instead of a form while the deployed engine does not serve the route
 * behind it. A form that can only answer 503 is a promise the site cannot keep, so it is not rendered at all. The page
 * is checked against the engine's own /v1/version at most every five minutes, so the form returns by itself after the
 * engine release that serves the route, with no site redeploy.
 */
export function NotYetAvailable({
  what,
  unreadable,
  alternative,
}: {
  /** The capability, as a noun phrase: "The scenario comparison". */
  what: string;
  /** The engine could not be read at all (as opposed to being read and not listing the route). */
  unreadable: boolean;
  alternative: { href: string; label: string };
}) {
  return (
    <section
      role="status"
      data-engine-route-state={unreadable ? "unknown" : "unavailable"}
      className="mt-8 max-w-3xl rounded border border-line bg-panel-2 p-6"
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-queue">
        {unreadable ? AVAILABILITY_UNCONFIRMED : NOT_YET_AVAILABLE}
      </p>
      <p className="mt-3 text-sm text-mute">
        {what} is not available yet: the engine release that serves it has not been deployed
        {unreadable ? " (or the engine could not be reached just now to confirm it)" : ""}. There is no form to fill in
        because it could only fail. Nothing is calculated, saved or charged on this page, and it opens by itself once the
        release is live.
      </p>
      <Link href={alternative.href} className="mt-4 inline-block text-sm text-power underline">
        {alternative.label}
      </Link>
    </section>
  );
}
