// Server-only: read a request body with a hard byte ceiling BEFORE anything expensive happens.
//
// `req.json()` / `req.text()` buffer whatever the caller sends. A route that forwards the parsed body to a paid provider must refuse an
// oversized one first, and must not read more than the ceiling to find out: the stream is cancelled the moment it passes. Every route that reads a
// body reads it through here (tests/site/bounded-json-bodies.test.ts scans app/api and fails on one that does not, bar a short, reasoned list).

export type BodyResult =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 413; error: string };

export type BytesResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: 400 | 413; error: string };

export type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

/** The engine refuses bodies over this (gridforge/api/server.py MAX_BODY_BYTES); the site must never forward more. */
export const ENGINE_BODY_MAX_BYTES = 512 * 1024;

/** POST /api/admin/login takes `{ "password": "..." }`: a few dozen bytes. This is generous for a password and nothing for an attacker. */
export const ADMIN_LOGIN_MAX_BODY_BYTES = 4 * 1024;

/** The Stripe webhook's cap. A Stripe event is a few kilobytes (the largest are a few hundred); 1 MiB is far above any real one and far below a cost. */
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/**
 * The body as the exact bytes received, or the refusal. The limit logic every reader here shares: a declared Content-Length over the cap is
 * refused without reading anything; otherwise the stream is read chunk by chunk and cancelled the moment the running total passes the cap (a
 * missing or LYING length is caught by the count, not trusted). No body is empty bytes.
 */
export async function readBoundedBytes(req: Request, maxBytes: number): Promise<BytesResult> {
  const tooLarge: BytesResult = { ok: false, status: 413, error: "Request too large." };
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  if (!req.body) return { ok: true, bytes: Buffer.alloc(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "The request body could not be read." };
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

/** The body decoded as UTF-8 text, under the same cap. For a signature check use readBoundedBytes: it hands over the bytes untouched. */
export async function readBoundedText(req: Request, maxBytes: number): Promise<BodyResult> {
  const body = await readBoundedBytes(req, maxBytes);
  if (!body.ok) return body;
  return { ok: true, text: new TextDecoder().decode(body.bytes) };
}

export async function readBoundedJson(req: Request, maxBytes: number): Promise<JsonResult> {
  const body = await readBoundedText(req, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body." };
  }
}
