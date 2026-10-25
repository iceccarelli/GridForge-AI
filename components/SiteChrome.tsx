"use client";

import { usePathname } from "next/navigation";

// Routes that render with none of the site shell (navigation, footer, sticky call to action, the scoping assistant). The
// Observatory presenter is recorded and streamed, so its page must carry no link to an account, admin or purchase, and
// nothing in it may call the site's APIs.
const BARE_PREFIXES = ["/observatory/presenter"];

export function isBareRoute(pathname: string | null | undefined): boolean {
  return Boolean(pathname) && BARE_PREFIXES.some((p) => pathname === p || pathname!.startsWith(`${p}/`));
}

export function SiteChrome({ children }: { children: React.ReactNode }) {
  return isBareRoute(usePathname()) ? null : <>{children}</>;
}
