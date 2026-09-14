"""How wrong the model is, stated as a number, per constraint.

Physics can be copied. A record of where this engine's predictions landed against
instrumented sites cannot — it accrues one hall at a time and it is the only thing
in the product that a competent engineer with three months cannot reproduce.

The ledger is also the honest end of the evidence ladder. E6_FIELD_VALIDATED is a
claim about reconciliation against site data, and no output may carry it unless
there are observations here to support it. With an empty ledger the correct answer
is "uncalibrated, n=0" printed in the deliverable — which is itself a differentiator,
because the alternative is silence and silence reads as accuracy.
"""
from .schema import Observation, ObservationError
from .stats import Calibration, CalibrationState, summarise, calibration_for
from .ledger import Ledger, load_ledger, append_observation
from .keys import all_keys, constraint_key, label
from .disclosure import accuracy_block, for_constraint, may_claim_field_validated

__all__ = ["Observation", "ObservationError", "Calibration", "CalibrationState",
           "summarise", "calibration_for", "Ledger", "load_ledger", "append_observation",
           "all_keys", "constraint_key", "label", "accuracy_block", "for_constraint",
           "may_claim_field_validated"]
