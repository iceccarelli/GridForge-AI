/**
 * The byte ceiling is enforced BEFORE the body is read to the end: a route that forwards a body to a paid provider must be
 * able to refuse an oversized one without buffering it, including a stream that never ends.
 */
import { describe, expect, it } from "vitest";
import { readBoundedJson, readBoundedText } from "@/lib/http-body";

function streamed(chunks: number, chunkBytes: number, declared?: number) {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls += 1;
      if (pulls > chunks) return c.close();
      c.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    },
  });
  const req = new Request("http://x/", { method: "POST", body, duplex: "half", headers: declared === undefined ? {} : { "content-length": String(declared) } } as RequestInit);
  return { req, pulls: () => pulls };
}

describe("readBoundedText / readBoundedJson", () => {
  it("returns the body when it fits, including exactly at the ceiling", async () => {
    const r = await readBoundedText(new Request("http://x/", { method: "POST", body: "a".repeat(100) }), 100);
    expect(r).toEqual({ ok: true, text: "a".repeat(100) });
  });

  it("refuses one byte over with 413", async () => {
    expect(await readBoundedText(new Request("http://x/", { method: "POST", body: "a".repeat(101) }), 100)).toMatchObject({ ok: false, status: 413 });
  });

  it("an oversized DECLARED length is refused without reading the body at all", async () => {
    const s = streamed(5, 10, 10_000_000);
    // (the platform primes a stream with one pull when the Request is built; what matters is that nothing more is read)
    expect(await readBoundedText(s.req, 1000)).toMatchObject({ ok: false, status: 413 });
    expect(s.pulls()).toBeLessThanOrEqual(1);
  });

  it("an undeclared (chunked) body that never ends is cut off as soon as it passes the ceiling", async () => {
    const s = streamed(1_000_000, 1024); // would be ~1 GB if read to the end
    expect(await readBoundedText(s.req, 4096)).toMatchObject({ ok: false, status: 413 });
    expect(s.pulls()).toBeLessThan(20);
  });

  it("a lying Content-Length does not let a larger body through", async () => {
    const s = streamed(50, 1024, 10); // declares 10 bytes, sends 50 KB
    expect(await readBoundedText(s.req, 4096)).toMatchObject({ ok: false, status: 413 });
  });

  it("invalid JSON is 400, not 413, and an empty body is not a JSON value", async () => {
    expect(await readBoundedJson(new Request("http://x/", { method: "POST", body: "{nope" }), 100)).toMatchObject({ ok: false, status: 400 });
    expect(await readBoundedJson(new Request("http://x/", { method: "POST" }), 100)).toMatchObject({ ok: false, status: 400 });
    expect(await readBoundedJson(new Request("http://x/", { method: "POST", body: '{"a":1}' }), 100)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("decodes multi-byte UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode("héllo—✓");
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
    const r = await readBoundedText(new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit), 100);
    expect(r).toEqual({ ok: true, text: "héllo—✓" });
  });
});
