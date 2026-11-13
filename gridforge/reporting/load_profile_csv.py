"""Read a customer's load-profile CSV in whatever dialect their spreadsheet exported.

A load profile from a European Excel is a UTF-8 file that starts with a byte-order mark and separates its cells with semicolons; one from a metering
system may use tabs. The equipment-schedule importer already reads all three, so this module does not write a second reader: it hands that importer's
tokenizer and delimiter sniffer to `power.load_profile.from_csv`. It lives in `reporting` because `power` may not import `intake` and `reporting` may
import both (tests/test_architecture.py).

What it does not do: convert a number or a date. Whether `1234,5` is a decimal comma is `power.load_profile`'s decision (only in a semicolon-separated
file, and counted into a warning); this module only finds the cells.
"""
from __future__ import annotations

from ..intake.schedule_import import ScheduleImportError, sniff_delimiter, tokenize
from ..power.load_profile import CsvRows, LoadProfile, LoadProfileError, from_csv
from ..validation import EvidenceClass


def read_dialect(text: str) -> CsvRows:
    """The records of a comma-, semicolon- or tab-separated file, each with the physical line it starts on. A tie between delimiters, an unclosed
    quote or a stray quote is a LoadProfileError naming the row, never a guess."""
    if text.startswith("﻿"):
        text = text[1:]
    try:
        delimiter = sniff_delimiter(text)
        records, _comments, _blank = tokenize(text, delimiter)
    except ScheduleImportError as exc:
        raise LoadProfileError(str(exc)) from exc
    return CsvRows([(rec.row, rec.cells) for rec in records], delimiter)


def load_profile_from_csv(text: str, *, source: str, evidence: EvidenceClass | None = None) -> LoadProfile:
    """`power.load_profile.from_csv` with the importer's dialect reader: BOM, comma, semicolon or tab."""
    if evidence is None:
        return from_csv(text, source=source, reader=read_dialect)
    return from_csv(text, source=source, evidence=evidence, reader=read_dialect)
