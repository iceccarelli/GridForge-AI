/**
 * The private artifact store client, against a deterministic Storage stub over real HTTP (tests/site/storage-stub.ts).
 * The stub persists exact bytes and enforces credentials, the private route and no-overwrite. It does NOT prove a
 * production Supabase Storage configuration.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_BUCKET, artifactPath, artifactRef, deleteArtifact, getArtifact, putVerified, readVerified, verifyBytes } from "@/lib/artifact-store";
import { sha256Hex } from "@/lib/run-identity";
import { startStorageStub, type StorageStub } from "./storage-stub";

const KEY = "stub-service-key";
const DELIV = "11111111-1111-4111-8111-111111111111";
const FP = "a".repeat(64);
let stub: StorageStub;

beforeAll(async () => {
  stub = await startStorageStub(KEY);
});
afterAll(() => stub.close());
beforeEach(() => {
  process.env.SUPABASE_URL = stub.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  stub.objects.clear();
  stub.log.length = 0;
  stub.fail.uploads = false;
  stub.fail.reads = false;
});

const bytes = Buffer.from("<html><body>SYNTHETIC study</body></html>", "utf8");
const meta = { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
const ref = artifactRef(artifactPath(DELIV, FP, meta.sha256));

describe("object path", () => {
  it("is ids and digests only, in the private bucket", () => {
    expect(ref).toBe(`${ARTIFACT_BUCKET}/${DELIV}/${FP}/${meta.sha256}.html`);
    expect(ref).not.toMatch(/SYNTHETIC|supplier|quote/i);
  });
});

describe("write, read back, verify", () => {
  it("stores the exact bytes, authenticated, never upserting, and reads them back through the private route", async () => {
    expect((await putVerified(ref, bytes, meta)).ok).toBe(true);
    expect(stub.objects.get(ref)!.bytes.equals(bytes)).toBe(true);
    expect(stub.log.every((l) => l.authed)).toBe(true);
    expect(stub.log.find((l) => l.method === "POST")!.upsert).toBe("false");
    expect(stub.log.find((l) => l.method === "GET")!.path).toContain("/object/authenticated/");
    const back = await readVerified(ref, meta);
    expect(back.ok && back.bytes.equals(bytes)).toBe(true);
  });

  it("accepts an identical object that is already there, and refuses a different one (no overwrite)", async () => {
    await putVerified(ref, bytes, meta);
    expect((await putVerified(ref, bytes, meta)).ok).toBe(true);
    const other = Buffer.from("different", "utf8");
    const r = await putVerified(ref, other, { sha256: sha256Hex(other), bytes: other.byteLength });
    expect(r.ok).toBe(false);
    expect(stub.objects.get(ref)!.bytes.equals(bytes)).toBe(true);
  });

  it("fails closed when the object is missing, changed, truncated or the store is down", async () => {
    await putVerified(ref, bytes, meta);
    const r0 = await readVerified(ref, meta);
    expect(r0.ok).toBe(true);
    stub.objects.set(ref, { bytes: Buffer.from(bytes.toString().replace("SYNTHETIC", "TAMPERED"), "utf8"), contentType: "text/html" });
    const changed = await readVerified(ref, meta);
    expect(changed.ok === false && changed.kind).toBe("corrupt");
    stub.objects.set(ref, { bytes: bytes.subarray(0, 10), contentType: "text/html" });
    expect((await readVerified(ref, meta)).ok).toBe(false);
    stub.objects.delete(ref);
    const missing = await readVerified(ref, meta);
    expect(missing.ok === false && missing.kind).toBe("missing");
    stub.fail.reads = true;
    const down = await readVerified(ref, meta);
    expect(down.ok === false && down.kind).toBe("unavailable");
  });

  it("does not report a write that the store refused or that reads back wrong", async () => {
    stub.fail.uploads = true;
    expect((await putVerified(ref, bytes, meta)).ok).toBe(false);
    expect(stub.objects.size).toBe(0);
    stub.fail.uploads = false;
    // The recorded digest disagrees with the bytes: the write is not reported as good.
    const r = await putVerified(ref, bytes, { sha256: "b".repeat(64), bytes: bytes.byteLength });
    expect(r.ok).toBe(false);
  });

  it("refuses a wrong credential and never sends one to a path it did not build", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "wrong";
    expect((await putVerified(ref, bytes, meta)).ok).toBe(false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
    stub.log.length = 0;
    expect((await getArtifact("project-evidence/x/y.pdf")).ok).toBe(false);
    expect((await getArtifact(`${ARTIFACT_BUCKET}/../../etc/passwd`)).ok).toBe(false);
    expect(stub.log).toHaveLength(0);
  });

  it("the public route of the private bucket does not serve the object", async () => {
    await putVerified(ref, bytes, meta);
    const r = await fetch(`${stub.url}/storage/v1/object/${ref}`, { headers: { apikey: KEY } });
    expect(r.status).not.toBe(200);
    const anon = await fetch(`${stub.url}/storage/v1/object/authenticated/${ref}`);
    expect(anon.status).toBe(401);
  });
});

describe("verification and deletion", () => {
  it("verifyBytes checks both length and digest", () => {
    expect(verifyBytes(bytes, meta)).toBe(true);
    expect(verifyBytes(bytes, { ...meta, bytes: meta.bytes + 1 })).toBe(false);
    expect(verifyBytes(bytes, { ...meta, sha256: "0".repeat(64) })).toBe(false);
  });
  it("deletes only a ref it could have written", async () => {
    await putVerified(ref, bytes, meta);
    expect(await deleteArtifact("project-evidence/anything")).toBe(false);
    expect(stub.objects.has(ref)).toBe(true);
    expect(await deleteArtifact(ref)).toBe(true);
    expect(stub.objects.has(ref)).toBe(false);
  });
});
