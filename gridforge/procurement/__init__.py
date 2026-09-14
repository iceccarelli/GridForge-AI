"""Turning a binding constraint into a thing a supplier can quote against.

A study ends with "the transformer sets the date at 52 weeks". The client then has
to go and buy a transformer, and between the finding and the purchase order sits
three weeks of an engineer writing a specification, arguing about what to ask for,
and comparing four quotations that answer four different questions.

That gap is the product. Every requirement in the specification is derived from a
number the engine already computed, with the constraint it came from named beside
it — so the specification cannot drift from the study, and a supplier who meets it
provably relieves the constraint.

And the responses come back. A returned bid is a dated, attributable price for a
specific relief on a specific project, which is exactly what the cost library is
short of. Every procurement engagement upgrades the evidence class of the figures
that every future study rests on. That is the flywheel: the work that pays for
itself twice.
"""
from .schema import (EvaluationCriterion, Requirement, ResponseField, ScopeItem,
                     SpecPackage, SupplierResponse, ProcurementError)
from .build import build_spec, relief_steps
from .evaluate import BidAssessment, assess, rank_bids
from .ingest import cost_entries_from

__all__ = ["EvaluationCriterion", "Requirement", "ResponseField", "ScopeItem",
           "SpecPackage", "SupplierResponse", "ProcurementError", "build_spec",
           "relief_steps", "BidAssessment", "assess", "rank_bids", "cost_entries_from"]
