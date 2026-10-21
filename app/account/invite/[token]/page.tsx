import type { Metadata } from "next";
import InviteClient from "./InviteClient";

export const dynamic = "force-dynamic";
// The secret is in this URL: keep it out of search indexes and out of any Referer header the page's own requests could send.
export const metadata: Metadata = {
  title: "Your invitation",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteClient token={token} />;
}
