import { NextResponse } from "next/server";
import { keyLife } from "@/lib/api-access";
import { PAYG, billingRuleText, paygChargeCents, scopeForPlan, utcMonth } from "@/lib/payg";
import { accountByToken } from "@/lib/payg-accounts";
import { alertCapUnits } from "@/lib/payg-alerts";
import { enc, pg } from "@/lib/payg-store";
import { capUsedUnits, recentEvents, usageNet } from "@/lib/payg-usage";
import type { Settlement } from "@/lib/payg-settle";
import { guardRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * GET ?token= -> the account's own usage, this month's meter, its last events and its settlements.
 *
 * The account portal token is the only credential, exactly as for /api/keys, and every read below is keyed on THAT account's id:
 * there is no parameter that names another account, so there is nothing to enumerate. Usage is copied from the engine's ledger
 * once a day, so `as_of` says how fresh it is; the engine's own counter is what enforces the cap, in real time.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!token) return NextResponse.json({ ok: false, error: "Unknown account" }, { status: 404 });
  const g = await guardRequest(req, "usage_read");
  if (g.denied) return g.denied;

  const acct = await accountByToken(token);
  if (acct === "error") return NextResponse.json({ ok: false, error: "Usage is unavailable just now." }, { status: 503 });
  if (!acct) return NextResponse.json({ ok: false, error: "Unknown account" }, { status: 404 });

  const month = utcMonth(new Date());
  const [net, events, settlements, alerts, cursor] = await Promise.all([
    usageNet(acct.account, month),
    recentEvents(acct.account, 50),
    pg<Settlement[]>("GET", `usage_settlements?account=eq.${enc(acct.account)}&select=month,units,amount_cents,status,carried_units,hosted_invoice_url&order=month.desc&limit=24`),
    pg<{ percent: number }[]>("GET", `usage_alerts?account=eq.${enc(acct.account)}&month=eq.${month}&select=percent`),
    pg<{ updated_at: string }[]>("GET", "payg_cursor?id=eq.1&select=updated_at&limit=1"),
  ]);
  if (!net || !events || !settlements.ok || !alerts.ok) {
    return NextResponse.json({ ok: false, error: "Usage is unavailable just now." }, { status: 503 });
  }

  const scope = scopeForPlan(acct.plan);
  const cap = acct.plan === "api_payg" || acct.plan === "api_free" ? alertCapUnits(acct) : acct.monthly_units > 0 ? acct.monthly_units : null;
  const used = capUsedUnits(acct.plan, net);
  const life = keyLife(acct);
  const sent = new Set((alerts.data ?? []).map((a) => a.percent));
  return NextResponse.json(
    {
      ok: true,
      account: {
        plan: acct.plan,
        status: acct.status,
        scope,
        cap_units: cap,
        cap_eur: acct.plan === "api_payg" && cap ? (cap * PAYG.unitPriceCents) / 100 : null,
        has_key: life.has_key,
        key_expires_at: acct.key_expires_at,
        payment_method_saved: Boolean(acct.stripe_payment_method_id),
      },
      month,
      // What counts against the cap: net units of this plan's own scope, as the engine counts them (free units never spend a payg cap).
      units_used: used,
      units_cap: cap,
      remaining_units: cap === null ? null : Math.max(0, cap - used),
      free_units_used: Math.max(0, net.net - net.billable_net),
      // What will be INVOICED: only pay-as-you-go units. The free allowance is never invoiced.
      billable_units: net.billable_net,
      eur_accrued_cents: acct.plan === "api_payg" ? paygChargeCents(net.billable_net) : 0,
      events,
      settlements: (settlements.data ?? []).map((s) => ({ month: s.month, units: s.units, amount_cents: s.amount_cents, status: s.status, carried_units: s.carried_units, hosted_invoice_url: s.hosted_invoice_url })),
      alerts: Object.fromEntries(PAYG.alertPercents.map((p) => [String(p), sent.has(p)])),
      unit_price_cents: PAYG.unitPriceCents,
      currency: PAYG.currency,
      min_invoice_cents: PAYG.minInvoiceCents,
      billing_rule: billingRuleText(),
      as_of: cursor.ok ? cursor.data?.[0]?.updated_at ?? null : null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
