"""EXEMPLARY REFERENCE PROJECT — SYNTHETIC DATA.

A European colocation hall of the kind described in docs/00 §2: built 2015 at
8 kW/rack, raised floor, legacy 6/12 degC chilled water, 400 A busway, sitting on
a firm grid connection in a metro where new connections are unavailable this
decade. The commercial point of the exercise is that the grid contract is the
asset and the building is the constraint.

NOTHING HERE IS A REAL SITE. No customer, no logo, no implied client.
Run:  python -m examples.reference_site
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from gridforge.common import ASSUMED, CUSTOMER, ESTIMATED, V  # noqa: E402
from gridforge.compute.library import get_platform  # noqa: E402
from gridforge.compute.schema import ClusterSpec  # noqa: E402
from gridforge.constraints import EnvelopeContext  # noqa: E402
from gridforge.power.schema import (GenerationOption, GridConnection, LVDistribution,  # noqa: E402
                                    PowerInput, TransformerBank, UPSBlock)
from gridforge.reporting import GateFailure, run_all_gates, to_html, to_markdown  # noqa: E402
from gridforge.reporting.study import build as build_study, collect_claims  # noqa: E402
from gridforge.scenario import ScenarioSpec, run_all, sensitivity  # noqa: E402
from gridforge.site.schema import FloorType, HallSpec, SiteSpec  # noqa: E402
from gridforge.thermal.library import (CDU_L2L_APPROACH_K, PUE_BY_ARCHITECTURE,  # noqa: E402
                                       TCS_SUPPLY_DESIGN_C)
from gridforge.thermal.schema import Architecture, CDUSpec, PlantSpec, ThermalInput  # noqa: E402

SYNTH = "Synthetic reference data — not a customer asset"


def build_context() -> EnvelopeContext:
    hall = HallSpec(
        id="DH-02",
        build_year=2015,
        floor_type=FloorType.RAISED,
        net_white_space_m2=V(2400, "m2", "hall net white space", CUSTOMER, assumptions=[SYNTH]),
        floor_loading_kPa=V(12, "kPa", "hall design floor loading (TIA-942 Rated-3)", CUSTOMER,
                            assumptions=[SYNTH, "Design value from the building record, not a survey"]),
        clear_height_m=V(3.2, "m", "clear height under containment", CUSTOMER, assumptions=[SYNTH]),
        aisle_pitch_m=V(2.4, "m", "installed aisle pitch", CUSTOMER, assumptions=[SYNTH]),
        rack_positions=560,
        positions_available=180,
        design_density_kW_per_rack=V(8, "kW", "hall design density per rack", CUSTOMER,
                                     assumptions=[SYNTH]),
        containment="cold_aisle",
    )
    site = SiteSpec(
        id="REF-EU-01", name="Reference Colocation Campus", country="DE", metro="Frankfurt",
        design_drybulb_C=V(34, "degC", "summer design dry-bulb temperature", ESTIMATED,
                           band=(32, 36), assumptions=["Nearest TMY station"]),
        design_wetbulb_C=V(21, "degC", "summer design wet-bulb temperature", ESTIMATED, band=(20, 23)),
        halls=[hall],
    )
    power = PowerInput(
        grid=GridConnection(
            dso="Reference DSO",
            firm_capacity_MVA=V(14.0, "MVA", "firm connection capacity", CUSTOMER, assumptions=[SYNTH]),
            power_factor=V(0.97, "1", "site power factor", ESTIMATED, band=(0.95, 0.99)),
            contracted_MW=V(12.0, "MW", "contracted capacity", CUSTOMER, assumptions=[SYNTH]),
            current_site_peak_MW=V(7.4, "MW", "current site peak demand", CUSTOMER,
                                   assumptions=[SYNTH, "12 months of half-hourly metered data"]),
            queue_note=("No new or increased connection capacity is available from the DSO in this "
                        "metro before the 2030s. The existing firm capacity is therefore the asset "
                        "and the entire question is how much compute can be produced from it."),
        ),
        current_it_load_MW=V(4.9, "MW", "current protected IT load", CUSTOMER, assumptions=[SYNTH]),
        transformers=[TransformerBank(
            id="TX-A/B", unit_rating_MVA=V(5.0, "MVA", "transformer unit rating", CUSTOMER,
                                           assumptions=[SYNTH]),
            units=3, redundancy="N+1",
            derating_factor=V(0.9, "1", "transformer derating for ambient and harmonics", ESTIMATED,
                              band=(0.85, 0.95)),
            replacement_lead_time_weeks=V(160, "weeks", "power transformer lead time", ASSUMED,
                                          band=(80, 210)),
        )],
        ups=[UPSBlock(id="UPS-1", unit_rating_kW=V(1200, "kW", "UPS module rating", CUSTOMER,
                                                   assumptions=[SYNTH]),
                      units=6, redundancy="N+1",
                      step_load_capability=V(0.5, "1", "accepted instantaneous step load", ASSUMED,
                                             band=(0.3, 0.7)))],
        lv=LVDistribution(
            voltage_V=V(400, "V", "LV distribution voltage", CUSTOMER, assumptions=[SYNTH]),
            phases=3,
            busway_ampacity_A=V(400, "A", "installed busway ampacity", CUSTOMER,
                                assumptions=[SYNTH, "Legacy 400 A busway; modern AI halls use 800-1000 A"]),
            busway_runs=8,
            busway_utilisation_limit=V(0.8, "1", "continuous-load derating on busway", ESTIMATED),
            tapoff_max_A=V(63, "A", "installed tap-off rating", CUSTOMER, assumptions=[SYNTH]),
        ),
        # Behind-the-meter options available to this site. They appear in the
        # ladder only if firm supply is what binds.
        options=[
            GenerationOption(
                id="BESS-2MW-8MWh", kind="bess",
                capacity_MW=V(2.0, "MW", "battery inverter rating", ASSUMED),
                capex_eur_per_kW=V(900, "EUR/kW", "4-hour BESS installed capex", ASSUMED, band=0.3),
                lead_time_weeks=V(30, "weeks", "BESS delivery and commissioning", ASSUMED,
                                  band=(20, 48)),
                firm=True,
                firm_capacity_factor=V(0.50, "1", "BESS firm factor over the required window",
                                       ASSUMED, band=(0.3, 0.6),
                                       assumptions=["8 MWh over an 8 h ride-through window gives "
                                                    "1 MW sustained against a 2 MW inverter"]),
                permitting_note="No combustion consent required; grid-code compliance and fire "
                                "separation govern the programme.",
            ),
            GenerationOption(
                id="GEN-5MW", kind="gas_engine",
                capacity_MW=V(5.0, "MW", "gas engine plant rating", ASSUMED),
                capex_eur_per_kW=V(800, "EUR/kW", "reciprocating engine installed capex", ASSUMED,
                                   band=0.35),
                lead_time_weeks=V(44, "weeks", "engine delivery, civils and commissioning", ASSUMED,
                                  band=(32, 70)),
                firm=True,
                opex_eur_per_MWh=V(95, "EUR/MWh", "fuel and maintenance", ASSUMED, band=0.4),
                permitting_note="Emissions consent and fuel supply are the schedule risk, not the "
                                "equipment. Confirm the permitting route before quoting this date.",
            ),
        ],
    )
    thermal = ThermalInput(
        plant=PlantSpec(
            id="CH-PLANT",
            chilled_water_capacity_kW=V(6800, "kW", "chilled-water plant capacity", CUSTOMER,
                                        assumptions=[SYNTH]),
            design_supply_C=V(6, "degC", "plant chilled-water supply temperature", CUSTOMER,
                              assumptions=[SYNTH, "Legacy low-temperature plant"]),
            design_return_C=V(12, "degC", "plant chilled-water return temperature", CUSTOMER,
                              assumptions=[SYNTH]),
            pump_flow_capacity_l_per_min=V(9000, "l/min", "available pumped flow to the hall",
                                           ESTIMATED, band=0.15),
            available_head_kPa=V(250, "kPa", "available pump head", ESTIMATED, band=0.2),
            free_cooling_hours_per_year=V(2600, "h", "free cooling hours at legacy temperatures",
                                          ESTIMATED, band=0.2),
            dry_cooler_capacity_kW=V(0, "kW", "installed dry cooler capacity", CUSTOMER,
                                     assumptions=[SYNTH, "None installed"]),
            dry_cooler_approach_K=None,
        ),
        tcs_target_supply_C=TCS_SUPPLY_DESIGN_C,
        cdu_approach_K=CDU_L2L_APPROACH_K,
        residual_air_capacity_kW_per_rack=V(9, "kW", "air removal capacity per rack position",
                                            ESTIMATED, band=(7, 12),
                                            assumptions=["Derived from hall design density and "
                                                         "containment; confirm by measurement"]),
        flow_l_per_min_per_kW=V(1.45, "l/min/kW", "TCS flow per kW at 10 K delta-T", ASSUMED,
                                band=(1.4, 1.5)),
        cdus=[],
    )
    cluster = ClusterSpec(
        platform=get_platform("gb300_nvl72"),
        utilisation=V(0.75, "1", "annual average utilisation of rack power", ASSUMED, band=(0.6, 0.9)),
    )
    return EnvelopeContext(site=site, hall=hall, power=power, thermal=thermal, cluster=cluster,
                           architecture=Architecture.HYBRID_DLC,
                           pue=PUE_BY_ARCHITECTURE[Architecture.HYBRID_DLC])


def _no_btm(c: EnvelopeContext) -> EnvelopeContext:
    """Grid-only counterfactual: the site as it would be assessed by anyone who
    does not sell behind-the-meter supply."""
    c = c.copy()
    c.power.options = []
    return c


def _with_cdus(c: EnvelopeContext) -> EnvelopeContext:
    c = c.copy()
    c.thermal.cdus = [CDUSpec(
        id="CDU-ROW", rated_capacity_kW=V(1350, "kW", "row CDU rated capacity", ASSUMED, band=0.1),
        rated_approach_K=V(5, "K", "CDU rated approach", ASSUMED),
        rated_flow_l_per_min=V(2000, "l/min", "CDU rated flow", ASSUMED),
        units=3, redundancy="N+1")]
    return c


def _full_dlc_btm(c: EnvelopeContext) -> EnvelopeContext:
    """Full DLC with the behind-the-meter options left available."""
    return _full_dlc(c)


def _full_dlc(c: EnvelopeContext) -> EnvelopeContext:
    c = _with_cdus(c)
    c.thermal.plant.dry_cooler_approach_K = V(10, "K", "dry cooler approach to dry bulb", ASSUMED,
                                              band=(8, 12))
    c.thermal.plant.dry_cooler_capacity_kW = V(9000, "kW", "new high-temperature dry cooler bank",
                                               ASSUMED, band=0.15)
    return c


SCENARIOS = [
    ScenarioSpec("s1_air", "S1 — retained air, grid only", Architecture.RETAINED_AIR,
                 "Do nothing to the cooling architecture. Establishes the counterfactual.",
                 overrides=_no_btm),
    ScenarioSpec("s2_rdhx", "S2 — rear-door heat exchangers, grid only", Architecture.RDHX,
                 "Lowest disruption path; keeps the legacy plant but lifts per-rack capability.",
                 overrides=_no_btm),
    ScenarioSpec("s3_hybrid", "S3 — hybrid DLC on retained plant, grid only", Architecture.HYBRID_DLC,
                 "Direct-to-chip for the chip load with the existing plant carrying both the liquid "
                 "and the residual air load. Cheapest route to high density, worst energy outcome.",
                 overrides=lambda c: _no_btm(_with_cdus(c))),
    ScenarioSpec("s4_full", "S4 — full DLC, grid only", Architecture.FULL_DLC,
                 "Dedicated warm-water loop and dry coolers for the chip load, legacy plant retained "
                 "only for the residual air load. Bounded by the grid connection, because no "
                 "additional firm supply is available in this metro this decade.",
                 overrides=lambda c: _no_btm(_full_dlc(c))),
    ScenarioSpec("s5_full_btm", "S5 — full DLC plus behind-the-meter supply", Architecture.FULL_DLC,
                 "The same hall, with on-site firm supply added where the grid connection binds. "
                 "This is the only scenario in which the site's capacity is set by what can be "
                 "built rather than by the interconnection queue.",
                 overrides=_full_dlc_btm),
]

def _sens_rack_kW(c):
    import dataclasses
    c = c.copy()
    c.cluster.platform = dataclasses.replace(
        c.cluster.platform,
        rack_kW=V(142, "kW", "platform rack power sensitivity 142 kW", ASSUMED))
    return c


SENSITIVITIES = {
    "Liquid capture fraction at 0.85 (vs 0.90)": lambda c: _sens_liquid(c, 0.85),
    "Liquid capture fraction at 0.92": lambda c: _sens_liquid(c, 0.92),
    "Busway at 800 A rather than 1000 A": lambda c: _sens_busway(c, 800),
    "Per-position air capacity at 20 kW": lambda c: _sens_air(c, 20),
    "Contracted power reduced to 10 MW": lambda c: _sens_contract(c, 10.0),
    "PUE 10% worse than assumed": lambda c: _sens_pue(c, 1.1),
    "PUE 10% better than assumed": lambda c: _sens_pue(c, 0.9),
    "Platform at 142 kW rather than 135 kW": lambda c: _sens_rack_kW(c),
    "Contracted power raised to 14 MW (full firm capacity)": lambda c: _sens_contract(c, 14.0),
}



def _sens_liquid(c, f):
    c = c.copy()
    import dataclasses
    c.cluster.platform = dataclasses.replace(
        c.cluster.platform,
        liquid_fraction=V(f, "1", f"liquid capture fraction sensitivity {f}", ASSUMED))
    return c


def _sens_busway(c, a):
    c = c.copy()
    c.power.lv.busway_ampacity_A = V(a, "A", f"busway ampacity sensitivity {a} A", ASSUMED)
    return c


def _sens_air(c, k):
    c = c.copy()
    c.thermal.residual_air_capacity_kW_per_rack = V(k, "kW", f"air capacity sensitivity {k} kW", ASSUMED)
    return c


def _sens_contract(c, mw):
    c = c.copy()
    c.power.grid.contracted_MW = V(mw, "MW", f"contracted power sensitivity {mw} MW", ASSUMED)
    return c


def _sens_pue(c, f):
    c = c.copy()
    c.pue = c.pue * V(f, "1", f"PUE sensitivity factor {f}", ASSUMED)
    return c


def main() -> int:
    ctx = build_context()
    results = run_all(ctx, SCENARIOS)
    from gridforge.reporting.study import Objective, _pick_recommended
    rec = _pick_recommended(results, Objective.MAX_COMPUTE)
    sens = sensitivity(rec, SENSITIVITIES)
    report = build_study(ctx, results, sens, client="Reference Project (synthetic)")

    md = to_markdown(report)
    html = to_html(report)
    run_all_gates(report, md, claims=collect_claims(results))

    out = pathlib.Path(__file__).resolve().parents[1] / "out"
    out.mkdir(exist_ok=True)
    (out / "reference_study.md").write_text(md)
    (out / "reference_study.html").write_text(html)
    (out / "reference_study.body.html").write_text(to_html(report, full_document=False))

    print(f"Recommended: {rec.spec.name}")
    for r in results:
        print(f"  {r.spec.id:10s} as-found {r.headline_racks:4d} racks  "
              f"after-ladder {r.unlocked_racks:4d} racks  "
              f"binding {r.envelope.binding.id:22s} capex {r.economics.capex_total_eur.value/1e6:6.2f} MEUR")
    print(f"\nWrote {out/'reference_study.md'} and {out/'reference_study.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
