# Time to Power — UI/Route/Component Audit

Written before any UI edit in this pass. Baseline at audit time: 410 pytest passed,
`tsc --noEmit` clean, `npm run build` clean (all still true — the audit found a
**copy and narrative** mismatch, not a broken build).

## The core finding

The backend (engine, catalogue, commercial docs, README, HANDOFF) has already
pivoted to the real product: **capacity screening for an existing AI hall** — no
hardware, no owned megawatts, no EPC. The **public homepage front-end was never
migrated**. It is still written for an earlier, different business: an
independent engineering practice that designs and stands up **behind-the-meter
generation (gas + fuel cell), on-site BESS, DC distribution and a physics-informed
EMS** for hyperscalers trying to bypass grid interconnection queues. That is a
different company, selling a different thing, forbidden by the capital rule
("no owned energy assets... physical deployment must be customer-funded") and by
this pass's standing order ("no hardware seller language").

This is not a cosmetic issue. The homepage's **signature hero panel**
(`TimeToPower.tsx`) autoplays five scenarios — *"Hyperscaler · Northern Virginia"*,
*"Sovereign AI · Germany — bypass grid fees entirely"* — with dollar figures and no
SYNTHETIC/illustrative label. Read at face value these are named customer
engagements. That is the forbidden-content item "fake customers ... case studies
that are not real or not labelled SYNTHETIC/REFERENCE," sitting in the single most
prominent element on the page.

## Route / component matrix

| Surface | Verdict | Why |
|---|---|---|
| `lib/products.ts`, `gridforge/commercial.py` | KEEP | Catalogue is correct and parity-tested. Not touched. |
| `/qualify`, `CapacityQualifier.tsx` | KEEP | Free qualifier, on-thesis. |
| `/pricing`, `EngagementLadder.tsx` | KEEP | Ladder rendered from catalogue. Not touched this pass. |
| `BindingConstraintInsights.tsx` | KEEP | On-thesis, used on home `#qualify` section. |
| `CommissionScreen.tsx`, `lib/ui.ts` | KEEP | Single paid CTA, reads price from catalogue. |
| `/constraints`, `/platforms`, `/reference`, `/developers` | KEEP | Reference/authority layer, on-thesis. |
| `lib/site.ts` — `SITE.name/tagline` | **CONFLICTING** | "GridForge AI / Speed to Power for AI Data Centers." No "Time to Power" brand anywhere in the UI despite README/HANDOFF already using it. **Fixed.** |
| `app/layout.tsx` metadata | **CONFLICTING** | Title, OG, Twitter, keywords all "Speed to Power," keywords include `DC microgrid`, `BESS`, `energy management system`. **Fixed.** |
| `components/Navbar.tsx` | **CONFLICTING** | Brand = "GridForge AI / SPEED TO POWER". Nav has two dead anchors (`#deploy`, `#architectures`) pointing at sections removed from `page.tsx` in a prior patch. Primary CTA was Density Screen, not the free qualifier the standing order wants primary. **Fixed.** |
| `components/Footer.tsx` | **CONFLICTING** | Same brand mismatch; description paragraph sells "power-systems engineering... close the gap between a grid queue and an energized site" (BTM framing); one dead anchor (`#architectures`). **Fixed.** |
| `app/page.tsx` hero copy | **CONFLICTING** | "Independent engineering for behind-the-meter generation, DC distribution, and physics-informed EMS" — sells the wrong company. **Fixed.** |
| `app/page.tsx` "APPROACH" (3 steps) | **CONFLICTING** | "Audit the site / Engineer the system / Commission & tune... EMS against live telemetry" describes an EPC/commissioning lifecycle we do not sell. **Fixed** — now names the actual ladder (Screen → Solve → Specify). |
| `TimeToPower.tsx` (hero signature panel) | **CONFLICTING (severe)** | Built entirely around "grid queue vs. behind-the-meter generation," with named-sounding scenarios ("Hyperscaler · Northern Virginia", "Sovereign AI · Germany — bypass grid fees entirely") that read as real customer engagements with no synthetic label. Kept as the signature visual per doctrine but **scenario content and copy rewritten** to the real product (binding constraint / headroom ladder / time-to-power for an existing hall) and explicitly labelled as illustrative scenarios, none named as a real customer. |
| `components/SystemFlow.tsx` ("HOW IT WORKS" section) | **DEMOTE (removed from home)** | A full behind-the-meter single-line diagram — gas, fuel cell, BESS, EMS nodes catching a "training spike." This is the same category of artefact HANDOFF says was already deleted once (`/infrastructure`) for depicting plant we do not design, build, own or fund. Removing the section from the homepage rather than rewriting 435 lines of plant-specific animation this pass. |
| `components/LoadSimulator.tsx` ("SEE THE PHYSICS" / "DEMONSTRATION" section) | **DEMOTE (removed from home)** | "The battery is what catches the spike" — a live gas/fuel-cell/BESS/renewables stack simulator. Same reasoning as SystemFlow: it visually asserts we design a generation+storage stack. Component left in the repo (not deleted, in case a later BTM-adjacent surface wants it), just unmounted from the money-path homepage. |
| `components/TimeToPowerComparator.tsx` ("COMPARATOR" section) | **DEMOTE (copy only)** | Quantifies "grid queue vs. on-site generation" months/revenue. Left mounted (it is a real, harmless MW/€ calculator) but the surrounding section copy was rewritten to frame it as "cost of an unrelieved binding constraint" rather than "build on-site power instead." |
| `lib/site.ts` — `ARCHITECTURES` export | **DEMOTE (dead code, deleted)** | Unused (the section that rendered it was already deleted per a comment in `page.tsx`) but still describes a "Hybrid Behind-the-Meter Microgrid," "High-Voltage DC Distribution," "Physics-Informed EMS" as our reference designs. Removed rather than left to be resurrected. |
| `lib/site.ts` — `TECH` array | **CONFLICTING** | "Hybrid microgrid architectures," "Physics-informed control," "Second-life BESS integration" presented as our technology. **Fixed** — replaced with the real technology (deterministic constraint engine, evidence classes + provenance, Headroom Ladder, calibration honesty). |
| `lib/site.ts` — `MARKET_STATS`, `PROBLEM_CARDS` | **CONFLICTING (unsourced / off-thesis)** | US-centric stats (RAND 68 GW, FERC 2,600 GW) not in `docs/04_MARKET_EVIDENCE.md`; problem framing sold "developers are moving behind-the-meter" as the fix. **Fixed** — replaced with the EU-sourced figures from `docs/04_MARKET_EVIDENCE.md` (CBRE neocloud signings, Uptime density reality, JLL vacancy/land cost, transformer lead times) and reframed the problem as the binding-constraint question the product actually answers. |
| `lib/site.ts` — `FAQ` | **CONFLICTING** | "How is on-site power faster than the grid?" sells BTM as our answer; "reference architectures" answer pointed at the now-deleted `ARCHITECTURES`. **Fixed.** |

## Not touched this pass (real, but out of scope for a UI-only pass)

- `/dashboard`, `/account` — client portal, unrelated to the public sell surface.
- Engine (`gridforge/`), Stripe webhook, catalogue, calibration ledger — untouched, per instruction not to rebuild the engine.
- `EngagementLadder.tsx`, `CapacityQualifier.tsx` — already correctly used on `/pricing` and `/qualify`; not duplicated onto the homepage.
- `SystemFlow.tsx` / `LoadSimulator.tsx` internals — unmounted from the homepage, not rewritten or deleted. A future pass can either delete them outright or repurpose the animation shell for an honest constraint-solving visualization.
