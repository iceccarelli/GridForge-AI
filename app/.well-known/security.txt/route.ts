import { securityTxt } from "@/lib/security-txt";

export const dynamic = "force-dynamic";

/** GET /.well-known/security.txt (RFC 9116); see lib/security-txt.ts. */
export function GET() {
  return new Response(securityTxt(), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
