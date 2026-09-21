# Ops smoke checklist — Time to Power (timetopower.ai)

Refreshed 2026-09-21 alongside `chore/prune-stale-branches`. No code changes
in this pass unless a real prod bug was found (none was — this is docs +
branch deletes only).

Mark each row PASS (measured by an agent with live/Dashboard access) or
HUMAN (Vincenzo must click through the Vercel/Stripe/Resend dashboards —
this session has no such access and makes no claim beyond what it can
curl or read from the repo).

## 1) Stripe webhook

- [ ] HUMAN — Webhook URL in Stripe Dashboard = `https://timetopower.ai/api/stripe/webhook`
- [ ] HUMAN — Subscribed event `checkout.session.completed` is enabled
      (repo also handles `invoice.paid`, `customer.subscription.deleted`,
      `invoice.payment_failed` — verify those are subscribed too if used)

## 2) Vercel environment variables

Exact names the code reads (verified in repo, not invented):

- `STRIPE_SECRET_KEY` — `app/api/checkout/route.ts`
- `STRIPE_WEBHOOK_SECRET` — `app/api/stripe/webhook/route.ts`
- `RESEND_API_KEY`, `RESEND_FROM` — lead/notification email
- `LEAD_FROM_EMAIL`, `LEAD_TO_EMAIL` — lead routing
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` — qualifications/deliverables tables
- `GRIDFORGE_API_URL`, `GRIDFORGE_API_KEY`, `GRIDFORGE_ADMIN_KEY`,
  `GRIDFORGE_KEY_SECRET` — engine (Fly.io) access
- `NEXT_PUBLIC_SITE_URL`, `SITE_URL` — canonical origin for checkout redirects
- `ADMIN_PASSWORD`, `CRON_SECRET`, `SLACK_WEBHOOK_URL`, `EIA_API_KEY`,
  `NEXT_PUBLIC_FORMSPREE_ID`, `FORMSPREE_FORWARD_ID` — ops/misc, not on the
  money path

- [ ] HUMAN — Confirm all of the above are set in the correct Vercel
      project/environment (Production) via the Vercel Dashboard

## 3) Live route checks

- [ ] HUMAN/PASS — `GET https://timetopower.ai/` → 200
- [ ] HUMAN/PASS — `GET https://timetopower.ai/qualify` → 200
- [ ] HUMAN/PASS — `GET https://timetopower.ai/pricing` → 200
- [ ] HUMAN/PASS — `GET https://timetopower.ai/workspace` → 200, nav HTML
      contains a link to `/workspace` (confirmed in repo:
      `components/ScopingAgent.tsx`, `components/StickyMobileCTA.tsx`),
      and the page's `<meta name="robots">` is `noindex, nofollow`
      (confirmed in repo: `app/workspace/page.tsx` sets
      `robots: { index: false, follow: false }`)

## 4) Live chat → commercial action

- [ ] HUMAN — `POST https://timetopower.ai/api/chat` with a qualifying
      payload returns a block including a `commercialAction` for the
      Density Screen (€4,500, `lib/products.ts`)

## 5) Live checkout

- [ ] HUMAN — `POST https://timetopower.ai/api/checkout` with
      `product=density_screen` returns a Stripe-hosted checkout URL
      (stop before completing payment)

## Notes

- This session verified the code paths above by reading the repository
  (`lib/products.ts`, `app/api/checkout/route.ts`,
  `app/api/stripe/webhook/route.ts`, `app/workspace/page.tsx`) and confirmed
  `components/ai/mock.ts` does not exist on `main` — the real `/api/chat`
  path is live in source. It did not have live Dashboard or production
  network access, so every row above that requires observing production
  behavior is marked HUMAN, not PASS, until Vincenzo confirms it directly.
