# Time to Power — conversion audit

Audited from source (`app/`, `components/`, `lib/site.ts`, `lib/products.ts`) —
outbound network access to `timetopower.ai` was blocked by the session's egress
proxy (`CONNECT tunnel failed, 403`), so this is a source audit, not a live-deploy
crawl. Routes read: `/`, `/qualify`, `/pricing`, `/reference`, `/developers`,
`/constraints`, `/platforms`, `/intelligence`.

## 1. Home page — current section inventory

| # | Section | Verdict | Why |
|---|---|---|---|
| 1 | Hero (promise + TimeToPower visual + dual CTA) | **stays** | This is the one-sentence pitch, already correct: free qualifier primary-adjacent, Density Screen commit CTA present, price not hardcoded (via `CommissionScreen`/`commissionDensityScreen`). |
| 2 | Market Reality stat strip | **merges** into a compact strip directly under the hero — it is proof the buyer already lives in this market, not a second thesis. Currently its own full-width dark band; folds into the new decision strip's surrounding context instead of standing alone. |
| 3 | Problem (3 cards + photo) | **merges** into the new decision strip's rationale copy — the same three claims (grid is the asset, density gap, binding constraint is electrical) restated as three data points, not three panel essays. |
| 4 | Live Market (LiveConsole + 3-way nav cards) | **stays, retitled** "Proof of method" and combined with the comparator into one section instead of two, since both exist to demonstrate the engine is live and deterministic, not decorative. |
| 5 | Approach ("How we engage", 3 numbered steps) | **dies** — duplicates the decision strip and the engagement ladder. Three sections (Approach → Comparator → Services) told the buyer the same "screen → study → spec" story three times with three different visual treatments. One is enough. |
| 6 | Comparator (TimeToPowerComparator) | **stays**, folded into "Proof of method" per #4. |
| 7 | Qualify teaser (BindingConstraintInsights compact + CTA) | **stays**, unchanged in substance — this is the free-answer moment and it already does not gate behind contact details. |
| 8 | Services (EngagementLadder cards, Density Screen flagship) | **stays**, dominant — already reads prices from `serviceCards()` → `lib/products.ts`. |
| 9 | Technology (4-item first-principles grid) | **stays**, unchanged — credibility content that does not compete with a CTA. |
| 10 | Evidence / calibration (empty-ledger disclosure) | **stays, unchanged** — this is the honesty-kernel-required disclosure and must remain visible; do not touch. |
| 11 | About / founder | **stays, demoted visually** (already low on the page, no change needed structurally) |
| 12 | FAQ | **stays** |
| 13 | Final CTA | **stays**, already single-purpose (Density Screen only) |

Net effect of Step 1: 13 section blocks → 11, by removing the standalone
"Approach" block (duplicate process narrative) and merging Market Reality +
Problem into the new decision strip's supporting copy rather than three
separate full-bleed sections before the reader has seen a single CTA-bearing
section.

## 2. CTA map and plausible drop-off

- **Hero**: two CTAs (Density Screen commit / free qualifier). Correct pairing,
  but a first-time visitor with no context is asked to commit to a purchase
  CTA before seeing what "binding constraint" even means. Mitigated by the new
  decision strip immediately below the hero, which explains the vocabulary in
  five labelled steps before the next CTA appears.
- **Mobile**: no persistent CTA once the visitor scrolls past the hero — the
  navbar's mobile menu CTAs are hidden inside a hamburger. This is the biggest
  concrete drop-off risk on a page this long (13 sections) at phone width.
  **Fix shipped**: a sticky bottom bar (`components/StickyMobileCTA.tsx`),
  mobile-only, "Free capacity check" + "Density Screen — €4,500" (price live
  from the catalogue), safe-area aware.
- **Mid-page**: CTAs repeat after Problem, after Live Market/Comparator, after
  the qualify teaser, after Services, and at the Final CTA — five to six
  repetitions is reasonable for a page this long and each one is contextual
  (free vs paid), not generic "Learn more" filler.
- **Pricing/Qualify**: single clear next step each (`EngagementLadder`,
  "Find the binding constraint"). No competing CTAs found.

## 3. Design-system gaps

- **Type scale**: hero H1 uses `text-[2.6rem] sm:text-6xl lg:text-[4.4rem]`,
  section titles use a shared `.section-title` class — consistent, no change
  needed.
- **Spacing**: sections mix `py-16` / `py-20` inconsistently; not a conversion
  blocker, left alone to stay in scope.
- **CTA hierarchy**: mostly fine (`btn-primary` = commit, `btn-secondary`/
  `btn-ghost` = free path). The Approach section's removal also removes the
  one place with no CTA at all breaking the page's rhythm.
- **Mobile sticky buy button**: absent before this change — fixed (see above).
- **Motion**: `framer-motion` used for the FAQ accordion and hero scroll
  affordance only — restrained, no decorative parallax or autoplay carousels.
  No changes needed.

## 4. Product-surface gaps per SKU (what exists vs. what a paying buyer needs)

- **Density Screen (€4,500, primary paid)**: `/reference` already shows the
  full worked example (study, deck, proposal, tender spec, raw CSVs) on a
  disclosed synthetic hall — this is exactly "what €4,500 buys" proof. No gap.
- **Envelope Study / Portfolio Screen (deposits)**: `EngagementLadder` on
  `/pricing` already states artefact, turnaround and price per rung from the
  catalogue. No gap found requiring code change in this pass.
- **Procurement Specification**: reference sample includes
  `specification.html` and `response_template.json` — the bid-comparison
  story is told. No gap.
- **Hall Watch**: recurring, thin post-purchase surface by nature (a change
  note quarterly) — copy on `/pricing` already sets expectations honestly
  ("nothing material to report is itself a reportable answer"). Left as-is;
  deeper work here is out of this pass's scope (Step 4 touches only
  copy/IA/empty-state clarity, and the existing copy already avoids faking
  completed work).
- **API/MCP** (`/developers`): out of scope for this pass beyond verifying no
  BESS/hardware language present (confirmed clean).

## 5. Explicit "do not build" list

Per the mission's forbidden list, this pass will **not** add:

- Any customer logo, testimonial, named deployment, or "MW delivered" figure.
- Any accuracy percentage, "field-validated" badge, or calibration claim not
  backed by the (currently empty) calibration ledger.
- A BESS/generator/microgrid/EMS/EPC product, price, or CTA anywhere,
  including inside comments or copy that implies a hardware roadmap.
- A second SKU, a second price list, or a second checkout flow.
- Any change to `gridforge/` engine code, evidence classes, or the
  calibration ledger schema.
- A photograph replacing `TimeToPower`, `EngagementLadder`,
  `BindingConstraintInsights`, `CapacityQualifier` results, pricing cards, or
  `LiveConsole` — these stay functional UI.
- A new Unsplash or other hotlinked stock carousel (none found in the current
  tree — `TtpPhoto` already serves the owned reference photo pack).
- Restoring `LiveScenario` to the home page — it is being mounted under
  `/intelligence` only, with the disclosure the mission specifies.
