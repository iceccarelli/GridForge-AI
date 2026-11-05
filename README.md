# Time to Power · GridForge Engine

**Time to Power** is the commercial practice. **GridForge Engine** (this repository, `gridforge-ai`) is the
engine it runs on. The website, [timetopower.ai](https://timetopower.ai), is the Time to Power front end of
this same repository.

Time to Power evaluates how much useful AI compute an **existing** data-centre hall can support, which
electrical or thermal constraint binds first, what relieves it, what the relief costs, and when it can be
available, with the evidence class behind every figure.

It is a founder-led, pilot-stage engineering practice. It is not a utility, EPC, equipment maker or supplier,
generator or battery vendor, or energy trader. **It sells no equipment, holds no inventory and owns no
megawatts.** Physical work, if any, is procured and funded by the client.

## Who it is for

Owners and operators of existing AI-capable halls (enterprise, colocation, AI infrastructure operators), data-centre
developers and investors screening a portfolio, electrical and mechanical engineering teams, and procurement or
technical advisors who need a defensible number before spending money.

## What Time to Power sells

All prices and turnarounds come from one catalogue, `lib/products.ts`, mirrored by `gridforge/commercial.py`
(`tests/test_catalogue_parity.py` fails if they drift). The website reads the catalogue; this table is a
convenience copy, so check the site or the catalogue for the live figure.

| Offer | What you get |
|---|---|
| **Free qualifier** | Seven numbers, no card. A directional answer naming the likely binding constraint, the key missing inputs and the evidence class. It is not an engineering opinion. |
| **Density Screen** (EUR 4,500, five working days from a complete intake) | One hall: what binds first, racks of your target platform before and after the costed ladder, the first six rungs of the headroom ladder, which item sets the date, and the list of inputs nobody has measured. Credits in full against the Envelope Study. |
| **Envelope Study** (deposit EUR 9,000 against a scoped fee of EUR 22k to 45k) | The complete constraint ladder, architectures compared, time to power, sensitivity, economics and a machine-readable model pack. |
| **Portfolio Screen** (deposit EUR 15,000 against EUR 60k to 140k) | Five to fifteen halls ranked under one methodology. |
| **Procurement Specification** (EUR 18,000) | A tender-ready technical specification for one relief option, and a comparison of the bids you receive. |
| **Hall Watch** (EUR 6,000 per quarter) | The hall's model kept live, with a change note naming what moved and whether it changes the decision. |
| **API access** (Triage, Scale, Platform; metered) | The engine as an API and an MCP endpoint, screening-mode output only. |

Deliverables are screening-mode unless a named engineer's review says otherwise. A model output is not an
engineering approval, a grid commitment, a procurement commitment or a utility guarantee.

## What the engine is

A Python package with **no required dependencies** (standard library only, Python 3.11+), so it can be reviewed
and run in an air-gapped environment. It takes a description of a hall (grid connection, transformers, UPS,
low-voltage distribution, rack feed, cooling plant, floor and white space) and a GPU platform, solves every
constraint together, and returns the rack count, the constraint that binds first, and a **headroom ladder**:
relieve the binding constraint, solve again, see what binds next.

```bash
pip install gridforge            # or: pip install -e . from a checkout

gridforge init -o intake.json         # a blank intake to send a client
gridforge gaps    intake.json         # the data request: what is missing and why it matters
gridforge screen  intake.json -o out  # a Density Screen
gridforge study   intake.json -o out  # an Envelope Study
gridforge portfolio halls/*.json -o out
```

```python
from gridforge.intake.loader import load
from gridforge.envelope import solve, ladder

intake = load("intake.json")
result = solve(intake.context)    # max racks, binding constraint, every constraint evaluated
steps = ladder(intake.context)    # the headroom ladder
```

Package layout and the rules for adding a constraint are in [`gridforge/README.md`](gridforge/README.md). The
engine's licence is FSL-1.1-ALv2 (see [`LICENSE`](LICENSE)): source-available, converting to Apache-2.0 two years
after each release. It is not OSI open source.

## Evidence classes and assumptions

Every number carries a provenance chain and an evidence class, and a result carries the **weakest** class that
went into it (`gridforge/validation/evidence.py`):

| Class | Meaning |
|---|---|
| E0 | Assumption: library default or judgement. Any lead time you supply is E0 until a quotation process exists. |
| E1 | Modelled from a documented model on assumed inputs |
| E2 | Simulated (numerical) |
| E3 | Engineering estimate reviewed by a qualified engineer |
| E4 | Compared with laboratory, rig or vendor test data |
| E5 | The client's own measured data, as supplied (not surveyed by us) |
| E6 | Field-validated: the model reconciled against measured site performance |
| E7 | Observed in operation after implementation |

Inputs the client did not supply are filled from a library default, labelled an assumption and listed in the
data request. Nothing is filled in silently. A missing cost, lead time or availability is never treated as zero
and never produces a date; a date resting on an assumed lead time is reported as an assumed lead time. The
**calibration ledger shipped today is empty**: the models have not been checked against measured data from a
real hall, and every output says so. Reports are generated through gates that fail on missing provenance, an
evidence class higher than the inputs, or language claiming measurement over a modelled quantity.

## The public demo and reference data

What the site shows without a purchase is labelled by kind:

- `/reference`, `/constraints`, `/platforms`: public engine reference data, with citation endpoints
  (`/api/cite`, `/api/constraints`) and a machine-readable model pack. It describes the engine, not a customer.
- The worked example hall is **synthetic**. The observatory scenarios are **modelled**, not observed.
- Photographs on the site are reference photography, not a customer site and not evidence of measured capacity.
- Queue statistics are not connection probabilities; wholesale price data is context, not site headroom.
- There are no customer names, testimonials or case studies on the site. A reference is added only with the
  customer's permission.

## What is production, what is not

| Status | Capability |
|---|---|
| Production | Free qualifier; Density Screen, Envelope Study, Portfolio Screen and Procurement Specification generation; Hall Watch re-solves and change notes; metered API (`/v1/*`) and MCP endpoint; checkout, entitlements and delivery for the catalogue above |
| Pilot-stage | The business itself (founder-led, no field calibration yet), the market intelligence subscription (a modelled signal, not a verified-site portfolio) |
| Not available | Equipment supply, installation, power purchase, financing or operation of generation or storage; issued professional opinions or indemnity; guaranteed grid dates; field-calibrated results |

## API

Public-tier routes (no signed key): `POST /v1/qualify`, `POST /v1/estimate`, and the read-only `GET /health`,
`/v1/version`, `/v1/platforms`, `/v1/intake/template`, `/v1/calibration`, `/v1/calibration/residuals` (aggregate
residual statistics over human-approved site observations only; `uncalibrated`, `n_records` 0 until there are
some), `/v1/tools`. Client routes (`/v1/screen`,
`/v1/compare`, `/v1/study`, `/v1/portfolio`, `/v1/diff`, `/v1/spec`, `/v1/bids` and others) need a signed key and
are metered by plan. The OpenAPI description is served at `/openapi.json`. The developer page, `/developers`,
documents authentication, limits and errors.

## Develop

```bash
npm ci
npm run typecheck && npm test && npm run build     # the Next.js site (Node 22)
python -m pip install -e '.[dev]' && python -m pytest    # the engine and its contracts
```

Rules that apply to every change: do not alter engineering assumptions or solver outputs to improve a demo; do
not weaken provenance, evidence classes, calibration rules, entitlements or privacy controls; do not invent
customers, measurements, lead times or dates; keep copy, prices and checkout consistent with `lib/products.ts`.
Operator and state notes are in [`docs/EXECUTION_STATE.md`](docs/EXECUTION_STATE.md). An independent adversarial
test harness lives in [`gridforge-stress-test`](https://github.com/iceccarelli/gridforge-stress-test).

## Contact

power@timetopower.ai · [timetopower.ai](https://timetopower.ai) · founder: Vincenzo Grimaldi
([about](https://timetopower.ai/about)).
