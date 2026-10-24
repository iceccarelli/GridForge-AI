# Pay-as-you-go and free allowance: what must be verified before it is sold

Everything below the line "Proven locally" was exercised on a developer machine against the real
engine, the production build, a real PostgreSQL 16 + PostgREST, and an injected fake Stripe client.
Nothing here was run against live Stripe, live Supabase or the deployed engine. Do these steps in
Stripe **test mode** and a **preview** deployment first. Do not charge a real card to test.

## 1. Deploy order
1. Engine first: `bash scripts/deploy-engine.sh` (needs Fly credentials). The deployed engine at the time of writing
   did not serve `/v1/compare`, `/v1/power/*` or `/v1/revoke`. Confirm with `python3 scripts/check-engine-drift.py`
   (read-only). It must print "serves every route and unit rate".
2. The engine must run **exactly one machine** with the `gridforge_data` volume: usage counter, ledger, revocations and
   the cost file are local state. `fly scale count 1`. A second machine would split the ledger.
3. Set on the engine: `GRIDFORGE_KEY_SECRET` (same value as the site), `GRIDFORGE_ADMIN_KEY`,
   `GRIDFORGE_LEDGER_FILE=/data/ledger.jsonl`, `GRIDFORGE_USAGE_FILE`, `GRIDFORGE_REVOKED_FILE`.
4. Migrations, in filename order, on a staging database first: 0028, 0030, 0031, 0032, 0033, 0034, 0035, 0036, 0037, 0039, 0041 (0029 is intentionally unused, and any later number the repository now carries; `scripts/apply-migration.py` allows that gap but still refuses applying out of order). Apply them in filename order only: re-applying an older one out of order can narrow a later constraint.
   All are additive and idempotent. Re-applying an older one out of order can narrow a later constraint; apply in order.
   **0041 (billing holds and the audit trail) before, or with, the deploy that carries it.** Without it a refunded, disputed or paused
   subscription payment still cuts access off (as a status change) and the operator is mailed once, but the hold is not individually
   reversible (a dispute won does not restore it), nothing is written to `billing_audit`, and the past_due grace does not start/revoke.
5. Site env: `GRIDFORGE_API_URL`, `GRIDFORGE_ADMIN_KEY`, `GRIDFORGE_KEY_SECRET`, `CRON_SECRET`, `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, Supabase service role, `ADMIN_SESSION_SECRET`, and `FUNNEL_REF_KEY` (16+ characters; REQUIRED for stable funnel cohorts: without it the account references and once-only keys derive from `GRIDFORGE_KEY_SECRET` and change if it is rotated, re-firing every once-only event). `GRIDFORGE_LEGACY_DEPOSIT` stays unset: the off-catalogue generic deposit and Founding credit are only created with `=1`.
6. Vercel crons (`vercel.json`): `/api/cron/payg` daily, `/api/cron/notifications` and `/api/cron/engagements` every 30 min,
   `/api/cron/watches` weekly. Confirm in the Vercel dashboard that each ran and answered 200 (needs `CRON_SECRET`).
   Whether the plan allows these schedules is not verifiable from the repository.

## 2. Stripe test-mode script (owner action)
- Webhook endpoint subscribed to: `checkout.session.completed`, `customer.subscription.deleted`,
  `customer.subscription.updated`, `invoice.paid`, `invoice.payment_failed` (all required: a plan switch, a pause or a cancellation made
  in the Stripe Billing Portal reaches the site only as `customer.subscription.updated`), and, recommended,
  `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed` (the operator is mailed when a dispute opens, with its
  evidence deadline, and how it ended; **and a subscription payment refunded in full or disputed suspends paid access** - API key
  revoked, Hall Watch paused, Intelligence not entitled - and a dispute won restores it, so without these three a charged-back customer
  keeps access), `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed` (only if a delayed payment
  method is ever enabled on Checkout; today it is card only). `/api/admin/stripe-health` reports what is missing, and the key
  revocations the engine has not confirmed (`revocations`: the deployed engine answers 404 for `/v1/revoke` until it is redeployed).
- Settings: enable Stripe's customer emails for failed payments (the site sends its own as well); decide VAT/Stripe Tax
  for the settlement invoices (the code does not configure tax).
- Free account: `POST /api/free-account` -> open the emailed link -> mint a trial key -> `GET /v1/usage` shows the allowance.
- Enable PAYG: portal -> choose a cap -> Stripe Checkout in *setup* mode with test card 4242 4242 4242 4242 -> returns to the
  portal -> no charge exists in Stripe. Mint a payg key; run a few billable calls; confirm the 402 at the cap.
- Settlement: after the month closes (or in a staging database with an old month) run `/api/cron/payg` twice with the cron
  secret: exactly one draft->finalised invoice per account-month, amount = net units x EUR 2.00, months under EUR 5 carried.
- **Stripe Billing Portal (external dependency, owner action).** `POST /api/billing/portal` opens Stripe's hosted Billing Portal, which
  is what gives customers "cancel any time", payment-method update and invoice history. It only works once the portal is CONFIGURED in the
  Stripe dashboard (Settings -> Billing -> Customer portal), in **test mode first** and then live: allow customers to cancel
  subscriptions, to update payment methods, and to view invoice history. Without that configuration Stripe refuses to create a session and
  the endpoint answers 502; nothing in the repository can configure or verify it. Cancelling there reaches the site through the existing
  `customer.subscription.deleted` webhook (key revoked, account cancelled). Pay-as-you-go has no subscription to cancel: stopping use and
  setting the cap to the minimum is how a customer stops spending; their saved card and invoices are managed in the same portal.
  **Leave `subscription_update` OFF in the portal configuration.** The site does not implement plan switches: a switch changes what
  Stripe bills but not what the site entitles (the webhook mails the operator once per subscription and changes nothing). A pause
  (`subscription_pause`, Stripe's `pause_collection`) is handled: while billing is paused the API key is revoked, the Hall Watch is
  paused and Intelligence is not entitled, and resuming restores them (the API key is minted again by the customer); most operators leave
  it off anyway. `/api/admin/stripe-health` warns when either is on.
- Past due (subscription API plans): the minted key keeps working for `API_PAST_DUE_GRACE_DAYS` (7) from the FIRST failed payment of the
  episode; the daily `/api/cron/payg` (and any later failure event) then revokes it. A payment that clears reopens minting.
- Failure path: use a card that declines on charge (4000 0000 0000 0341): settlement fails -> account past_due -> key revoked
  on the engine -> failure email -> the customer replaces the card -> the invoice is paid -> account active -> mint a new key.
  Which "replace the card" does what, exactly:
  - **"Replace card" on the site** (Stripe Checkout in setup mode): the new card becomes the customer's default and the account's card,
    every UNPAID failed settlement invoice is pointed at it and paid at once, and the result arrives as `invoice.paid`
    (account reinstated) or `invoice.payment_failed`.
  - **Replacing the card in the Stripe Billing Portal**: this changes the customer's default payment method at Stripe and sends the site
    NO event it acts on. The daily settlement then bills the customer's CURRENT default (resolved from Stripe at invoice time, recorded
    on the account, and also used for a settlement invoice that is still a draft), so the next month, or a month still waiting to be
    invoiced, is charged to the new card. An invoice that was already finalised and failed keeps the card it was created with, so
    Stripe's own retries of it do NOT use the new card, and the site does not re-point or re-pay it after a portal change: collect it with
    "Replace card" on the site, or from the invoice's hosted page / the Stripe Dashboard.
  - A settlement the site cannot invoice (no payment method, a detached card, a Stripe error) is mailed to the operator, once per
    settlement per day, with its category (never Stripe's message or the customer's details).
- Webhook replay from the Stripe dashboard: a repeated event changes nothing.

## 3. Known limits (stated, not hidden)
- Portal usage is copied from the engine ledger by a daily cron; the engine's own counter enforces the cap in real time.
- A balance that never reaches the EUR 5 minimum is never invoiced.
- Caps are counted per (account, month, scope): free-allowance units never count against a pay-as-you-go cap, and the reverse
  (`tests/test_payg_scope_counters.py`; `tests/site/payg-journey.realdb.test.ts` runs a EUR 100 cap to exactly 50 billable units after the 25 free ones).
  The deployed engine must be v0.9.0+ with this change; until it is redeployed the live engine still counts per account.
- Ledger loss (volume failure) loses at most the events since the last ingest; there is no replica.
- A hard kill while a refund is queued after a failed ledger write can leave a charge that support must reverse by hand.
- The free-account route has no bound on unverified rows beyond a per-IP rate limit.
- Hall Watch runs weekly; a quarterly note can follow its due date by up to a week.
- Calibration ledger is empty: every figure is modelled (E0 to E3). Nothing in this checklist changes that.
