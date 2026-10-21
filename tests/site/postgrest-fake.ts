/**
 * An in-memory PostgREST, good enough for the queries this site actually makes.
 *
 * It exists for one reason above all the others: it can be told that a table does
 * not exist, and it then answers the way the real thing does — HTTP 404 with a
 * JSON body, NOT a thrown error. That distinction is the entire defect this test
 * suite was written for. `subscriptions` and `scenarios` had no migration for
 * several releases; every call site wrapped its request in `try/catch`; `fetch`
 * does not reject on 404; so the catch never ran, the failure was never logged,
 * and a paying customer was shown the unsubscribed view.
 *
 * A stub that throws would have let that code pass. This one does not.
 */

export class PgError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface Row {
  [key: string]: unknown;
}

type Filter = { column: string; op: string; value: string };

export class PostgrestFake {
  /** Tables that exist. A table absent from here answers 404, like the real one. */
  tables: Map<string, Row[]> = new Map();
  /** Every request seen, so a test can assert on what was actually sent. */
  calls: { method: string; url: string; body: unknown }[] = [];
  /** Set to force a transport-level failure, for the "database is down" path. */
  failNext: { status: number; body: string } | null = null;
  /**
   * Fail every request using this method.
   *
   * `failNext` fails whichever request happens to come first, which is usually a
   * lookup — so it cannot express "the read worked and the WRITE did not", which
   * is the interesting half of a partial failure.
   */
  failMethod: { method: string; status: number; body: string } | null = null;
  /**
   * Columns a table does NOT have yet, by table.
   *
   * The mirror of dropTable, for the window between deploying code and applying
   * its migration. PostgREST refuses an insert that names an unknown column with
   * 400 PGRST204 — it does not ignore it — so code written against a column that
   * is not there yet fails every write, and with the fulfilment fix in place that
   * is a paid purchase Stripe retries until it gives up.
   */
  missingColumns: Map<string, Set<string>> = new Map();

  /**
   * Tables whose UPDATE and DELETE the database refuses outright (a trigger in
   * 0015_projects.sql). Answers 403 with Postgres' insufficient_privilege code,
   * which is what PostgREST returns for that RAISE.
   */
  appendOnly: Set<string> = new Set();
  /** Unique keys by table, as column lists; a clash answers 409 / 23505. */
  uniqueKeys: Map<string, string[][]> = new Map();
  /** A row trigger, as a migration's BEFORE INSERT/UPDATE would run it: called with the new row and (on update) a copy of the old one. */
  rowHooks: Map<string, (row: Row, old?: Row) => void> = new Map();
  /** Column defaults applied to a new row of a table (what the migration's `default`s would supply). */
  rowDefaults: Map<string, () => Row> = new Map();
  /** Objects written through the Storage API, keyed `bucket/path`. */
  objects: Map<string, { bytes: Uint8Array; contentType: string }> = new Map();
  /** Set to make the Storage API refuse writes, for the "object store is down" path. */
  failStorage: { status: number; body: string } | null = null;

  /** Server-side functions (/rest/v1/rpc/<name>). Each runs as ONE transaction: if it
   * throws, every table is restored to what it was before the call. */
  rpcs: Map<string, (args: any, db: PostgrestFake) => unknown> = new Map();

  /** Make every event write inside an rpc fail, to prove the record rolls back with it. */
  failEvents = false;

  private seq = 0;

  constructor(tableNames: string[] = []) {
    for (const t of tableNames) this.tables.set(t, []);
    this.installRateLimit();
    this.installFounding();
  }

  /**
   * Migration 0024 as applied: the counter table and gf_rate_limit_hit, one fixed window per (bucket, subject). Present by
   * default because every guarded route consults it; a test of the "migration not applied" path removes the rpc.
   * SUPPLEMENTAL: that the real function is atomic is proven against PostgreSQL (tests/test_buyer_page_migration.py).
   */
  installRateLimit(): void {
    this.createTable("rate_limit_windows");
    this.rpcs.set("gf_rate_limit_hit", ({ p_bucket, p_subject, p_limit, p_window_seconds }) => {
      if (!(p_limit >= 1 && p_limit <= 100000) || !(p_window_seconds >= 1 && p_window_seconds <= 86400)) {
        throw new PgError("22023", "p_limit or p_window_seconds out of range", 400);
      }
      if (!/^[0-9a-f]{64}$/.test(String(p_subject))) throw new PgError("23514", "rate_limit_windows_subject_check", 400);
      const nowS = Date.now() / 1000;
      const ws = Math.floor(nowS / p_window_seconds) * p_window_seconds;
      const rows = this.rows("rate_limit_windows");
      let row = rows.find((r) => r.bucket === p_bucket && r.subject === p_subject && r.window_start === ws);
      if (!row) row = this.insertRow("rate_limit_windows", { bucket: p_bucket, subject: p_subject, window_start: ws, hits: 0 });
      row.hits = Math.min((row.hits as number) + 1, 2147483000);
      const hits = row.hits as number;
      return { allowed: hits <= p_limit, hits, limit: p_limit, retry_after_seconds: Math.max(1, Math.ceil(ws + p_window_seconds - nowS)) };
    });
  }

  /**
   * Migration 0028's gf_founding_reserve, as applied: paid + live reservations < total, one reservation per call.
   * SUPPLEMENTAL: that the real function is serialised is proven against PostgreSQL (tests/test_payg_migration.py).
   */
  installFounding(): void {
    this.createTable("founding_reservations");
    this.rpcs.set("gf_founding_reserve", ({ p_paid, p_total, p_ttl_minutes }) => {
      if (!(p_ttl_minutes >= 1 && p_ttl_minutes <= 2880) || p_paid < 0 || p_total < 0) throw new PgError("22023", "founding reservation arguments out of range", 400);
      const rows = this.rows("founding_reservations");
      const now = Date.now();
      for (let i = rows.length - 1; i >= 0; i--) if (new Date(rows[i].expires_at as string).getTime() <= now) rows.splice(i, 1);
      if (p_paid + rows.length >= p_total) return null;
      return this.insertRow("founding_reservations", { expires_at: new Date(now + p_ttl_minutes * 60_000).toISOString() }).id;
    });
  }

  createTable(name: string): void {
    if (!this.tables.has(name)) this.tables.set(name, []);
  }

  dropTable(name: string): void {
    this.tables.delete(name);
  }

  /** Pretend a migration has not been applied yet. */
  dropColumn(table: string, column: string): void {
    const cols = this.missingColumns.get(table) ?? new Set<string>();
    cols.add(column);
    this.missingColumns.set(table, cols);
  }

  rows(name: string): Row[] {
    return this.tables.get(name) ?? [];
  }

  seed(name: string, rows: Row[]): void {
    this.createTable(name);
    for (const r of rows) this.tables.get(name)!.push({ id: this.nextId(), ...r });
  }

  private nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  /** Install as globalThis.fetch. Returns a restore function. */
  install(): () => void {
    const previous = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.handle(input, init)) as typeof fetch;
    return () => {
      globalThis.fetch = previous;
    };
  }

  /** Insert one row as the database would: id/created_at defaults and unique keys. */
  insertRow(table: string, raw: Row): Row {
    if (!this.tables.has(table)) throw new PgError("42P01", `relation "public.${table}" does not exist`, 404);
    const store = this.tables.get(table)!;
    const row: Row = { id: this.nextId(), created_at: new Date().toISOString(), ...(this.rowDefaults.get(table)?.() ?? {}), ...raw };
    for (const cols of this.uniqueKeys.get(table) ?? []) {
      if (cols.every((c) => row[c] !== null && row[c] !== undefined) && store.some((r) => cols.every((c) => r[c] === row[c]))) {
        throw new PgError("23505", `duplicate key value violates unique constraint on ${table}(${cols.join(",")})`, 409);
      }
    }
    this.rowHooks.get(table)?.(row);
    store.push(row);
    return row;
  }

  private async handleRpc(name: string, body: unknown): Promise<Response> {
    const fn = this.rpcs.get(name);
    if (!fn) {
      return json(JSON.stringify({ code: "PGRST202", message: `Could not find the function public.${name}` }), 404);
    }
    const snapshot = new Map([...this.tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
    try {
      return json(JSON.stringify(fn(body, this) ?? null), 200);
    } catch (err) {
      this.tables = snapshot; // the whole call rolls back
      if (err instanceof PgError) {
        return json(JSON.stringify({ code: err.code, message: err.message }), err.status);
      }
      throw err;
    }
  }

  /** Supabase Storage's object API, as far as evidence upload uses it. */
  private async handleStorage(method: string, ref: string, init?: RequestInit): Promise<Response> {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (method === "POST") {
      if (this.failStorage) return json(this.failStorage.body, this.failStorage.status, false);
      if (this.objects.has(ref)) {
        return json(JSON.stringify({ error: "Duplicate", message: "The resource already exists" }), 409);
      }
      const raw = init?.body as Buffer | Uint8Array | string | undefined;
      const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw ?? []);
      this.objects.set(ref, { bytes, contentType: headers["Content-Type"] ?? "" });
      return json(JSON.stringify({ Key: ref }), 200);
    }
    if (method === "DELETE") {
      this.objects.delete(ref);
      return json(JSON.stringify({ message: "Successfully deleted" }), 200);
    }
    return json(JSON.stringify({ message: `unsupported ${method}` }), 405);
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    this.calls.push({ method, url, body });

    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return json(f.body, f.status, false);
    }
    if (this.failMethod && this.failMethod.method === method) {
      return json(this.failMethod.body, this.failMethod.status, false);
    }

    const parsed = new URL(url);
    const rp = parsed.pathname.match(/\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/);
    if (rp) return this.handleRpc(rp[1], body);
    const so = parsed.pathname.match(/\/storage\/v1\/object\/(.+)$/);
    if (so) return this.handleStorage(method, decodeURIComponent(so[1]), init);
    const m = parsed.pathname.match(/\/rest\/v1\/([A-Za-z0-9_]+)$/);
    if (!m) return json(JSON.stringify({ message: "not a rest path" }), 404);
    const table = m[1];

    if (!this.tables.has(table)) {
      // Verbatim shape of a PostgREST miss on an undefined relation.
      return json(
        JSON.stringify({
          code: "42P01",
          message: `relation "public.${table}" does not exist`,
        }),
        404
      );
    }

    const params = parsed.searchParams;
    const filters: Filter[] = [];
    for (const [key, raw] of params.entries()) {
      if (["select", "order", "limit", "offset"].includes(key)) continue;
      const dot = raw.indexOf(".");
      if (dot < 0) continue;
      filters.push({ column: key, op: raw.slice(0, dot), value: raw.slice(dot + 1) });
    }

    if (this.appendOnly.has(table) && (method === "PATCH" || method === "DELETE")) {
      return json(
        JSON.stringify({ code: "42501", message: `${table} is append-only: ${method} is not permitted` }),
        403
      );
    }

    const store = this.tables.get(table)!;
    const matching = store.filter((row) => filters.every((f) => match(row, f)));
    const wantsRepresentation = String(
      (init?.headers as Record<string, string> | undefined)?.Prefer ?? ""
    ).includes("return=representation");

    if (method === "GET") {
      // Verbatim shape of PostgREST refusing a select that names a column the table does not have.
      const absentCols = this.missingColumns.get(table);
      const named = absentCols && [...absentCols].find((c) => (params.get("select") ?? "").split(",").includes(c));
      if (named) {
        return json(JSON.stringify({ code: "42703", message: `column ${table}.${named} does not exist` }), 400);
      }
      let out = [...matching];
      const order = params.get("order");
      if (order) {
        // "a.desc,b.asc": the first key decides, the next breaks ties, as PostgREST orders.
        const keys = order.split(",").map((k) => k.split("."));
        out.sort((a, b) => {
          for (const [col, dir] of keys) {
            const c = cmp(a[col], b[col]) * (dir === "desc" ? -1 : 1);
            if (c !== 0) return c;
          }
          return 0;
        });
      }
      const limit = Number(params.get("limit"));
      if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
      return json(JSON.stringify(out), 200);
    }

    if (method === "POST") {
      const ignoreDuplicates = String((init?.headers as Record<string, string> | undefined)?.Prefer ?? "").includes("ignore-duplicates");
      const incoming = Array.isArray(body) ? body : [body];
      const absent = this.missingColumns.get(table);
      if (absent) {
        for (const raw of incoming as Row[]) {
          const named = Object.keys(raw ?? {}).find((k) => absent.has(k));
          if (named) {
            // Verbatim shape of PostgREST refusing an unknown column.
            return json(
              JSON.stringify({
                code: "PGRST204",
                message: `Could not find the '${named}' column of '${table}' in the schema cache`,
              }),
              400
            );
          }
        }
      }
      const created: Row[] = [];
      for (const raw of incoming as Row[]) {
        const row: Row = { id: this.nextId(), created_at: new Date().toISOString(), ...(this.rowDefaults.get(table)?.() ?? {}), ...raw };
        let dup = false;
        // The one partial unique index the schema declares, enforced here too so a
        // test can prove the supersede actually happened rather than assuming it.
        if (table === "subscriptions" && row.status === "active") {
          const clash = store.some((r) => r.email === row.email && r.status === "active");
          if (clash) {
            return json(
              JSON.stringify({
                code: "23505",
                message:
                  'duplicate key value violates unique constraint "subscriptions_one_active_per_email"',
              }),
              409
            );
          }
        }
        for (const cols of this.uniqueKeys.get(table) ?? []) {
          if (cols.every((c) => row[c] !== null && row[c] !== undefined) && store.some((r) => cols.every((c) => r[c] === row[c]))) {
            // `Prefer: resolution=ignore-duplicates`: a conflicting row is skipped, not an error.
            if (ignoreDuplicates) { dup = true; break; }
            return json(
              JSON.stringify({
                code: "23505",
                message: `duplicate key value violates unique constraint on ${table}(${cols.join(",")})`,
              }),
              409
            );
          }
        }
        if (dup) continue;
        this.rowHooks.get(table)?.(row);
        store.push(row);
        created.push(row);
      }
      return json(JSON.stringify(created), 201);
    }

    if (method === "PATCH") {
      for (const row of matching) {
        const old = { ...row };
        Object.assign(row, body as Row);
        this.rowHooks.get(table)?.(row, old);
      }
      return json(wantsRepresentation ? JSON.stringify(matching) : "", 200);
    }

    if (method === "DELETE") {
      for (const row of matching) {
        const i = store.indexOf(row);
        if (i >= 0) store.splice(i, 1);
      }
      return json(wantsRepresentation ? JSON.stringify(matching) : "", 200);
    }

    return json(JSON.stringify({ message: `unsupported ${method}` }), 405);
  }
}

function match(row: Row, f: Filter): boolean {
  const actual = row[f.column];
  switch (f.op) {
    case "eq":
      return String(actual ?? "") === f.value;
    case "neq":
      return String(actual ?? "") !== f.value;
    case "in": {
      const set = f.value.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim());
      return set.includes(String(actual ?? ""));
    }
    case "lt": case "lte": case "gt": case "gte": {
      // PostgREST compares by column type: numbers numerically, text and timestamps in order.
      const numeric = actual !== null && actual !== undefined && actual !== "" && f.value !== "" && Number.isFinite(Number(actual)) && Number.isFinite(Number(f.value));
      const a: string | number = numeric ? Number(actual) : String(actual ?? "");
      const b: string | number = numeric ? Number(f.value) : f.value;
      return f.op === "lt" ? a < b : f.op === "lte" ? a <= b : f.op === "gt" ? a > b : a >= b;
    }
    case "is":
      return f.value === "null" ? actual === null || actual === undefined : false;
    case "not":
      return !match(row, { ...f, op: f.value.split(".")[0], value: f.value.split(".").slice(1).join(".") });
    default:
      return true;
  }
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a ?? "");
  const y = String(b ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
}

function json(body: string, status: number, _ok?: boolean): Response {
  return new Response(body || null, {
    status,
    headers: { "content-type": "application/json" },
  });
}
