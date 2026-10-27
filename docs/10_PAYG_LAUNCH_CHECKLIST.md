# Pay-as-you-go and free allowance: what must be verified before it is sold

Everything below the line "Proven locally" was exercised on a developer machine against the real
engine, the production build, a real PostgreSQL 16 + PostgREST, and an injected fake Stripe client.
Nothing here was run against live Stripe, live Supabase or the deployed engine. Do these steps in
Stripe **test mode** and a **preview** deployment first. Do not charge a real card to test.

## 1. Deploy order
1. Engine first. The deployed engine at the time of writing did not serve `/v1/estimate`, `/v1/compare`, `/v1/power/*`
   or `/v1/revoke`, and published no `provenance.code_sha256` or `metering.ledger_durable`. Nothing in this repository
   has deployed it; a deploy needs a Fly credential that only the owner holds.
   - One-time: create a deploy token and add it as the repository secret **`FLY_API_TOKEN`**:
     `fly tokens create deploy -a gridforge-engine`, then GitHub, Settings, Secrets and variables, Actions, New
     repository secret. Optionally add required reviewers to the `production-engine` environment (Settings,
     Environments) so a deploy needs a second approval.
   - Deploy: GitHub, Actions, **deploy-engine**, Run workflow, type `DEPLOY`. It stops at once, naming the fix, if the
     secret is missing; then runs the engine tests, `bash scripts/deploy-engine.sh` (no `--bootstrap`: a deploy never
     creates, rotates or overwrites a credential; one machine with the `gridforge_data` volume), and finally
     `python3 scripts/check-engine-drift.py` against the live engine. The job is red if any drift remains.
     From a machine already signed in to Fly the same script is `bash scripts/deploy-engine.sh` (exit 3 means no
     credential, nothing was changed; exit 1 means it deployed but verification failed).
   - Verify (read-only, any machine): `python3 scripts/check-engine-drift.py`. It must print "serves every route and
     unit rate". Differences are grouped (routes, unit rates, version, provenance, ledger, tool names) and `--json`
     gives the same for tooling. The `engine-drift` workflow repeats this daily and lists the differences in its job summary.
   - Then refresh the website's record of the deployed engine from the live engine:
     `python3 scripts/check-engine-drift.py --write-snapshot lib/engine-deployed.json`
     (the deploy workflow also uploads `engine-deployed.json` as an artifact), and commit it.
2. The engine must run **exactly one machine** with the `gridforge_data` volume: usage counter, ledger, revocations and
   the cost file are local state. The deploy script uses `--ha=false` and fails if it finds anything other than exactly
   one machine mounting the volume; to repair by hand, `fly scale count 1`. A second machine would split the ledger.
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
  `customer.subscription.updated`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`,
  `charge.dispute.updated`, `charge.dispute.closed` (all required: a plan switch, a pause or a cancellation made in the Stripe Billing
  Portal reaches the site only as `customer.subscription.updated`; **a subscription payment refunded in full or disputed suspends paid
  access** - API key revoked, Hall Watch paused, Intelligence not entitled - a dispute that opens as a warning inquiry and escalates
  arrives as `charge.dispute.updated`, and a dispute won restores access, so without these a charged-back customer keeps it; the
  operator is also mailed when a dispute opens, with its evidence deadline, and how it ended; every dispute event is decided from the
  dispute's CURRENT state, which the site reads from Stripe with `STRIPE_SECRET_KEY`, so created/updated/closed may arrive in any order;
  a pause set in the Billing Portal takes effect when the **paid period ends**, not at once (migration 0043: the end of the period is
  recorded and the daily job starts the hold); and `charge.refunded` / `charge.dispute.*` for a pay-as-you-go **monthly settlement
  invoice** is recorded against that settlement, suspends further pay-as-you-go use when the refund is in full or the dispute stands,
  and mails the operator, who decides whether access continues), and, recommended,
  `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed` (only if a delayed payment method is ever
  enabled on Checkout; today it is card only). `/api/admin/stripe-health` reports what is missing, and the key
  revocations the engine has not confirmed (`revocations`: an engine older than this repository answers 404 for `/v1/revoke`; the deployed engine has served it since the 2026-10-27 redeploy).
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
  The deployed engine must be v0.9.0+ with this change (the 2026-10-27 redeploy carries it: `check-engine-drift.py` reports no difference); an older engine counts per account.
- Ledger loss (volume failure) loses at most the events since the last ingest; there is no replica.
- A hard kill while a refund is queued after a failed ledger write can leave a charge that support must reverse by hand.
- The free-account route has no bound on unverified rows beyond a per-IP rate limit.
- Hall Watch runs weekly; a quarterly note can follow its due date by up to a week.
- Calibration ledger is empty: every figure is modelled (E0 to E3). Nothing in this checklist changes that.
