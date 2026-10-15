// Server-only: the private object store for generated cost-evidence documents.
//
// Same conventions as project evidence in lib/projects.ts: Supabase Storage over fetch, the service-role credentials
// only (never sent to a browser), a PRIVATE bucket, no public URL anywhere, and a log line carries a status and a code
// but never a body. The one addition is read-back: an artifact is only ever served after its bytes have been
// re-hashed against the digest and length the database recorded.

import crypto from "node:crypto";
import { creds } from "@/lib/projects";
import { storeFault } from "@/lib/safe-log";

export const ARTIFACT_BUCKET = "cost-evidence-artifacts";
export const ARTIFACT_MEDIA_TYPE = "text/html; charset=utf-8";

export interface ArtifactMeta {
  sha256: string;
  bytes: number;
}

export type StoreResult<T> = ({ ok: true } & T) | { ok: false; kind: "missing" | "unavailable" | "corrupt"; error: string };

/** '<bucket>/<deliverable>/<run fingerprint>/<artifact sha256>.html': ids and digests only, nothing a customer or a
 * supplier said. The digest in the key means two different byte strings can never share an object. */
export function artifactPath(deliverable_id: string, run_fingerprint: string, sha256: string): string {
  return `${deliverable_id}/${run_fingerprint}/${sha256}.html`;
}
export const artifactRef = (path: string) => `${ARTIFACT_BUCKET}/${path}`;

export function verifyBytes(bytes: Uint8Array, meta: ArtifactMeta): boolean {
  return bytes.byteLength === meta.bytes && crypto.createHash("sha256").update(bytes).digest("hex") === meta.sha256;
}

function authOnly(): { url: string; headers: Record<string, string> } | null {
  const c = creds();
  if (!c) return null;
  const { "Content-Type": _json, ...rest } = c.headers;
  void _json;
  return { url: c.url, headers: rest };
}

/** A ref is only ever the bucket and the paths this module writes; anything else is refused before a request is made. */
const REF = new RegExp(`^${ARTIFACT_BUCKET}/[0-9a-f-]{36}/[0-9a-f]{64}/[0-9a-f]{64}\\.html$`);
const refOk = (ref: string) => REF.test(ref);

export async function getArtifact(ref: string): Promise<StoreResult<{ bytes: Buffer }>> {
  const c = authOnly();
  if (!c) return { ok: false, kind: "unavailable", error: "storage is not configured" };
  if (!refOk(ref)) return { ok: false, kind: "corrupt", error: "the artifact reference is not one this service wrote" };
  try {
    const res = await fetch(`${c.url}/storage/v1/object/authenticated/${ref}`, { headers: c.headers, cache: "no-store" });
    if (res.status === 404 || res.status === 400) {
      // Supabase answers a missing object 400 or 404 depending on version, with the real code in the body. Only an
      // explicit not-found is "missing"; any other 400 (a rejected credential, a bad bucket) is the store failing.
      const body = (await res.clone().json().catch(() => ({}))) as { statusCode?: unknown };
      if (res.status === 404 || String(body.statusCode) === "404") {
        return { ok: false, kind: "missing", error: "the stored artifact is missing" };
      }
    }
    if (!res.ok) {
      console.error("[GridForge] artifact read failed:", await storeFault(res));
      return { ok: false, kind: "unavailable", error: "the artifact store is unavailable" };
    }
    return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    console.error("[GridForge] artifact store unreachable:", err instanceof Error ? err.name : "error");
    return { ok: false, kind: "unavailable", error: "the artifact store is unreachable" };
  }
}

/** Read the object and prove it is the bytes the record names. Never returns bytes that failed the proof. */
export async function readVerified(ref: string, meta: ArtifactMeta): Promise<StoreResult<{ bytes: Buffer }>> {
  const got = await getArtifact(ref);
  if (!got.ok) return got;
  if (!verifyBytes(got.bytes, meta)) {
    console.error("[GridForge] artifact integrity check failed for a recorded run");
    return { ok: false, kind: "corrupt", error: "the stored artifact does not match its recorded digest" };
  }
  return got;
}

/**
 * Store candidate bytes WITHOUT overwriting (x-upsert: false), then read them back and prove them. An object that
 * already exists at this path is accepted only if its bytes are identical (the path embeds the digest, so a different
 * byte string cannot legitimately be there).
 */
export async function putVerified(ref: string, bytes: Buffer, meta: ArtifactMeta): Promise<StoreResult<object>> {
  const c = authOnly();
  if (!c) return { ok: false, kind: "unavailable", error: "storage is not configured" };
  if (!refOk(ref)) return { ok: false, kind: "corrupt", error: "refused to write an unexpected artifact path" };
  try {
    const res = await fetch(`${c.url}/storage/v1/object/${ref}`, {
      method: "POST",
      headers: { ...c.headers, "Content-Type": ARTIFACT_MEDIA_TYPE, "x-upsert": "false" },
      body: new Uint8Array(bytes),
      cache: "no-store",
    });
    if (!res.ok) {
      const dup = res.status === 409 || (res.status === 400 && /"(statusCode":\s*"?409|error":\s*"Duplicate)/.test(await res.clone().text().catch(() => "")));
      if (!dup) {
        console.error("[GridForge] artifact store failed:", await storeFault(res));
        return { ok: false, kind: "unavailable", error: "the artifact could not be stored" };
      }
    }
  } catch (err) {
    console.error("[GridForge] artifact store unreachable:", err instanceof Error ? err.name : "error");
    return { ok: false, kind: "unavailable", error: "the artifact could not be stored" };
  }
  const back = await readVerified(ref, meta);
  return back.ok ? { ok: true } : back;
}

export async function deleteArtifact(ref: string): Promise<boolean> {
  const c = authOnly();
  if (!c || !refOk(ref)) return false;
  try {
    const res = await fetch(`${c.url}/storage/v1/object/${ref}`, { method: "DELETE", headers: c.headers, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}
