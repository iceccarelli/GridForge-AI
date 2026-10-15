/**
 * A deterministic Supabase-Storage-shaped stub for tests. It persists EXACT bytes in memory and models the parts of the
 * Storage HTTP contract the site relies on:
 *
 *   POST   /storage/v1/object/<bucket>/<path>                 create; refuses an existing object unless x-upsert: true
 *   GET    /storage/v1/object/authenticated/<bucket>/<path>   read a private object (credentials required)
 *   GET    /storage/v1/object/<bucket>/<path>                 the PUBLIC route: always refused, the bucket is private
 *   DELETE /storage/v1/object/<bucket>/<path>
 *
 * Every request must carry the service credential or it is refused 401, and every request is logged (method, path,
 * whether credentials were present) so a test can assert what was sent where.
 *
 * WHAT THIS IS NOT: Supabase. It does not prove that a deployed project's bucket exists, is private, or that its
 * service key can write to it. That needs the real service and is stated as unverified in the delivery notes.
 */
import http from "node:http";

export interface StorageStub {
  url: string;
  objects: Map<string, { bytes: Buffer; contentType: string }>;
  log: { method: string; path: string; authed: boolean; upsert: string | null }[];
  /** Fault injection. */
  fail: { uploads: boolean; reads: boolean; corruptWrites: boolean };
  close(): Promise<void>;
}

export async function startStorageStub(serviceKey: string): Promise<StorageStub> {
  const objects: StorageStub["objects"] = new Map();
  const log: StorageStub["log"] = [];
  const fail = { uploads: false, reads: false, corruptWrites: false };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const path = decodeURIComponent((req.url ?? "").split("?")[0]);
    const auth = `${req.headers.authorization ?? ""}${req.headers.apikey ?? ""}`;
    const authed = auth.includes(serviceKey);
    log.push({ method: req.method ?? "", path, authed, upsert: (req.headers["x-upsert"] as string) ?? null });
    const json = (status: number, o: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (!authed) return json(401, { statusCode: "401", error: "Unauthorized" });
    const m = path.match(/^\/storage\/v1\/object\/(authenticated\/)?(.+)$/);
    if (!m) return json(404, { statusCode: "404", error: "not_found" });
    const key = m[2];
    if (req.method === "POST") {
      if (m[1]) return json(400, { statusCode: "400", error: "bad route" });
      if (fail.uploads) return json(500, { statusCode: "500", error: "injected upload failure" });
      if (objects.has(key) && req.headers["x-upsert"] !== "true") {
        return json(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists", code: "KeyAlreadyExists" });
      }
      // corruptWrites models a store that acknowledges a write and persists something else.
      objects.set(key, { bytes: fail.corruptWrites ? body.subarray(0, Math.max(0, body.length - 1)) : body, contentType: String(req.headers["content-type"] ?? "") });
      return json(200, { Key: key });
    }
    if (req.method === "GET") {
      if (!m[1]) return json(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found", code: "NoSuchBucket" }); // private: the public route does not serve it
      if (fail.reads) return json(500, { statusCode: "500", error: "injected read failure" });
      const o = objects.get(key);
      if (!o) return json(400, { statusCode: "404", error: "not_found", message: "Object not found", code: "NoSuchKey" });
      return res.writeHead(200, { "content-type": o.contentType }).end(o.bytes);
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      return json(200, { message: "Successfully deleted" });
    }
    return json(405, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    objects,
    log,
    fail,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
