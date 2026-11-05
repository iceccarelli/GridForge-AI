import Link from "next/link";
import { SITE } from "@/lib/site";

/**
 * What a private link (a deliverable, a Hall Watch) says when its token matches nothing.
 *
 * It used to be a heading and one sentence ("reply to the email it came in") with no link and no address, so a buyer whose
 * link had been truncated by a mail client had nowhere to go. This names the usual cause, the address to write to and the
 * two pages that still work without the link.
 */
export function LinkNotFound({ what }: { what: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8" data-testid="link-not-found">
      <h1 className="text-2xl font-semibold text-ghost">We could not find {what}</h1>
      <p className="mt-3 max-w-2xl text-mute">
        This link does not match {what}. The usual cause is a link cut short by an email client or a chat app: open the
        original message and use the whole address, which ends in a long run of letters and digits.
      </p>
      <p className="mt-3 max-w-2xl text-mute">
        If that does not help, write to{" "}
        <a href={`mailto:${SITE.email}`} className="text-power underline">
          {SITE.email}
        </a>{" "}
        and say which engagement it is.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-x-6">
        <Link href="/contact" className="inline-flex min-h-11 items-center text-power underline">
          How to reach us
        </Link>
        <Link href="/products" className="inline-flex min-h-11 items-center text-power underline">
          The engagements
        </Link>
      </div>
    </div>
  );
}
