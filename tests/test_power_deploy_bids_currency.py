"""/v1/power/deploy/bids ranks with the same procurement.rank_bids as the hall comparison, so a bid in another currency is disqualified there too.

#108 fixed the hall comparison (a JPY or USD figure in capex_eur ranked as if it were euros) and left the behind-the-meter route unchecked.
It shares the ranking, so it inherits the fix; this pins that, so a future second ranking path cannot quietly lose it.
"""
from gridforge.api import server as S
from gridforge.api.tiers import Tier

REQUEST = {
    "load_profile": {"csv": "timestamp,kW\n2026-01-01T00:00:00,30000\n2026-01-01T00:15:00,30000\n2026-01-01T00:30:00,30000\n",
                     "source": "synthetic-hall.csv"},
    "grid_firm_MW": 10.0, "target_MW": 35.0, "ride_through_hours": 3.0, "redundancy": "N+1",
    "generation": [
        {"id": "GEN-A", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16_000_000, "lead_time_weeks": 44, "fuel_type": "natural gas"},
        {"id": "GEN-B", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16_000_000, "lead_time_weeks": 44, "fuel_type": "natural gas"},
    ],
    "bess": [{"id": "BESS-1", "power_MW": 8.0, "energy_MWh": 32.0, "capex_eur": 7_200_000, "lead_time_weeks": 30}],
    "interconnection": {"utility": "TenneT", "pcc_voltage_kV": 20, "import_capacity_MW": 15},
    "permitting": {"emissions_status": "application submitted"},
    "architecture": "GRID + BESS + GENERATION", "project": "North Campus",
}


def bids(*offers):
    pkg = S._btm_spec_from_body(REQUEST)
    mandatory = [q.id for q in pkg.mandatory()]
    out = []
    for name, capex, currency in offers:
        d = {"supplier": name, "received_on": "2026-10-01", "valid_until": "2027-12-31",
             "values": {"capex_eur": capex, "lead_time_weeks": 30, "install_weeks": 4}, "compliance": {i: "C" for i in mandatory}}
        if currency:
            d["currency"] = currency
        out.append(d)
    return S.handle_power_deploy_bids({**REQUEST, "responses": out}, Tier.CLIENT)


def test_a_bid_in_another_currency_is_disqualified_and_cannot_lead():
    out = bids(("Euro", 1_000_000, "EUR"), ("Yen", 800_000, "JPY"), ("Dollar", 900_000, "USD"))
    rows = {r["supplier"]: r for r in out["ranked"]}
    assert not rows["Euro"]["disqualified"]
    for name, code in (("Yen", "JPY"), ("Dollar", "USD")):
        assert rows[name]["disqualified"]
        assert any(f"quoted in {code}" in n and "exchange rate" in n for n in rows[name]["notes"])
    assert out["leading"] == "Euro"


def test_euro_and_unstated_currency_still_rank():
    out = bids(("Explicit", 1_000_000, "EUR"), ("Unstated", 1_100_000, None))
    assert not any(r["disqualified"] for r in out["ranked"])
    assert out["leading"] in {"Explicit", "Unstated"}
