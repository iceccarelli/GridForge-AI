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

// --- Qualifications and purchased deliverables -------------------------------
//
// The qualifications table is the asset the physics is not. Anyone competent can
// rebuild a constraint model; nobody else is accumulating what actually binds in
// real European halls, hall by hall, with the numbers behind it.

export interface AdminQualification {
  id: string;
  created_at: string;
  site_name: string | null;
  hall_id: string | null;
  metro: string | null;
  country: string | null;
  platform: string | null;
  inputs: Record<string, number | string | null>;
  racks_as_found: number | null;
  racks_after_relief: number | null;
  binding_constraint: string | null;
  intake_completeness: number | null;
  name: string | null;
  company: string | null;
  email: string | null;
  source: string;
  status: string;
}

export interface AdminDeliverable {
  id: string;
  created_at: string;
  token: string;
  kind: string;
  status: string;
  email: string | null;
  company: string | null;
  amount_cents: number | null;
  title: string | null;
  released_at: string | null;
  has_document: boolean;
  has_deck: boolean;
}

export async function fetchQualifications(limit = 500): Promise<AdminQualification[]> {
  const c = sb();
  if (!c) return [];
  try {
    const res = await fetch(
      `${c.url}/rest/v1/qualifications?select=*&order=created_at.desc&limit=${limit}`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) {
      console.error("[GridForge] fetchQualifications failed:", await res.text());
      return [];
    }
    return (await res.json()) as AdminQualification[];
  } catch (err) {
    console.error("[GridForge] fetchQualifications error:", err);
    return [];
  }
}

export async function fetchDeliverables(limit = 200): Promise<AdminDeliverable[]> {
  const c = sb();
  if (!c) return [];
  try {
    // Deliberately does not select the document bodies: the pipeline view lists
    // engagements, it does not need to ship two megabytes of HTML to render a row.
    const cols =
      "id,created_at,token,kind,status,email,company,amount_cents,title,released_at," +
      "document_html,deck_html";
    const res = await fetch(
      `${c.url}/rest/v1/deliverables?select=${cols}&order=created_at.desc&limit=${limit}`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) {
      console.error("[GridForge] fetchDeliverables failed:", await res.text());
      return [];
    }
    const rows = (await res.json()) as (AdminDeliverable & {
      document_html: string | null;
      deck_html: string | null;
    })[];
    return rows.map(({ document_html, deck_html, ...r }) => ({
      ...r,
      has_document: Boolean(document_html),
      has_deck: Boolean(deck_html),
    }));
  } catch (err) {
    console.error("[GridForge] fetchDeliverables error:", err);
    return [];
  }
}

export interface ConstraintStat {
  constraint: string;
  halls: number;
  share: number;
}

export interface QualificationInsights {
  halls: number;
  withResult: number;
  constraints: ConstraintStat[];
  medianHeadroomPct: number | null;
  medianTapoffA: number | null;
  medianBuswayA: number | null;
  medianPlantSupplyC: number | null;
  blockedAsFound: number;
  metros: { metro: string; halls: number }[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** What actually binds, across every hall anyone has typed numbers into.
 *  This is the only figure in the business that gets better simply by existing. */
export function summariseQualifications(rows: AdminQualification[]): QualificationInsights {
  const scored = rows.filter((r) => r.binding_constraint);
  const counts = new Map<string, number>();
  for (const r of scored) {
    const k = r.binding_constraint as string;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const constraints: ConstraintStat[] = [...counts.entries()]
    .map(([constraint, halls]) => ({
      constraint,
      halls,
      share: scored.length ? halls / scored.length : 0,
    }))
    .sort((a, b) => b.halls - a.halls);

  const headroom: number[] = [];
  const tapoff: number[] = [];
  const busway: number[] = [];
  const plant: number[] = [];
  for (const r of rows) {
    const contracted = num(r.inputs?.contractedMW);
    const peak = num(r.inputs?.currentPeakMW);
    if (contracted && peak !== null && contracted > 0) {
      headroom.push(((contracted - peak) / contracted) * 100);
    }
    const t = num(r.inputs?.tapoffMaxA);
    if (t) tapoff.push(t);
    const b = num(r.inputs?.buswayAmpacityA);
    if (b) busway.push(b);
    const p = num(r.inputs?.plantSupplyC);
    if (p !== null) plant.push(p);
  }

  const metroCounts = new Map<string, number>();
  for (const r of rows) {
    const m = (r.metro || "").trim();
    if (m) metroCounts.set(m, (metroCounts.get(m) ?? 0) + 1);
  }

  return {
    halls: rows.length,
    withResult: scored.length,
    constraints,
    medianHeadroomPct: median(headroom),
    medianTapoffA: median(tapoff),
    medianBuswayA: median(busway),
    medianPlantSupplyC: median(plant),
    blockedAsFound: scored.filter((r) => (r.racks_as_found ?? 0) === 0).length,
    metros: [...metroCounts.entries()]
      .map(([metro, halls]) => ({ metro, halls }))
      .sort((a, b) => b.halls - a.halls)
      .slice(0, 8),
  };
}
