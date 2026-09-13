# gridforge — capacity envelope engine

Answers one question: **how much AI compute can this hall carry, what binds first,
and what does each step of extra density cost?**

```bash
python3 -m gridforge init -o intake.json      # blank intake to send a client
python3 -m gridforge gaps    intake.json      # the data request
python3 -m gridforge screen  intake.json -o out   # Density Screen
python3 -m gridforge study   intake.json -o out   # Capacity & Density Envelope Study
python3 -m gridforge portfolio examples/intake/*.json -o out  # N halls, one methodology
```

```python
from gridforge.intake.loader import load
from gridforge.envelope import solve, ladder

intake = load("intake.json")
res = solve(intake.context)   # -> max racks, binding constraint, every constraint evaluated
lad = ladder(intake.context)  # -> Headroom Ladder: relieve the binding constraint, solve again
```

## Structure

| Package | Owns |
|---|---|
| `site/` | asset of record: geometry, climate, structural |
| `power/` | grid import -> transformer -> UPS -> LV distribution -> rack feed |
| `compute/` | GPU platform library, cluster definition |
| `thermal/` | heat split, TCS/FWS, CDU, plant, hydraulics |
| `scenario/` | scenarios as data, sweeps, one-at-a-time sensitivity |
| `economics/` | screening capex/opex, AACE Class 5 |
| `envelope/` | the solver and the Headroom Ladder |
| `validation/` | `Quantity`, `Provenance`, evidence classes E0-E7 |
| `intake/` | customer intake schema, loader, and the data-gap ledger |
| `reporting/` | report model, CI gates, Markdown + HTML renderers, screen / study / portfolio |
| `cli.py`, `serialize.py` | the delivery pipeline and the machine-readable model pack |
| `integrations/` | ports for ThermalForge / DERIM / GridOS. Nothing implemented yet. |

`tests/test_architecture.py` enforces the dependency rule, including the rule that
no domain module may import `gridforge.integrations`.

## The two rules that matter

1. **Every number carries its provenance.** `Quantity` propagates an evidence class
   through arithmetic and takes the minimum. A model applied to measured data is a
   modelled number, not a measurement. There is no way to construct a report number
   without a provenance chain — `reporting.model.Table` rejects bare numerals.
2. **The report cannot overstate itself.** `reporting.gates` fails the build on a
   missing provenance chain, on an evidence class higher than its inputs, on language
   asserting measurement over a modelled quantity, and — in `ISSUED` mode — on any
   capacity claim below its evidence floor.

## Adding a constraint

```python
from gridforge.constraints import ConstraintResult, constraint, floor_racks

@constraint
def my_constraint(ctx) -> ConstraintResult:
    ...
```
Registration is automatic and order-independent. A constraint must return the number
of racks it permits, one sentence of basis, and — if relief exists — what it costs and
how long it takes. A constraint with no relief is a scenario choice, not a capex item.
