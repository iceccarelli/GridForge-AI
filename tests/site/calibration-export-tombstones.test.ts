/**
 * The admin calibration export carries `tombstones` (migration 0056): the sha256 of every observation withdrawn with its organisation's consent, and
 * nothing else about it, so that `gridforge calibrate import` can refuse an export that holds one and leave one out of the private ledger.
 *
 * Asserted at the PostgREST boundary (the fake), on what leaves the route: that the key is additive (the schema string and the rows are what they were),
 * that it is hash-only, that it is complete or the export fails (never a silently cut list), and that a database without 0056 yields an empty list
 * rather than an error. The importer's side of the contract (the key is a list of 64-hex strings; a withdrawn row refuses the whole export) is
 * tests/test_calibration_tombstones.py, and the shape it reads is checked here against the importer's own source.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { adminToken } from "@/lib/admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestFake } from "./postgrest-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

let db: PostgrestFake;
let restore: () => void;
let errors: ReturnType<typeof vi.spyOn>;

const hash = (id: string) => createHash("sha256").update(`gridforge.calibration.observation:${id}`).digest("hex");
const exportRow = {
  id: "00000000-0000-4000-8000-0000000000aa", key: "btm.firm_MW", observed_value: "33", predicted_value: 36.4, unit: "MW", site_ref: "site_0123456789ab",
  measurement_kind: "metered", evidence_sha256: "a".repeat(64), engine_provenance_digest: "c".repeat(64), report_date: "2026-03-01", observed_on: "2026-09-30",
  method: "revenue meter", evidence_class: "E5", reviewed_by: "J. Ortiz", reviewed_at: "2026-10-02T09:00:00Z",
};
const get = async () => (await import("@/app/api/admin/calibration-export/route")).GET();
/** What the table holds: the hash and the withdrawal's own columns, which must never reach the export. */
const tombstone = (h: string) => ({ observation_hash: h, withdrawn_at: "2026-11-01T10:00:00Z", withdrawal_id: "11111111-1111-4111-8111-111111111111" });

beforeEach(() => {
  jar.length = 0;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  jar.push({ name: "gf_admin", value: adminToken()! });
  db = new PostgrestFake(["calibration_ledger_rows"]);
  restore = db.install();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  restore();
  errors.mockRestore();
  delete process.env.ADMIN_PASSWORD;
});

describe("the export's tombstones", () => {
  it("is an empty list, and the rest of the export unchanged, on a database where 0056 is not applied (no such table)", async () => {
    db.seed("calibration_ledger_rows", [exportRow]);
    const res = await get();
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, schema: "gridforge/calibration-export/1", count: 1, tombstones: [] });
    expect(body.rows).toEqual([{ ...exportRow, observed_value: 33 }]);
  });

  it("lists the hash of each withdrawn observation, sorted, and only the hash: no time, no organisation, no withdrawal id", async () => {
    db.createTable("calibration_tombstones");
    const hashes = ["z", "b", "m", "a"].map((s) => hash(`obs-${s}`));
    for (const h of hashes) db.insertRow("calibration_tombstones", tombstone(h));
    const res = await get();
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.tombstones).toEqual([...hashes].sort());
    for (const t of body.tombstones) expect(t).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/withdrawn_at|withdrawal_id|organisation|11111111-1111/);
    // only the one column was asked for
    const asked = db.calls.filter((c) => c.url.includes("calibration_tombstones")).map((c) => new URL(c.url).searchParams.get("select"));
    expect(asked).toEqual(["observation_hash"]);
  });

  it("is the shape the importer reads: a list of 64-hex strings under `tombstones`, beside `schema` and `rows`", async () => {
    db.createTable("calibration_tombstones");
    db.insertRow("calibration_tombstones", tombstone(hash("00000000-0000-4000-8000-000000000001")));
    const body: any = await (await get()).json();
    const importer = readFileSync("gridforge/calibration/ledger.py", "utf8");
    expect(importer).toContain('doc.get("tombstones")');
    expect(importer).toMatch(/isinstance\(h, str\) and SHA256_RE\.match\(h\) for h in listed/);
    expect(importer).toContain('EXPORT_SCHEMA = "gridforge/calibration-export/1"');
    expect(body.schema).toBe("gridforge/calibration-export/1");
    expect(Array.isArray(body.tombstones) && body.tombstones.every((h: unknown) => typeof h === "string")).toBe(true);
  });

  it("is the same hash the database and the engine make of an observation id", async () => {
    // gf_calibration_observation_hash (0056) and gridforge/calibration/tombstones.py observation_hash both hash this exact string
    expect(readFileSync("supabase/migrations/0056_calibration_publication_gates.sql", "utf8")).toContain("'gridforge.calibration.observation:' || p_id::text");
    expect(readFileSync("gridforge/calibration/tombstones.py", "utf8")).toContain('f"gridforge.calibration.observation:{observation_id}"');
    expect(hash("00000000-0000-4000-8000-000000000001")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is complete across pages: a full page is followed by the next, and nothing is dropped or repeated", async () => {
    db.createTable("calibration_tombstones");
    const all = Array.from({ length: 2503 }, (_, i) => hash(`obs-${i}`));
    for (const h of all) db.insertRow("calibration_tombstones", tombstone(h));
    const body: any = await (await get()).json();
    expect(body.tombstones).toEqual([...all].sort());
    expect(new Set(body.tombstones).size).toBe(2503);
    expect(db.calls.filter((c) => c.url.includes("calibration_tombstones")).length).toBe(3);
  });

  it("an exact multiple of the page size ends on an empty page, not an error", async () => {
    db.createTable("calibration_tombstones");
    const all = Array.from({ length: 1000 }, (_, i) => hash(`exact-${i}`));
    for (const h of all) db.insertRow("calibration_tombstones", tombstone(h));
    const body: any = await (await get()).json();
    expect(body.tombstones).toEqual([...all].sort());
  });

  it("fails the whole export, with no rows, when the list cannot be read: never an empty list that reads as 'nothing withdrawn'", async () => {
    db.seed("calibration_ledger_rows", [exportRow]);
    db.createTable("calibration_tombstones");
    const inner = globalThis.fetch;
    globalThis.fetch = ((u: RequestInfo | URL, i?: RequestInit) =>
      String(u).includes("calibration_tombstones") ? Promise.resolve(new Response(JSON.stringify({ code: "XX000" }), { status: 500 })) : inner(u, i)) as typeof fetch;
    try {
      const res = await get();
      const body: any = await res.json();
      expect(res.status).toBe(502);
      expect(body.rows).toBeUndefined();
      expect(body.tombstones).toBeUndefined();
      expect(body.error).toMatch(/Nothing was exported/);
    } finally {
      globalThis.fetch = inner;
    }
  });

  it("fails when a later page cannot be read, and when the table answers 404 for any reason but a missing relation", async () => {
    db.createTable("calibration_tombstones");
    for (let i = 0; i < 1200; i++) db.insertRow("calibration_tombstones", tombstone(hash(`late-${i}`)));
    const inner = globalThis.fetch;
    globalThis.fetch = ((u: RequestInfo | URL, i?: RequestInit) =>
      String(u).includes("offset=1000") ? Promise.resolve(new Response(JSON.stringify({ code: "XX000" }), { status: 500 })) : inner(u, i)) as typeof fetch;
    try {
      expect((await get()).status).toBe(502);
      globalThis.fetch = ((u: RequestInfo | URL, i?: RequestInit) =>
        String(u).includes("calibration_tombstones") ? Promise.resolve(new Response(JSON.stringify({ code: "PGRST301" }), { status: 404 })) : inner(u, i)) as typeof fetch;
      expect((await get()).status).toBe(502);
    } finally {
      globalThis.fetch = inner;
    }
  });

  it("treats the schema-cache answer of a current PostgREST for a missing table the same as the older one: no table, no withdrawal", async () => {
    const inner = globalThis.fetch;
    globalThis.fetch = ((u: RequestInfo | URL, i?: RequestInit) =>
      String(u).includes("calibration_tombstones")
        ? Promise.resolve(new Response(JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.calibration_tombstones' in the schema cache" }), { status: 404 }))
        : inner(u, i)) as typeof fetch;
    try {
      const res = await get();
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).tombstones).toEqual([]);
    } finally {
      globalThis.fetch = inner;
    }
  });

  it("refuses a hash that is not 64 lowercase hex characters, and a list longer than it will read (a cut list is not a list)", async () => {
    db.createTable("calibration_tombstones");
    db.insertRow("calibration_tombstones", tombstone("NOT-A-HASH"));
    expect((await get()).status).toBe(502);
    db.tables.set("calibration_tombstones", []);
    db.insertRow("calibration_tombstones", tombstone(hash("fine")));
    expect((await get()).status).toBe(200);
    // a table that never ends: every page is full, so the export stops asking after its cap and fails instead of exporting what it has
    const inner = globalThis.fetch;
    let pages = 0;
    globalThis.fetch = ((u: RequestInfo | URL, i?: RequestInit) => {
      if (!String(u).includes("calibration_tombstones")) return inner(u, i);
      const offset = Number(new URL(String(u)).searchParams.get("offset"));
      pages += 1;
      return Promise.resolve(new Response(JSON.stringify(Array.from({ length: 1000 }, (_, k) => ({ observation_hash: hash(`n-${offset + k}`) }))), { status: 200 }));
    }) as typeof fetch;
    try {
      const res = await get();
      expect(res.status).toBe(502);
      expect(pages).toBe(100);
      expect(((await res.json()) as any).tombstones).toBeUndefined();
    } finally {
      globalThis.fetch = inner;
    }
  });

  it("is admin-only, like the rest of the export", async () => {
    jar.length = 0;
    expect((await get()).status).toBe(401);
  });
});
