import { NextResponse } from "next/server";
import { getByIntakeToken } from "@/lib/deliverables";
import { attachIntakeFile, listIntakeEvidence } from "@/lib/intake-evidence";
import { checkEvidenceType, EVIDENCE_MAX_BYTES } from "@/lib/projects";
import { guardRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

// The documents a buyer attaches to a purchased engagement, behind the numbers they will confirm (lib/intake-evidence.ts).
//   GET  -> the attached files and the values currently confirmed from them.
//   POST -> attach one file. The body IS the file; its type is the Content-Type header, its name is ?filename=. Stored as received
//           and never read or interpreted.
// The intake token is the credential, exactly as for /api/intake/<token>. An unknown token is a 404 whatever else is wrong.

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

const tooBig = () => NextResponse.json({ ok: false, error: `The file is larger than the ${EVIDENCE_MAX_BYTES / (1024 * 1024)} MB limit.` }, { status: 413 });

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByIntakeToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  const r = await listIntakeEvidence(row);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, files: r.files, confirmed: r.confirmed });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByIntakeToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > EVIDENCE_MAX_BYTES) return tooBig();
  const mediaType = req.headers.get("content-type") ?? "";
  // Type before body: an unsupported type never costs a read.
  const badType = checkEvidenceType(mediaType);
  if (badType) return NextResponse.json({ ok: false, error: badType.error }, { status: badType.status });

  const g = await guardRequest(req, "intake_evidence");
  if (g.denied) return g.denied;
  const bytes = await readCapped(req, EVIDENCE_MAX_BYTES);
  if (!bytes) return tooBig();

  const r = await attachIntakeFile(row, { filename: new URL(req.url).searchParams.get("filename") ?? "", mediaType, bytes });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, file: r.file }, { status: 201 });
}
