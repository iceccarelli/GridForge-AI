# Patch 0001 — GridForge-AI capacity envelope engine

**Additive only. Nothing existing is deleted, moved or rewritten.** Every file in this
patch is new, under `gridforge/`, `tests/`, `examples/` and `docs/`. If it is wrong,
`git revert` removes it completely and GridForge-AI is exactly as it was.

## Why this exists — the commercial justification

Without it there is nothing to show the first twenty conversations and no way to produce
the reference project in `docs/01_PRODUCT_SPEC` §8. It is the smallest artefact that can
generate the €22k–€45k Capacity & Density Envelope Study end to end.

Against the gate in `docs/00_COMMERCIAL_SPINE` §11:

| Question | Answer |
|---|---|
| Who pays? | European colo operators with pre-2020 halls on contracted grid capacity, and the neoclouds hunting for halls that can take GB300-class racks. |
| What decision does it improve? | Whether to convert a hall, at what density, in what order, and whether to stop. |
| How much money is that decision? | €20m–€100m for a 10 MW hall. |
| How much faster? | 3–5 weeks against 8–16 for a consultancy feasibility engagement. |
| Can we reuse it? | The engine, the libraries and the report are the reusable core; per project only the inputs change. |
| Can it become software? | Yes, and the automation ledger in `docs/01` §7 says when — after three customers need the same calculation, not before. |
| Proprietary IP? | The **Headroom Ladder** and the provenance system. Neither exists in a competitor's deliverable. |
| Worth the founder-hour? | It is the difference between ~68 h and ~30 h per study. |

## What it does

`solve(ctx)` evaluates 13 independent constraints over a common context and returns the
minimum, the binding constraint, and every other constraint with its basis.
`ladder(ctx)` relieves the binding constraint, solves again, and repeats — producing the
ordered, costed, time-phased list of what stops this hall, which is the artefact the
customer is actually buying.

Run the reference project:

```bash
make reference      # writes out/reference_study.{md,html}
make test           # 28 tests: provenance, constraints, report gates, architecture rules
```

On the synthetic reference hall (12 MW site, 8 MW contracted, 2015 build at 8 kW/rack,
raised floor, 6/12 °C plant, 400 A busway, 63 A tap-offs, Frankfurt):

| Scenario | As found | After ladder | Binds first | Binds last |
|---|---|---|---|---|
| S1 retained air | 0 | 0 | tap-off rating | **architecture capability — no capex relieves this** |
| S2 rear-door HX | 0 | 0 | tap-off rating | architecture capability |
| S3 hybrid DLC on legacy plant | 0 | 26 | tap-off rating | firm grid capacity |
| S4 full DLC, high-temperature loop | 0 | **28** | tap-off rating | firm grid capacity |

S4 delivers more racks than S3 for *less* capex, because a better PUE releases grid
capacity back to compute. That is the power↔thermal coupling the product is sold on, and
it falls out of the model rather than being asserted.

## The two mechanisms that make this sellable

1. **`Quantity` cannot be separated from its provenance.** Arithmetic propagates an
   evidence class and takes the minimum, so a model applied to measured data yields a
   modelled number. Report tables reject bare numerals.
2. **The report cannot overstate itself.** `reporting.gates` fails on missing provenance,
   on an evidence class above its inputs, on language asserting measurement over a
   modelled quantity, and — in `ISSUED` mode — on any capacity claim below its evidence
   floor. The reference study runs in `SCREENING` mode and is therefore *required* to
   carry an explicit evidence disclosure; the test suite proves the same report is
   rejected in `ISSUED` mode.

## What it deliberately does not do

- No third-party dependencies (enforced by a test). The engine runs inside a customer's
  air-gapped review.
- No ThermalForge code is imported. The extraction candidates are listed in
  `gridforge/integrations/thermalforge/`; each will land as its own PR with a parity test
  once the repository is audited.
- No DERIM or GridOS migration. Ports only. `tests/test_architecture.py` fails the build
  if any domain module imports `gridforge.integrations`.
- No CFD, no hydraulic network solve, no protection study, no structural assessment.
  These are screening constraints with stated limitations, and the report says so.
- No unpublished platform data. `get_platform("vr200_nvl144")` **raises**, because NVIDIA
  has not published Vera Rubin rack power and a number invented for a sales meeting is
  how an engineering reputation ends.

## Still owed — reconciliation against the audit

This patch was written without access to GridForge-AI, ThermalForge-Liquid-Cooling, DERIM
or GridOS. Before it is merged, the audit must answer `docs/03_TARGET_ARCHITECTURE` §8 and
this patch must be reconciled against it. **Where existing GridForge-AI code already does
any of this and works, the existing code wins and this patch is trimmed to fit.**
Highest-priority audit finding class remains any accuracy claim already in those
repositories that implies measured performance where the number is modelled.

## Suggested merge sequence

Split into the PRs in `docs/03` §7 if you want the history to read cleanly; land as one
commit if you want it in front of a customer this week. Either way the whole thing is one
`git revert` away from gone.
