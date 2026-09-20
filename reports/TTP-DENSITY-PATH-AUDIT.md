# Density-screen buy-path audit (this pass)

Baseline: PRs #7–#10 merged (brand clean, honest photo pack, Unsplash chrome
removed, BESS demo off home, decision strip + sticky mobile CTA on home,
LiveScenario mounted only under `/intelligence`). Working tree clean on
`claude/wonderful-hopper-k8on8z` at `930c71b`.

## Live-site check

`https://timetopower.ai/{,/qualify,/pricing,/reference,/intelligence}` could
not be fetched — the session's egress proxy rejects the CONNECT to
`timetopower.ai:443` (`connect_rejected — organization policy`), same
limitation the prior audit (`reports/TTP-UI-SWEEP.md`) hit. Findings below are
from reading the route source directly under `app/` and `components/`, which
is what actually ships (Vercel builds from this repo).

## Confirmed from source

- Decision strip (`SITE → BINDING CONSTRAINT → HEADROOM → COST → TIME`) is
  present on home (`app/page.tsx`, `#market` section).
- `StickyMobileCTA` is mounted globally (`app/layout.tsx`) and hidden on
  `/dashboard` and `/checkout`.
- `LiveScenario` is imported only in `app/intelligence/page.tsx`; `app/page.tsx`
  does not reference it. Confirmed via `grep -rn "LiveScenario" app/`.

## Concrete gaps found (this pass's scope)

1. **`/pricing` had no page-specific metadata.** `app/pricing/page.tsx` was a
   client component with no `<title>`/description of its own, so it inherited
   the root layout's home title/description verbatim — a term-sheet page
   sharing a tab title with the marketing home page.
2. **Qualify → paid handoff had two competing buttons.** `CommissionPanel` in
   `components/CapacityQualifier.tsx` rendered two separate "commission"
   actions side by side (a filled button that called checkout directly, and
   an outlined button that called the same checkout helper by a different
   path) with no secondary path to `/reference`. Two buttons doing the same
   thing is not two choices, it is one decision made harder to make.
3. **Density Screen was not visually distinct on `/pricing`.** `EngagementLadder`
   rendered all five ladder products as equal-weight cards in a plain grid.
   The screen is the primary SKU and the entry point for every other
   engagement, but nothing on the page said so visually.
4. **Sticky mobile CTA vs. final CTA.** `StickyMobileCTA`'s own comment claims
   it is "hidden once the visitor reaches the final CTA," but no such check
   existed in the code — only a route allowlist and a scroll-past-hero
   threshold. On a long page (home) a visitor scrolled to the final CTA
   section would see the identical Density Screen offer twice, once fixed to
   the bottom of the viewport and once inline.
5. **`/reference` is already a reasonably strong proof magnet** (worked study,
   deck, proposal, spec, response schedule, full working-file tables, an
   explicit synthetic-data notice, and a qualify CTA at the bottom) — this
   pass does not rewrite its deliverable claims, only strengthens the CTA path
   into the Density Screen and confirms nothing it describes exceeds what
   `gridforge/reporting` actually generates.

These four gaps (1–4) are what this pass fixes. See the PR description for the
full list of changes.
