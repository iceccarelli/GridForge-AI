# Engineering Reference & Assumption Library v0.1
**Compiled 2026-09-13 from public sources.** This is the seed of `gridforge` library data.
**Every entry is E0 (assumption) or E1 (model) until independently corroborated.** `[V]` = vendor/marketing claim. `[M]` = measured or independently reported. `[C]` = calculated here from sourced inputs.
**Rule: a `[V]` figure may never be presented to a customer as validated performance.**

---

## 1. AI rack power — platform library seed

| Platform | Rack power | Power delivery | Status Sep 2026 | Class |
|---|---|---|---|---|
| GB200 NVL72 | 120 kW quoted; 132 kW total TDP = 115 kW liquid + 17 kW air | 415/480 VAC → ~48 VDC busbar, paired ~1,400 A | Shipping | [V] |
| GB300 NVL72 | up to 142 kW (NVIDIA RA); Lenovo 135 kW TDP / 155 kW peak | 200–277 VAC (346–480 VAC WYE) in, 50 VDC out; 6–8 × 33 kW shelves; 1,400 A rear busbar | Shipping | [V] |
| Vera Rubin NVL144 (VR200) | **NOT DISCLOSED.** Third-party estimate 190–230 kW | 800 VDC ecosystem; 45 °C liquid, liquid-cooled busbar | Announced, vol. 2H2026 | unverified — **do not use for paid sizing** |
| Rubin Ultra NVL576 / Kyber | ~600 kW target, needs second rack footprint | 800 VDC | Announced 2H2027 | [V] roadmap |
| AMD MI355X | GPU TDP 1.4 kW liquid / 1.0 kW air; ≤128 GPU/rack liquid | — | Shipping | [V] |
| AMD Helios (MI450), Open Rack Wide | 64/72/128 GPU/rack; **rack kW not published** | OCP ORW | ES 2H2026, MP Q2 2027 | unverified |
| Meta HPR roadmap | 140 → 190 → 300 → 800 kW; busbar rated 700 kW | 48 VDC → ±400 VDC (Mt Diablo) | v2 deployed, rest roadmap | [V] |

**800 VDC:** OCP Mt Diablo = 480 VAC → ±400 VDC in a **sidecar power rack** — this is the retrofit-relevant path. Claimed +150% power through the same copper `[V]`. ~80 ecosystem partners aligned Aug 2026.

## 2. Heat rejection split (design input, high sensitivity)

| Source | Liquid | Air | Basis | Class |
|---|---|---|---|---|
| QCT, GB200 NVL72 | 115 kW (87%) | 17 kW (13%) | 132 kW rack | [V] |
| Lenovo, GB300 NVL72 | ~90% | ~10% | cold plates on CPU/GPU/HBM/NVSwitch | [V] |
| Chilldyne 500 kW design | 414 kW (83%) | 86 kW (17%, via RDHx) | design study | [V] |
| Uptime Intelligence | ~70% typical, >90% possible | 5–30%, "sometimes 50%" | general DLC | [M] |
| Vertiv | 70–75% | 25–30% | general DLC | [V] |

**Library default:** NVL72-class → **85–90% liquid / 10–15% air**; general DLC servers → **70–80% / 20–30%**.
**The number that kills retrofits:** residual air load is still **13–20 kW/rack** for a 130–142 kW rack — above what most legacy halls deliver per rack today. *Always solve the residual-air constraint explicitly; it is the most commonly missed one.*

## 3. Cooling architecture capability

| Architecture | Practical kW/rack | Facility-side requirement |
|---|---|---|
| Perimeter air + containment | 10–15 legacy, 20–25 optimised | floor tile ~1,900 cfm best case vs ~5,000 cfm needed at 40–50 kW |
| Close-coupled / in-row air | ≤50 | chilled water to row |
| RDHx passive/active | 20–80 | chilled water per rack door; passive relies on server fans |
| DLC single-phase cold plate | >50 typical; 142 shipping; 150+ advanced | CDU + TCS manifolds + residual air path |
| Two-phase DLC | OCP spec exists; **no verified deployed ceiling** | refrigerant CDU, leak/GWP management |
| Immersion | >150 per vat | tank-level, no raised floor |

## 4. ASHRAE liquid classes, TCS/FWS

5th-edition Thermal Guidelines (2021): W17/W27/W32/W40/W45/W+ = **maximum facility supply temperature °C**; all classes have a 2 °C lower limit. Compliance requires *unthrottled* operation across the class range. FWS → CDU liquid-to-liquid HX → TCS → cold plates.

| Parameter | Value | Class |
|---|---|---|
| GB300 NVL72 water range | 2–50 °C, ASHRAE W45 | [V] |
| NVL72 max liquid in/out | 45 °C / 65 °C, ΔT 20 K | [V] |
| **What operators actually specify** | **27–30 °C TCS supply** for 500–700 W parts; Meta standardised 30 °C | [M] |
| Cold-plate design ΔT | 10 K (40→50 °C) | [V] |
| CDU liquid-to-liquid approach | 4–5 K | [V] |
| CDU liquid-to-air approach | 11 K | [V] |

**Planning rule:** W45 is an *equipment survival* rating, not an operating point. Design FWS to deliver TCS at 27–32 °C → **FWS ≈ 22–28 °C** at a 4–5 K CDU approach. Legacy plant at 6–7 °C supply is thermally capable but hydraulically mis-sized and economically wasteful — **flow, not ΔT, governs the retrofit**.

## 5. CDU and hydraulics

| Parameter | Value | Class |
|---|---|---|
| In-rack L2A CDU | 70 kW at 11 K approach | [V] |
| In-row / row L2L CDU | 121 / 600 / 1,350 / 2,300 kW families; 2,000 kW at 5 K approach, 2,125 l/min @ 35 psi | [V] |
| Flow per NVL72 rack | 120–130 l/min | [V] |
| **Flow rule of thumb** | **~1.4–1.5 l/min per kW at 10 K ΔT** | [C] |
| TCS operating pressure | 140–450 kPa (20–65 psi) | OCP |
| Pressure-drop example (9 kW server) | cold plate 1.8 + manifold 0.25 + QD pair 0.5 psi, +1 psi CDU→rack at 20 ft | [V] |
| Redundancy convention | dual pumps, dual feeds, 50 µm inline filter | [V] |
| **TCS water quality (OCP)** | conductivity <1,500 µS/cm @25 °C; pH 8.0–10.5; TSS <5 ppm (fill <1); sidestream filtration <5 µm at 10% flow; azole inhibitor >100 ppm | OCP standard |

**Always derate a vendor CDU rating to the site's actual FWS temperature before sizing.** A 2,000 kW rating at 5 K approach is not 2,000 kW at a site that can only deliver 24 °C FWS.

## 6. Retrofit constraints in an existing hall

| Constraint | Number | Class |
|---|---|---|
| European colo design density, 2010–2020 builds | **8–20 kW/rack**; ~30 only in HPC/hyperscale 2015–20 | [M] |
| Installed reality, 2025 survey n≈1,000 | modal 4–5 kW (30% of operators); mean ~9 kW; **82% below 30 kW**; only 9% >50 kW; **<4% of facilities can host 100 kW+** | [M] |
| Floor loading design standard | TIA-942 Rated-3: **12 kPa ≈ 1,223 kg/m²** superimposed live load | standard |
| GB200 NVL72 rack mass | ~1,360 kg | [M] |
| Implied loading, ~130 kW rack | ~1,890 kg/m² over 0.6×1.2 m; ~945 kg/m² over a 0.6×2.4 m aisle pitch | [C] — **arithmetic only; requires structural engineer** |
| Retrofit ceiling, practitioner view | **20–40 kW/rack**, pain above 40–50 kW at scale | [M] |

**Consequence:** raised floors generally need load-spreading or removal; **slab is the default for 120 kW+**. Keeping one chilled-water plant for both legacy air and DLC either strands free-cooling benefit or strands the air tenants — model the split loop explicitly.
**Modelled retrofit outcome (Vertiv, 75% liquid):** PUE 1.38 → 1.34 (−3.3%) but **facility power −18.1% and total site power −10.2%** `[V, modelled]` — PUE understates the gain because IT power itself drops ~7% (server fans −80%). *Never sell a retrofit on PUE alone; sell it on total site kW released back to compute.*

## 7. Electrical

| Item | Value | Class |
|---|---|---|
| Busway ampacity | legacy **400 A**; modern AI halls **800–1,000 A** | [M] |
| Current at 600 kW | 208 V 3φ ≈1,670 A; **415/400 V 3φ ≈835 A**; 800 VDC ≈750 A | [C] |
| Practical tiers | ≤30 kW cable+floor PDU · 30–80 kW 415 V busway+tap-off · 80–140 kW OCP power shelves · >140 kW ±400/800 VDC | [M] |
| OCP power shelf | 33 kW output, 27.5 kW at N+1 | [V] |
| In-rack busbar | 1,400 A | [V] |
| SELV boundary | <60 VDC — 48 V compliant; ±400/800 V need added shock protection | standard |
| PUE reference | global weighted avg **1.54** (2025); ≤5 yr sites 1.48; ≥20 MW sites 1.44 | [M] |
| DLC hall PUE claims | 1.05–1.15 | [V] — **unproven; use 1.15–1.25 for design** |
| Cooling share of site energy | hyperscale ~7%, enterprise >30% | IEA [M] |
| Transformer lead time | 120 weeks (2024) → **160+ weeks (2026)**, range 80–210 | [M] |

## 8. Water

- Modern liquid-cooled sites claim WUE ≤0.1 l/kWh vs ~1.5 historic `[V]`.
- NVIDIA's "300× more water efficient" claim is **marketing, not measured** — do not repeat it in a report.
- **Dry/adiabatic viability, Northern/Central Europe:** at TCS W32–W40 with 4–5 K CDU approach, FWS 27–35 °C is achievable with dry coolers at ~10 K approach to dry bulb for essentially the whole year (design dry bulb 30–35 °C) → WUE ≈ 0 with adiabatic assist for a handful of peak hours. **But** if TCS is held at 27–30 °C (what operators actually pick for 700 W+ parts), FWS falls to 22–25 °C and dry-only rejection fails on summer design days — trim chiller or adiabatic assist required. The residual 10–15% air load still needs a conventional chilled-water/CRAH circuit at legacy temperatures. `[C]`

## 9. DO NOT USE FOR PAID WORK (unverified)

1. Vera Rubin NVL144 / VR200 rack power — NVIDIA has not published it; 190–230 kW is a single third-party estimate.
2. Rubin R200 GPU TDP — undisclosed.
3. AMD Helios rack kW — not published.
4. Rubin Ultra 600 kW — a stated target, not a specification.
5. GB200 "120 kW" vs "132 kW" — different quantities (marketing rack figure vs OEM total TDP); no NVIDIA datasheet states either publicly.
6. **W/m² design density for European colo 2010–2020** — no defensible primary figure found. Derive per hall from rack count and footprint; never quote a generic value.
7. Floor loading for a 130 kW rack — the kg/m² figures here are arithmetic from rack mass and an assumed footprint. Structural engineer required.
8. Two-phase DLC and immersion per-rack ceilings — no credible deployed limits found.
9. Meta HPRv3/v4 (300/800 kW) — roadmap, not shipping.
10. DLC PUE 1.05–1.15 — vendor claim; the only *modelled* retrofit figure found was 1.34 at 75% liquid.
11. OCP ACS Cold Plate Requirements r1.0 is dated Oct 2019 and still uses the old W1–W5 naming — stale vs ASHRAE 5th ed.; verify against a current revision.
12. Retrofit cost per MW — two circulating figures differ by 4–6× ($2 m/MW STL Partners interview-derived vs $8–12 m/MW low-quality secondary). **Neither is a benchmark.** Build our own unit-cost library from quotes obtained during the first two projects.
