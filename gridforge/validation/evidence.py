"""Evidence classes — the machine-checkable version of the validation ladder.

A number's evidence class is a claim about *how much the world has tested it*.
The classes are ordered; arithmetic takes the MINIMUM. See docs/01_PRODUCT_SPEC §6.
"""
from __future__ import annotations

from enum import IntEnum


class EvidenceClass(IntEnum):
    E0_ASSUMPTION = 0            # no data; engineering judgement or library default
    E1_MODEL = 1                 # computed from a documented model on assumed inputs
    E2_SIMULATION = 2            # numerical simulation (hydraulic / thermal network / time series)
    E3_ENGINEERING_ESTIMATE = 3  # model + reviewed by a qualified engineer against practice
    E4_EXPERIMENTAL = 4          # compared against lab / rig / vendor test data
    E5_CUSTOMER_DATA = 5         # customer's own measured trend data, as supplied
    E6_FIELD_VALIDATED = 6       # our model reconciled against measured site performance
    E7_DEPLOYED = 7              # operating outcome observed post-implementation

    @property
    def verb(self) -> str:
        return _VERB[self]

    @property
    def short(self) -> str:
        return self.name.split("_", 1)[0]


_VERB = {
    EvidenceClass.E0_ASSUMPTION: "assumed",
    EvidenceClass.E1_MODEL: "modelled",
    EvidenceClass.E2_SIMULATION: "simulated",
    EvidenceClass.E3_ENGINEERING_ESTIMATE: "estimated",
    EvidenceClass.E4_EXPERIMENTAL: "validated against test data",
    EvidenceClass.E5_CUSTOMER_DATA: "measured at site (customer data)",
    EvidenceClass.E6_FIELD_VALIDATED: "field-validated",
    EvidenceClass.E7_DEPLOYED: "observed in operation",
}

# Minimum evidence class a claim of each kind may carry before it reaches a customer.
# Enforced by gridforge.validation.checks.check_claim_floor.
CLAIM_FLOOR = {
    "electrical_capacity": EvidenceClass.E3_ENGINEERING_ESTIMATE,
    "cooling_performance": EvidenceClass.E2_SIMULATION,
    "capex": EvidenceClass.E1_MODEL,
    "schedule": EvidenceClass.E1_MODEL,
}
