import { InputBody, hallInputs, pathId, recordInput, reply, serveRead, serveWrite } from "@/lib/sites";

export const runtime = "nodejs";

// GET [?history=1] -> the hall's CURRENT figures (the latest, non-replaced claim per field), or every claim ever made, oldest first. Each carries
// its origin, evidence class, date, source label and who recorded it. A field nobody has recorded is simply not listed here: the page shows it
// as missing.
//
// POST -> append one claim. Nothing is ever overwritten: a correction names the claim it replaces (`supersedes`), and the earlier one stays.
// The origin and class are the RECORDER'S declaration, and the database refuses the combinations that would let a declared figure pass for a
// measured one (a measured, observed or quoted figure needs a source file; an assumed or modelled one cannot claim above E3; missing has no value).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  const history = ["1", "true"].includes(new URL(req.url).searchParams.get("history") ?? "");
  return serveRead(req, async (email) => {
    const hall = pathId(raw);
    if (!hall.ok) return hall.response;
    const r = await hallInputs(email, hall.id, history);
    return r.ok ? reply({ ok: true, hall: r.value.hall, inputs: r.value.inputs, history }) : r.response;
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  return serveWrite(req, InputBody, async (email, body) => {
    const hall = pathId(raw);
    if (!hall.ok) return hall.response;
    const r = await recordInput(email, hall.id, body);
    return r.ok ? reply({ ok: true, id: r.value.id }, 201) : r.response;
  });
}
