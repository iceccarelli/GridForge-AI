// Server-only: read a request body with a hard byte ceiling BEFORE anything expensive happens.
//
// `req.json()` buffers whatever the caller sends. A route that forwards the parsed body to a paid provider must refuse an
// oversized one first, and must not read more than the ceiling to find out: the stream is cancelled the moment it passes.

export type BodyResult =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 413; error: string };

export type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

/** The engine refuses bodies over this (gridforge/api/server.py MAX_BODY_BYTES); the site must never forward more. */
export const ENGINE_BODY_MAX_BYTES = 512 * 1024;

export async function readBoundedText(req: Request, maxBytes: number): Promise<BodyResult> {
  const tooLarge: BodyResult = { ok: false, status: 413, error: "Request too large." };
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  if (!req.body) return { ok: true, text: "" };
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
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)) };
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
