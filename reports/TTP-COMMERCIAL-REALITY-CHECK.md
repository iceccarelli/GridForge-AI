# Commercial reality check — attacking the "nothing left to fix" conclusion

Written after the prior session's reports (all dated 2026-09-23, same tip)
concluded the money path had no code-fixable defects left. This session
does not repeat that audit. It takes the brief's own challenge — find at
least five things that could still block a purchase even though tests
pass — and answers it against the actual UI, copy and routes, not a fresh
capability matrix.

## Method

Read the homepage (`HomeClient.tsx`), the free qualifier (`CapacityQualifier.tsx`,
`/qualify`), the catalogue (`lib/products.ts`), the checkout route, the
post-payment page (`/commissioned`), both customer portals (`/dashboard`,
`/account`), and the machine manifest (`/llms.txt`) — the exact surfaces a
cold human or a cold machine buyer would hit first. Every finding below cites
the file and line it came from.

## 1. What is genuinely strong

- The homepage passes its own 120-second test: hero states the product
  ("how much AI compute an existing hall can carry"), states what's excluded
  ("no equipment to sell"), and the primary CTA is the real, catalogue-priced
  Density Screen — not a lead-gen form. `lib/ui.ts`'s own comment documents
  that this used to be a fake "Power Audit" funnel and was deliberately fixed.
- The free qualifier (`/qualify`) genuinely demonstrates the paid product:
  it runs the same engine, names the binding constraint, links to a full
  worked example (`/reference`), and ends at a `CommissionScreen` button
  wired to real checkout with the qualification id carried through — so a
  paying customer isn't asked to retype numbers they already typed.
- Post-payment (`/commissioned`) is unusually honest about failure modes: it
  resolves the intake token from the Stripe session server-side (not email
  alone), explains exactly what happens next, and gives a fallback ("reply
  to the Stripe receipt") if the email never arrives.
- The evidence-class system (E0–E7) is enforced, not decorative — the
  homepage, `/llms.txt`, and every deliverable state the same honest limit:
  zero calibration observations today.
- The catalogue is a genuine single source: `amountCents` in `lib/products.ts`
  is the only place a price is defined; checkout, the AI prompt, the
  dashboard, and the machine manifest all read from it.

## 2. What merely looked strong

- **The Intelligence portal (`/account`) referenced a product that cannot be
  bought.** Three places told a paying subscriber "a paid Audit confirms"
  their figures (`app/account/page.tsx:384`, `:430`, `components/DelayDemo.tsx:68`)
  — but "Audit" (formerly "Power Audit") was explicitly killed as a product:
  no catalogue entry, no checkout path, no intake, no deliverable. The
  repository even has a test guarding against this exact regression
  (`tests/site/sell-surface.test.ts`, "no user-facing copy offers a Power
  Audit") — it just didn't catch the reworded phrase. This is the clearest
  example in the repo of a defect that looks fixed (a passing test) but
  wasn't (the actual copy still promised a nonexistent purchase).
- **The machine manifest looked commerce-complete but wasn't.** `/llms.txt`
  correctly lists every product, its price, its deliverable, and the honesty
  policy — but never told a machine buyer *how* to purchase: no checkout
  endpoint, no request shape, no statement of what completes a transaction.
  A crawler could discover the price and still have no path to spend it,
  which fails the brief's own machine-buyer test ("HOW DO I PURCHASE?").
- **Two customer portals, no link between them.** `/dashboard` (paid
  engagements) and `/account` (GridForge Intelligence subscriptions) share
  the same Supabase auth but had zero navigation between them. A customer
  holding both an engagement and a subscription had to know both URLs by
  memory — a real, if narrow, project-continuity gap.

## 3. What remains commercially weak (found, not code-fixable here)

- **No case studies, no completed deployments, no track record** — and the
  repo's own honesty-kernel rule forbids inventing them. This is the single
  largest thing a €20k+ buyer will doubt, and it cannot be fixed with code;
  it is fixed by a first real paid engagement actually happening and being
  disclosed, which is market-side, not code-side.
- **Zero reconciled calibration observations**, stated honestly everywhere —
  which is correct per the honesty kernel, but it is still the concrete
  answer to "why would I trust an E0/E1 figure." No code change closes this;
  only field data does.
- **Live production verification is still blocked** — this sandbox's
  outbound network to `timetopower.ai` returns `connect_rejected` (confirmed
  again this session via `curl … $HTTPS_PROXY/__agentproxy/status`). Whether
  the webhook, Resend keys, and founder notification are actually configured
  in production remains a human-only check, exactly as the prior session's
  `TTP-NEXT-REVENUE.md` already listed.

## 4. What a €4,500 buyer still doubts

Nothing in the product presentation itself — price, deliverable, and
turnaround are explicit before checkout, and the free qualifier already
proves the engine works on the buyer's own numbers. What's still missing is
external: no evidence anyone else has bought this yet. That's a demand
question, not a product-clarity question.

## 5. What a €20k+ buyer still doubts

The jump from Density Screen (€4,500) to the Envelope Study (€9,000 deposit
against €22k–€45k) is explained on `/pricing` ("credits in full against the
study it usually leads to") and the Density Screen's own description names
what the Screen does *not* do (full architecture comparison, sensitivity,
economics) that the Study adds. The explanation exists. What a buyer at this
level still doubts is the same external one as above — a track record — not
a packaging problem.

## 6. What an AI agent still could not determine (before this session's fix)

Before this session: price, product, deliverable, evidence policy — yes.
**How to actually transact — no.** `/llms.txt` had no purchase mechanics.
Fixed in this session (see below).

## 7. What code can fix

All three defects below are code-fixable and were fixed. Nothing else found
this session was both code-fixable and verified — the remaining gaps (proof,
track record, live production config) are explicitly market-side or
human-side per the brief's own distinction.

## 8. What code cannot fix

Track record, case studies, calibration observations, live Stripe/Vercel/
Resend configuration in production. Documented above and in
`reports/TTP-NEXT-REVENUE.md` (human blockers list, unchanged this session).

## 9. Three changes implemented

1. **Removed three dead references to a nonexistent "paid Audit" product**
   (`app/account/page.tsx` ×2, `components/DelayDemo.tsx` ×1) and replaced
   them with a link to the real next purchasable product (the Density
   Screen, via `/pricing`). Extended `tests/site/sell-surface.test.ts` with
   a new guard (`/paid audit/i`) so the rephrased version of this defect —
   which slipped past the existing "Power Audit" guard — cannot reappear
   silently.
2. **Added purchase mechanics to `/llms.txt`** — a new "How to buy" section
   documenting `POST /api/checkout` (body shape, response shape), the
   subscription checkout path for API products, what happens after payment
   (intake resolves server-side from the Stripe session, no login required),
   the status states a purchase moves through, and an explicit note that the
   manifest is not itself a purchase mechanism — a real charge still
   requires completing the returned Stripe Checkout session.
3. **Cross-linked the two customer portals** — `/dashboard` now links to
   `/account` ("Intelligence portal →") and `/account` now links back to
   `/dashboard` ("Engagements →"), so a customer with both products (or
   trying to find out if the other product exists) doesn't need to know a
   second URL by memory.

## 10. Tests proving the changes

- `tests/site/sell-surface.test.ts` — 14/14 passing, including the new guard;
  confirmed it fails against the pre-fix copy (the phrase `/paid audit/i`
  matched all three pre-fix files) and passes against the fix.
- Full suite: 265/265 vitest tests passing (264 pre-existing + 1 new),
  418/418 Python tests passing, `tsc --noEmit` clean. Run and confirmed in
  this session, not relayed from a prior one.
- No live-production verification was possible (network policy denies
  `timetopower.ai` from this sandbox, confirmed again this session) — these
  are code-path proofs, marked as such.
