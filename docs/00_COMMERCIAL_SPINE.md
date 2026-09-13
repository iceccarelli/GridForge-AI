# GridForge-AI — Commercial Spine v0.1
**Status:** decision document, pre-audit. Written 2026-09-13.
**Owner:** founder. **Review cadence:** weekly against the metrics in §8.

---

## 1. The one sentence

> We tell the owner of an **existing** data hall, in weeks not months and with sourced evidence, **how much AI compute that hall can actually carry, what binds first, and what each step of extra density costs** — power, cooling and money together, with no equipment to sell.

## 2. Why this, why now — the evidence that matters

Three findings from the market scan reframe the opportunity, and one of them contradicts the naive version of the brief.

**(a) In Europe, the grid connection is the asset, not the building.** Mainova says Frankfurt has essentially **no chance of new large connections before 2030**, with high-performance connections returning mid-2030s. Amsterdam's queue is ~10 years; a Dutch court upheld TenneT's refusal of a 70 MW Haarlemmermeer connection in April 2026. Ireland's CRU Large Energy User policy (live 12 Dec 2025) blocks load increases unless matched by connected dispatchable generation. FLAP-D colo vacancy is 6.4% (Frankfurt 3.1%).
→ **Consequence:** in core European metros, the only fast way to add AI capacity is to get more useful compute out of *already contracted* power at an *already connected* site. That is exactly the question we answer.

**(b) The density the market talks about is not the density the market has.** Uptime 2025/26: **82% of operators' densest rack is below 30 kW**, only 9% run above 50 kW, and **fewer than 4% of facilities can host 100 kW+ racks**. Uptime's own analysts put the practical retrofit ceiling at **20–40 kW/rack**, with the pain starting above 40–50 kW at scale.
→ **Consequence:** do **not** sell "we will get your hall to 130 kW/rack." Most halls cannot get there and the honest answer is often "no." Sell the **defensible maximum** and the **cost ladder to raise it**. The value is in a credible *no* or a credible *47 kW* just as much as in a *130*.

**(c) The binding constraint is usually electrical, not thermal.** Uptime (Bizo): at high density power distribution "creates issues much more than cooling" — breakers, busway, tap-off units, plus 1.4 t racks against a TIA-942 Rated-3 floor design of ~1,223 kg/m². Transformer lead times 120→160+ weeks.
→ **Consequence:** a thermal-only or power-only answer is wrong by construction. **Integrated power+thermal+compute is the product**, and that is precisely what the existing repositories (GridForge-AI + ThermalForge + DERIM) are positioned to do and what no incumbent sells as one artefact.

**What we must stop saying immediately:** that German EnEfG is tightening and forcing retrofits. The cabinet-approved amendment of **24 June 2026** *relaxes* existing-site PUE to 1.6 (2027) / 1.4 (2030), extends new-build windows and softens waste-heat duties. The EU rating scheme is still **draft**; labels are due Aug 2027. Regulation is a secondary driver in 2026. **Grid scarcity is the primary driver.** Any pitch built on the opposite is falsifiable in one meeting.

## 3. ICP — primary and the one adjacent test

**ICP-A (primary, chosen): European colocation operators with pre-2020 halls sitting on contracted grid capacity they cannot presently monetise at AI densities.**

Qualify hard on all six:
1. Owns ≥1 hall commissioned 2008–2020, designed ≤15 kW/rack.
2. Holds firm grid capacity that is **under-utilised or under-contracted** (the asset).
3. Is in, or adjacent to, a metro where new connections are blocked (FLAP-D, Dublin, Milan, Madrid, Warsaw, Zurich, Vienna, Berlin, Munich, Stockholm, Oslo).
4. Has an inbound AI/HPC tenant request it has not been able to say yes to in the last 12 months.
5. Capex authority ≥ €5 m at regional/group level.
6. Has *not* already commissioned a full MEP feasibility study from Arup/Ramboll/RED/Cundall for that hall.

Highest-fit sub-segment: **regional/edge roll-ups and independent operators** — AtlasEdge, nLighten, Serverfarm, Penta, maincubes, Itenos, noris, Data Center One, Etix, Pulsant, Proximity, WIIT/Irideos, Nabiax, Aruba — whose whole business model is acquiring older halls with live grid contracts, and who do **not** have a 40-person in-house design engineering group. Tier-1 (Equinix, Digital Realty, NTT, Vantage) have internal teams and their own labs; treat them as later-stage, not first-blood.

**ICP-B (adjacent, test in the same 90 days at zero extra cost): European neoclouds / AI tenants hunting for a European hall that can take GB300-class racks inside 6 months.** European neocloud signings jumped to **420 MW in H1 2026 from 89 MW a year earlier**. This buyer has money, extreme urgency, a short decision cycle, and the same question inverted: *"which of these six candidate halls can actually take my racks, and how fast?"* Same engine, same report, multi-site scope, higher fee. If ICP-A stalls on price, ICP-B is where we go — not down in price.

**Explicitly not targeted:** greenfield hyperscale (served by Schneider/Vertiv/NVIDIA reference designs for free), single-rack enterprise, anyone who wants a BOM.

## 4. The wedge — what we sell that they cannot buy today

| Who | What they give | Why it fails this buyer |
|---|---|---|
| **Schneider / Vertiv / Eaton / nVent** | Free, excellent, NVIDIA-validated reference designs (RD110/RD111 at 142 kW/rack with ETAP + CFD models attached; Vertiv AI Hub design selector, quotable retrofit designs; ETAP+Omniverse grid-to-chip twin) | Conflicted by construction — every study ends in their BOM. Designed for **greenfield or vendor-led refit**, not "what does *my* 2014 hall actually allow." No independent sign-off an investor or board will lean on. |
| **Arup / Ramboll / RED / Cundall / HDR / Jacobs** | Real, integrated, insured engineering. Jacobs has productised an NVIDIA-blueprint digital twin. | Bespoke, brand- and PI-gated, procurement-heavy, typically **8–16 weeks** and priced as a design engagement. Answers deterministically with margin hidden in caveats. Too slow and too heavy for a screening decision. |
| **CoolIT / Motivair / JetCool / Iceotope / Submer** | Free hydraulic and CDU sizing | Answers "will my CDU fit," never "can this site take 40 MW." Thermal-only. |
| **Cadence Reality DC, ETAP, EcoStruxure IT Advisor, Sunbird, EkkoSense** | Thermal CFD **or** electrical **or** DCIM capacity | Nobody does the **joint** power×thermal×compute envelope. Cadence does thermal; ETAP does electrical; the seam between them is where the answer lives. |

**The wedge, stated commercially:** a **fast, vendor-neutral, evidence-graded capacity opinion that sits *before* the €100k design engagement and *against* the free but conflicted vendor study.** We compete on **decision speed + integrated envelope + auditable provenance**, and we never quote equipment.

**The steelman against us (hold this honestly):** every good consultancy will say they already do this, and they are not lying. Buyers procure on brand, PI insurance and a signable, liable signature. Uncertainty bands are a methodology preference, not yet a purchasing criterion. → We must (i) carry professional indemnity cover before the first paid study, (ii) sell speed and independence, not superior mathematics, and (iii) never position against a full MEP package — that fight is lost on day one.

## 5. The product ladder

| # | Offer | Price | Elapsed | Founder-h | Purpose |
|---|---|---|---|---|---|
| 0 | **Density Screen** (1 hall, desk-based, 8-page envelope + binding constraint) | **€4,500** fixed, credited in full against #1 | 5 working days | 10–14 | Door-opener. Converts a conversation into a paid relationship. Not a loss-leader — it must be profitable on its own. |
| 1 | **Capacity & Density Envelope Study** (the core product) | **€22k–€45k** | 3–5 weeks | 45–70 → 30 once templated | The €20–50k product in the brief. See `01_PRODUCT_SPEC`. |
| 2 | **Portfolio Screen** (5–15 halls, ranked, one methodology) | **€60k–€140k** | 6–10 weeks | 120–200 | ICP-A roll-ups and ICP-B site hunts. Highest €/hour once #1 is templated — same engine, N sites. |
| 3 | **Owner's-engineer support through concept design** | €80k–€150k+, or day rate | 3–6 months | — | Only when pulled. Do not chase. |
| 4 | **Re-run / monitoring subscription** | Deferred | — | — | Only after the trigger in §7 fires. |

Rule: **#0 and #1 must stand alone commercially.** If they only make sense as a route to #3, we are a design firm with a marketing gimmick.

## 6. Pricing logic and the price objection

Anchor on the decision, not the hours. A 10 MW hall retrofit is a **€20m–€100m** decision (retrofit cost estimates in circulation range **$2 m/MW** (STL Partners, interview-derived) to **$8–12 m/MW** (low-quality secondary) — a 4–6× spread that is itself an argument for paying someone to get the number right). At 0.05–0.2% of the decision value, €22–45k is trivially defensible. Consultancy day-rate inference puts a 10–20 day senior feasibility study in the **€20k–€60k** band — we sit at the bottom of that band with a faster clock and no equipment conflict.

**If a qualified prospect refuses €20k+, run this diagnosis before touching price** (per the brief — never reflexively discount):
- *Wrong buyer?* We are talking to an operations/facilities manager, not the person holding the capex case. Escalate, do not discount.
- *Wrong scope?* They want one hall screened, not a study. Sell #0.
- *Insufficient value?* They do not believe the constraint binds. Ask for their current stated max kW/rack and the last tenant request they declined. If neither exists, they are not ICP.
- *Wrong segment?* No firm grid capacity, or no AI demand. Disqualify and move on.
- *Trust/liability?* They need an insured signature. Fix with PI cover + a named co-signing chartered engineer, not with price.

## 7. Service → software triggers (do not pre-empt)

- **3 customers need the same calculation** → automate that calculation inside the engine. Expected first: the heat-split → CDU/FWS sizing chain, and the busway/tap-off ampacity check.
- **10 customers need the same workflow** → productise the workflow (input intake → envelope solve → report).
- **Customers ask to re-run as inputs change, or to watch a live hall** → *only then* consider subscription. Not before.
- Everything else stays bespoke and high-margin. A bespoke engineering business at 70%+ gross margin is an acceptable terminal state.

## 8. Metrics — reviewed weekly

Primary: **cash collected per founder-hour.** Target ≥ €400/h by project 3, ≥ €700/h by project 6.
Secondary: average project value; gross margin; founder-hours/project; proposal win rate; sales cycle (first contact → PO); repeat rate; referral rate; % of report generated by the engine rather than by hand (**automation %** — the leading indicator for the software transition).

## 9. First 90 days

| Phase | Days | Target |
|---|---|---|
| Evidence & credibility | 1–15 | Reference project published (synthetic, clearly labelled). Engine capable of one hall end-to-end. PI cover quoted. |
| Prospect build | 1–20 | **50 qualified prospects** against the six ICP-A gates, plus 15 ICP-B. Named buyer per account. |
| Outbound | 15–60 | **20 serious conversations.** Opening question, not a pitch: *"What is the highest kW/rack you will commit to in writing today in hall X, and what stopped you at that number?"* |
| Proposals | 30–80 | **10 proposals**, ≥6 at #1 pricing. |
| Close | 45–90 | **2 paid studies.** |

**Primary-research obligation inside those 20 conversations** — the market scan could not evidence these, and they are load-bearing: (i) who actually signs off the density decision, (ii) how such studies are procured, (iii) real decision-cycle length, (iv) whether anyone has ever bought a standalone capacity opinion. Ten calls closes that gap; no go-to-market claim rests on those four until it does.

## 10. Kill criteria — written down in advance

Kill or pivot if, by **day 90**:
- **<10** of 50 qualified prospects will take a 30-minute call → wrong ICP or wrong message. Pivot to ICP-B.
- **≥15** conversations happen and **zero** prospects will pay **€4,500** for the Density Screen → the problem is not felt as expensive. Stop building; re-segment.
- Prospects consistently say "our OEM does this free and we trust it" **and** cannot name a decision the free study got wrong → the wedge is imaginary. Pivot to ICP-B (investor/tenant side, where vendor conflict is disqualifying).
- **2 paid studies land but each takes >120 founder-hours with <20% reuse** → no leverage path. Either raise price to ≥€60k and stay boutique, or kill.
- Grid queues in FLAP-D materially clear (they will not by day 90, but check) → thesis (a) collapses; re-base on regulation or density economics.

**Thesis health check (re-test quarterly):** the business must get *more* valuable as AI demand rises, rack density rises, power gets scarcer, cooling gets harder and interconnection gets slower. If any of those reverse, re-read this section.

## 11. The gate every new feature passes

Who pays? · What decision does it improve? · How much money is that decision? · How much faster do we deliver? · Can we reuse it? · Can it become software? · Does it create proprietary IP? · Is it worth the founder-hour?

**Current proprietary-IP candidate:** the **Headroom Ladder** — the ordered set of binding constraints for a hall, each with the density at which it binds and the €/kW to relieve it. No competitor delivers this as a single artefact. It is the centrepiece of the report and the core of the engine (`03_TARGET_ARCHITECTURE` §4).

---
*Sources for §2 are listed with links in `04_MARKET_EVIDENCE.md`. No number in this document is a measurement of a customer asset.*
