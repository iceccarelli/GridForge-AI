import { SITE } from "@/lib/site";

export const dynamic = "force-static";

/** A vCard for address books and CRMs. Only what the site already publishes: no telephone number and no street address, because there is none to publish. */
export function GET() {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${SITE.name}`,
    `N:;${SITE.name};;;`,
    `ORG:${SITE.name}`,
    `URL:${SITE.url}`,
    `EMAIL;TYPE=INTERNET,WORK:${SITE.email}`,
    `NOTE:${SITE.tagline}. Based in ${SITE.baseLocation}.`,
    "END:VCARD",
  ];
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/vcard; charset=utf-8",
      "content-disposition": 'attachment; filename="time-to-power.vcf"',
      "cache-control": "public, max-age=86400",
    },
  });
}
