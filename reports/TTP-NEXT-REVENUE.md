# TTP Next Revenue — the shortest path to one paid Density Screen

Written after PR #17 (structured blocks + commercial handoff) merged to `main`
and a live smoke pass was confirmed against `https://timetopower.ai` in
another session with outbound web access — this session's own sandbox
cannot reach that host to re-verify, so the live claims below are relayed,
not independently re-run here.

## 1. One-week sell path

**ICP**: someone who already has an air-cooled hall in production and is
being asked "how many AI racks can we put in the hall we already have" —
not a greenfield build. They have real numbers for contracted MW, current
site peak, busway ampacity and tap-off rating (the four required qualify
inputs) sitting in a single-line diagram or a BMS export, not in their head.

**Offer line**: "Free: tell us four numbers about your hall and we'll name
the constraint that binds first, in minutes, with the evidence class shown.
€4,500, five days: the full Density Screen — every constraint evaluated, the
headroom ladder, and the data-request list your own engineer can act on."

**Proof link**: `/workspace` — the chat surface a prospect (or the person
selling to them) drives directly; `/qualify` is the older, narrower
qualifier form for the same free read. Either ends at the same
`gridforge_qualify` → constraint named → `CommercialActionCard` offering the
Density Screen at its real catalogue price.

**How the buyer reaches Stripe Checkout**: `/workspace` → free qualify names
a binding constraint → the commercialAction card's button ("Commission
Density Screen — €4,500") → `startCommission()` (`lib/ui.ts`) → `POST
/api/checkout` with `{ product: "density_screen" }` → a real Stripe Checkout
Session URL, `metadata.kind = "density_screen"`.

**What they receive after paying**: `checkout.session.completed` →
`openDeliverable()` opens a `deliverables` row (`status: "awaiting_intake"`)
and emails the customer their intake link. They fill in the hall's numbers
(anything left blank is filled from a library default and named as an
assumption in the document) → the engine's `/v1/screen` endpoint generates
the document (`status: "draft"`) → a senior engineer reviews and releases it
from `/admin` (`status: "released"`) → the customer reads it at their
deliverable link. Full trace: `reports/TTP-MONEY-PATH-PROOF.md`.

## 2. Human-only blockers

Pass/fail — check these in the Stripe dashboard and Vercel project settings,
not in code (this list names the exact env vars the code reads, so there is
nothing to guess):

- [ ] **Stripe Dashboard** — a webhook endpoint at
      `https://timetopower.ai/api/stripe/webhook` is registered and
      listening for `checkout.session.completed`.
- [ ] **Vercel prod env** — `STRIPE_SECRET_KEY` set (read in
      `app/api/checkout/route.ts` and `app/api/stripe/webhook/route.ts`).
- [ ] **Vercel prod env** — `STRIPE_WEBHOOK_SECRET` set (read in
      `app/api/stripe/webhook/route.ts`, verifies the signature).
- [ ] **Vercel prod env** — `RESEND_API_KEY` and `RESEND_FROM` set (read by
      `emailIntakeLink` in `app/api/stripe/webhook/route.ts` — without both,
      the intake link is generated and logged but never emailed to the
      customer).
- [ ] **Vercel prod env** — `RESEND_API_KEY` and `LEAD_TO_EMAIL` set (read
      by `notifyFounder` in the same file, with `LEAD_FROM_EMAIL` as an
      optional sender override — without these, nobody is told a Density
      Screen was just purchased except whoever is watching `/admin`).
- [ ] **Founder is watching `/admin`** for `awaiting_intake` → `draft` →
      `released` on the `deliverables` list — release is a deliberate,
      named human act (`app/api/admin/deliverables/route.ts`), not
      automatic, and nothing pages anyone if `notifyFounder` above is
      unconfigured.

## 3. Do not build

No Agent 4/5/7/8. No multimodal. No new SKUs or prices. No cinema redesign.
No second Stripe stack. None of it, until one real paid Density Screen
exists — or Vincenzo orders otherwise.

## 4. Optional software backlog (max 3, each must move €4,500 closer)

1. ~~Empty metric blocks on a real qualify because the evidence-class check
   only matched the short "E0" form, not the engine's actual wire format
   ("E0_ASSUMPTION", from Python's `EvidenceClass.name`)~~ — **fixed in this
   PR** (`lib/ai/provenance.ts`): verified against a real
   `handle_qualify()` payload generated from the actual engine, which
   returned zero metric blocks before the fix and two after, both with the
   real digest carried through. Regression-tested in
   `tests/site/ai-core.test.ts` against a fixture shaped exactly as the
   engine emits it, not a short-form mock.
2. `components/ai/adaptBlocks.ts` drops the `nextAction` "secondary CTA"
   path silently — nothing today emits a `nextAction` block (agent.ts never
   constructs one), so there is no visible "continue refining inputs" path
   next to the Density Screen CTA. Worth a `nextAction` pointing back at
   `/qualify` or offering another qualify round, once there's a live buyer
   asking for it — not before.
3. `evidenceSummary` (wired into `agent.ts` in the prior PR) fires once per
   distinct evidence-class/digest pair per tool call — on a hall with many
   quantity leaves this could mean several evidence cards competing for
   attention with the one commercialAction card on the same turn. Worth
   checking against a real multi-leaf qualify response once a prospect
   actually triggers one; no evidence it's a problem yet, so not fixed here.
