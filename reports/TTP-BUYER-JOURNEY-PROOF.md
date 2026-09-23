# Buyer journey proof — actual routes and code, this session's tip

Traces the real human, machine, payment, fulfillment and repeat paths as
they exist in code today. No imagined future architecture; every step names
the file it comes from.

## Human path

1. `/` (`components/HomeClient.tsx`) — hero states the product, primary CTA
   commissions the Density Screen directly (`CommissionScreen` →
   `lib/ui.ts:startCommission`).
2. `/qualify` (`components/CapacityQualifier.tsx`) — free, no login. Seven
   numbers → real engine call → binding constraint named, with evidence
   class → `CommissionPanel` offers the Density Screen, qualification id
   attached.
3. Checkout (`app/api/checkout/route.ts`) — creates a Stripe Checkout
   Session, price read from `lib/products.ts`, metadata carries
   `qualification_id`, `kind`, `service` (attribution tag).
4. `/commissioned?session_id=…` (`app/commissioned/page.tsx`) — resolves the
   paid session server-side, opens the intake token immediately, no wait on
   email.
5. `/intake/<token>` — hall's numbers submitted (pre-filled from the
   qualifier's numbers where available).
6. Engine generates the document (`status: draft`) → senior engineer
   releases it from `/admin` (`status: released`) → customer reads it at
   `/deliverable/<token>`.
7. `/dashboard` — passwordless email sign-in (Supabase magic link), lists
   every engagement against the paying email, each with its status and the
   right action (submit numbers / read document). **New this session:**
   links to `/account` if the customer also holds an Intelligence
   subscription.

## Machine path

1. `/llms.txt` (`app/llms.txt/route.ts`) — machine index: merchant identity,
   product list with price/deliverable, evidence policy, MCP endpoint.
   **New this session:** a "How to buy" section giving the actual purchase
   mechanics (see below) — previously the file stopped at price and
   deliverable with no path to transact.
2. `gridforge_qualify` over MCP (`POST https://gridforge-engine.fly.dev/mcp`)
   or `POST /v1/qualify` — free, no key, same engine as the human path.
3. `POST /api/checkout` with `{"product": "<id>"}` — returns
   `{"ok": true, "url": "<Stripe Checkout URL>"}`. This is the actual
   authorization boundary: the manifest names the price, but nothing
   charges until a human (or an agent's payment instrument) completes that
   Stripe session — no autonomous, unconfirmed spend is possible from the
   manifest alone.
4. Post-payment: same `/commissioned` resolution as the human path — the
   webhook (`app/api/stripe/webhook/route.ts`) writes the `deliverables` row
   keyed on the Stripe session id (idempotent on that key), independent of
   who or what completed the checkout.
5. Status: the same state machine as the human path
   (`awaiting_intake → generating → draft → released`), readable from
   `/dashboard` once signed in, or via the private per-engagement link.

## Payment path

`checkout.session.completed` → `app/api/stripe/webhook/route.ts` writes/
updates the `deliverables` row (unique on `stripe_session_id`, so a
redelivered webhook does not double-fulfil) → emails the intake link via
Resend → notifies the founder via Resend. A write failure returns 500 so
Stripe redelivers rather than silently dropping a paid engagement — this
was verified in code this session (`lib/deliverables.ts`) and matches the
prior session's `TTP-MONEY-PATH-PROOF.md` trace, re-read rather than
re-derived here since nothing in that path changed.

## Fulfillment path

`draft` → human review at `/admin` (`app/api/admin/deliverables/route.ts`)
→ `released`, a deliberate act, not automatic. No document reaches a
customer that a senior engineer has not read. This is unchanged this
session; confirmed present in code, not re-tested end-to-end (that requires
a live Stripe session, which requires production credentials this sandbox
does not have).

## Repeat path

- Density Screen → credits in full against the Envelope Study
  (`lib/products.ts:creditsAgainst`), and `/pricing` states this explicitly.
- Envelope Study → Procurement Specification is the next rung on the
  ladder (`ladderOrder: 30`), justified by the study's own output (a named
  relief that needs a tender-ready spec).
- Hall Watch (`recurring`, quarterly) — the one product designed around a
  recurring trigger (a hall's numbers changing), not a manufactured
  subscription.
- Two customer portals for two recurring relationships (engagements via
  `/dashboard`, GridForge Intelligence via `/account`) now cross-link
  (fixed this session) rather than requiring the customer to remember two
  separate URLs.

## What this proof does not cover

Live confirmation against `https://timetopower.ai` — outbound network from
this session is policy-denied (`connect_rejected`, re-confirmed this
session). Every step above is a code-path trace against the current tip,
not a production observation. The human-only checklist for closing that gap
is unchanged from `reports/TTP-NEXT-REVENUE.md` (Stripe webhook
registration, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, Resend keys,
founder watching `/admin`).
