import Link from "next/link";
import type { ComponentProps } from "react";
import { isStaticFileHref } from "@/lib/static-href";

/** next/link for routes, a plain anchor for files in public/ (see lib/static-href.ts for why). Same props as Link. */
export function FileAwareLink({ href, children, prefetch: _prefetch, ...rest }: ComponentProps<typeof Link>) {
  const h = typeof href === "string" ? href : (href.pathname ?? "");
  if (typeof href === "string" && isStaticFileHref(h)) {
    const { replace: _r, scroll: _s, shallow: _sh, locale: _l, legacyBehavior: _lb, passHref: _ph, ...anchor } = rest as Record<string, unknown>;
    return (
      <a href={href} {...(anchor as ComponentProps<"a">)}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}
