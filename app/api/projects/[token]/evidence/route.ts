import { NextResponse } from "next/server";
import { attachEvidence, checkEvidenceType, EVIDENCE_MAX_BYTES } from "@/lib/projects";
import { fail, withProject } from "@/lib/project-http";

export const runtime = "nodejs";
export const maxDuration = 60;

// Attach one artifact. The body IS the file; its media type is the Content-Type
// header and its name/category/note are query parameters:
//   POST /api/projects/{token}/evidence?filename=letter.pdf&source_category=utility_correspondence
// Stored unverified and unclassified. Contents are not read, parsed or interpreted.

/** Read at most `max + 1` bytes: enough to know it is too big, never the whole thing. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > EVIDENCE_MAX_BYTES) {
    return fail({ status: 413, error: `The file is larger than the ${EVIDENCE_MAX_BYTES / (1024 * 1024)} MB limit.` });
  }
  const url = new URL(req.url);
  const mediaType = req.headers.get("content-type") ?? "";

  // Type is checked before the body is read: an unsupported type never costs a read.
  const badType = checkEvidenceType(mediaType);
  if (badType) return fail(badType);

  const bytes = await readCapped(req, EVIDENCE_MAX_BYTES);
  if (!bytes) {
    return fail({ status: 413, error: `The file is larger than the ${EVIDENCE_MAX_BYTES / (1024 * 1024)} MB limit.` });
  }
  const r = await attachEvidence(p.project, {
    filename: url.searchParams.get("filename") ?? "",
    mediaType,
    bytes,
    sourceCategory: url.searchParams.get("source_category") ?? undefined,
    note: url.searchParams.get("note") ?? undefined,
  });
  if (!r.ok) return fail(r);
  const e = r.evidence;
  return NextResponse.json(
    {
      ok: true,
      evidence: {
        id: e.id, filename: e.filename, media_type: e.media_type, sha256: e.sha256,
        byte_size: e.byte_size, storage_ref: e.storage_ref, review_status: e.review_status,
        evidence_class: e.evidence_class,
      },
    },
    { status: 201 }
  );
}
