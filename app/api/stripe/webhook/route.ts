import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createDeliverable } from "@/lib/deliverables";
import { createWatch } from "@/lib/watches";
import { PRODUCT_BY_KIND } from "@/lib/products";

export const runtime = "nodejs";

// Stripe webhook. Verifies the signature (so events can't be forged), then on
// checkout.session.completed marks the matching lead deposit_paid in Supabase
// and emails the founder. Reads the raw body — required for signature checks.
export async function POST(req: Request) {
  const key = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !whSecret) {
    return NextResponse.json({ ok: false, error: "Webhook not configured" }, { status: 503 });
  }
  const stripe = new Stripe(key);

  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig ?? "", whSecret);
  } catch (err) {
    console.error("[GridForge] Stripe signature verify failed:", err);
    return NextResponse.json({ ok: false, error: "Bad signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_email || session.customer_details?.email || "";
    const company = (session.metadata?.company as string) || "";
    const amount = session.amount_total ?? 0;

    const kind = (session.metadata?.kind as string) || "engagement_deposit";
    const product = PRODUCT_BY_KIND[kind];
    if (kind === "hall_watch") {
      await openWatch({
        email,
        company,
        sessionId: session.id,
        subscriptionId: typeof session.subscription === "string" ? session.subscription : null,
        customerId: typeof session.customer === "string" ? session.customer : null,
      });
      await notifyFounder({ email, company, amount });
    } else if (product?.producesDeliverable) {
      // A purchased engineering deliverable. Paying does not produce a document:
      // it opens an intake the client fills in, which is then generated and
      // released by a human. See lib/deliverables.ts.
      await openDeliverable({
        kind,
        email,
        company,
        amount,
        sessionId: session.id,
        qualificationId: (session.metadata?.qualification_id as string) || null,
      });
      await notifyFounder({ email, company, amount });
    } else if (kind === "intelligence_subscription") {
      const plan = (session.metadata?.plan as string) || "unknown";
      const customerId = typeof session.customer === "string" ? session.customer : "";
      await recordSubscription({ email, plan, sessionId: session.id, customerId });
      await notifySubscriber({ email, plan });
    } else {
      // Mark the most recent matching lead deposit_paid (match by email, newest first).
      await markDepositPaid({ email, company, amount, sessionId: session.id });
      await notifyFounder({ email, company, amount });
    }
  }

  return NextResponse.json({ ok: true, received: true });
}

async function openWatch(p: {
  email: string;
  company: string;
  sessionId: string;
  subscriptionId: string | null;
  customerId: string | null;
}): Promise<void> {
  const row = await createWatch({
    email: p.email || null,
    company: p.company || null,
    stripe_subscription_id: p.subscriptionId,
    stripe_customer_id: p.customerId,
    cadence: "quarterly",
  });
  if (!row) {
    console.error("[GridForge] could not open a watch for session", p.sessionId);
    return;
  }
  const base = process.env.SITE_URL || "https://timetopower.ai";
  const url = `${base}/watch/${row.token}`;
  console.log(`[GridForge] hall watch opened for ${p.email || "unknown"} — ${url}`);
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from || !p.email) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: p.email,
        subject: "Your hall is now watched",
        text:
          "The model stays live from here.\n\n" +
          "Give it the hall's current numbers once, and from then on it is re-solved every " +
          "quarter and whenever you change an input. You get a change note naming what moved " +
          "and which input moved it — including when the movement came from our side because a " +
          "library or the constraint set was revised.\n\n" +
          url +
          "\n\nIf nothing material changes, we will tell you that in three lines rather than " +
          "send you a document to justify the fee.",
      }),
    });
  } catch (err) {
    console.error("[GridForge] watch email failed:", err);
  }
}

async function openDeliverable(p: {
  kind: string;
  email: string;
  company: string;
  amount: number;
  sessionId: string;
  qualificationId: string | null;
}): Promise<void> {
  const record = await createDeliverable({
    kind: p.kind,
    email: p.email || null,
    company: p.company || null,
    amount_cents: p.amount || null,
    stripe_session_id: p.sessionId,
    qualification_id: p.qualificationId || null,
    status: "awaiting_intake",
  });
  if (!record) {
    console.error("[GridForge] could not open a deliverable for session", p.sessionId);
    return;
  }
  const base = process.env.SITE_URL || "https://timetopower.ai";
  console.log(
    `[GridForge] deliverable opened (${p.kind}) for ${p.email || "unknown"} — intake link: ${base}/intake/${record.token}`
  );
  await emailIntakeLink({ email: p.email, kind: p.kind, url: `${base}/intake/${record.token}` });
}

async function emailIntakeLink(p: { email: string; kind: string; url: string }): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from || !p.email) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: p.email,
        subject: "Your GridForge engagement — the numbers we need",
        text:
          "Thank you. The engagement is open.\n\n" +
          "The next step is the hall's own numbers. Everything you do not supply is filled " +
          "from a library default and named as an assumption in the deliverable, so the more " +
          "of it you complete, the fewer of your conclusions rest on our guesses.\n\n" +
          p.url +
          "\n\nThe link is unguessable and specific to this engagement. Do not forward it to " +
          "anyone who should not read the result.",
      }),
    });
  } catch (err) {
    console.error("[GridForge] intake email failed:", err);
  }
}

async function recordSubscription(p: {
  email: string;
  plan: string;
  sessionId: string;
  customerId: string;
}): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !p.email) return;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  try {
    await fetch(
      `${url}/rest/v1/subscriptions?email=eq.${encodeURIComponent(p.email)}&status=eq.active`,
      {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ status: "superseded" }),
      }
    );
    await fetch(`${url}/rest/v1/subscriptions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        email: p.email,
        plan: p.plan,
        status: "active",
        stripe_session_id: p.sessionId,
        stripe_customer_id: p.customerId,
      }),
    });
  } catch (err) {
    console.error("[GridForge] subscription record error:", err);
  }
}

async function notifySubscriber(p: { email: string; plan: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_TO_EMAIL;
  const from = process.env.LEAD_FROM_EMAIL || "GridForge AI <power@timetopower.ai>";
  if (!apiKey) return;
  if (to) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [to],
          subject: `New Intelligence subscriber \u2014 ${p.plan} (${p.email})`,
          text: `New GridForge Intelligence subscription.\n\nEmail: ${p.email}\nPlan: ${p.plan}`,
        }),
      });
    } catch (err) {
      console.error("[GridForge] subscriber notify error:", err);
    }
  }
  if (p.email && p.email.includes("@")) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [p.email],
          reply_to: process.env.LEAD_TO_EMAIL || "power@timetopower.ai",
          subject: "Welcome to GridForge Intelligence",
          text:
            `Your ${p.plan} subscription is active.\n\n` +
            `Sign in to your live dashboard: https://timetopower.ai/account/login\n\n` +
            `\u2014 GridForge AI`,
        }),
      });
    } catch (err) {
      console.error("[GridForge] subscriber welcome error:", err);
    }
  }
}

async function markDepositPaid(p: {
  email: string;
  company: string;
  amount: number;
  sessionId: string;
}): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !p.email) return;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  try {
    // PATCH the newest lead with this email.
    const res = await fetch(
      `${url}/rest/v1/leads?email=eq.${encodeURIComponent(p.email)}&order=created_at.desc&limit=1`,
      {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          deposit_paid: true,
          deposit_amount_cents: p.amount,
          stripe_session_id: p.sessionId,
          status: "deposit_paid",
        }),
      }
    );
    if (!res.ok) console.error("[GridForge] deposit PATCH failed:", await res.text());
  } catch (err) {
    console.error("[GridForge] deposit PATCH error:", err);
  }
}

async function notifyFounder(p: { email: string; company: string; amount: number }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_TO_EMAIL;
  const from = process.env.LEAD_FROM_EMAIL || "GridForge AI <onboarding@resend.dev>";
  if (!apiKey || !to) return;
  const eur = (c: number) => `€${(c / 100).toLocaleString("en-IE")}`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `💳 Deposit paid — ${p.company || p.email} (${eur(p.amount)})`,
        text: `Engagement deposit received.\n\nCompany: ${p.company}\nEmail: ${p.email}\nAmount: ${eur(p.amount)}\n\nThe lead has been marked deposit_paid. Follow up to scope the engagement.`,
      }),
    });
  } catch (err) {
    console.error("[GridForge] deposit notify error:", err);
  }
}
