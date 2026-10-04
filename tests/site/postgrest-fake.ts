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
  /** Objects written through the Storage API, keyed `bucket/path`. */
  objects: Map<string, { bytes: Uint8Array; contentType: string }> = new Map();
  /** Set to make the Storage API refuse writes, for the "object store is down" path. */
  failStorage: { status: number; body: string } | null = null;

  private seq = 0;

  constructor(tableNames: string[] = []) {
    for (const t of tableNames) this.tables.set(t, []);
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
      let out = [...matching];
      const order = params.get("order");
      if (order) {
        const [col, dir] = order.split(".");
        out.sort((a, b) => cmp(a[col], b[col]) * (dir === "desc" ? -1 : 1));
      }
      const limit = Number(params.get("limit"));
      if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
      return json(JSON.stringify(out), 200);
    }

    if (method === "POST") {
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
        const row: Row = { id: this.nextId(), created_at: new Date().toISOString(), ...raw };
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
          if (store.some((r) => cols.every((c) => r[c] === row[c]))) {
            return json(
              JSON.stringify({
                code: "23505",
                message: `duplicate key value violates unique constraint on ${table}(${cols.join(",")})`,
              }),
              409
            );
          }
        }
        store.push(row);
        created.push(row);
      }
      return json(JSON.stringify(created), 201);
    }

    if (method === "PATCH") {
      for (const row of matching) Object.assign(row, body as Row);
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
    case "is":
      return f.value === "null" ? actual === null || actual === undefined : false;
    case "not":
      return !match(row, { ...f, op: f.value.split(".")[0], value: f.value.split(".").slice(1).join(".") });
    default:
      return true;
  }
}

function cmp(a: unknown, b: unknown): number {
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
