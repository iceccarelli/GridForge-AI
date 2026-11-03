import { SITE, siteUrl } from "@/lib/site";

/**
 * RFC 9116 `Expires` is required and must not be stale. Rather than a date typed into a file that silently lapses, it is the end of the
 * month six months ahead of `now`: always a real future commitment, and stable within a month (so it caches).
 */
export function securityTxtExpires(now: Date = new Date()): string {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 7, 1, 0, 0, 0)); // first of the seventh month ahead = end of the sixth
  return end.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The disclosure address app/legal/security already publishes; no Encryption line (there is no key) and no Acknowledgments page (there is none). */
export function securityTxt(now: Date = new Date()): string {
  return [
    `Contact: mailto:${SITE.email}`,
    `Expires: ${securityTxtExpires(now)}`,
    "Preferred-Languages: en",
    `Canonical: ${siteUrl("/.well-known/security.txt")}`,
    `Policy: ${siteUrl("/legal/security")}`,
    "",
  ].join("\n");
}
