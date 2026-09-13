from __future__ import annotations

from dataclasses import dataclass

from ..constraints import EnvelopeContext
from ..economics.model import EconomicsResult, evaluate
from ..envelope.solver import EnvelopeResult, HeadroomLadder, ladder, solve
from ..thermal.library import PUE_BY_ARCHITECTURE
from .schema import ScenarioSpec


@dataclass
class ScenarioResult:
    spec: ScenarioSpec
    envelope: EnvelopeResult
    ladder: HeadroomLadder
    economics: EconomicsResult
    context: EnvelopeContext

    @property
    def headline_racks(self) -> int:
        return self.envelope.max_racks

    @property
    def unlocked_racks(self) -> int:
        return self.ladder.final.max_racks if self.ladder.final else self.envelope.max_racks


def run(base: EnvelopeContext, spec: ScenarioSpec) -> ScenarioResult:
    ctx = base.copy()
    ctx.architecture = spec.architecture
    ctx.pue = PUE_BY_ARCHITECTURE[spec.architecture]
    if spec.overrides is not None:
        ctx = spec.overrides(ctx)
    env = solve(ctx)
    lad = ladder(ctx)
    econ = evaluate(lad.final or env, lad, ctx.cluster.utilisation)
    return ScenarioResult(spec, env, lad, econ, lad.final_context or ctx)


def run_all(base: EnvelopeContext, specs: list[ScenarioSpec]) -> list[ScenarioResult]:
    return [run(base, s) for s in specs]


def sensitivity(result: ScenarioResult, knobs: dict) -> list[tuple[str, int]]:
    """One-at-a-time sensitivity on the RELIEVED case.

    Run against the as-found case the answer is uniformly zero, because feasibility
    gates dominate; that tells the customer nothing. Run against the post-ladder
    case it tells them which input their answer actually depends on, which is the
    input worth paying to measure.
    """
    out: list[tuple[str, int]] = []
    for label, fn in knobs.items():
        out.append((label, solve(fn(result.context.copy())).max_racks))
    return out
