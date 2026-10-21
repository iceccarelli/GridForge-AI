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
4. Migrations, in filename order, on a staging database first: 0028, 0030, 0031, 0032, 0033, 0034, 0035 (0029 is intentionally unused, and any later number the repository now carries). Apply them in filename order only: re-applying an older one out of order can narrow a later constraint.
   All are additive and idempotent. Re-applying an older one out of order can narrow a later constraint; apply in order.
5. Site env: `GRIDFORGE_API_URL`, `GRIDFORGE_ADMIN_KEY`, `GRIDFORGE_KEY_SECRET`, `CRON_SECRET`, `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, Supabase service role, `ADMIN_SESSION_SECRET`, optional `FUNNEL_REF_KEY`.
6. Vercel crons (`vercel.json`): `/api/cron/payg` daily, `/api/cron/notifications` and `/api/cron/engagements` every 30 min,
   `/api/cron/watches` weekly. Confirm in the Vercel dashboard that each ran and answered 200 (needs `CRON_SECRET`).
   Whether the plan allows these schedules is not verifiable from the repository.

## 2. Stripe test-mode script (owner action)
- Webhook endpoint subscribed to: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.paid`,
  `invoice.payment_failed`.
- Settings: enable Stripe's customer emails for failed payments (the site sends its own as well); decide VAT/Stripe Tax
  for the settlement invoices (the code does not configure tax).
- Free account: `POST /api/free-account` -> open the emailed link -> mint a trial key -> `GET /v1/usage` shows the allowance.
- Enable PAYG: portal -> choose a cap -> Stripe Checkout in *setup* mode with test card 4242 4242 4242 4242 -> returns to the
  portal -> no charge exists in Stripe. Mint a payg key; run a few billable calls; confirm the 402 at the cap.
- Settlement: after the month closes (or in a staging database with an old month) run `/api/cron/payg` twice with the cron
  secret: exactly one draft->finalised invoice per account-month, amount = net units x EUR 2.00, months under EUR 5 carried.
- Failure path: use a card that declines on charge (4000 0000 0000 0341): settlement fails -> account past_due -> key revoked
  on the engine -> failure email -> replace card in the portal -> unpaid invoice retried -> mint a new key.
- Webhook replay from the Stripe dashboard: a repeated event changes nothing.

## 3. Known limits (stated, not hidden)
- Portal usage is copied from the engine ledger by a daily cron; the engine's own counter enforces the cap in real time.
- A balance that never reaches the EUR 5 minimum is never invoiced.
- Ledger loss (volume failure) loses at most the events since the last ingest; there is no replica.
- A hard kill while a refund is queued after a failed ledger write can leave a charge that support must reverse by hand.
- The free-account route has no bound on unverified rows beyond a per-IP rate limit.
- Hall Watch runs weekly; a quarterly note can follow its due date by up to a week.
- Calibration ledger is empty: every figure is modelled (E0 to E3). Nothing in this checklist changes that.
