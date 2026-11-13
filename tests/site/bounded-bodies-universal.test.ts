/**
 * Bounded request bodies, for the two routes that were not: POST /api/admin/login (unauthenticated, behind only the login throttle) and the Stripe
 * webhook (`req.text()`, unauthenticated until the signature is checked, and the signature is checked AFTER the whole body is read).
 *
 * `req.json()` / `req.text()` buffer whatever the caller sends. The five open routes were bounded in tests/site/bounded-json-bodies.test.ts; these two
 * were missed. Each now refuses a body over its cap with 413 before anything is parsed, compared or verified:
 *
 *   - admin login reads through readBoundedJson with a small cap (a password is a few dozen bytes), AFTER the throttle, so an oversized attempt still
 *     counts as an attempt;
 *   - the webhook reads the raw bytes through readBoundedBytes with a 1 MiB cap and hands those exact bytes, untouched, to the signature check.
 *
 * Stripe is a stand-in (tests/site/billing-holds-harness.ts) and the store an in-memory fake; signatures are real, made by the SDK's own test helper.
 */
import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { ADMIN_LOGIN_MAX_BODY_BYTES, STRIPE_WEBHOOK_MAX_BODY_BYTES, readBoundedBytes, readBoundedJson, readBoundedText } from "@/lib/http-body";
import { WH, startRig, type Rig } from "./billing-holds-harness";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => [...jar].reverse().find((c) => c.name === name),
    set: (name: string, value: string) => { jar.push({ name, value }); },
    delete: () => {},
  }),
}));

const enc = new TextEncoder();
const stream = (chunks: Uint8Array[], onCancel?: () => void) =>
  new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); }, cancel() { onCancel?.(); } });
const streamed = (chunks: Uint8Array[], headers: Record<string, string> = {}, onCancel?: () => void) =>
  new Request("http://x/", { method: "POST", headers, body: stream(chunks, onCancel), duplex: "half" } as RequestInit);
const plain = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("http://x/", { method: "POST", headers, body });

describe("the readers (lib/http-body.ts)", () => {
  it("readBoundedBytes returns the EXACT bytes, including ones that are not valid UTF-8 and a leading byte-order mark, and readBoundedText decodes the same bytes", async () => {
    const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xc3, 0xa9, 0x22, 0x7d]);
    const b = await readBoundedBytes(plain(raw), 1000);
    expect(b.ok).toBe(true);
    if (b.ok) expect([...b.bytes]).toEqual([...raw]);
    const t = await readBoundedText(plain(raw), 1000);
    expect(t.ok).toBe(true);
    if (t.ok && b.ok) expect(t.text).toBe(new TextDecoder().decode(b.bytes));
  });

  it("the cap is in BYTES, exact at the limit and refused one past it", async () => {
    expect((await readBoundedBytes(plain("a".repeat(1000)), 1000)).ok).toBe(true);
    expect(await readBoundedBytes(plain("a".repeat(1001)), 1000)).toMatchObject({ ok: false, status: 413 });
    expect(await readBoundedText(plain("é".repeat(600)), 1000)).toMatchObject({ ok: false, status: 413 }); // 1200 bytes, 600 characters
  });

  it("a declared Content-Length over the cap is refused without reading the body; a LYING small one is caught by the stream", async () => {
    let pulled = false;
    // highWaterMark 0: nothing is pulled from the source until a reader asks for it.
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled = true; c.enqueue(enc.encode("a".repeat(10))); c.close(); } }, { highWaterMark: 0 });
    const declared = await readBoundedBytes(new Request("http://x/", { method: "POST", headers: { "content-length": "5000" }, body, duplex: "half" } as RequestInit), 1000);
    expect(declared).toMatchObject({ ok: false, status: 413 });
    expect(pulled, "the body was not read once its declared length was over the cap").toBe(false);
    const lying = await readBoundedBytes(plain("a".repeat(5000), { "content-length": "5" }), 1000);
    expect(lying).toMatchObject({ ok: false, status: 413 });
  });

  it("a chunked body with no length is cancelled the moment it passes the cap", async () => {
    let cancelled = false;
    const r = await readBoundedBytes(streamed([enc.encode("a".repeat(400)), enc.encode("a".repeat(400)), enc.encode("a".repeat(400)), enc.encode("a".repeat(400))], {}, () => { cancelled = true; }), 1000);
    expect(r).toMatchObject({ ok: false, status: 413 });
    expect(cancelled, "the stream was cancelled, not drained").toBe(true);
  });

  it("no body is empty bytes; the caps are the ones the routes use", async () => {
    expect(await readBoundedBytes(new Request("http://x/", { method: "POST" }), 10)).toEqual({ ok: true, bytes: expect.any(Uint8Array) });
    expect(ADMIN_LOGIN_MAX_BODY_BYTES).toBeLessThanOrEqual(8 * 1024);
    expect(ADMIN_LOGIN_MAX_BODY_BYTES).toBeGreaterThanOrEqual(512);
    expect(STRIPE_WEBHOOK_MAX_BODY_BYTES).toBe(1024 * 1024);
  });

  it("readBoundedJson still answers 400 for invalid JSON and 413 for too much", async () => {
    expect(await readBoundedJson(plain("{nope"), 100)).toMatchObject({ ok: false, status: 400 });
    expect(await readBoundedJson(plain(JSON.stringify({ pad: "x".repeat(500) })), 100)).toMatchObject({ ok: false, status: 413 });
    expect(await readBoundedJson(plain('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("POST /api/admin/login", () => {
  const PASSWORD = "a-long-random-admin-password";
  const post = (body: BodyInit | null, headers: Record<string, string> = {}, ip = "203.0.113.41") =>
    new Request(siteUrl("/api/admin/login"), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, body });
  const login = async (req: Request) => (await import("@/app/api/admin/login/route")).POST(req);

  beforeEach(async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    jar.length = 0;
    (await import("@/lib/admin")).resetLoginThrottle();
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.ADMIN_PASSWORD;
    vi.restoreAllMocks();
  });

  it("a body over the cap is 413, whatever it holds, and signs nobody in (even with the right password inside it)", async () => {
    const big = JSON.stringify({ password: PASSWORD, pad: "x".repeat(ADMIN_LOGIN_MAX_BODY_BYTES + 1) });
    const res = await login(post(big));
    expect(res.status).toBe(413);
    expect(jar).toHaveLength(0);
  });

  it("a declared length over the cap, and a chunked body with none, are refused the same way", async () => {
    expect((await login(post(JSON.stringify({ password: "x" }), { "content-length": String(ADMIN_LOGIN_MAX_BODY_BYTES + 100) }))).status).toBe(413);
    const chunked = new Request(siteUrl("/api/admin/login"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.42" },
      body: stream([enc.encode('{"password":"'), enc.encode("x".repeat(ADMIN_LOGIN_MAX_BODY_BYTES)), enc.encode('"}')]),
      duplex: "half",
    } as RequestInit);
    expect((await login(chunked)).status).toBe(413);
    expect(jar).toHaveLength(0);
  });

  it("a normal login still works, a wrong password is 401, and malformed JSON is the same 400 as before", async () => {
    expect((await login(post(JSON.stringify({ password: PASSWORD })))).status).toBe(200);
    expect(jar.map((c) => c.name)).toContain("gf_admin");
    expect((await login(post(JSON.stringify({ password: "wrong" })))).status).toBe(401);
    const bad = await login(post("{not json"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, error: "Invalid payload" });
    expect((await login(post(""))).status).toBe(400);
    for (const odd of ["null", "[]", "42", '"str"']) expect((await login(post(odd))).status, odd).toBe(401);
  });

  it("the body is read AFTER the throttle (an oversized attempt still costs an attempt) and through the bounded reader, never req.json()", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app/api/admin/login/route.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).toContain("readBoundedJson(req, ADMIN_LOGIN_MAX_BODY_BYTES)");
    expect(src).not.toMatch(/\breq\.json\(\)/);
    expect(src.indexOf("throttleLogin(")).toBeGreaterThan(-1);
    expect(src.indexOf("throttleLogin(")).toBeLessThan(src.indexOf("readBoundedJson("));
  });

  it("oversized attempts are counted by the throttle: enough of them from one address and the answer becomes 429", async () => {
    const big = JSON.stringify({ pad: "x".repeat(ADMIN_LOGIN_MAX_BODY_BYTES + 1) });
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) seen.add((await login(post(big, {}, "203.0.113.77"))).status);
    expect(seen.has(413)).toBe(true);
    expect(seen.has(429), "the throttle stood in front of the body read").toBe(true);
  });
});

describe("POST /api/stripe/webhook", () => {
  const sdk = new Stripe("sk_test_placeholder");
  let rig: Rig;
  beforeEach(() => { rig = startRig(); });
  afterEach(() => rig.stop());

  const TABLES = ["api_accounts", "watches", "subscriptions", "deliverables", "leads", "billing_audit", "funnel_events", "customer_notifications", "operator_notices"];
  const snapshot = () => JSON.stringify(TABLES.map((t) => { try { return rig.db.rows(t); } catch { return null; } }));
  const hook = async (body: BodyInit | null, headers: Record<string, string> = {}) =>
    (await import("@/app/api/stripe/webhook/route")).POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "content-type": "application/json", ...headers }, body, ...(body && typeof body !== "string" && !(body instanceof Uint8Array) ? { duplex: "half" } : {}) } as RequestInit));
  const signed = (raw: string) => ({ "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload: raw, secret: WH }) });
  const unknownEvent = (extra = "") => JSON.stringify({ id: "evt_unknown_1", object: "event", type: "test.nothing_we_handle", livemode: false, data: { object: { id: "x", note: extra } } });

  it("a body over 1 MiB is 413 before the signature is looked at: nothing is verified, written or mailed (a correctly signed one included)", async () => {
    const before = snapshot();
    const big = unknownEvent("y".repeat(STRIPE_WEBHOOK_MAX_BODY_BYTES));
    expect(big.length).toBeGreaterThan(STRIPE_WEBHOOK_MAX_BODY_BYTES);
    const res = await hook(big, signed(big));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(snapshot()).toBe(before);
    expect(rig.mail).toHaveLength(0);
  });

  it("a declared Content-Length over the cap, and a chunked body with none, are refused the same way", async () => {
    const small = unknownEvent();
    expect((await hook(small, { ...signed(small), "content-length": String(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1) })).status).toBe(413);
    const chunk = enc.encode("z".repeat(256 * 1024));
    const chunked = await hook(stream([chunk, chunk, chunk, chunk, chunk]));
    expect(chunked.status).toBe(413);
  });

  it("a body of exactly the cap is READ (and, being no signed event, refused as a bad signature, not as too large)", async () => {
    const pad = "p".repeat(STRIPE_WEBHOOK_MAX_BODY_BYTES);
    expect((await hook(pad, { "stripe-signature": "t=1,v1=00" })).status).toBe(400);
  });

  it("a normal signed delivery is verified and acknowledged; the same delivery with one byte changed is a bad signature", async () => {
    const raw = unknownEvent("normal");
    expect((await hook(raw, signed(raw))).status).toBe(200);
    const tampered = raw.replace("normal", "abnormal");
    expect((await hook(tampered, signed(raw))).status).toBe(400);
  });

  it("the signature is checked over the EXACT bytes received: odd whitespace and multi-byte characters verify, and the route hands the SDK those bytes (not re-encoded text)", async () => {
    const raw = `{ "id" : "evt_exact_1" ,\n  "object":"event",\t"type":"test.nothing_we_handle", "livemode":false,\n"data":{"object":{"id":"é-İ-😀","pad":"  spaced   out  "}} }\n\n`;
    expect((await hook(raw, signed(raw))).status).toBe(200);
    const src = fs.readFileSync(path.join(process.cwd(), "app/api/stripe/webhook/route.ts"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toContain("readBoundedBytes(req, STRIPE_WEBHOOK_MAX_BODY_BYTES)");
    expect(src).toMatch(/constructEvent\(\s*read\.bytes\b/);
    expect(src).not.toMatch(/\breq\.text\(\)/);
  });

  it("an unconfigured webhook is still 503 (the cap does not change what an unconfigured deployment answers)", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const raw = unknownEvent();
    expect((await hook(raw, signed(raw))).status).toBe(503);
  });
});
