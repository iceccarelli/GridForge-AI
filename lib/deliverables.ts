// Server-only data layer for purchased deliverables.
//
// The lifecycle is deliberate. Paying does not produce a document by itself —
// the client still has to supply the hall's numbers, and a human still releases
// the result. Automating generation is leverage; automating the release would be
// selling an unreviewed engineering opinion, which is the one thing this whole
// codebase exists to refuse.
//
//   awaiting_intake -> generating -> draft -> released
//                                 \-> engine_unavailable
//
// Access is by unguessable token in the URL. That is appropriate for a document
// the holder paid for and was emailed a link to; it is not an identity system,
// and the page says so.

import crypto from "node:crypto";
import { storeFault } from "@/lib/safe-log";
import { PRODUCTS, PRODUCT_BY_KIND } from "./products";

export const DELIVERABLE_STATUSES = [
  "awaiting_intake",
  "generating",
  "draft",
  "released",
  "engine_unavailable",
] as const;

export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export interface DeliverableRecord {
  id: string;
  token: string;
  kind: string;
  status: DeliverableStatus;
  email: string | null;
  company: string | null;
  qualification_id: string | null;
  /**
   * Grants one thing: submit this engagement's numbers.
   *
   * Separate from `token`, which reads the released document. Splitting them is
   * what lets /commissioned show the intake link at the moment of payment without
   * turning a Stripe session id into a document credential.
   */
  intake_token: string | null;
  stripe_session_id: string | null;
  amount_cents: number | null;
  intake: Record<string, unknown> | null;
  document_html: string | null;
  document_md: string | null;
  deck_html: string | null;
  working_files: Record<string, string> | null;
  title: string | null;
  created_at?: string;
  released_at?: string | null;
}

export function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function creds(): { url: string; headers: Record<string, string> } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  return { url, headers: { ...auth, "Content-Type": "application/json" } };
}

export async function createDeliverable(
  row: Partial<DeliverableRecord> & { kind: string }
): Promise<DeliverableRecord | null> {
  const token = row.token ?? newToken();
  const intakeToken = row.intake_token ?? newToken();
  const record = {
    status: "awaiting_intake" as DeliverableStatus,
    ...row,
    token,
    intake_token: intakeToken,
  };
  const c = creds();
  if (!c) {
    console.log("[GridForge] deliverable (not persisted — Supabase unset):", JSON.stringify(record));
    return { ...(record as DeliverableRecord), id: "local" };
  }
  const insert = (payload: Record<string, unknown>) =>
    fetch(`${c.url}/rest/v1/deliverables`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "return=representation" },
      body: JSON.stringify(payload),
    });

  let res = await insert(record);

  // The deploy window.
  //
  // Code ships before its migration runs — that is the ordinary order of things,
  // and the standing order deploys before applying 0009-0012. PostgREST does not
  // ignore an unknown column, it refuses the whole insert with PGRST204. So for as
  // long as 0012 is unapplied, EVERY purchase would fail to open an engagement,
  // the webhook would return 500, and Stripe would retry until it gave up: a
  // payment taken and nothing delivered, on the primary cash product.
  //
  // So the separate intake credential degrades. Without the column the engagement
  // still opens and the intake link still resolves — getByIntakeToken falls back to
  // `token`, which is exactly how rows created before 0012 are already handled.
  // Once the migration lands, new rows get the split credential with no further
  // change. The deploy order stops mattering, which is better than getting it right.
  if (!res.ok) {
    const detail = await res.text();
    if (detail.includes("PGRST204") && detail.includes("intake_token")) {
      console.warn(
        "[GridForge] deliverables.intake_token is missing — apply migration 0012. " +
          "Opening the engagement on the document token alone."
      );
      const { intake_token: _omitted, ...withoutIntakeToken } = record;
      res = await insert(withoutIntakeToken);
      if (!res.ok) {
        console.error("[GridForge] deliverable insert failed:", await storeFault(res));
        return null;
      }
    } else {
      console.error("[GridForge] deliverable insert failed:", detail);
      return null;
    }
  }
  const rows = (await res.json()) as DeliverableRecord[];
  return rows[0] ?? null;
}

/**
 * The engagement already opened for a Stripe checkout session, if there is one.
 *
 * Stripe redelivers a webhook until it gets a 2xx, and the handler now returns a
 * 500 when it cannot open the engagement — which is the only way a four-figure payment
 * stops being silently orphaned. That makes a replay certain rather than unlikely,
 * so the insert has to be safe to repeat: without this lookup a retry would hand
 * one customer two intake links for one payment.
 */
export async function deliverableBySession(
  sessionId: string
): Promise<DeliverableRecord | null> {
  const c = creds();
  if (!c || !sessionId) return null;
  try {
    const res = await fetch(
      `${c.url}/rest/v1/deliverables?stripe_session_id=eq.${encodeURIComponent(sessionId)}` +
        `&select=*&limit=1`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) {
      console.error("[GridForge] deliverable by session failed:", await storeFault(res));
      return null;
    }
    const rows = (await res.json()) as DeliverableRecord[];
    return rows[0] ?? null;
  } catch (err) {
    console.error("[GridForge] deliverable by session unreachable:", err);
    return null;
  }
}

/**
 * What this customer has already paid that credits against an engagement.
 *
 * Two customer-facing surfaces promise the Density Screen "credits in full against
 * the full study", and `lib/products.ts` declares `creditsAgainst`. Nothing read
 * it, so honouring the credit depended on whoever raised the invoice remembering a
 * purchase that might be months old. Forgetting it breaks a written promise;
 * remembering it twice gives the money away twice.
 *
 * A deliverable row exists only because a checkout completed, so its existence is
 * the payment. Engagements are named without the `_deposit` suffix, which is what
 * `creditsAgainst` points at.
 */
export async function creditsToward(
  email: string,
  engagement: string
): Promise<{ cents: number; from: { kind: string; token: string; amount_cents: number }[] }> {
  const empty = { cents: 0, from: [] };
  const e = (email ?? "").trim().toLowerCase();
  if (!e || !engagement) return empty;

  const crediting = Object.values(PRODUCTS).filter(
    (p) => p.creditsAgainst && p.creditsAgainst.replace(/_deposit$/, "") === engagement
  );
  if (!crediting.length) return empty;

  const c = creds();
  if (!c) return empty;
  const kinds = crediting.map((p) => p.kind);
  const res = await fetch(
    `${c.url}/rest/v1/deliverables?email=eq.${encodeURIComponent(e)}` +
      `&kind=in.(${kinds.map(encodeURIComponent).join(",")})&select=kind,token,amount_cents`,
    { headers: c.headers, cache: "no-store" }
  );
  if (!res.ok) {
    // Never guess a credit. Reporting none is recoverable by a human reading the
    // pipeline; inventing one is money given away on our own arithmetic.
    console.error("[GridForge] credit lookup failed:", await storeFault(res));
    return empty;
  }
  const rows = (await res.json()) as { kind: string; token: string; amount_cents: number | null }[];
  const from = rows.map((r) => ({
    kind: r.kind,
    token: r.token,
    // Fall back to the catalogue price when the row did not record one.
    amount_cents: r.amount_cents ?? PRODUCT_BY_KIND[r.kind]?.amountCents ?? 0,
  }));
  return { cents: from.reduce((a, r) => a + r.amount_cents, 0), from };
}

export async function getByToken(token: string): Promise<DeliverableRecord | null> {
  const c = creds();
  if (!c || !token) return null;
  try {
    // `fetch` REJECTS on a network-level failure rather than returning a status,
    // and an unguarded rejection here propagates out of the server component and
    // becomes a 500 on a page the customer reached by paying. Fail closed, the way
    // lib/qualify.ts already does — which is why /q/ stayed at 404 in production
    // while every other token page did not.
    const res = await fetch(
      `${c.url}/rest/v1/deliverables?token=eq.${encodeURIComponent(token)}&select=*&limit=1`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as DeliverableRecord[];
    return rows[0] ?? null;
  } catch (err) {
    console.error("[GridForge] deliverable lookup unreachable:", err);
    return null;
  }
}

/**
 * The engagement an intake link addresses.
 *
 * Tries `intake_token` first, then `token` — rows created before 0012 have only
 * the latter and must keep working. Only `intake_token` is ever disclosed by
 * anything that did not already hold the document credential.
 */
export async function getByIntakeToken(token: string): Promise<DeliverableRecord | null> {
  const c = creds();
  if (!c || !token) return null;
  const q = encodeURIComponent(token);
  try {
    const res = await fetch(
      `${c.url}/rest/v1/deliverables?intake_token=eq.${q}&select=*&limit=1`,
      { headers: c.headers, cache: "no-store" }
    );
    if (res.ok) {
      const rows = (await res.json()) as DeliverableRecord[];
      if (rows[0]) return rows[0];
    } else {
      console.error("[GridForge] intake token lookup failed:", await storeFault(res));
    }
  } catch (err) {
    console.error("[GridForge] intake token lookup unreachable:", err);
  }
  return getByToken(token);
}

export async function updateByToken(
  token: string,
  patch: Partial<DeliverableRecord>
): Promise<boolean> {
  const c = creds();
  if (!c) return false;
  const res = await fetch(
    `${c.url}/rest/v1/deliverables?token=eq.${encodeURIComponent(token)}`,
    { method: "PATCH", headers: { ...c.headers, Prefer: "return=minimal" }, body: JSON.stringify(patch) }
  );
  if (!res.ok) console.error("[GridForge] deliverable update failed:", await storeFault(res));
  return res.ok;
}

/** Ask the engine for the rendered deliverable. Client tier: needs the API key. */
/**
 * Compare supplier responses against the capacity model.
 *
 * The third of the three things a Procurement Specification's catalogue entry
 * promises — "a bid comparison against the capacity model showing what each
 * response does to the energisation date" — and the one that had no surface. The
 * engine has done it all along; nothing called it.
 *
 * Judged against the relief the specification was WRITTEN for, carried on the
 * engagement, not against whatever binds the hall today. Four quotes answered one
 * requirement; comparing them against a different one would be worse than not
 * comparing them.
 */
export async function compareBids(
  row: DeliverableRecord,
  responses: unknown[]
): Promise<
  | { ok: true; ranked: unknown[]; leading: unknown; relief: string; sized_for_racks: number; note?: unknown }
  | { ok: false; error: string; status: number }
> {
  const base = process.env.GRIDFORGE_API_URL;
  const key = process.env.GRIDFORGE_API_KEY;
  if (!base || !key) {
    return { ok: false, status: 503, error: "The capacity engine is not connected to this deployment." };
  }
  const intake = (row.intake ?? null) as Record<string, unknown> | null;
  if (!intake) {
    return { ok: false, status: 409, error: "This engagement has no intake yet." };
  }
  const meta = (intake._gridforge ?? {}) as { spec?: { constraint_id?: string } };
  const constraint = meta.spec?.constraint_id ?? "";

  // The customer's own numbers only. `_gridforge` is ours.
  const engineIntake = { ...intake };
  delete (engineIntake as Record<string, unknown>)._gridforge;

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/bids`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({ intake: engineIntake, responses, constraint }),
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const detail = typeof body?.error === "string" ? body.error : `engine ${res.status}`;
      console.error("[GridForge] bid comparison refused:", res.status, detail);
      // 422 from the engine is the customer's responses being wrong, which they
      // can fix. Anything else is ours.
      return { ok: false, status: res.status === 422 ? 422 : 502, error: detail };
    }
    return {
      ok: true,
      ranked: Array.isArray(body.ranked) ? body.ranked : [],
      leading: body.leading ?? null,
      relief: typeof body.relief === "string" ? body.relief : "",
      sized_for_racks: Number(body.sized_for_racks) || 0,
      note: body.note,
    };
  } catch (err) {
    console.error("[GridForge] bid comparison unreachable:", err);
    return { ok: false, status: 502, error: "The capacity engine could not be reached." };
  }
}

function boardFrom(
  html: { board?: { document?: string; document_full?: string } },
  md: { board?: { document?: string } }
): { html: string; md: string } | null {
  // Standalone page for the html (it opens in its own tab, like the deck); both formats must be present.
  const h = html.board?.document_full ?? html.board?.document;
  const m = md.board?.document;
  return typeof h === "string" && h && typeof m === "string" && m ? { html: h, md: m } : null;
}

// --- The paid Envelope Study pack --------------------------------------------------------------------------------
//
// An Envelope Study is delivered as a pack: the full study and the one-page board summary a sponsor forwards.
// The board summary lives in `working_files` beside the other non-column artefacts (the specification and the bid
// comparison already do), so it belongs to the same engagement row, the same release gate and the same
// token-gated route, and needs no migration. `bundle.json` records what the pack was supposed to contain, so
// "complete" is checked against the artefacts actually stored rather than assumed.

export const BOARD_HTML = "board_summary.html";
export const BOARD_MD = "board_summary.md";
export const BUNDLE_MANIFEST = "bundle.json";
const PACK_FILES = new Set([BOARD_HTML, BOARD_MD, BUNDLE_MANIFEST]);

/** Working files the customer downloads as data; the pack's own artefacts are shown as documents instead. */
export function isPackFile(name: string): boolean {
  return PACK_FILES.has(name);
}

export function packArtifacts(kind: string): string[] {
  return PRODUCT_BY_KIND[kind]?.endpoint === "study" ? ["study", "board_summary"] : ["study"];
}

export interface PackState {
  /** Every artefact the pack promises is stored. */
  complete: boolean;
  missing: string[];
  /** Generated before packs existed: delivered study-only, and still valid to release as such. */
  legacy: boolean;
}

export function packState(row: Pick<DeliverableRecord, "kind" | "document_html" | "working_files">): PackState {
  const files = row.working_files ?? {};
  const raw = files[BUNDLE_MANIFEST];
  if (raw === undefined) {
    // No manifest: a row generated before packs existed. Do not retroactively hold it hostage to a board.
    return { complete: Boolean(row.document_html), missing: row.document_html ? [] : ["study"], legacy: true };
  }
  let expected = packArtifacts(row.kind);
  try {
    const m = JSON.parse(raw) as { expected?: unknown };
    if (Array.isArray(m.expected) && m.expected.every((x) => typeof x === "string")) expected = m.expected as string[];
  } catch {
    // An unreadable manifest is treated as "expects the full pack": fail towards incomplete.
  }
  const has: Record<string, boolean> = {
    study: Boolean(row.document_html),
    board_summary: Boolean(files[BOARD_HTML]) && Boolean(files[BOARD_MD]),
  };
  const missing = expected.filter((a) => !has[a]);
  return { complete: missing.length === 0, missing, legacy: false };
}

export type StoreOutcome =
  | { ok: true; complete: boolean; missing: string[]; title: string }
  | { ok: false; stage: "render" | "persist"; error: string };

/**
 * Generate an engagement's deliverables from its intake and store them in ONE row update.
 *
 * Used by the customer's intake submission and by the operator's "regenerate", so there is a single fulfilment
 * path. Status is `draft` only when every artefact the product promises was produced AND stored; otherwise it is
 * `engine_unavailable` with whatever was produced kept, and the manifest says what is missing. A persistence
 * failure is reported, not swallowed: the row is never left in `generating` while the caller reports success.
 */
export async function generateAndStore(
  row: Pick<DeliverableRecord, "token" | "kind" | "working_files">,
  doc: Record<string, unknown>,
  endpoint: "screen" | "study" | "spec"
): Promise<StoreOutcome> {
  const rendered = await renderDeliverable(doc, endpoint);
  if (!rendered.ok) {
    await updateByToken(row.token, { status: "engine_unavailable" });
    return { ok: false, stage: "render", error: rendered.error };
  }

  const meta: Record<string, unknown> = {};
  const binding = rendered.binding ?? bindingFrom(rendered.working);
  if (binding) meta.binding = binding;
  if (rendered.spec) meta.spec = rendered.spec;

  // Carry forward files this run does not own (a bid comparison), but never a board from an earlier run: a new
  // study beside an old board would be two documents from two different solves.
  const kept = Object.fromEntries(
    Object.entries(row.working_files ?? {}).filter(([k]) => !PACK_FILES.has(k))
  );
  const files: Record<string, string> = { ...kept, ...(rendered.working ?? {}) };
  if (endpoint === "study") {
    if (rendered.board) {
      files[BOARD_HTML] = rendered.board.html;
      files[BOARD_MD] = rendered.board.md;
    }
    files[BUNDLE_MANIFEST] = JSON.stringify({ expected: packArtifacts(row.kind), generated: new Date().toISOString() });
  }
  const candidate = { kind: row.kind, document_html: rendered.html, working_files: files };
  const state = endpoint === "study" ? packState(candidate) : { complete: true, missing: [] as string[], legacy: true };

  const ok = await updateByToken(row.token, {
    status: state.complete ? "draft" : "engine_unavailable",
    title: rendered.title,
    intake: Object.keys(meta).length ? { ...doc, _gridforge: meta } : doc,
    document_html: rendered.html,
    document_md: rendered.md,
    ...(rendered.deck ? { deck_html: rendered.deck } : {}),
    working_files: Object.keys(files).length ? files : null,
  });
  if (!ok) {
    // Best effort: leave a state a human can see and act on rather than "generating" forever.
    await updateByToken(row.token, { status: "engine_unavailable" });
    return { ok: false, stage: "persist", error: "The generated documents could not be stored." };
  }
  return { ok: true, complete: state.complete, missing: state.missing, title: rendered.title };
}

/**
 * The constraint that binds, from scenarios.csv. Tolerant: a missing or reshaped bundle returns null and the page
 * falls back to a generic sentence, because guessing a constraint would be worse than not naming one.
 */
export function bindingFrom(working: Record<string, string> | null): string | null {
  const csv = working?.["scenarios.csv"];
  if (!csv) return null;
  try {
    const [header, ...rows] = csv.split("\n").filter((l) => l.trim());
    const cols = header.split(",");
    const i = cols.indexOf("binds_first");
    if (i < 0 || !rows.length) return null;
    // Split respecting quoted fields — scenario names contain commas.
    const cells = rows[0].match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [];
    const raw = (cells[i] ?? "").replace(/,$/, "").replace(/^"|"$/g, "").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** The relief a Procurement Specification was written for, from its own bundle. */
function specFrom(
  files: Record<string, string> | null
): { constraint_id: string; constraint: string; relief: string; sized_for_racks: number } | null {
  const raw = files?.["specification.json"];
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const id = typeof d.constraint_id === "string" ? d.constraint_id : "";
    if (!id) return null;
    return {
      constraint_id: id,
      constraint: typeof d.constraint === "string" ? d.constraint : id,
      relief: typeof d.relief === "string" ? d.relief : "",
      sized_for_racks: Number(d.sized_for_racks) || 0,
    };
  } catch {
    return null;
  }
}

export async function renderDeliverable(
  intake: Record<string, unknown>,
  endpoint: "screen" | "study" | "spec"
): Promise<
  | {
      ok: true;
      title: string;
      html: string;
      md: string;
      deck: string | null;
      working: Record<string, string> | null;
      /**
       * The one-page board summary of the paid Envelope Study pack, rendered by the engine in the SAME call as
       * the study (one solve: same model, objective, evidence classes and watermark). Null when the engine did
       * not return one -- an older engine, or a gate refusing it -- which makes the pack incomplete, never
       * silently study-only.
       */
      board: { html: string; md: string } | null;
      /** What binds the hall as found, straight from the engine's own payload. */
      binding: string | null;
      /**
       * For a Procurement Specification: which relief it was written for.
       *
       * Kept because the bid comparison has to be judged against the SAME relief
       * the suppliers quoted. Re-deriving it later would let a library revision
       * move what binds and silently compare four quotes against a different
       * requirement than the one they answered.
       */
      spec: { constraint_id: string; constraint: string; relief: string; sized_for_racks: number } | null;
    }
  | { ok: false; error: string }
> {
  const base = process.env.GRIDFORGE_API_URL;
  const key = process.env.GRIDFORGE_API_KEY;
  if (!base) return { ok: false, error: "GRIDFORGE_API_URL is not set" };
  if (!key) return { ok: false, error: "GRIDFORGE_API_KEY is not set — paid endpoints need it" };

  const call = async (format: "html" | "md") => {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({ intake, format, ...(endpoint === "study" ? { bundle: "board" } : {}) }),
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `engine ${res.status}`);
    return body as {
      title: string;
      document: string;
      document_full?: string;
      board?: { title?: string; document?: string; document_full?: string };
    };
  };

  const deck = async (): Promise<string | null> => {
    // The walkthrough is part of the Study engagement, not the Screen and not a
    // Specification. A failed deck must never fail the document: the document is
    // what was bought.
    if (endpoint !== "study") return null;
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/deck`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify({ intake }),
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { document_full?: string };
      return body.document_full ?? null;
    } catch {
      return null;
    }
  };

  /**
   * The binding constraint, from the engine's structured answer.
   *
   * It used to be read only out of `scenarios.csv` in the working-file bundle —
   * and a Density Screen does not produce one. Its catalogue entry promises the
   * document, the ladder and the data request, and no working files; `/v1/screen`
   * has no csv format at all and is right not to.
   *
   * So for the Density Screen — the EUR 4,500 entry product whose whole commercial
   * purpose is to credit against the Envelope Study — the follow-on offer named a
   * generic constraint instead of the customer's own. That is the single most
   * valuable upsell in the business and it was running blind on every screen ever
   * sold. The figure was there the whole time, one field away, in the payload the
   * engine already returns.
   */
  const structured = async (): Promise<string | null> => {
    if (endpoint === "spec") return null;
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify({ intake }),
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
      });
      if (!res.ok) {
        console.error("[GridForge] binding lookup failed:", await storeFault(res));
        return null;
      }
      const body = (await res.json()) as {
        scenarios?: { as_found?: { binding_name?: string } }[];
      };
      return body.scenarios?.[0]?.as_found?.binding_name ?? null;
    } catch (err) {
      console.error("[GridForge] binding lookup error:", err);
      return null;
    }
  };

  const working = async (): Promise<Record<string, string> | null> => {
    // The tables behind the document, so the client's own engineers can check the
    // arithmetic. A failed bundle never fails the document.
    //
    // For a Specification the equivalent artefact is the response schedule: the
    // machine-readable template a supplier fills in, which is the half that makes
    // four quotations comparable. Same slot, same delivery route.
    try {
      if (endpoint === "spec") {
        const res = await fetch(`${base.replace(/\/$/, "")}/v1/spec`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": key },
          body: JSON.stringify({ intake, format: "md" }),
          signal: AbortSignal.timeout(120_000),
          cache: "no-store",
        });
        if (!res.ok) return null;
        const body = (await res.json()) as {
          response_template?: unknown;
          specification?: Record<string, unknown>;
        };
        if (!body.response_template) return null;
        const out: Record<string, string> = {
          "response_template.json": JSON.stringify(body.response_template, null, 2),
        };
        // The relief this specification was written for, kept with it. The bid
        // comparison is judged against this and not against whatever binds later.
        if (body.specification) {
          out["specification.json"] = JSON.stringify(body.specification, null, 2);
        }
        return out;
      }
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify({ intake, format: "csv" }),
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { files?: Record<string, string> };
      return body.files ?? null;
    } catch {
      return null;
    }
  };

  try {
    const [html, md, deckHtml, files, binding] = await Promise.all([
      call("html"),
      call("md"),
      deck(),
      working(),
      structured(),
    ]);
    return {
      ok: true,
      title: html.title,
      html: html.document,
      md: md.document,
      deck: deckHtml,
      working: files,
      board: boardFrom(html, md),
      binding,
      spec: specFrom(files),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "engine unreachable" };
  }
}
