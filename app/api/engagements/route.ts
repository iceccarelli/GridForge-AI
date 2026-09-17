import { NextResponse } from "next/server";
import { identify } from "@/lib/portal";
import { PRODUCT_BY_KIND } from "@/lib/products";

export const runtime = "nodejs";

/**
 * What this person has actually bought. Nothing else.
 *
 * Every row here is a row somebody paid for: a `deliverables` row exists only
 * because a checkout completed, and a `watches` row only because a subscription
 * started. There is no sample, no placeholder and no "for demo" branch, which is
 * the whole point of the route — /dashboard rendered three invented projects and
 * a fabricated $2.9M savings figure because it had no source of real ones.
 *
 * An empty answer is a real answer and the page renders it as one.
 *
 * Matched on the VERIFIED email from the caller's Supabase session, never on an
 * email the caller supplied. See lib/portal.ts.
 */
export async function GET(req: Request) {
  const who = await identify(req);
  if (!who.ok) {
    return NextResponse.json({ ok: false, error: who.error }, { status: who.status });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json(
      { ok: false, error: "The engagement store is not connected to this deployment." },
      { status: 503 }
    );
  }
  const headers: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };

  const eq = `eq.${encodeURIComponent(who.email)}`;

  // A store we could not read says nothing about this customer. Answering with an
  // empty list would tell somebody who has paid us that they have bought nothing,
  // which is the exact failure /api/subscription-status was fixed for.
  let engagements: Row[];
  let watches: WatchRow[];
  try {
    const [d, w] = await Promise.all([
      fetch(
        `${url}/rest/v1/deliverables?email=${eq}&select=` +
          `token,intake_token,kind,status,title,amount_cents,created_at,released_at` +
          `&order=created_at.desc&limit=100`,
        { headers, cache: "no-store" }
      ),
      fetch(
        `${url}/rest/v1/watches?email=${eq}&select=` +
          `token,status,cadence,site_name,hall_id,created_at,last_run_at,next_run_at` +
          `&order=created_at.desc&limit=100`,
        { headers, cache: "no-store" }
      ),
    ]);
    if (!d.ok) {
      console.error("[GridForge] portal deliverables read failed:", d.status, await d.text());
      return unreachable();
    }
    if (!w.ok) {
      console.error("[GridForge] portal watches read failed:", w.status, await w.text());
      return unreachable();
    }
    engagements = (await d.json()) as Row[];
    watches = (await w.json()) as WatchRow[];
  } catch (err) {
    console.error("[GridForge] portal store unreachable:", err);
    return unreachable();
  }

  return NextResponse.json({
    ok: true,
    email: who.email,
    engagements: engagements.map((r) => {
      const product = PRODUCT_BY_KIND[r.kind];
      const released = r.status === "released";
      return {
        kind: r.kind,
        name: product?.name ?? r.kind,
        status: r.status,
        title: r.title,
        amountCents: r.amount_cents,
        createdAt: r.created_at,
        releasedAt: r.released_at,
        turnaroundDays: product?.turnaroundDays ?? null,
        // The document credential is disclosed only once there is a released
        // document behind it. Before that the only useful link is the intake, and
        // handing out the document token early would turn this page into a way of
        // collecting one for later.
        documentToken: released ? r.token : null,
        // `awaiting_intake` is precisely the state in which the hall's numbers are
        // still wanted; once it has moved on, the link is spent.
        intakeToken:
          r.status === "awaiting_intake" ? (r.intake_token ?? r.token) : null,
      };
    }),
    watches: watches.map((w) => ({
      token: w.token,
      status: w.status,
      cadence: w.cadence,
      siteName: w.site_name,
      hallId: w.hall_id,
      createdAt: w.created_at,
      lastRunAt: w.last_run_at,
      nextRunAt: w.next_run_at,
    })),
  });
}

function unreachable() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "We could not read your engagements just now. This is our fault, not a " +
        "statement about your account — nothing has been cancelled.",
    },
    { status: 503 }
  );
}

interface Row {
  token: string;
  intake_token: string | null;
  kind: string;
  status: string;
  title: string | null;
  amount_cents: number | null;
  created_at: string;
  released_at: string | null;
}

interface WatchRow {
  token: string;
  status: string;
  cadence: string;
  site_name: string | null;
  hall_id: string | null;
  created_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
}
