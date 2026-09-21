# TTP Money Path Proof — free qualify → Density Screen (€4,500)

Traced against the code on `claude/wizardly-knuth-qdwo69` (base: PR #16 on `main`).
No new fulfilment system built — this is a read of the existing Stripe
webhook → deliverable → intake → release path, plus the fixes in this PR
that make the chat agent actually offer the sale.

## 1. What this PR changed

`/api/chat` (`lib/ai/agent.ts`, `lib/ai/responses.ts`) already called the
real engine (`gridforge_qualify`) and built `metric` blocks correctly. Two
things were broken or missing:

1. **The workspace UI never rendered them.** The server's block contract
   (`lib/ai/schemas.ts`) and the workspace's rendering contract
   (`components/ai/types.ts`) had drifted into two incompatible shapes with
   no adapter between them — `components/ai/chat.ts` cast the server's JSON
   straight onto the client's richer discriminated-union types with no
   validation. A server `metric` block has no `metricKind`, so
   `BlockRenderer`'s `switch (block.metricKind)` matched nothing and
   rendered undefined; a server `commercialAction` block has no `productId`,
   so `CommercialActionCard` rendered its "Unknown product id" fallback.
   Fixed with `components/ai/adaptBlocks.ts`, a validated translation layer
   between the two contracts (drops and logs anything it can't validate,
   rather than crashing or vanishing silently).
2. **Nothing ever offered the Density Screen.** `commercialActionBlockSchema`
   declared an `"engagement_offer"` reason, but no code constructed one — a
   successful qualify that named a binding constraint produced an essay,
   never a CTA. Fixed with `constraintFromQualify` + `engagementOfferBlock`
   in `lib/ai/responses.ts`, wired into `lib/ai/agent.ts`'s
   `runOneToolCall`: a successful `gridforge_qualify` call that names a
   binding constraint now always appends a `constraint` block and a
   `commercialAction` block (`reason: "engagement_offer"`, priced and named
   straight from `lib/products.ts`, never a number typed into the block
   itself).

Paid-tool refusals (`blockFromRefusal`, unchanged) already routed to
`/pricing` with 402 semantics (never 429) — the adapter now also resolves
every `commercialAction`, offer or refusal alike, to the one catalogue
product the chat agent ever offers: `density_screen`.

## 2. The Stripe events required

| Event | Handled by | What it does |
|---|---|---|
| `checkout.session.completed` | `app/api/stripe/webhook/route.ts` | The only event this path acts on. Reads `session.metadata.kind` (`"density_screen"`), looks it up in `PRODUCT_BY_KIND`, and — because `density_screen.producesDeliverable === true` — calls `openDeliverable()`. |

`app/api/checkout/route.ts` creates the Checkout Session with
`metadata.kind = "density_screen"` (validated against `isProductId`) and, if
the workspace CTA supplied one, `metadata.qualification_id` +
`metadata.service` (the `workspace-density_screen` / `chat-engagement_offer`
attribution tag `CommercialActionCard` sets — see `ai_checkout_started` /
`ai_checkout_completed` logging in that route and the webhook).

No other Stripe event type (`payment_intent.*`, `charge.*`,
`customer.subscription.*`) is read for this product — `density_screen` is a
one-time payment, not a subscription, so there is nothing else to listen for.

## 3. What a paying customer receives

1. **Checkout completes** → webhook fires → `openDeliverable()`
   (`app/api/stripe/webhook/route.ts:408`):
   - Replay-safe: `deliverableBySession(sessionId)` is checked first, so
     Stripe's retry-until-2xx behaviour can never double-open an engagement.
   - Creates a `deliverables` row (`status: "awaiting_intake"`), and emails
     the customer their **intake link** (`/intake/<intake_token>` — a
     separate, forwardable-safe token from the document token that guards
     the released opinion).
   - A failed write returns **HTTP 500** (not 200), so Stripe redelivers
     rather than the payment silently going unfulfilled.
2. **Customer submits the intake form** (`app/api/intake/[token]/route.ts`):
   - Every field they leave blank is filled from a library default and named
     as an assumption in the document itself (never silently guessed).
   - `deliverableEndpoint("density_screen")` → `"screen"` — read from
     `lib/products.ts`, not branched on the kind inline, so a Density Screen
     purchase can never generate the wrong document.
   - Calls the real engine (`/v1/screen`) and stores the generated
     `document_html`/`document_md` with `status: "draft"`.
   - If the engine is unreachable, the intake is saved and the customer is
     told nothing was invented and nothing lost — `status: "engine_unavailable"`,
     picked up manually rather than silently retried with a guess.
3. **A senior engineer reviews and releases it**
   (`app/api/admin/deliverables/route.ts` `PATCH`, admin-cookie gated): a
   deliberately separate, named human act — a document cannot be released
   before it has been generated (`document_html` must exist), and release is
   the only thing that flips `status` to `"released"` and makes
   `/deliverable/[token]` (the document token, never emailed to anyone but
   the released link) resolve.
4. The customer is emailed the intake confirmation at step 2 and — once
   released — reads the document at their deliverable link. The founder is
   notified (`notifyFounder`) on `openDeliverable` success, i.e. as soon as
   payment clears, not on release.

## 4. Gaps — code vs human-only

No code bugs found in this path that would drop a paid Density Screen
customer: the replay guard, the 500-on-failure semantics, and the
catalogue-derived (never branched) generation endpoint were already correct
before this PR and are unchanged by it.

**Human-only, not this PR's to fix:**

- **Stripe dashboard**: the webhook endpoint and the `checkout.session.completed`
  event subscription must actually be configured in the live Stripe
  dashboard against `https://timetopower.ai/api/stripe/webhook`, and
  `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` must be set in the Vercel
  production environment — this PR cannot verify either from the repo.
- **RESEND_API_KEY / RESEND_FROM**: if unset, `emailIntakeLink` and
  `notifyFounder` no-op silently (by design, so a missing mail key never
  blocks fulfilment) — but that also means nobody is told a deliverable
  opened unless someone is watching `/admin`. Worth confirming these are set
  in production.
- **The release step is, and should stay, a human act** — an engineer has to
  read and sign the generated Density Screen before `/admin` can release it.
  That is not a gap to close; it is the "named signatory" this product sells.
