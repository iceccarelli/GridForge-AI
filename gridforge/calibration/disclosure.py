"""What the deliverable says about its own accuracy.

This module exists so that one sentence is written once. Every surface — the study,
the screen, the API, the deck — states the same thing about how far this engine has
been reconciled against instrumented sites, and none of them may state it differently.

The uncomfortable case is the default case: n=0. The disclosure is printed anyway.
A report that quietly omits its accuracy record when the record is empty has told the
reader that accuracy is not a question worth asking, which is the opposite of the
discipline this product sells.
"""
from __future__ import annotations

from .keys import all_keys, label
from .ledger import Ledger, load_ledger
from .stats import Calibration, CalibrationState, calibration_for, coverage


def accuracy_block(keys: list[str] | None = None, ledger: Ledger | None = None) -> dict:
    led = ledger or load_ledger()
    ks = keys or all_keys()
    cals = [calibration_for(k, led.observations) for k in ks]
    with_data = [c for c in cals if c.n > 0]
    cov = coverage(led.observations, ks)
    # The overall state is a statement about the MODEL, not about its best output: it reads 'calibrated' only when
    # every output asserted here has met the per-output requirement (n and independent sites). One calibrated
    # output out of twenty is partial coverage, and says so.
    overall = (CalibrationState.CALIBRATED if cals and all(
                   c.state is CalibrationState.CALIBRATED for c in cals)
               else CalibrationState.INDICATIVE if with_data
               else CalibrationState.UNCALIBRATED)
    return {
        "state": overall.value,
        "statement": disclosure_sentence(cov, overall),
        "observations": cov["observations"],
        "observations_total": cov["observations_total"],
        "observations_without_source_ref": cov["observations_without_source_ref"],
        "sites": cov["sites"],
        "halls": cov["halls"],
        "keys_asserted": cov["keys_asserted"],
        "keys_with_site_observations": cov["keys_with_site_observations"],
        "keys_calibrated": cov["keys_calibrated"],
        "coverage": cov["coverage"],
        "keys": [dict(c.to_dict(), label=label(c.key)) for c in with_data],
        "uncalibrated_keys": [c.key for c in cals if c.n == 0],
    }


def disclosure_sentence(cov: dict, overall: CalibrationState) -> str:
    if cov["observations"] == 0:
        return (
            "Model accuracy against instrumented sites has not been established: "
            f"0 reconciled observations across 0 sites, covering 0 of "
            f"{cov['keys_asserted']} model outputs. Every figure in this report is "
            "modelled. The uncertainty ranges shown come from input uncertainty "
            "propagated through the model, not from the difference between this "
            "engine's predictions and site data — no such difference has been "
            "recorded yet.")
    head = (
        f"Model accuracy against instrumented sites: {cov['observations']} reconciled "
        f"observation(s) across {cov['sites']} site(s), covering "
        f"{cov['keys_with_site_observations']} of {cov['keys_asserted']} model outputs "
        f"({cov['coverage'] * 100:.0f}%). ")
    if overall is CalibrationState.CALIBRATED:
        body = overall.sentence
    else:
        body = (
            "Coverage is partial and the model as a whole is not calibrated: "
            f"{cov['keys_calibrated']} of {cov['keys_asserted']} outputs meet the requirement for a quoted "
            "spread (enough observations from enough independent sites). Read every other output as "
            "indicative at most.")
    tail = " Outputs with no observations remain modelled and are listed as such."
    if cov.get("observations_without_source_ref"):
        tail += (f" {cov['observations_without_source_ref']} observation(s) carry no source reference: they were "
                 "entered by hand and cannot be traced to a reviewed artifact.")
    return head + body + tail


def for_constraint(constraint_id: str, ledger: Ledger | None = None) -> Calibration:
    from .keys import constraint_key
    led = ledger or load_ledger()
    return calibration_for(constraint_key(constraint_id), led.observations)


def may_claim_field_validated(keys: list[str], ledger: Ledger | None = None) -> bool:
    """The gate on E6.

    E6_FIELD_VALIDATED means 'our model reconciled against site performance'. It is
    the one evidence class a report can assert about itself rather than about an
    input, and it must be earned per output, not per company.
    """
    led = ledger or load_ledger()
    return all(calibration_for(k, led.observations).state is CalibrationState.CALIBRATED
               for k in keys) and bool(keys)
