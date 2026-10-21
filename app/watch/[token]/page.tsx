import type { Metadata } from "next";
import { EngagementIntake } from "@/components/EngagementIntake";
import { getWatch, notesFor } from "@/lib/watches";
import { RATE_POLICIES } from "@/lib/rate-limit";

export const metadata: Metadata = {
  title: "Hall Watch",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function WatchPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const w = await getWatch(token);

  if (!w) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
        <h1 className="text-2xl font-semibold text-ghost">Not found</h1>
        <p className="mt-3 text-mute">
          This link does not correspond to a watched hall. Check the address, or reply to the email
          it came in.
        </p>
      </main>
    );
  }

  const notes = w.id === "local" ? [] : await notesFor(w.id);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-28 sm:px-8">
      <header className="mb-8 max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
          Hall Watch · {w.cadence}
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost">
          {w.site_name ? `${w.site_name} · ${w.hall_id ?? ""}` : "Your hall, kept live"}
        </h1>
        <p className="mt-4 text-mute">
          The model is re-solved on schedule and whenever you change an input. You get what moved,
          which input moved it, and whether it changes the decision. When our own libraries move —
          a quotation replaces a placeholder, a platform&apos;s figures are revised — the answer can
          change without you touching anything, and you hear it from us.
        </p>
      </header>

      {w.status === "paused" ? (
        <p className="mb-8 max-w-3xl rounded border border-queue/50 bg-queue/10 p-4 text-sm text-ghost">
          This watch is paused because the last payment did not clear. No runs happen while it is paused, and re-solving is
          off. Your numbers and every note are kept, and it resumes by itself when a payment clears.
        </p>
      ) : null}
      {w.status === "cancelled" ? (
        <p className="mb-8 max-w-3xl rounded border border-line bg-panel-2 p-4 text-sm text-mute">
          This watch was cancelled: no further runs happen. The notes below stay readable here.
        </p>
      ) : null}

      {notes.length ? (
        <section className="mb-10">
          <h2 className="mb-3 text-sm font-semibold text-ghost">Change notes</h2>
          <div className="grid gap-2">
            {notes.map((n) => (
              <div
                key={n.id}
                className={`rounded border bg-panel-2 p-4 ${
                  n.material ? "border-queue/50" : "border-line"
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
                    {new Date(n.created_at).toLocaleDateString()} ·{" "}
                    {n.trigger === "inputs_updated" ? "you updated an input" : n.trigger === "baseline" ? "baseline" : "scheduled run"}
                  </span>
                  {typeof n.racks_delta === "number" && n.racks_delta !== 0 ? (
                    <span className="font-mono text-sm text-queue">
                      {n.racks_delta > 0 ? "+" : ""}
                      {n.racks_delta} racks
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-ghost">{n.headline}</p>
                {n.document_html ? (
                  <a
                    href={`/api/watch/${token}/note/${n.id}`}
                    className="mt-2 inline-block text-sm text-power hover:underline"
                  >
                    Read the note
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {w.status === "active" ? (
        <section>
          <h2 className="mb-1 text-sm font-semibold text-ghost">
            {w.intake ? "Update the hall's numbers" : "Give the model the hall's numbers"}
          </h2>
          <p className="mb-4 max-w-3xl text-xs text-faint">
            Submitting re-solves immediately — you do not wait for the next scheduled run to learn that your answer moved.
            Re-solves are limited to {RATE_POLICIES.customer_generate.limit} an hour per connection (a fair-use limit shared with
            other work on your engagements); a refused request says when to retry.
            {w.intake
              ? ` Scheduled runs happen at the first weekly check after the next run date${w.next_run_at ? ` (${new Date(w.next_run_at).toLocaleDateString("en-IE")})` : ""}, so a run can follow that date by up to a week.`
              : " Nothing runs on a schedule until the first numbers are in; the first submission records the baseline later notes compare against."}
          </p>
          <EngagementIntake
            token={token}
            endpoint={`/api/watch/${token}`}
            submitLabel={w.intake ? "Re-solve the hall" : "Start the watch"}
          />
        </section>
      ) : null}
    </main>
  );
}
