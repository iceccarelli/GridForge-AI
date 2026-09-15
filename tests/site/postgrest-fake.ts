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

    const parsed = new URL(url);
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
