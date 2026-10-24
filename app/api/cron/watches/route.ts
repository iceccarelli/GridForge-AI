import { notifyOperator } from "@/lib/mail";
import { announceNote } from "@/lib/watch-notices";
import { NextResponse } from "next/server";
import { cronAuthorised as authorised } from "@/lib/cron-auth";
import {
  claimWatch,
  dueWatches,
  getWatch,
  nextRun,
  recordNote,
  storedChange,
  weeksLine,
  runWatch,
  updateWatch,
  updateWatchIfActive,
  watchStatusNow,
  WATCH_CRON_START_BY_MS,
  WATCH_RETRY_BACKOFF_MS,
  type WatchRecord,
} from "@/lib/watches";
import { runTrusted } from "@/lib/spend-scope";
import type { ReversalStripe } from "@/lib/billing-holds";
import { gateWatch, pauseWatchNow } from "@/lib/billing-pause";
import { paygStripe } from "@/lib/payg-stripe";

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
  if (!authorised(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Authenticated by the cron secret above: scheduled re-solves of watches customers pay for, not metered per caller.
  return runTrusted("cron-secret", async () => {
    // Drain EVERY due watch inside the run budget, not the first 25. The schedule is weekly, so a watch left over waits a
    // week; a run that cannot finish says so to the operator instead of leaving the remainder to be discovered.
    // WATCH_CRON_BUDGET_MS exists so a test can shrink the budget; production uses the default.
    const startBy = Number(process.env.WATCH_CRON_BUDGET_MS) > 0 ? Number(process.env.WATCH_CRON_BUDGET_MS) : WATCH_CRON_START_BY_MS;
    const t0 = Date.now();
    const seen = new Set<string>();
    const results: { token: string; status: string; headline?: string }[] = [];
    let considered = 0;
    let exhausted = false;

    drain: for (;;) {
      // Everything already handled is skipped, however many are still due (a claim error leaves a row due).
      const batch = (await dueWatches(seen.size + 25)).filter((w) => !seen.has(w.token));
      if (batch.length === 0) break;
      for (const w of batch) {
        if (Date.now() - t0 > startBy) {
          exhausted = true;
          break drain;
        }
        seen.add(w.token);
        considered += 1;
        // A billing pause is scheduled for the end of the period the customer paid for. Once that instant has passed, a note that fell due
        // BEFORE it is still delivered (then the pause is written); one that falls due after it is not, and the watch is paused now.
        const gate = await gateWatch(w, stripeForPause());
        if (gate.skip) {
          results.push({ token: w.token, status: gate.status });
          continue;
        }
        // Lease first: a conditional update of next_run_at, so an overlapping
        // invocation that read the same due list skips this watch instead of
        // re-running it and double-notifying the client.
        const claim = await claimWatch(w);
        if (claim !== "claimed") {
          results.push({ token: w.token, status: claim === "lost" ? "skipped_claimed_elsewhere" : "claim_error" });
          continue;
        }
        results.push(await runOne(w));
        if (gate.pauseAfter) {
          const fresh = await getWatch(w.token);
          if (fresh) await pauseWatchNow(fresh, stripeForPause());
        }
      }
    }

    const remaining = exhausted ? (await dueWatches(seen.size + 200)).filter((w) => !seen.has(w.token)).length : 0;
    const failed = results.filter((r) => FAILED.test(r.status));
    if (exhausted || failed.length) {
      // Page a person. The failed watches are pushed back by the retry backoff and the next scheduled run is a week away,
      // so without this a failed watch is silently a week late, or more.
      await notifyOperator(
        `Hall Watch run needs attention — ${failed.length} failed${exhausted ? `, ${remaining} not reached` : ""}`,
        `Considered ${considered}. ${failed.length} failed (${[...new Set(failed.map((f) => f.status.split(":")[0]))].join(", ") || "none"}).` +
          (exhausted ? ` The run budget was used up with ${remaining} due watch(es) not started; they stay due and run next time.` : "") +
          `\n\nThe schedule is weekly: a watch that failed is not retried until the next scheduled run unless you call /api/cron/watches again with the cron secret.`
      );
    }
    return NextResponse.json({ ok: true, considered, remaining, budget_exhausted: exhausted, results });
  });
}

const stripeForPause = (): ReversalStripe | null => paygStripe() as unknown as ReversalStripe | null;

/** Statuses that mean a watch did NOT get its run. */
const FAILED = /^(engine_error|store_error|note_not_stored|state_not_advanced|claim_error)/;

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
    // Conditional on the watch still being active: a cancellation or hold that landed while the engine was working is not overtaken.
    const saved = await updateWatchIfActive(w.token, {
      last_state: baseline.diff.after,
      last_run_at: new Date().toISOString(),
      next_run_at: nextRun(new Date(), w.cadence),
    });
    if (saved === "inactive") return { token: w.token, status: "skipped_inactive" };
    if (saved === "error") {
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

  // The watch was due and claimed when this run began; the engine has taken up to minutes since. A cancellation (or a refund, dispute
  // or pause hold) that landed in that time ends the run HERE: no note is stored, no state advances, nothing is sent. The store is asked,
  // not the copy read at the start; and an answer that cannot be had is not read as "still active".
  const live = await watchStatusNow(w.token);
  if (live === "unknown") {
    await backOff(w);
    return { token: w.token, status: "store_error" };
  }
  if (live !== "active") return { token: w.token, status: "skipped_inactive" };

  // The note is the durable record of what moved. last_state is the baseline the
  // NEXT run compares against, so it advances only once the note is stored: if it
  // advanced without one, the change would be lost and the next note misattributed.
  const noteId = await recordNote({
    watch_id: w.id,
    material: Boolean(d.material),
    headline: d.headline,
    racks_delta: d.racks_delta,
    weeks_delta: d.weeks_delta,
    binding_moved: d.binding_moved,
    document_html: (d.document_full as string) ?? (d.document as string) ?? null,
    document_md: d.markdown ?? null,
    change: storedChange(d),
    trigger: "scheduled",
  });
  if (!noteId) {
    await backOff(w);
    return { token: w.token, status: "note_not_stored" };
  }
  const advanced = await updateWatchIfActive(w.token, {
    last_state: d.after,
    last_run_at: new Date().toISOString(),
    next_run_at: nextRun(new Date(), w.cadence),
  });
  // Cancelled between the check above and now: the note exists (rows are never deleted) but is not announced and the state stays.
  if (advanced === "inactive") return { token: w.token, status: "skipped_inactive" };
  if (advanced === "error") {
    // Note stored but state not advanced: do not email (the retry would email again).
    await backOff(w);
    return { token: w.token, status: "state_not_advanced" };
  }

  // The change note is stored and on the watch page; its email is a durable obligation retried by the engagements sweep. One last look
  // first: a watch that stopped being active since the write above receives nothing.
  if (d.material && (await watchStatusNow(w.token)) !== "active") return { token: w.token, status: "skipped_inactive", headline: d.headline };
  if (d.material) await announceNote({ id: noteId, watch_id: w.id }, w, d.headline, weeksLine({ weeks_delta: d.weeks_delta, change: d }));
  return { token: w.token, status: d.material ? "changed" : "no_change", headline: d.headline };
}
