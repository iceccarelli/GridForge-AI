"""The keyed site reference (gridforge/calibration/siteref.py), its parity with the website (lib/site-ref.ts), and the mixed-reference handling of the CLI.

No database. tests/site_ref_vectors.json is read by BOTH this file and tests/site/site-ref.test.ts: each must reproduce every vector, so the TypeScript
and Python implementations cannot drift apart without a test failing. Every key, label and digest here is a SYNTHETIC fixture; no key is ever printed.
"""
import hashlib
import hmac as stdlib_hmac
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.calibration import Observation, ObservationError, siteref
from gridforge.calibration.ledger import EXPORT_SCHEMA, append_observation, import_export, load_ledger, read_chain
from gridforge.calibration.schema import SITE_REF_RE, site_only_ref
from gridforge.validation.evidence import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
_VECTOR_FILE = json.loads((ROOT / "tests" / "site_ref_vectors.json").read_text())
VECTORS, KEY_VECTORS = _VECTOR_FILE["vectors"], _VECTOR_FILE["key_vectors"]
K1, K2 = "vector-key-one-0123456789abcdef", "vector-key-two-0123456789abcdef"
SHA, DIGEST = "b" * 64, "a" * 64


def keyed(label, key=K1):
    return siteref.keyed_site_only_ref(label, key)


# ---------------------------------------------------------------------------------------------------- parity with the website

def test_every_shared_vector_is_reproduced():
    assert len(VECTORS) >= 50 and {v["key"] for v in VECTORS} == {K1, K2}
    assert any(v["expected"] is None for v in VECTORS) and any(v["expected"] for v in VECTORS)
    for v in VECTORS:
        if v["expected"] is None:
            with pytest.raises(siteref.SiteRefError):
                keyed(v["label"], v["key"])
        else:
            assert keyed(v["label"], v["key"]) == v["expected"], repr(v["label"])[:60]


def test_the_vectors_were_not_made_with_this_module_alone():
    """An independent restatement of the algorithm (stdlib hmac and unicodedata, no helper from the module under test) agrees with the file."""
    import re
    import unicodedata
    edge = re.compile("^[\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$")
    for v in VECTORS:
        if v["expected"] is not None:
            n = unicodedata.normalize("NFC", edge.sub("", v["label"]))
            n = "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in n)          # ASCII letters only
            n = n.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
            assert v["expected"] == "site_" + stdlib_hmac.new(v["key"].encode(), b"site\x00" + n.encode(), hashlib.sha256).hexdigest()[:12]


def test_the_key_length_rule_counts_code_points_as_the_website_does():
    for kv in KEY_VECTORS:
        key, source = siteref.resolve_key({"GRIDFORGE_SITE_REF_SECRET": kv["secret"], "GRIDFORGE_KEY_SECRET": "signing"})
        assert (source == siteref.ENV_DEDICATED) is kv["accepted"], kv["secret"][:6]
    assert {kv["accepted"] for kv in KEY_VECTORS} == {True, False} and any(len(kv["secret"].encode("utf-16-le")) // 2 != len(kv["secret"]) for kv in KEY_VECTORS)


def test_the_site_message_is_domain_separated_from_the_hall_suffix():
    n = siteref.normalise_label("Dublin DC1")
    plain = "site_" + stdlib_hmac.new(K1.encode(), n.encode(), hashlib.sha256).hexdigest()[:12]
    assert keyed("Dublin DC1") != plain                                               # keyed over "site\0" + label, not the bare label
    assert keyed("Dublin DC1") == "site_" + stdlib_hmac.new(K1.encode(), b"site\x00" + n.encode(), hashlib.sha256).hexdigest()[:12]


def test_normalisation_is_nfc_and_ascii_lowercase_only_and_the_consequence_is_the_stated_one():
    assert keyed("Fr\u00e1ncfort") == keyed("Fra\u0301ncfort")                         # composed and decomposed: one label
    assert keyed("Ab\u00c7") != keyed("ab\u00e7")                                       # a NON-ASCII letter's case is a different site (stated consequence)
    assert keyed("\U00010d50 x") == keyed("\U00010d50 X")                               # a Unicode-16 letter is untouched, so Python 3.11-3.13 and Node agree
    assert siteref.normalise_label("  \u0130STANBUL ") == "\u0130stanbul"


def test_a_different_secret_gives_a_different_reference_and_the_same_secret_a_stable_one():
    for label in ("Hall A", "Dublin DC1", "x"):
        assert keyed(label, K1) == keyed(label, K1)
        assert keyed(label, K1) != keyed(label, K2)
        assert keyed(label, K1) != site_only_ref(label)          # not the old bare hash
    assert keyed("Hall A", K1) != keyed("Hall B", K1)


def test_case_and_surrounding_whitespace_do_not_make_a_new_site_but_inner_changes_do():
    base = keyed("Dublin DC1")
    for spelling in ("dublin dc1", "DUBLIN DC1", "  Dublin DC1  ", "\tDublin DC1\n", " Dublin DC1　", "﻿Dublin DC1 "):
        assert keyed(spelling) == base, repr(spelling)
    for other in ("Dublin  DC1", "Dublin-DC1", "DublinDC1", "Dublin DC 1"):
        assert keyed(other) != base, repr(other)


def test_the_format_is_site_and_twelve_lowercase_hex_and_is_what_the_database_accepts():
    for v in VECTORS:
        if v["expected"]:
            assert siteref.SITE_ONLY_RE.match(v["expected"]) and SITE_REF_RE.match(v["expected"])
    assert not siteref.SITE_ONLY_RE.match("site_0123456789AB") and not siteref.SITE_ONLY_RE.match("site_0123456789ab\n")
    # "$" in a Python regex also matches before a trailing newline: a reference with one must not pass any of the three validators
    from gridforge.calibration import records
    for hostile in ("site_0123456789ab\n", "site_0123456789ab-01234567\n"):
        assert not SITE_REF_RE.match(hostile) and not records._SITE_RE.match(hostile)
    assert siteref.keyed_site_ref("Dublin DC1", "DH-02", K1).startswith(keyed("Dublin DC1") + "-")
    assert SITE_REF_RE.match(siteref.keyed_site_ref("Dublin DC1", "DH-02", K1))


@pytest.mark.parametrize("label", ["", "   ", "\t\n", " 　"])
def test_an_empty_label_has_no_reference(label):
    with pytest.raises(siteref.SiteRefError):
        keyed(label)


@pytest.mark.parametrize("label", [
    "'; drop table projects; --", "<script>alert(1)</script>", "a\x00b", "‮Hall A", "x" * 100_000, "\U0001F3ED" * 500, "\ud800", "Hall A\u0000", "../../etc/passwd",
    "%s%s%s%n", "{{7*7}}", "İİİ", "ﬃ" * 50,
])
def test_hostile_labels_give_a_well_formed_reference_or_a_clean_refusal_never_a_crash_or_a_leak(label):
    ref = keyed(label)
    assert siteref.SITE_ONLY_RE.match(ref)
    assert label[:20] not in ref and len(ref) == 17


@pytest.mark.parametrize("bad", [None, 5, b"x", ["x"], {"a": 1}])
def test_a_label_that_is_not_text_is_refused(bad):
    with pytest.raises(siteref.SiteRefError):
        siteref.normalise_label(bad)


def test_the_hall_suffix_is_keyed_normalised_and_domain_separated_from_the_site_part():
    a = siteref.keyed_site_ref("Dublin DC1", "DH-02", K1)
    assert a == siteref.keyed_site_ref(" dublin dc1 ", " dh-02 ", K1)
    assert a != siteref.keyed_site_ref("Dublin DC1", "DH-03", K1) and a != siteref.keyed_site_ref("Dublin DC1", "DH-02", K2)
    assert a.split("-", 1)[1] != hashlib.sha256(b"dublin dc1|dh-02").hexdigest()[:8]           # not the old guessable suffix
    assert siteref.keyed_site_ref("a", "b|c", K1) != siteref.keyed_site_ref("a|b", "c", K1)    # the separator cannot be smuggled into a label
    with pytest.raises(siteref.SiteRefError):
        siteref.keyed_site_ref("Dublin DC1", "  ", K1)


# ---------------------------------------------------------------------------------------------------- which key

def test_key_resolution_order_and_what_is_said_about_it():
    long = "d" * 20
    assert siteref.resolve_key({"GRIDFORGE_SITE_REF_SECRET": long, "GRIDFORGE_KEY_SECRET": "signing"}) == (long, siteref.ENV_DEDICATED)
    assert siteref.resolve_key({"GRIDFORGE_SITE_REF_SECRET": "short", "GRIDFORGE_KEY_SECRET": "signing"}) == ("signing", siteref.ENV_SIGNING)
    assert siteref.resolve_key({"GRIDFORGE_KEY_SECRET": "signing"}) == ("signing", siteref.ENV_SIGNING)
    assert siteref.resolve_key({}) == (siteref.FALLBACK_KEY, "fallback")
    assert siteref.resolve_key({"GRIDFORGE_SITE_REF_SECRET": "", "GRIDFORGE_KEY_SECRET": ""}) == (siteref.FALLBACK_KEY, "fallback")
    assert siteref.key_warning(siteref.ENV_DEDICATED) is None
    assert "PUBLIC" in siteref.key_warning("fallback") and "rotated" in siteref.key_warning(siteref.ENV_SIGNING)
    for source in ("fallback", siteref.ENV_SIGNING):
        assert "rotat" in (siteref.key_warning(source) or "").lower() or source == "fallback"


def test_the_fallback_key_is_the_one_the_website_uses():
    ts = (ROOT / "lib" / "site-ref.ts").read_text()
    assert f'"{siteref.FALLBACK_KEY}"' in ts
    assert f"SITE_REF_SECRET_MIN = {siteref.SECRET_MIN}" in ts
    assert "GRIDFORGE_SITE_REF_SECRET" in ts and "GRIDFORGE_KEY_SECRET" in ts


# ---------------------------------------------------------------------------------------------------- the CLI

def run_cli(*args, env=None):
    base = {k: v for k, v in os.environ.items() if k not in ("GRIDFORGE_SITE_REF_SECRET", "GRIDFORGE_KEY_SECRET", "GRIDFORGE_SITE_REF_ALIASES", "GRIDFORGE_CALIBRATION_LEDGER")}
    r = subprocess.run([sys.executable, "-m", "gridforge", *args], cwd=ROOT, capture_output=True, text=True, env={**base, **(env or {})})
    assert "Traceback" not in r.stderr, r.stderr
    return r


ADD = ["calibrate", "add", "--key", "envelope.racks", "--hall", "DH-02", "--predicted", "26", "--observed", "24", "--unit", "racks", "--on", "2026-06-30",
       "--method", "half-hourly metering"]


def ledger_sites(path):
    return [o.site_ref for o in read_chain(path)[0]]


def test_calibrate_add_records_the_keyed_reference_the_website_would_compute(tmp_path):
    led = tmp_path / "ledger.json"
    r = run_cli(*ADD, "--site", "Dublin DC1", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert r.returncode == 0, r.stderr
    (ref,) = ledger_sites(led)
    assert ref == siteref.keyed_site_ref("Dublin DC1", "DH-02", K1)
    assert ref.split("-")[0] == keyed("Dublin DC1") and ref.split("-")[0] != site_only_ref("Dublin DC1")
    assert K1 not in r.stdout + r.stderr and "warning" not in r.stderr          # the dedicated secret: no warning, and the secret is never printed


@pytest.mark.parametrize("env,needle", [({}, "PUBLIC fallback"), ({"GRIDFORGE_KEY_SECRET": "signing-secret-not-real"}, "rotated")])
def test_calibrate_add_says_when_the_key_is_not_the_dedicated_one_and_never_prints_it(tmp_path, env, needle):
    r = run_cli(*ADD, "--site", "Dublin DC1", "--ledger", str(tmp_path / "l.json"), env=env)
    assert r.returncode == 0 and needle in r.stderr
    for secret in env.values():
        assert secret not in r.stdout + r.stderr


def test_a_different_secret_makes_a_different_site_so_calibrate_add_does_not_merge_them_silently(tmp_path):
    led = tmp_path / "ledger.json"
    assert run_cli(*ADD, "--site", "Dublin DC1", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1}).returncode == 0
    assert run_cli(*ADD, "--site", "Dublin DC1", "--on", "2026-07-30", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K2}).returncode == 0
    assert len({r.split("-")[0] for r in ledger_sites(led)}) == 2         # a rotation: a new site, as documented


def test_calibrate_add_refuses_to_write_a_keyed_reference_beside_the_same_sites_unsalted_one(tmp_path):
    led = tmp_path / "ledger.json"
    append_observation(Observation(key="envelope.racks", site_ref=site_only_ref("Dublin DC1") + "-0123abcd", predicted=26.0, observed=24.0, unit="racks",
                                   observed_on="2026-05-30", evidence=EvidenceClass.E5_CUSTOMER_DATA, method="metering"), led)
    r = run_cli(*ADD, "--site", "Dublin DC1", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert r.returncode == 2 and "UNSALTED" in r.stderr and "calibrate alias" in r.stderr
    assert len(ledger_sites(led)) == 1                                                         # nothing was written
    # declared once, it goes through, and the ledger reads the two as one site
    a = run_cli("calibrate", "alias", "--site", "Dublin DC1", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert a.returncode == 0, a.stderr
    assert run_cli(*ADD, "--site", "Dublin DC1", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1}).returncode == 0
    env = {"GRIDFORGE_CALIBRATION_LEDGER": str(led)}
    assert len({o.site for o in _load(led)}) == 1


def _load(led):
    old = os.environ.get("GRIDFORGE_CALIBRATION_LEDGER")
    os.environ["GRIDFORGE_CALIBRATION_LEDGER"] = str(led)
    try:
        return load_ledger().observations
    finally:
        if old is None:
            del os.environ["GRIDFORGE_CALIBRATION_LEDGER"]
        else:
            os.environ["GRIDFORGE_CALIBRATION_LEDGER"] = old


def test_calibrate_add_still_refuses_what_it_always_refused(tmp_path):
    led = str(tmp_path / "l.json")
    assert run_cli("calibrate", "add", "--key", "envelope.racks", "--ledger", led).returncode == 2                      # no site/hall
    r = run_cli(*ADD, "--site", "   ", "--ledger", led)
    assert r.returncode == 2 and "Traceback" not in r.stderr and not Path(led).exists()


# ---------------------------------------------------------------------------------------------------- aliases and the importer

def export_row(n, ref, on):
    return {"id": f"{n:08x}-0000-0000-0000-000000000000", "key": "btm.firm_MW", "observed_value": 28.5, "predicted_value": 30.0, "unit": "MW", "site_ref": ref,
            "measurement_kind": "metered", "evidence_sha256": SHA, "engine_provenance_digest": DIGEST, "report_date": "2026-03-01", "observed_on": on,
            "method": "revenue-grade metering", "evidence_class": "E5", "reviewed_by": "J. Ortiz", "reviewed_at": "2026-07-01T10:00:00+00:00"}


LEGACY, KEYED = site_only_ref("Cork DC2"), keyed("Cork DC2")


def export(*rows):
    return {"schema": EXPORT_SCHEMA, "rows": list(rows)}


def test_without_a_declaration_the_two_references_are_two_sites_and_the_importer_says_so(tmp_path):
    led, ex = tmp_path / "ledger.json", tmp_path / "export.json"
    ex.write_text(json.dumps(export(export_row(1, LEGACY, "2026-05-01"), export_row(2, KEYED, "2026-06-01"))))
    r = run_cli("calibrate", "import", str(ex), "--ledger", str(led), "--accept-mixed-refs")
    assert r.returncode == 0, r.stderr
    assert len({o.site for o in read_chain(led)[0]}) == 2                          # as the data stands: honest, not merged by guesswork
    assert "UNSALTED" in r.stderr and "calibrate alias" in r.stderr and "TWO sites" in r.stderr
    assert "counted as: 2 distinct site reference(s)" in r.stdout and "0 of 2 row(s) re-keyed" in r.stdout


def test_a_declared_alias_makes_the_importer_store_one_site_and_read_old_rows_as_that_site_too(tmp_path):
    led, ex = tmp_path / "ledger.json", tmp_path / "export.json"
    # an OLD import already in the ledger under the unsalted reference
    first = tmp_path / "first.json"
    first.write_text(json.dumps(export(export_row(1, LEGACY, "2026-05-01"))))
    assert run_cli("calibrate", "import", str(first), "--ledger", str(led), "--accept-mixed-refs").returncode == 0
    a = run_cli("calibrate", "alias", "--site", "  cork dc2 ", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert a.returncode == 0 and LEGACY in a.stdout and KEYED in a.stdout, a.stderr
    assert K1 not in a.stdout + a.stderr
    again = run_cli("calibrate", "alias", "--site", "Cork DC2", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert again.returncode == 0 and "already recorded" in again.stdout
    # a LATER import carries both forms
    ex.write_text(json.dumps(export(export_row(2, LEGACY, "2026-06-01"), export_row(3, KEYED, "2026-07-01"))))
    r = run_cli("calibrate", "import", str(ex), "--ledger", str(led))
    assert r.returncode == 0, r.stderr
    assert "1 of 2 row(s) re-keyed" in r.stdout and "1 alias(es) declared" in r.stdout
    stored = [o.site_ref for o in read_chain(led)[0]]
    assert stored == [LEGACY, KEYED, KEYED]                           # the old row is NOT edited (the chain stands); the new legacy row was stored keyed
    assert {o.site for o in _load(led)} == {KEYED}                   # and the ledger reads all three as one site
    c = [o for o in read_chain(led)[0] if "re-keyed" in o.note]
    assert len(c) == 1


def test_the_same_measurement_under_both_references_is_not_counted_twice_once_declared(tmp_path):
    led = tmp_path / "ledger.json"
    assert run_cli("calibrate", "alias", "--site", "Cork DC2", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1}).returncode == 0
    import_export(export(export_row(1, LEGACY, "2026-05-01")), led)
    with pytest.raises(ObservationError, match="already recorded"):
        import_export(export(export_row(2, KEYED, "2026-05-01")), led)
    assert len(read_chain(led)[0]) == 1


def test_the_importer_works_with_both_reference_formats_and_with_hall_suffixed_ones(tmp_path):
    led = tmp_path / "ledger.json"
    out = import_export(export(export_row(1, LEGACY, "2026-05-01"), export_row(2, KEYED, "2026-05-01")), led, accept_mixed_refs=True)
    assert out["imported"] == 2 and out["rekeyed"] == 0
    assert SITE_REF_RE.match(KEYED) and SITE_REF_RE.match(KEYED + "-0123abcd")
    bad = export(export_row(3, "site_NOT-HEX", "2026-05-02"))
    with pytest.raises(ObservationError):
        import_export(bad, led, accept_mixed_refs=True)
    assert len(read_chain(led)[0]) == 2


def test_alias_file_validation_refuses_anything_that_could_merge_the_wrong_sites(tmp_path):
    p = tmp_path / siteref.ALIAS_FILENAME
    for body in ("not json", "[]", json.dumps({"schema": "other", "aliases": {}}), json.dumps({"schema": siteref.ALIAS_SCHEMA, "aliases": {"x": "y"}}),
                 json.dumps({"schema": siteref.ALIAS_SCHEMA, "aliases": {LEGACY: LEGACY}}),
                 json.dumps({"schema": siteref.ALIAS_SCHEMA, "aliases": {"site_aaaaaaaaaaaa": "site_bbbbbbbbbbbb", "site_bbbbbbbbbbbb": "site_cccccccccccc"}})):
        p.write_text(body)
        with pytest.raises(siteref.SiteRefError):
            siteref.read_aliases(p)
    p.unlink()
    assert siteref.read_aliases(p) == {}
    assert siteref.add_alias(p, LEGACY, KEYED) is True and siteref.add_alias(p, LEGACY, KEYED) is False
    for legacy, keyed_ref in ((LEGACY, "site_cccccccccccc"), ("site_dddddddddddd", LEGACY), (KEYED, "site_eeeeeeeeeeee")):
        with pytest.raises(siteref.SiteRefError):
            siteref.add_alias(p, legacy, keyed_ref)                    # a conflict, a chain: nothing is written
    with pytest.raises(siteref.SiteRefError):
        siteref.add_alias(p, LEGACY, LEGACY)
    assert siteref.read_aliases(p) == {LEGACY: KEYED}


def test_a_corrupt_alias_file_stops_the_import_instead_of_guessing(tmp_path):
    led, ex = tmp_path / "ledger.json", tmp_path / "export.json"
    (tmp_path / siteref.ALIAS_FILENAME).write_text("{ broken")
    ex.write_text(json.dumps(export(export_row(1, LEGACY, "2026-05-01"))))
    for extra in ([], ["--accept-mixed-refs"]):                                      # not even the explicit flag lets a corrupt file through
        r = run_cli("calibrate", "import", str(ex), "--ledger", str(led), *extra)
        assert r.returncode != 0 and "alias" in r.stderr.lower()
        assert not led.exists()


def test_calibrate_alias_needs_a_site_and_where_reports_the_count(tmp_path):
    led = str(tmp_path / "ledger.json")
    assert run_cli("calibrate", "alias", "--ledger", led).returncode == 2
    assert run_cli("calibrate", "alias", "--site", "   ", "--ledger", led).returncode == 2
    assert run_cli("calibrate", "alias", "--site", "Cork DC2", "--ledger", led, env={"GRIDFORGE_SITE_REF_SECRET": K1}).returncode == 0
    r = run_cli("calibrate", "where", env={"GRIDFORGE_CALIBRATION_LEDGER": led})
    assert r.returncode == 0 and "aliases declared" in r.stdout and r.stdout.rstrip().splitlines()[-1] != ""
    assert "1" in [l for l in r.stdout.splitlines() if "aliases declared" in l][0]


def test_the_environment_check_warns_when_the_dedicated_secret_is_unset_or_too_short(tmp_path):
    base = {"ADMIN_PASSWORD": "x" * 14}
    for env, expect in (({}, "unset"), ({"GRIDFORGE_SITE_REF_SECRET": "short"}, "shorter than 16"), ({"GRIDFORGE_SITE_REF_SECRET": "z" * 20}, None)):
        f = tmp_path / "e.env"
        f.write_text("\n".join(f"{k}={v}" for k, v in {**base, **env}.items()))
        r = subprocess.run(["node", str(ROOT / "scripts" / "check-env.mjs"), "--json", str(f)], capture_output=True, text=True, timeout=30)
        doc = json.loads(r.stdout)
        names = [w["name"] for w in doc["warnings"]]
        if expect is None:
            assert "GRIDFORGE_SITE_REF_SECRET" not in names
        else:
            (w,) = [w for w in doc["warnings"] if w["name"] == "GRIDFORGE_SITE_REF_SECRET"]
            assert expect in w["reason"]
        assert "zzzz" not in r.stdout                                                  # a value is never printed
        assert "GRIDFORGE_SITE_REF_SECRET" not in [p["name"] for p in doc["problems"]]  # optional: a warning, never a failure


# ---------------------------------------------------------------------------------------------------- "$" accepts a trailing newline

def test_no_validator_in_the_calibration_package_accepts_a_trailing_newline():
    """In a Python regex "$" also matches before a final newline, so an identifier ending in one would pass a "^...$" check and be stored. Every anchored
    pattern in gridforge/calibration now ends in \\Z; each one is shown to refuse the newline-suffixed form of a value it accepts."""
    from gridforge.calibration import ledger, records, schema
    good = {
        (schema, "KEY_RE"): "envelope.racks", (schema, "SITE_REF_RE"): "site_0123456789ab-01234567", (schema, "SHA256_RE"): "a" * 64,
        (schema, "SOURCE_REF_RE"): "obs-0001-" + "x" * 3 + ":" + "b" * 64, (records, "_ID_RE"): "obs-0001", (records, "_SITE_RE"): "site_0123456789ab",
        (records, "_HALL_RE"): "DH-02", (records, "_VERSION_RE"): "1.2.3", (ledger, "_UUID_RE"): "00000001-0000-0000-0000-000000000000",
        (siteref, "SITE_ONLY_RE"): "site_0123456789ab",
    }
    for (mod, name), value in good.items():
        rx = getattr(mod, name)
        assert rx.match(value), (name, value)
        for hostile in (value + "\n", value + "\r\n", value + "\n\n"):
            assert not rx.match(hostile), (name, hostile)
    source = "\n".join(p.read_text() for p in (ROOT / "gridforge" / "calibration").glob("*.py"))
    import re
    assert not re.search(r're\.compile\(r?"\^[^"\n]*[^\\]\$"\)', source), "an anchored pattern ends in a bare $"


# ---------------------------------------------------------------------------------------------------- the conservative default for mixed references

def test_import_refuses_by_default_writes_nothing_and_says_what_it_would_have_counted(tmp_path):
    led, ex = tmp_path / "ledger.json", tmp_path / "export.json"
    ex.write_text(json.dumps(export(export_row(1, LEGACY, "2026-05-01"), export_row(2, KEYED, "2026-06-01"), export_row(3, KEYED, "2026-07-01"))))
    r = run_cli("calibrate", "import", str(ex), "--ledger", str(led))
    assert r.returncode == 2 and not led.exists() and "Nothing was imported" in r.stderr
    assert "2 distinct site reference(s) in 3 row(s)" in r.stderr and "UNSALTED" in r.stderr and "TWO independent sites" in r.stderr
    assert "--none-needed" in r.stderr and "--accept-mixed-refs" in r.stderr and "calibrate alias --site" in r.stderr
    with pytest.raises(ObservationError, match="Decide first"):
        import_export(json.loads(ex.read_text()), led)
    assert not led.exists()
    # an export with no rows has nothing to decide
    empty = tmp_path / "empty.json"
    empty.write_text(json.dumps(export()))
    assert run_cli("calibrate", "import", str(empty), "--ledger", str(led)).returncode == 0


def test_each_recorded_decision_lets_the_import_through_and_says_which_it_was(tmp_path):
    ex = tmp_path / "export.json"
    ex.write_text(json.dumps(export(export_row(1, LEGACY, "2026-05-01"), export_row(2, KEYED, "2026-06-01"))))
    # (1) the flag, for this one import only
    a = tmp_path / "a" / "ledger.json"
    r = run_cli("calibrate", "import", str(ex), "--ledger", str(a), "--accept-mixed-refs")
    assert r.returncode == 0 and "--accept-mixed-refs for this import only" in r.stdout and "nothing was merged" in r.stderr
    assert run_cli("calibrate", "import", str(ex), "--ledger", str(a)).returncode == 2                     # it did not become a standing decision
    # (2) a dated acknowledgement in the alias file
    b = tmp_path / "b" / "ledger.json"
    ack = run_cli("calibrate", "alias", "--none-needed", "--ledger", str(b))
    assert ack.returncode == 0 and "no site spans" in ack.stdout
    doc = json.loads((b.parent / siteref.ALIAS_FILENAME).read_text())
    assert doc["aliases"] == {} and set(doc["acknowledgement"]) == {"none_needed_on"} and len(doc["acknowledgement"]["none_needed_on"]) == 10
    r = run_cli("calibrate", "import", str(ex), "--ledger", str(b))
    assert r.returncode == 0 and "you recorded that no site spans the 0053 boundary" in r.stdout
    assert "already recorded" in run_cli("calibrate", "alias", "--none-needed", "--ledger", str(b)).stdout
    # (3) aliases
    c = tmp_path / "c" / "ledger.json"
    assert run_cli("calibrate", "alias", "--site", "Cork DC2", "--ledger", str(c), env={"GRIDFORGE_SITE_REF_SECRET": K1}).returncode == 0
    r = run_cli("calibrate", "import", str(ex), "--ledger", str(c))
    assert r.returncode == 0 and "1 alias(es) declared" in r.stdout


def test_an_acknowledgement_survives_an_alias_being_added_and_is_validated(tmp_path):
    led = tmp_path / "ledger.json"
    assert run_cli("calibrate", "alias", "--none-needed", "--ledger", str(led)).returncode == 0
    assert run_cli("calibrate", "alias", "--site", "Cork DC2", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1}).returncode == 0
    path = tmp_path / siteref.ALIAS_FILENAME
    _, ack = siteref.read_alias_file(path)
    assert ack and ack["none_needed_on"]
    for bad in ({"none_needed_on": "tomorrow"}, {"none_needed_on": "2026-11-08", "by": "x"}, "yes", {}):
        doc = json.loads(path.read_text())
        doc["acknowledgement"] = bad
        path.write_text(json.dumps(doc))
        with pytest.raises(siteref.SiteRefError):
            siteref.read_alias_file(path)
    assert run_cli("calibrate", "alias", "--none-needed", "--site", "x", "--ledger", str(led)).returncode == 2        # it stands alone


# ---------------------------------------------------------------------------------------------------- the legacy reference is the database's, not a guess

LEGACY_VECTORS = json.loads((ROOT / "tests" / "site_ref_legacy_vectors.json").read_text())


def test_plain_ascii_labels_have_the_databases_legacy_reference_and_everything_else_is_refused_not_guessed():
    for v in LEGACY_VECTORS["ascii"]:
        assert siteref.legacy_site_only_ref(v["label"]) == v["legacy_ref"], repr(v["label"])
    for label in LEGACY_VECTORS["needs_database"]:
        if "\ud83d" in label:
            continue                                                                          # a lone surrogate is refused as not-UTF-8 instead (below)
        with pytest.raises(siteref.LegacyRefNeedsDatabase, match="select 'site_'"):
            siteref.legacy_site_only_ref(label)
    assert "lower(regexp_replace(" in siteref.LEGACY_REF_SQL and "'^\\s+|\\s+$'" in siteref.LEGACY_REF_SQL


def test_the_sql_the_cli_prints_is_the_expression_the_migration_uses():
    sql = (ROOT / "supabase" / "migrations" / "0047_calibration_consent_and_origin.sql").read_text()
    assert "label := lower(regexp_replace(coalesce(pr.site_label, ''), '^\\s+|\\s+$', '', 'g'));" in sql
    assert "'site_' || substr(encode(sha256(convert_to(label, 'UTF8')), 'hex'), 1, 12)" in sql
    assert "lower(regexp_replace(coalesce(site_label, ''), '^\\s+|\\s+$', '', 'g'))" in siteref.LEGACY_REF_SQL
    assert "substr(encode(sha256(convert_to(" in siteref.LEGACY_REF_SQL and "'UTF8')), 'hex'), 1, 12)" in siteref.LEGACY_REF_SQL


@pytest.mark.parametrize("label", ["\u039f\u0394\u039f\u03a3", "\u0130stanbul", "\u1e9e", "\x85Hall"])
def test_alias_with_a_non_ascii_name_needs_the_reference_from_the_database_and_writes_nothing_without_it(tmp_path, label):
    led = tmp_path / "ledger.json"
    r = run_cli("calibrate", "alias", "--site", label, "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert r.returncode == 2 and "--legacy-ref" in r.stderr and "select 'site_'" in r.stderr and "Traceback" not in r.stderr
    assert not (tmp_path / siteref.ALIAS_FILENAME).exists()
    given = "site_53ad14b05bf3"
    ok = run_cli("calibrate", "alias", "--site", label, "--legacy-ref", given, "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert ok.returncode == 0, ok.stderr
    assert siteref.read_aliases(tmp_path / siteref.ALIAS_FILENAME) == {given: keyed(label)}
    assert run_cli("calibrate", "alias", "--site", label, "--legacy-ref", given, "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1}).stdout.startswith("already recorded")


@pytest.mark.parametrize("bad", ["", "site_", "SITE_0123456789ab", "site_0123456789AB", "site_0123456789ab\n", "site_0123456789abc", "x"])
def test_a_malformed_legacy_ref_is_refused(tmp_path, bad):
    r = run_cli("calibrate", "alias", "--site", "Cork DC2", "--legacy-ref", bad or " ", "--ledger", str(tmp_path / "l.json"), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert r.returncode == 2 and "Traceback" not in r.stderr
    assert not (tmp_path / siteref.ALIAS_FILENAME).exists()


def test_a_legacy_ref_that_contradicts_a_plain_ascii_name_is_refused(tmp_path):
    r = run_cli("calibrate", "alias", "--site", "Cork DC2", "--legacy-ref", "site_000000000000", "--ledger", str(tmp_path / "l.json"), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert r.returncode == 2 and "database derives" in r.stderr
    assert run_cli("calibrate", "alias", "--site", "Cork DC2", "--legacy-ref", LEGACY, "--ledger", str(tmp_path / "l.json"), env={"GRIDFORGE_SITE_REF_SECRET": K1}).returncode == 0


def test_calibrate_add_warns_instead_of_silently_missing_when_it_cannot_check_a_non_ascii_name(tmp_path):
    led = tmp_path / "ledger.json"
    r = run_cli(*ADD, "--site", "\u039f\u0394\u039f\u03a3", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert r.returncode == 0 and "cannot check whether" in r.stderr and "--legacy-ref" in r.stderr
    # given the database's reference, the check is made: a ledger already holding that site under it refuses
    legacy = "site_53ad14b05bf3"
    append_observation(Observation(key="envelope.racks", site_ref=legacy + "-0123abcd", predicted=26.0, observed=24.0, unit="racks", observed_on="2026-05-30",
                                   evidence=EvidenceClass.E5_CUSTOMER_DATA, method="metering"), tmp_path / "other.json")
    r = run_cli(*ADD, "--site", "\u039f\u0394\u039f\u03a3", "--legacy-ref", legacy, "--ledger", str(tmp_path / "other.json"), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert r.returncode == 2 and "UNSALTED" in r.stderr


# ---------------------------------------------------------------------------------------------------- hostile arguments, locking, an unreadable file

def test_an_argument_that_is_not_valid_utf8_is_a_clean_refusal(tmp_path):
    for args in (["alias", "--site", b"Hall\xff"], [*ADD[1:], "--site", b"Hall\xff"]):
        r = subprocess.run([sys.executable, "-m", "gridforge", "calibrate", *[a.encode() if isinstance(a, str) else a for a in args], b"--ledger", str(tmp_path / "l.json").encode()],
                           cwd=ROOT, capture_output=True, env={k: v for k, v in os.environ.items() if k != "GRIDFORGE_SITE_REF_SECRET"})
        assert r.returncode == 2 and b"Traceback" not in r.stderr and b"not valid UTF-8" in r.stderr, r.stderr
    assert not (tmp_path / "l.json").exists() and not (tmp_path / siteref.ALIAS_FILENAME).exists()


def _add_one(args):
    path, i = args
    siteref.add_alias(Path(path), "site_%012x" % (i + 1), "site_%012x" % (i + 100001))
    return i


def test_concurrent_alias_writers_do_not_lose_each_others_lines(tmp_path):
    import multiprocessing
    path = tmp_path / siteref.ALIAS_FILENAME
    n = 24
    with multiprocessing.get_context("spawn").Pool(8) as pool:
        pool.map(_add_one, [(str(path), i) for i in range(n)])
    assert len(siteref.read_aliases(path)) == n
    assert siteref.read_aliases(path)["site_%012x" % 5] == "site_%012x" % 100005


def test_where_works_with_an_unreadable_alias_file_and_says_so_while_import_and_add_stop(tmp_path):
    led = tmp_path / "ledger.json"
    (tmp_path / siteref.ALIAS_FILENAME).write_text("{ broken")
    w = run_cli("calibrate", "where", env={"GRIDFORGE_CALIBRATION_LEDGER": str(led)})
    assert w.returncode == 0 and "alias file unreadable" in w.stdout and "IGNORE it" in w.stdout
    add = run_cli(*ADD, "--site", "Dublin DC1", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert add.returncode == 2 and "not valid JSON" in add.stderr and not led.exists()
    al = run_cli("calibrate", "alias", "--site", "Dublin DC1", "--ledger", str(led), env={"GRIDFORGE_SITE_REF_SECRET": K1})
    assert al.returncode == 2 and "not valid JSON" in al.stderr
    assert run_cli("calibrate", "show", env={"GRIDFORGE_CALIBRATION_LEDGER": str(led)}).returncode != 0         # a count of sites needs the aliases


# ---------------------------------------------------------------------------------------------------- git

def test_the_alias_file_and_its_lock_and_temp_files_are_gitignored():
    names = [siteref.ALIAS_FILENAME, siteref.ALIAS_FILENAME + ".lock", f".{siteref.ALIAS_FILENAME}.12345.tmp", ".calibration.local.json.12345.tmp"]
    r = subprocess.run(["git", "check-ignore", "-v", *names], cwd=ROOT, capture_output=True, text=True)
    ignored = {line.split("\t")[1] for line in r.stdout.splitlines()}
    assert ignored == set(names), (r.stdout, r.stderr)
