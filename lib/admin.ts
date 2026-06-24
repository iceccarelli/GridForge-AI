// Server-only helpers for the founder admin dashboard: a lightweight password
// gate (single founder, internal use) and the Supabase read/update data layer.
//
// Auth model: a SHA-256 of ADMIN_PASSWORD is stored in an httpOnly cookie. It
// can't be forged without the password, and we compare in constant time. This
// is a deliberate, honest "simple gate" for one operator — swap for Supabase
// Auth / Clerk when real *clients* get portal logins. Never import this file
// from a client component.

import crypto from "node:crypto";

export const ADMIN_COOKIE = "gf_admin";

export function adminConfigured(): boolean {
  return !!process.env.ADMIN_PASSWORD;
}

/** The cookie value we set on login: sha256(ADMIN_PASSWORD). */
export function adminToken(): string | null {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return null;
  return crypto.createHash("sha256").update(pw).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Login check: does the submitted password match ADMIN_PASSWORD? */
export function checkPassword(input: string): boolean {
  const pw = process.env.ADMIN_PASSWORD;
  return !!pw && safeEqual(input, pw);
}

/** Request check: is this cookie a valid admin session? */
export function verifyAdminCookie(value: string | undefined): boolean {
  const token = adminToken();
  return !!token && !!value && safeEqual(value, token);
}

// --- Supabase data layer (service-role; server-only) -------------------------
export type LeadStatus =
  | "new"
  | "reviewed"
  | "call_booked"
  | "proposal"
  | "won"
  | "lost";

export interface AdminLead {
  id: string;
  created_at: string;
  name: string;
  company: string;
  email: string;
  location: string;
  capacity_mw: number | null;
  urgency: string;
  grid_status: string;
  services: string[];
  message: string;
  context: string;
  source: string;
  score: number;
  tier: "hot" | "warm" | "exploratory";
  reasons: string[];
  status: LeadStatus;
}

export const LEAD_STATUSES: LeadStatus[] = [
  "new",
  "reviewed",
  "call_booked",
  "proposal",
  "won",
  "lost",
];

function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  // New secret keys (sb_secret_…) are NOT JWTs and must be sent ONLY on the
  // apikey header — sending them as a Bearer token returns 401. Legacy
  // service_role JWTs need the Bearer header to elevate the Postgres role.
  const headers: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  return { url, headers };
}

export function supabaseConfigured(): boolean {
  return sb() !== null;
}

export async function fetchLeads(): Promise<AdminLead[]> {
  const c = sb();
  if (!c) return [];
  try {
    const res = await fetch(
      `${c.url}/rest/v1/leads?select=*&order=created_at.desc`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) {
      console.error("[GridForge] fetchLeads failed:", await res.text());
      return [];
    }
    return (await res.json()) as AdminLead[];
  } catch (err) {
    console.error("[GridForge] fetchLeads error:", err);
    return [];
  }
}

export async function updateLeadStatus(
  id: string,
  status: LeadStatus
): Promise<boolean> {
  const c = sb();
  if (!c) return false;
  try {
    const res = await fetch(`${c.url}/rest/v1/leads?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...c.headers, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ status }),
    });
    return res.ok;
  } catch (err) {
    console.error("[GridForge] updateLeadStatus error:", err);
    return false;
  }
}
