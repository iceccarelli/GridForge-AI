from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from ..constraints import EnvelopeContext
from ..thermal.schema import Architecture


@dataclass
class ScenarioSpec:
    """A scenario is DATA: a name, an architecture, and a set of overrides.
    Scenarios are never code branches inside a model."""
    id: str
    name: str
    architecture: Architecture
    rationale: str
    overrides: Callable[[EnvelopeContext], EnvelopeContext] | None = field(default=None, repr=False)
