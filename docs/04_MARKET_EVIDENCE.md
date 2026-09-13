# Market Evidence Log v0.1 — compiled 2026-09-13
Sourced findings behind `00_COMMERCIAL_SPINE`. Confidence is stated per claim. Re-verify quarterly.

---

## A. Demand and the grid thesis

- European colo+hyperscale capacity growing ~20% to 13 GW in 2026; Q2 take-up 260 MW; demand outpacing supply **"mostly due to a lack of available power causing delays"** — [CBRE via DCD](https://www.datacenterdynamics.com/en/news/cbre-europe-data-center-market-to-grow-by-nearly-a-quarter-in-2026/). European neocloud signings **420 MW in H1 2026 vs 89 MW a year earlier**; 55% of take-up now outside FLAP-D. *(High confidence.)*
- FLAP-D colo vacancy **6.4%** Q2 2026 — Frankfurt 3.1%, Dublin 7.2%, London 7.4%; prime powered land up **82% since 2021 to €2.26 m/MW** — [JLL EMEA Data Centre Report](https://www.jll.com/en-uk/insights/emea-data-centre-report). *(High.)*
- Mainova: until 2030 new larger Frankfurt projects **"will actually have no chance of being connected"**; high-performance connections return mid-2030s; 5–10 qualified requests/yr at 50–100 MW; data centres ≈40% of Frankfurt power demand — [Tech Policy Press](https://www.techpolicy.press/germanys-data-center-boom-is-pushing-the-power-grid-to-its-limits/). *(High.)*
- Queues: Amsterdam ~10 years; London West substation early 2030s; Denmark 60 GW queue vs 7 GW peak demand — [TNW](https://thenextweb.com/news/europe-data-centres-leaving-flap-d-grid-queues-land). Dutch court upheld TenneT's refusal of a 70 MW Haarlemmermeer connection, constraints possibly to ~2035 — [NL Times, Apr 2026](https://nltimes.nl/2026/04/29/judge-rules-electricity-grid-haarlemmermeer-full-data-centre-connection-delayed). *(High.)*
- Transformers: **120 weeks (2024) → 160+ weeks (2026)**, range 80–210; specialist electrical components 6–12 months — [DCK](https://www.datacenterknowledge.com/energy-power-supply/why-ai-data-center-projects-face-years-of-delays-after-approval). *(High.)*

**→ Thesis (a): in core European metros the existing grid contract is the asset, and densification within contracted load is the only fast path.** This is the strongest sales argument available and it is well evidenced.

## B. Density reality — the constraint on our own pitch

- Uptime 2025/26: **82% of operators cap below 30 kW/rack**, only **9% above 50 kW**, **<4% of facilities can host 100 kW+ racks** — [DCK](https://www.datacenterknowledge.com/cooling/for-high-density-ai-available-data-center-space-may-not-be-usable). Modal installed density 4–5 kW; mean ~9 kW — [Uptime Global Survey 2025](https://datacenter.uptimeinstitute.com/rs/711-RIA-145/images/2025.Annual.Survey.Report.pdf). *(High.)*
- Uptime (Daniel Bizo): at high density **power distribution "creates issues much more than cooling"**; practical retrofit ceiling **20–40 kW/rack**; AI racks up to **1.5 t before power and liquid infrastructure** — [DCK](https://www.datacenterknowledge.com/data-center-construction/ai-demands-stretch-the-limits-of-data-center-retrofits). *(High.)*
- Liquid cooling adoption **19%** deployed, 36% planning within 12–24 months (from Uptime 2025 data). *(Medium — secondary source.)*
- Legacy chilled water 6–7 °C (optimised 10 °C+) vs DTC wanting 27–32 °C; 500 W chips → 30 °C, 700 W → 27 °C — [DCD](https://www.datacenterdynamics.com/en/analysis/hot-water-cold-water/). *(High.)*
- Colo-specific commercial blockers: retrofits are **"operationally complex and highly disruptive… risk impacting customer workloads, tenancy revenues"** — [STL Partners](https://stlpartners.com/free_reports/the-retrofitting-roadmap-an-evolution-of-liquid-cooling/); colos need **"stronger customer commitments, lease certainty and detailed migration plans"** — [Data Centre Review](https://datacentrereview.com/2026/06/liquid-cooling-retrofits-could-cut-ai-data-centre-upgrade-costs-by-around-80/). *(Medium-high.)*

**→ Consequence for positioning: sell the defensible maximum and the cost ladder, never a promised density.**

## C. Named European retrofit activity (thin — this is a research gap)

- **Data4 Marcoussis DC01 (FR)** — explicit "major retrofit"; DLC deployment testing **up to 140 kW liquid + 60 kW air per rack**; **250 MW of DLC design projects** across the portfolio; CDU co-designed with Danfoss, Jun 2025 — [DCD](https://www.datacenterdynamics.com/en/news/data4-develops-first-liquid-cooled-deployment-at-marcoussis-campus/). *Strongest single datapoint.*
- **Digital Realty LHR19 London** (2019 building, 5 storeys) — Innovation Lab May 2026, **150 kW+/rack DTC on raised floor** with a 1.5 MW Inova CDU — [DCD](https://www.datacenterdynamics.com/en/news/digital-realty-launches-liquid-cooling-lab-in-london/); DLC offer 30–150 kW/rack across "more than half" of ~170 sites — [DCD](https://www.datacenterdynamics.com/en/news/digital-realty-launches-direct-liquid-cooling-offering/).
- **Telehouse South London** — Legrand ColdLogik CL20 RDHx at **>90 kW/cabinet**, Jan 2025 — [DCD](https://www.datacenterdynamics.com/en/news/telehouse-launches-liquid-cooling-lab-at-london-data-center/).
- **Equinix** — DTC support announced across 100+ IBX sites (Dec 2023), no European retrofit MW published since — [DCD](https://www.datacenterdynamics.com/en/news/equinix-to-roll-out-support-for-direct-to-chip-liquid-cooling-at-100-data-centers/).

**Gap (low confidence / unevidenced):** no public announcement by Equinix, NTT, Vantage, CyrusOne, Global Switch, maincubes, Penta, Itenos, Stack, Yondr, atNorth or Green Mountain quantifying converted MW of existing European hall to 80–130 kW/rack. Either confidential or genuinely rare. **Treat "a wave of European retrofits" as unproven.** Close this with primary calls, not desk research.

## D. Regulation — secondary driver, and currently moving the wrong way

- **EU EED Art. 12 / Delegated Reg. 2024/1364** — in force, mandatory reporting for sites ≥500 kW IT — [White & Case](https://www.whitecase.com/insight-alert/data-centres-and-energy-consumption-evolving-eu-regulatory-landscape-and-outlook-2026).
- **EU rating scheme** — **still draft**; consultation closed 23 Apr 2026, not adopted as of 22 Jun 2026 — [EC](https://energy.ec.europa.eu/news/rating-scheme-data-centres-eu-commission-launches-call-feedback-2026-03-27_en), [Jones Day](https://www.jonesday.com/en/insights/2026/06/green-data-centers-pioneering-energy-efficiency-and-sustainability-in-the-eu). Draft: A–G on PUE/WUE, labels mandatory >500 kW IT by **Aug 2027**.
- **Germany EnEfG** — applies >300 kW. In force: existing sites PUE ≤1.5 by Jul 2027, ≤1.3 by Jul 2030. **But the cabinet-approved amendment of 24 Jun 2026 (not yet through the Bundestag) relaxes these to 1.6 (2027) / 1.4 (2030)**, extends new-build windows 2→4 years, lets internal waste-heat use count, exempts sites with no reasonable heat-network connection, and pushes 100% renewables to 2030 — [CMS](https://cms.law/de/deu/legal-updates/enefg-novelle-bringt-entlastung-fuer-rechenzentren). *(High confidence — verify Bundestag status before any client meeting.)*
- **Ireland** — CRU Large Energy User policy live **12 Dec 2025**: dispatchable generation covering 100% of demand (≥10 MVA separately connected/metered), 80% new Irish renewables within six years, connection only where no major reinforcement needed — [William Fry](https://www.williamfry.com/knowledge/irelands-data-centre-connections-back-online/). **Load at an existing Dublin site cannot rise until matching generation is connected → in-hall densification within contracted load is the only fast path there.**
- **France** — ERF ≥0.20 from 1 MW. **Spain** — draft only.

**→ Do not build the pitch on tightening regulation.** Build it on grid scarcity.

## E. Competition

**Vendor free-analysis (the real threat to a paid screen):**
- Schneider: free [Data Center Reference Designs](https://www.se.com/us/en/work/solutions/for-business/data-centers-and-networks/reference-designs/); Oct 2025 NVIDIA co-designs **RD110/RD111, GB300 NVL72, 142 kW/rack**, shipped **with ETAP electrical models and EcoStruxure IT Design CFD models attached** — [BusinessWire](https://www.businesswire.com/news/home/20251006074939/en/Schneider-Electric-unveils-new-AI-data-centre-reference-designs-with-NVIDIA). Owns ETAP (majority) and 75% of Motivair; [first grid-to-chip AI-factory power digital twin with NVIDIA Omniverse](https://www.se.com/us/en/about-us/newsroom/news/press-releases/etap-and-schneider-electric-unveil-world%E2%80%99s-first-digital-twin-to-simulate-ai-factory-power-requirements-from-grid-to-chip-level-using-nvidia-omniverse-67d8f1bae06184512a0b9f48/).
- Vertiv: free [AI Reference Design Selector](https://www.vertiv.com/en-emea/solutions/ai-hub/design/), Modular Designer, quotable **retrofit** designs; [Liquid Cooling Services](https://www.vertiv.com/en-us/campaigns/liquid-cooling-services/) with a **"Transition Design"** tier (site assessment + modelling + design), price not public.
- Eaton: [Brightlayer Data Centers](https://www.eaton.com/gb/en-gb/digital/brightlayer/brightlayer-data-centers-suite.html) + [Brightlayer Energy (2026)](https://www.eaton.com/gb/en-gb/company/news-insights/news-releases/2026/eaton-unveils-brightlayer-energy-an-ai-powered-energy-management.html). Siemens, nVent, Trane are partners in [NVIDIA's Omniverse DSX blueprint](https://www.datacenterfrontier.com/design/article/55338673/nvidia-and-partners-define-a-repeatable-blueprint-for-ai-factory-data-centers).

**Consultancies:** Arup, Ramboll (EYP MCF), Cundall, Sweco, Deerns, RED Engineering (still independent — it was Red *Technologies* that [NV5 bought](https://www.datacenterdynamics.com/en/news/red-technologies-acquired-by-technology-and-engineering-consultancy-nv5/)), AECOM, Jacobs (which [productised an NVIDIA-blueprint digital twin](https://www.jacobs.com/newsroom/press-release/jacobs-optimize-data-centers-nvidia-ai-factory-digital-twin-blueprint)), WSP, Royal HaskoningDHV, Linesight, T&T, Mace, HDR (bought [Hurley Palmer Flatt](https://www.datacenterdynamics.com/en/news/hdr-buys-hurley-palmer-flatt/)), Salas O'Brien ([Blackstone $300 m minority stake](https://news.bloomberglaw.com/mergers-and-acquisitions/blackstone-pays-300-million-for-minority-stake-in-salas-obrien)). **No fees published by any of them.**

**Software:** Cadence Reality DC (ex-6SigmaDCX, quote-only) · Ansys (avg contract **$316,679** — [Vendr](https://www.vendr.com/buyer-guides/ansys)) · ETAP (not public) · EcoStruxure IT Advisor (**$8,300/yr MSRP**, 100 racks — [CDW](https://www.cdw.com/product/subscription-ecostruxure-it-advisor-change-module-saas-1-year-100-rack/8115276)) · Sunbird (**$234/cabinet/yr** — [published](https://www.sunbirddcim.com/pricing)) · Hyperview (**$3/asset/yr**, 500 min — [published](https://hyperviewhq.com/pricing/)) · Vigilent, EkkoSense (not public).
**Structural observation:** DCIM is cheap and transparent; simulation is expensive and opaque; **nothing answers the site-level power+thermal+compute question end-to-end.**

**Public pricing datapoints:** Uptime Tier III certification **$150k–$400k** (third-party blog, medium confidence); TCDD design review 8–12 weeks. CFD consulting **$100–250/hr**; outsourced CFD **$5k–25k per study** — [Resolved Analytics](https://www.resolvedanalytics.com/theflux/costs-of-cfd). Commercial CFD licence $15k–50k+/yr.

**Inferred, not sourced (flag as inference in any internal use):** senior EU MEP day rates €900–1,800 (director €1,800–2,800) → a 10–20 day feasibility study ≈ **€20k–60k**; single-asset technical DD €30k–80k, portfolio €100k–300k+, 3–6 weeks. **No EU tender award was found that isolates a data-centre power/cooling feasibility study as a line item.**

## F. Project economics — do not quote either figure as a benchmark

- STL Partners (May 2026): retrofit ≈ **$2 m/MW** vs greenfield liquid-cooled **>$11 m/MW**, i.e. ~80% lower headline capex — [press release](https://stlpartners.com/press/liquid-cooling-retrofits-can-cost-roughly-80-less/). Eight ecosystem interviews; density and timeline undisclosed; STL itself warns retrofit "should not be seen as a universal fix"; excludes migration, downtime and lost revenue.
- Secondary low-quality source: **$8–12 m/MW** and 14–22 months downtime.
- **4–6× spread.** *(Medium-low confidence both ways.)* Build our own unit-cost library from real quotes on projects 1–2. **The spread is itself a sales argument.**
- *Inference:* a 10 MW hall retrofit is a €20–100 m decision; study at 0.05–0.2% of decision value → €22–45k is easily defensible.

## G. Open research gaps — close with 10 primary calls, not with search

1. Who actually signs off "can this hall take 100 kW racks"? *(No public evidence found. Named public voices only: Chris Sharp CTO and Paula Cogan EMEA MD at Digital Realty; Mark Pestridge EVP Telehouse Europe; Tiffany Osias VP Global Colocation Equinix.)*
2. How are such studies procured — framework, one-off, or vendor-funded? *(Unevidenced.)*
3. Real decision-cycle length for a European colo densification decision. *(Unevidenced.)*
4. Has anyone ever bought a standalone capacity opinion, and from whom? *(Unevidenced.)*
5. UPS topology limits, floor-loading thresholds, contracted-vs-installed headroom ratios in real European halls. *(No public data — this is exactly what our studies would generate, i.e. the commercial opening.)*

## H. Source hygiene note
Several 2026 sources encountered (mgrid.org, moduledge, energy-solutions.co, terrapincg) appear to be SEO/AI-generated content farms. They were used only where they explicitly cite Uptime, and are flagged as low quality wherever referenced. **Nothing from that tier may enter a customer report.**
