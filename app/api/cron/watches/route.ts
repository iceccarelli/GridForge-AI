import crypto from "node:crypto";
import { SITE_URL } from "@/lib/site";
import { sendMail } from "@/lib/mail";
import { NextResponse } from "next/server";
import {
  claimWatch,
  dueWatches,
  nextRun,
  recordNote,
  runWatch,
  updateWatch,
  WATCH_RETRY_BACKOFF_MS,
  type WatchRecord,
} from "@/lib/watches";
import { runTrusted } from "@/lib/spend-scope";

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
// Header-only authorization (Authorization: Bearer <CRON_SECRET>), constant-time.
// A secret in the query string ends up in access logs, so ?key= is not accepted.
// With no CRON_SECRET configured nothing is authorised.
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!authorised(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Authenticated by the cron secret above: scheduled re-solves of watches customers pay for, not metered per caller.
  return runTrusted("cron-secret", async () => {
    const watches = await dueWatches();
    const results: { token: string; status: string; headline?: string }[] = [];

    for (const w of watches) {
      // Lease first: a conditional update of next_run_at, so an overlapping
      // invocation that read the same due list skips this watch instead of
      // re-running it and double-notifying the client.
      const claim = await claimWatch(w);
      if (claim !== "claimed") {
        results.push({ token: w.token, status: claim === "lost" ? "skipped_claimed_elsewhere" : "claim_error" });
        continue;
      }
      results.push(await runOne(w));
    }

    return NextResponse.json({ ok: true, considered: watches.length, results });
  });
}

/**
 * A failed attempt (engine down, note or state not stored) pushes next_run_at
 * back by a retry backoff. dueWatches() orders by next_run_at ascending, so a
 * watch that keeps failing moves behind the healthy ones instead of starving them.
 */
async function backOff(w: WatchRecord): Promise<void> {
  await updateWatch(w.token, { next_run_at: new Date(Date.now() + WATCH_RETRY_BACKOFF_MS).toISOString() });
}

async function runOne(w: WatchRecord): Promise<{ token: string; status: string; headline?: string }> {
  if (!w.intake) {
    const ok = await updateWatch(w.token, { next_run_at: nextRun(new Date(), w.cadence) });
    return { token: w.token, status: ok ? "no_intake" : "store_error" };
  }
  if (!w.last_state) {
    // First run: there is nothing to compare against, so record the baseline rather
    // than reporting a change that did not happen.
    const baseline = await runWatch(w.intake, null, w.intake);
    if (!baseline.ok) {
      await backOff(w);
      return { token: w.token, status: `engine_error: ${baseline.error}` };
    }
    const saved = await updateWatch(w.token, {
      last_state: baseline.diff.after,
      last_run_at: new Date().toISOString(),
      next_run_at: nextRun(new Date(), w.cadence),
    });
    if (!saved) {
      await backOff(w);
      return { token: w.token, status: "store_error" };
    }
    return { token: w.token, status: "baseline_recorded" };
  }

  const out = await runWatch(w.intake, w.last_state);
  if (!out.ok) {
    await backOff(w);
    return { token: w.token, status: `engine_error: ${out.error}` };
  }
  const d = out.diff;

  // The note is the durable record of what moved. last_state is the baseline the
  // NEXT run compares against, so it advances only once the note is stored: if it
  // advanced without one, the change would be lost and the next note misattributed.
  const noted = await recordNote({
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
  if (!noted) {
    await backOff(w);
    return { token: w.token, status: "note_not_stored" };
  }
  const advanced = await updateWatch(w.token, {
    last_state: d.after,
    last_run_at: new Date().toISOString(),
    next_run_at: nextRun(new Date(), w.cadence),
  });
  if (!advanced) {
    // Note stored but state not advanced: do not email (the retry would email again).
    await backOff(w);
    return { token: w.token, status: "state_not_advanced" };
  }

  if (d.material) await notify(w, d.headline);
  return { token: w.token, status: d.material ? "changed" : "no_change", headline: d.headline };
}

async function notify(w: WatchRecord, headline: string): Promise<void> {
  // The change note itself is stored (watch_notes) and readable on the watch page, so this email is a
  // courtesy pointer to it, not the only copy: a failure is logged by record id and category only.
  if (!w.email) {
    console.error(`[GridForge] watch change NOT emailed: no address on record (watch ${w.id})`);
    return;
  }
  const r = await sendMail({
    to: w.email,
    subject: `${w.site_name ?? "Your hall"} ${w.hall_id ?? ""} — the answer moved`.trim(),
    text: `${headline}\n\nThe change note, with the input that moved it:\n${SITE_URL}/watch/${w.token}\n`,
  });
  if (!r.sent) console.error(`[GridForge] watch change NOT emailed (watch ${w.id}): ${r.category}${r.status ? ` (HTTP ${r.status})` : ""}`);
}
