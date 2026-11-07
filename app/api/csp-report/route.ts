import { NextResponse } from "next/server";
import { readBoundedJson } from "@/lib/http-body";
import { guardRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Receives Content-Security-Policy-Report-Only violation reports (lib/security-headers.ts sends browsers here). It exists to tell us what an
 * enforced policy would block, so it keeps exactly two facts per report: the violated DIRECTIVE name and the blocked source's ORIGIN. It never logs
 * a full address, path, query, fragment, the page the visitor was on, or a script sample: those can carry a capability token or personal data.
 *
 * Bounded like any unauthenticated write: 8 KB body, the repo's per-caller rate limit, and nothing stored. Always 204 for a well-formed report.
 */
const MAX_BODY_BYTES = 8 * 1024;

/** A directive name, or "unknown": anything that is not a plain lowercase directive token cannot reach a log line. */
function directiveOf(v: unknown): string {
  const first = typeof v === "string" ? v.trim().split(/\s+/)[0] : "";
  return /^[a-z][a-z-]{1,39}$/.test(first) ? first : "unknown";
}

/** The origin of a blocked source, or one fixed word. Paths, queries and fragments are dropped before anything is logged. */
function blockedOf(v: unknown): string {
  if (typeof v !== "string" || v === "") return "none";
  if (v === "inline" || v === "eval" || v === "data" || v === "self" || v === "wasm-eval") return v;
  if (v.length > 2048) return "other";
  if (/^blob:/i.test(v)) return "blob";
  if (/^data:/i.test(v)) return "data";
  try {
    const u = new URL(v);
    if ((u.protocol === "https:" || u.protocol === "http:" || u.protocol === "wss:" || u.protocol === "ws:") && u.origin.length <= 120) return u.origin;
  } catch {
    /* not a URL */
  }
  return "other";
}

/** The legacy `{ "csp-report": {...} }` shape (application/csp-report) and the Reporting API list (application/reports+json). */
function fieldsOf(value: unknown): { directive: string; blocked: string } {
  const root = Array.isArray(value) ? value[0] : value;
  const obj = (root && typeof root === "object" ? root : {}) as Record<string, unknown>;
  const legacy = (obj["csp-report"] && typeof obj["csp-report"] === "object" ? obj["csp-report"] : null) as Record<string, unknown> | null;
  const modern = (obj.body && typeof obj.body === "object" ? obj.body : null) as Record<string, unknown> | null;
  if (legacy) return { directive: directiveOf(legacy["effective-directive"] ?? legacy["violated-directive"]), blocked: blockedOf(legacy["blocked-uri"]) };
  if (modern) return { directive: directiveOf(modern.effectiveDirective ?? modern.violatedDirective), blocked: blockedOf(modern.blockedURL ?? modern["blocked-uri"]) };
  return { directive: "unknown", blocked: "none" };
}

export async function POST(req: Request) {
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.status === 413 ? "Report too large." : "Invalid report." }, { status: read.status });
  const g = await guardRequest(req, "csp_report");
  if (g.denied) return g.denied;
  const { directive, blocked } = fieldsOf(read.value);
  console.warn(`[GridForge] csp report-only violation: directive=${directive} blocked=${blocked}`);
  return new NextResponse(null, { status: 204 });
}
