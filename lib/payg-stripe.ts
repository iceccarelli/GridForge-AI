// Server-only: the slice of the Stripe SDK pay-as-you-go billing uses, as an injectable interface.
//
// One payment implementation: the same `stripe` package the checkout and webhook routes already use, no second product per
// endpoint. The interface is deliberately the SDK's own surface (stripe v22, checked against node_modules/stripe/cjs/resources:
// Invoices.create/finalizeInvoice/list/retrieve with RequestOptions.idempotencyKey, InvoiceItems.create/list with `invoice`,
// Checkout.Sessions.create mode 'setup', SetupIntents.retrieve, Customers.update invoice_settings.default_payment_method), so
// the real client satisfies it unchanged and tests inject a fake with the same shapes.

import Stripe from "stripe";
import { boundStripe, isStripeTimeout, stripeCallTimeoutMs } from "@/lib/stripe-timeout";

export interface InvoiceLite {
  id: string;
  status?: string | null;
  hosted_invoice_url?: string | null;
  metadata?: Record<string, string> | null;
}

export interface PaygStripe {
  checkout: {
    sessions: { create(params: Stripe.Checkout.SessionCreateParams): Promise<{ id: string; url: string | null }> };
  };
  setupIntents: {
    retrieve(id: string): Promise<{
      id: string;
      status?: string;
      payment_method: string | { id: string } | null;
      customer: string | { id: string } | null;
      metadata?: Record<string, string> | null;
    }>;
  };
  customers: {
    update(id: string, params: Stripe.CustomerUpdateParams): Promise<unknown>;
    /** The customer as Stripe holds it NOW: `invoice_settings.default_payment_method` follows a card replaced in the Billing Portal. */
    retrieve(id: string): Promise<{ id?: string; deleted?: boolean; invoice_settings?: { default_payment_method?: string | { id: string } | null } | null }>;
  };
  /** The charge a dispute is about: only its customer is read (to name the account in the operator's notice). */
  charges: { retrieve(id: string): Promise<{ id?: string; customer?: string | { id: string } | null }> };
  /** Stripe's hosted Billing Portal (cancel, payment method, invoice history). Needs the portal configured in the Stripe dashboard. */
  billingPortal: { sessions: { create(params: { customer: string; return_url: string }): Promise<{ id: string; url: string | null }> } };
  invoices: {
    create(params: Stripe.InvoiceCreateParams, options?: { idempotencyKey?: string }): Promise<InvoiceLite>;
    finalizeInvoice(id: string, params?: Stripe.InvoiceFinalizeInvoiceParams, options?: { idempotencyKey?: string }): Promise<InvoiceLite>;
    retrieve(id: string): Promise<InvoiceLite>;
    list(params: Stripe.InvoiceListParams): Promise<{ data: InvoiceLite[] }>;
    /** Point an unpaid invoice at a replacement card (invoices keep the payment method they were created with). */
    update(id: string, params: Stripe.InvoiceUpdateParams): Promise<InvoiceLite>;
    /** Attempt payment of a finalised invoice now, with the given payment method. */
    pay(id: string, params?: Stripe.InvoicePayParams): Promise<InvoiceLite>;
  };
  invoiceItems: {
    create(params: Stripe.InvoiceItemCreateParams, options?: { idempotencyKey?: string }): Promise<{ id: string }>;
    list(params: Stripe.InvoiceItemListParams): Promise<{ data: { id: string; metadata?: Record<string, string> | null }[] }>;
  };
}

let override: PaygStripe | null = null;

/** Tests only: install a fake client (labelled as a mock in every test that uses it). */
export function setPaygStripeForTests(client: PaygStripe | null): void {
  override = client;
}

/**
 * The client billing talks to, or null when Stripe is not configured on this deployment. EVERY call on it is bounded
 * (lib/stripe-timeout.ts): a call with no answer in STRIPE_CALL_TIMEOUT_MS fails as a StripeConnectionError with code stripe_call_timeout,
 * which means "cannot say" (the call may still have succeeded at Stripe), never an outcome. The SDK is given the same limit so that the
 * request itself is abandoned rather than left holding a socket.
 */
export function paygStripe(): PaygStripe | null {
  if (override) return boundStripe(override);
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return boundStripe(new Stripe(key, { timeout: stripeCallTimeoutMs() }) as unknown as PaygStripe);
}

/** Did this error come from the bound (no answer in time)? The call's outcome at Stripe is unknown. */
export const stripeTimedOut = isStripeTimeout;

/** A category for a failed Stripe call: its documented type/code, never its message (which can echo request data). */
export function stripeFault(err: unknown): string {
  const e = err as { type?: unknown; code?: unknown; statusCode?: unknown } | null;
  const part = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(v) ? v : "");
  const out = [part(e?.type), part(e?.code), typeof e?.statusCode === "number" ? String(e.statusCode) : ""].filter(Boolean).join(":");
  return out || "stripe_error";
}
