import { guardRequest, refundHit, accountSubject } from "@/lib/rate-limit";
import { admit, pathId, registryCaller, reply } from "@/lib/sites";
import { ENGINE_DIFF_PER_DAY, ENGINE_DIFF_PER_HALL_PER_DAY, ENGINE_DIFF_PER_HOUR, ENGINE_DIFF_PER_ORG_PER_DAY } from "@/lib/site-registry-engine";
import { RunAllowance, engineDiffEnabled, featureOff, notRun, prepareDiff, readDiffBody, runEngineDiff } from "@/lib/site-registry-engine-server";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET -> whether the engine diff is switched on for this deployment (GRIDFORGE_HALL_ENGINE_DIFF=1) and the allowance, so the page can say so instead of offering a button that cannot work.
// Reads nothing of any hall and costs nothing.
export async function GET(req: Request) {
  const caller = await registryCaller(req);
  if (!caller.ok) return caller.response;
  const read = await admit(req, caller, "read");
  if (read) return read;
  return reply({ ok: true, enabled: engineDiffEnabled(), allowance: { perHour: ENGINE_DIFF_PER_HOUR, perDay: ENGINE_DIFF_PER_DAY, perHallPerDay: ENGINE_DIFF_PER_HALL_PER_DAY, perOrganisationPerDay: ENGINE_DIFF_PER_ORG_PER_DAY } });
}

// POST {from: <point>, to: <point>} -> the ENGINE's answer to "what did the change between these two points do to this hall's capacity envelope?".
// A point is {asOf: "YYYY-MM-DD"} (the record at the end of that UTC day), {now: true}, or {proposed: [import rows]} (the figures with a pending import laid over
// them, judged by the import's own rules; nothing is written). A viewer may ask: it reads, and writes nothing.
//
// OFF unless GRIDFORGE_HALL_ENGINE_DIFF=1: a run spends the OPERATOR's engine units for a free verified account, so it is 503 `feature_off` before anything is read.
// When on, a run is allowed sparingly: per verified account (hour and day), per organisation and per hall (day), and one site-wide daily ceiling that fails closed, under the
// registry's own provider budget (never the customer or public ones). Only a run that reaches the engine is counted, and every allowance a run took is given back if it fails
// before the engine answers. A stranger is answered exactly as for a hall that does not exist; an engine that is down, or has no /v1/diff, is a 503 with nothing partial;
// figures the engine needs that are not recorded are named in the answer and the engine is NOT called. Every figure goes to the engine as the recorder declared it, at no
// higher a class than the registry can stand behind (lib/site-registry-engine.ts).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!engineDiffEnabled()) return featureOff();
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

  // From here on a run costs the operator units. Organisation and hall first, then the verified account, then the site-wide ceiling; all are given back if the run fails.
  const allowance = new RunAllowance();
  const early = await allowance.scope(prepared.value.hall.orgId, hall.id);
  if (early) await allowance.refundAll();                                                          // a hall at its cap must not cost the organisation a run
  if (early) return early;
  const g = await guardRequest(req, "registry_diff", { account: { verifiedEmail: caller.email, policy: "registry_diff" }, accountOnly: true, cls: "registry" });
  g.denied?.headers.set("Cache-Control", "no-store");
  if (g.denied) await allowance.refundAll();                                                     // turned away: nothing was used, so nothing is kept
  if (g.denied?.status === 429) await refundHit("registry_diff", accountSubject(caller.email) ?? "");
  if (g.denied) return g.denied;
  allowance.note("registry_diff", accountSubject(caller.email));
  const late = await allowance.accountDayAndGlobal(caller.email);
  if (late) {
    await allowance.refundAll();
    return late;
  }
  const res = await g.run(() => runEngineDiff(prepared.value));
  if (res.status !== 200) await allowance.refundAll();
  return res;
}
