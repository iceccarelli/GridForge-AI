import { InputBody, hallInputs, pathId, recordInput, reply, serveRead, serveWrite } from "@/lib/sites";
import { FIELD_PATH_PATTERN } from "@/lib/site-registry-fields";

export const runtime = "nodejs";

// GET [?history=1[&field=<path>][&limit=1..500]] -> the hall's CURRENT figures (the latest, non-replaced claim per field; a hall holds at most 500), or every claim
// ever made NEWEST FIRST, bounded (`truncated` says more exist), optionally for one field. Each carries
// its origin, evidence class, date, source label and who recorded it. A field nobody has recorded is simply not listed here: the page shows it
// as missing.
//
// POST -> append one claim. Nothing is ever overwritten: a correction names the claim it replaces (`supersedes`), and the earlier one stays.
// The origin and class are the RECORDER'S declaration, and the database refuses the combinations that would let a declared figure pass for a
// measured one (a measured, observed or quoted figure needs a source file; an assumed or modelled one cannot claim above E3; missing has no value).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  const q = new URL(req.url).searchParams;
  const history = ["1", "true"].includes(q.get("history") ?? "");
  const rawField = (q.get("field") ?? "").trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, Number.parseInt(q.get("limit") ?? "500", 10) || 500));
  return serveRead(req, async (email) => {
    const hall = pathId(raw);
    if (!hall.ok) return hall.response;
    if (rawField && !FIELD_PATH_PATTERN.test(rawField)) return reply({ ok: false, error: "field must be a dotted path." }, 400);
    const r = await hallInputs(email, hall.id, { history, field: rawField || null, limit });
    return r.ok ? reply({ ok: true, hall: r.value.hall, inputs: r.value.inputs, truncated: r.value.truncated, history }) : r.response;
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  return serveWrite(req, InputBody, async (email, body) => {
    const hall = pathId(raw);
    if (!hall.ok) return hall.response;
    const r = await recordInput(email, hall.id, body);
    return r.ok ? reply({ ok: true, id: r.value.id, input: r.value.input }, 201) : r.response;
  });
}
