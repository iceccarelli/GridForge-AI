# Repository Audit — findings v1.0
**Performed 2026-09-13 against the repositories as cloned.** This supersedes the speculative
integration plan in `docs/03_TARGET_ARCHITECTURE` §6, which was written without access.

**The headline finding inverts the original brief: ThermalForge holds nothing reusable, and
GridOS — listed as the lowest-priority source — is the only real engineering asset of the four.**

---

## 1. What each repository actually is

| Repository | Shape | Size | Tests | CI | Licence | Verdict |
|---|---|---|---|---|---|---|
| **GridForge-AI** | Next.js 15 marketing + lead-generation site with a commercial stack | 23 components, 13 API routes, 14 `lib` modules (~2,200 LOC TS) | none | none | **no LICENSE file** | Commercial front end. Real, shipping, and the sales channel for the engineering product. |
| **ThermalForge-Liquid-Cooling** | Next.js marketing site + portal, single commit `Full marketing site + portal rebuild` | 19 `.tsx`, 2,206 LOC | none | none | **no LICENSE file** | **Nothing to extract.** No calculations, no models, no Python. |
| **DERIM** | — | — | — | — | — | **Not accessible** under this account (`could not read Username`). Audit outstanding. |
| **GridOS** | Python engineering platform, FastAPI service | 99 `.py`, ~13,100 LOC, 55 commits | **23 test modules** | GitHub Actions | **MIT** | **The asset.** Tested, licensed, honest about its own scope. |

## 2. ThermalForge — the extraction list was void

`docs/03` §6 listed eight candidate extractions from ThermalForge: liquid-cooling calculations,
a thermal network model, rack-density analysis, thermal constraints, hydraulic calculations,
architecture comparison, scenario modelling and thermal report generation.

**None of them exist.** The repository is a marketing site and a portal shell: 19 React
components, fonts, SVGs, one commit. There is no calculation code, no test suite and no Python.

*Consequence:* every thermal capability in `gridforge/thermal` is original work, not an
extraction. That is a better position than the brief assumed — there is no legacy thermal code
to carry, and no parity test to write — but it also means the thermal library defaults are E0
and the fastest route to E3 is a reviewing engineer, not an old repository. **The ThermalForge
port stays in place and stays empty.** Do not spend founder-hours mining it.

## 3. GridOS — what is worth taking, and what is not

Present and tested: `economics/` (value-stacked dispatch MILP — arbitrage + demand-charge +
degradation; TOU tariff with demand charge; recency-weighted seasonal forecaster; receding-horizon
MPC; baseline-vs-optimised ROI backtest), `digital_twin/models/` (battery, PV, load, line,
transformer, bus, EV charger), a pandapower solver, protocol adapters (Modbus, MQTT, OPC-UA,
DNP3, IEC 61850), FastAPI routes, SQLite/InfluxDB/TimescaleDB storage, k8s manifests.

The code is unusually honest for a young repository. Its README separates launch scope from
experimental modules and says so; `economics/roi.py` documents the exact annualisation error that
inflates ROI figures ~30× and avoids it; `tariff.py` explains why a flat €/kWh model is useless
to a C&I buyer. This is a codebase written by someone who expects to be checked.

**Wired in this patch** (`gridforge/integrations/gridos/adapter.py`, lazy import, MIT attribution):

| Capability | Why it earns its place | Evidence ceiling |
|---|---|---|
| Value-stacked dispatch + ROI backtest | Turns "you could install 2 MW of storage" into "it earns X per year and pays back in Y" — the second half of every behind-the-meter conversation | **E1** — an optimiser result is what an asset *could* earn under modelled inputs, never what it *has* earned |
| Firm capacity from storage duration | Stops a study crediting a 2 MW / 8 MWh battery as 2 MW of firm capacity against an 8-hour window when it is 1 MW. Needs no GridOS import at all | E1 |

**Deliberately not wired:** forecasting (no paid workflow needs it yet), MPC (operations, not
feasibility), telemetry / digital twin / grid state (dormant until a customer-facing workflow
pays for it), protocol adapters (nothing in a feasibility study talks to a PLC).

**Licence:** MIT, so consumption with attribution is clean. GridOS is imported *lazily, inside
the call*, so `gridforge` keeps its zero-dependency guarantee and a study that never asks an
economics question never touches it. Its absence raises `NotWired`, never a silent zero.

## 4. Validation status of everything we now hold

Against the ladder in `docs/01` §6:

| Asset | Honest class | Why not higher |
|---|---|---|
| GridForge-AI market figures | External market claims, correctly labelled as such | They are claims about the market, not about us — the README says so and the code keeps to it |
| `lib/siting.ts` regional scores | **E1 (model)** with per-field provenance labels already in the data | Live EPEX prices are E5 *inputs*; the score built on them is a model |
| GridOS economics | **E1–E2** (model / simulation), unit-tested | Tested code proves the arithmetic, not the world. No field reconciliation, no customer data |
| GridOS digital twin | **E1**, experimental by its own README | Not mounted in the default app |
| `gridforge` engine | **E0–E1** on library inputs; **E3** outputs where a constraint is reviewed | Library defaults are assumptions until a site's own data replaces them |
| ThermalForge | — | Nothing to classify |

**Nothing in any repository is E4 or above. Nothing is field-validated. Nothing is deployed.**
That is the accurate position and it should be stated in exactly those words to any buyer who
asks.

## 5. Accuracy-claim findings — the one that mattered

The site is, on the whole, unusually disciplined: `lib/site.ts` opens with a comment forbidding
fabricated customers and metrics, the FAQ states pilot stage plainly, and the AI analyst route
is instructed never to give a bankable number for free. That is a real asset and it should be
defended.

**Finding A1 (corrected in this patch).** Two places described the reference architectures as
*"validated engineering reference designs"* — `app/page.tsx` and the FAQ in `lib/site.ts`.
Validated against what? There is no test data, no commissioned installation and no field
measurement behind them. On the evidence ladder, "validated" is E4 and these designs are E1.
The word is the single highest-exposure claim on the site, and it sits directly against the
repository's own stated policy. Corrected to language that says what is true: modelled and
internally reviewed, not validated against a delivered project.

**Not a finding.** `lib/site.ts` line 106 offers *"Validated performance + tuned controls"* as
the deliverable of a commissioning engagement. That is correct usage — commissioning is where
validation actually happens.

**Finding A2 (open).** **Neither GridForge-AI nor ThermalForge has a LICENSE file.** Absent a
licence, the default is all rights reserved, which is fine for the site but blocks anyone from
contributing and makes the intent ambiguous if code is ever shared with a customer under an
engagement. Decide deliberately: proprietary for the commercial site, and a permissive licence
only if a client needs to run the engine themselves.

## 6. Reconciliation with `docs/00` and `docs/03`

1. **`docs/03` §6 ThermalForge extraction list is void** — superseded by §2 above.
2. **GridOS is promoted** from "future selective integration" to the only wired integration.
   It does not become the centre of gravity: one adapter, one port, lazily imported.
3. **The ICP needs a second look.** `docs/00` targets colocation operators retrofitting halls to
   high density. The site GridForge-AI already markets sells *speed to power* — behind-the-meter
   generation to bypass interconnection queues. These are the same engineering question asked from
   two ends, and the engine now answers both: the retrofit question is "what does this hall allow",
   the speed-to-power question is "how fast can firm supply be made to exist". Patch 0002 makes the
   second one a first-class output. **The two ICPs share one engine and one report; they do not
   need two businesses.**
4. **DERIM stays unaudited.** Its port stays empty and nothing depends on it.

## 7. What this changes about what we sell

The reference project now shows the number that only this engine produces: the same hall carries
**28 racks on the grid connection alone and 62 racks with behind-the-meter firm supply** — with
the item that sets the date named, and the ladder costed at each step. No vendor study will say
that, because it ends in their bill of materials. No consultancy study will say it in three weeks.

That comparison is the product.
