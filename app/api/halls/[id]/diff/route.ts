import { countHit, guardRequest, subjectOf } from "@/lib/rate-limit";
import { admit, pathId, registryCaller, reply } from "@/lib/sites";
import { notRun, prepareDiff, readDiffBody, runEngineDiff } from "@/lib/site-registry-engine-server";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST {from: <point>, to: <point>} -> the ENGINE's answer to "what did the change between these two points do to this hall's capacity envelope?".
// A point is {asOf: "YYYY-MM-DD"} (the record at the end of that UTC day), {now: true}, or {proposed: [import rows]} (the figures with a pending import laid over
// them, judged by the import's own rules; nothing is written). A viewer may ask: it reads, and writes nothing.
//
// IT COSTS THE OPERATOR 2 ENGINE UNITS A RUN, so it is allowed sparingly (lib/rate-limit.ts registry_diff per verified account, registry_diff_hall per hall) and only
// a run that reaches the engine is counted. A stranger is answered exactly as for a hall that does not exist; an engine that is down, or that has not been deployed with
// /v1/diff, is a 503 with nothing partial; figures the engine needs that are not recorded are named in the answer and the engine is NOT called. Every figure goes to
// the engine as the recorder declared it, at no higher a class than the registry can stand behind (lib/site-registry-engine.ts).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  const caller = await registryCaller(req);
  if (!caller.ok) return caller.response;
  const body = await readDiffBody(req);
  if (!body.ok) return body.response;
  const read = await admit(req, caller, "read");
  if (read) return read;
  const hall = pathId(raw);
  if (!hall.ok) return hall.response;
  const prepared = await prepareDiff(caller.email, hall.id, body.value);
  if (!prepared.ok) return prepared.response;
  const answered = notRun(prepared.value);
  if (answered) return answered;

  // From here on a run costs units: the verified account's allowance, then the hall's, then the engine under this request's spend scope.
  const g = await guardRequest(req, "registry_diff", { account: { verifiedEmail: caller.email, policy: "registry_diff" }, accountOnly: true, cls: "customer" });
  g.denied?.headers.set("Cache-Control", "no-store");
  if (g.denied) return g.denied;
  const subject = subjectOf(`hall-diff:${hall.id}`);
  const day = subject ? await countHit("registry_diff_hall", subject) : null;
  if (!day) return reply({ ok: false, error: "This service is temporarily unavailable, so nothing was run. Try again shortly." }, 503);
  if (!day.allowed) {
    const r = reply({ ok: false, error: "This hall has used its engine runs for today. Nothing was run.", reason: "hall_allowance", retry_after_seconds: day.retryAfter }, 429);
    r.headers.set("Retry-After", String(day.retryAfter));
    return r;
  }
  return g.run(() => runEngineDiff(prepared.value));
}
