import { SITE_URL, siteUrl } from "@/lib/site";
import { NextResponse } from "next/server";
import {
  dueWatches,
  nextRun,
  recordNote,
  runWatch,
  updateWatch,
  type WatchRecord,
} from "@/lib/watches";

export const runtime = "nodejs";
export const maxDuration = 300;

// Scheduled re-run of every watched hall.
//
// Nothing the client did has to change for this to be worth sending. Our own
// libraries move — a quotation replaces a placeholder, a platform's figures are
// revised, a constraint is added — and the answer moves with them. The client
// hears that from us rather than discovering it two quarters later.
//
// A run that finds nothing material still records a note. "Nothing changed" is a
// real answer and the subscription is partly paying for the confidence of hearing
// it; manufacturing a finding to justify the fee is how this product would die.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : new URL(req.url).searchParams.get("key");
  if (!secret || given !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const watches = await dueWatches();
  const results: { token: string; status: string; headline?: string }[] = [];

  for (const w of watches) {
    results.push(await runOne(w));
  }

  return NextResponse.json({ ok: true, considered: watches.length, results });
}

async function runOne(w: WatchRecord): Promise<{ token: string; status: string; headline?: string }> {
  if (!w.intake) {
    await updateWatch(w.token, { next_run_at: nextRun(new Date(), w.cadence) });
    return { token: w.token, status: "no_intake" };
  }
  if (!w.last_state) {
    // First run: there is nothing to compare against, so record the baseline rather
    // than reporting a change that did not happen.
    const baseline = await runWatch(w.intake, null, w.intake);
    if (!baseline.ok) return { token: w.token, status: `engine_error: ${baseline.error}` };
    await updateWatch(w.token, {
      last_state: baseline.diff.after,
      last_run_at: new Date().toISOString(),
      next_run_at: nextRun(new Date(), w.cadence),
    });
    return { token: w.token, status: "baseline_recorded" };
  }

  const out = await runWatch(w.intake, w.last_state);
  if (!out.ok) return { token: w.token, status: `engine_error: ${out.error}` };
  const d = out.diff;

  await recordNote({
    watch_id: w.id,
    material: Boolean(d.material),
    headline: d.headline,
    racks_delta: d.racks_delta,
    weeks_delta: d.weeks_delta,
    binding_moved: d.binding_moved,
    document_html: (d.document_full as string) ?? (d.document as string) ?? null,
    document_md: d.markdown ?? null,
    change: d,
    trigger: "scheduled",
  });
  await updateWatch(w.token, {
    last_state: d.after,
    last_run_at: new Date().toISOString(),
    next_run_at: nextRun(new Date(), w.cadence),
  });

  if (d.material) await notify(w, d.headline);
  return { token: w.token, status: d.material ? "changed" : "no_change", headline: d.headline };
}

async function notify(w: WatchRecord, headline: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from || !w.email) return;
  const base = SITE_URL;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: w.email,
        subject: `${w.site_name ?? "Your hall"} ${w.hall_id ?? ""} — the answer moved`.trim(),
        text: `${headline}\n\nThe change note, with the input that moved it:\n${base}/watch/${w.token}\n`,
      }),
    });
  } catch (err) {
    console.error("[GridForge] watch notification failed:", err);
  }
}
