import type { Metadata } from "next";

// Signed-in and operator screens: blocked in robots.txt, and also marked noindex here because a URL that is only blocked
// can still be listed when other pages link to it (the portal link is in the site-wide navigation).
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
