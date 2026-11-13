"""Import a customer's equipment schedule (CSV) as the intake's `transformers` or `ups` list, with provenance, and never invent a value.

Why it exists. A hall with no transformer / UPS schedule is not comparable in a portfolio and cannot be issued a study, and the customer's
schedule is already a spreadsheet. Retyping it is where a unit slips (kVA read as MVA) and where a figure is guessed. This module reads what the
file says, refuses what it does not say clearly, and leaves every gap for the loader to name.

    python3 -m gridforge import-schedule schedule.csv --kind transformers --rows-are-installed \\
        --into intake.json --replace -o intake.merged.json --ledger intake.merged.import.json --source-label "E-101 rev C"

What it reads (exact header aliases only: casefolded, spaces / underscores / hyphens collapsed; no fuzzy matching; the UNIT must be in the header)
  transformers  id | unit rating in MVA, or in kVA (divided by 1000) | units | redundancy | optional derating factor (a fraction) |
                optional replacement lead time (header must say weeks; months or days are REFUSED, never converted)
  ups           id | module rating in kW (a kVA rating is REFUSED unless the file also has a power-factor column: kW = kVA x pf) | units | redundancy |
                optional step-load capability (a fraction)
  A header that maps to nothing is listed as UNMAPPED, verbatim. A header that is recognised but REFUSED (a lead time in months, a derating in
  percent, a rating with no unit) refuses the file.

What it refuses (the whole file, all-or-nothing; every problem found is named by file row and column; nothing is written)
  an empty required cell (id, rating); `TBC`, `n/a`, `-` or any placeholder; a thousands separator (`1,600`), a product (`2x1600`), a formula
  (`=1+1`), `nan`, `inf`, scientific notation, non-ASCII digits; zero or negative; a value above the loader's PLAUSIBLE_MAX; a non-integer
  `units`; a repeated id (compared after trimming and ignoring letter case: `TX-A` and `tx-a` are one bank); a redundancy outside the loader's accepted
  set; a ragged row. Only a plain decimal is read. A title row above the header is not skipped: the file is refused, and the message says which row looks like the title
  and that the rows above the header are to be deleted.
  An EMPTY optional cell (or an absent optional column) is omitted from the item. The loader then names it as a gap. It is never defaulted, zeroed
  or inferred (identical rows with different ids are different items; `units` is never counted from repeated rows).

Installed or planned. A schedule often lists planned equipment, and the engine counts everything it is given as installed. With a status column
(status / state / installed / in service / commissioned) only the rows whose status is installed, in service, commissioned or live count; the others
are EXCLUDED and listed by id. With no status column the operator must say so: `--rows-are-installed`.

Evidence. This module assigns NO evidence class and asserts none: every ledger field is `"verified": false` (the importer reads a file; it cannot
verify a document, which is for a human or a later evidence step). The class of each figure is the LOADER's to give, and it gives: the rating E5
(client-supplied), a supplied transformer derating E3, a supplied transformer lead time E0 (forced down: a figure on a sheet is not a quotation), a
supplied UPS step-load E0. tests/test_schedule_import.py pins those classes, and the CLI report quotes them as the loader read them.

Output is the loader's own input. The items are run through the real `load_document` (on the target intake, or on a document holding just this
section when there is no `--into`) and refused if the loader refuses. The gaps and warnings that remain for this section are reported:
a bank with no redundancy column is a REQUIRED named gap (`transformers[ID].redundancy`) and the intake cannot be issued.

The ledger (JSON, data, not an intake key: the loader would refuse it inside the intake) holds, per emitted item and per field, the source file
name and sha256 (once, in `source`), the optional `--source-label`, the 1-based file row, the header text, the raw cell text, the conversion applied
and `"verified": false`; plus the unmapped headers, the excluded rows, the skipped comment lines and what each item left out. No clock is read: the
same input gives byte-identical output and ledger.

What it does not do (phase 2): REST / MCP exposure, rack-register counts for hall.occupied_positions, XLSX, DCIM / BMS exports. A declared integration
port is not an implemented integration; this module is only the CSV file adapter.

Layering: standard library plus `.loader` only (tests/test_architecture.py). Decimal arithmetic is exact (Python integers), because `decimal` and
`fractions` are outside the engine's standard-library allow-list and because float arithmetic would write a value nobody wrote (1111 kVA x 0.9
is 999.9000000000001 in floats).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .loader import EQUIPMENT_KEYS, MAX_EQUIPMENT_ITEMS, PLAUSIBLE_MAX, _REDUNDANCY, IntakeError, load_document

#: The bounds on what one call reads. They keep the work, the ledger and every message small; none is an engineering claim.
MAX_BYTES = 256 * 1024            #: the schedule file
MAX_DATA_ROWS = 200               #: data rows read (installed or not); the loader separately limits one equipment list to MAX_EQUIPMENT_ITEMS
MAX_COLUMNS = 128
MAX_HEADER_CHARS = 200
MAX_ID_CHARS = 80
MAX_NUMBER_CHARS = 32
MAX_LABEL_CHARS = 200
MAX_INTAKE_BYTES = 512 * 1024     #: the `--into` document (the API's own request limit)
MAX_PROBLEMS_SHOWN = 25
TITLE_SCAN_LINES = 12             #: lines below the first row searched for the real header when the first row looks like a title
LEDGER_FORMAT = "gridforge.schedule-import-ledger/1"
KINDS = ("transformers", "ups")

#: The keys emitted for each kind, in the order they are written (the examples' order). Checked against the loader's allow-list below.
_FIELDS = {
    "transformers": ("id", "unit_rating_MVA", "units", "redundancy", "derating_factor", "replacement_lead_time_weeks"),
    "ups": ("id", "unit_rating_kW", "units", "redundancy", "step_load_capability"),
}
for _kind, _keys in _FIELDS.items():
    if not set(_keys) <= EQUIPMENT_KEYS[_kind]:                        # the loader would refuse a key outside its list: fail here, loudly, instead
        raise RuntimeError(f"schedule_import emits keys the loader does not read for {_kind}: {sorted(set(_keys) - EQUIPMENT_KEYS[_kind])}")

#: Statuses (after the header normalisation) that count a row as installed. Anything else, an empty cell included, excludes the row.
INSTALLED_STATUSES = frozenset({"installed", "in service", "commissioned", "live"})


class ScheduleImportError(IntakeError):
    """The schedule cannot be imported. `reasons` holds every problem found, each naming its file row and column; nothing was written."""

    def __init__(self, reasons) -> None:
        self.reasons = [reasons] if isinstance(reasons, str) else list(reasons)
        shown = self.reasons[:MAX_PROBLEMS_SHOWN]
        if len(self.reasons) == 1:
            text = self.reasons[0]
        else:
            text = f"{len(self.reasons)} problems:\n" + "\n".join(f"  - {r}" for r in shown)
            if len(self.reasons) > len(shown):
                text += f"\n  - ... and {len(self.reasons) - len(shown)} more"
        super().__init__(text)


# ---------------------------------------------------------------------------------------------------------------- text helpers
def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + "..."


def _q(text: str, limit: int = 40) -> str:
    """Text from the file, for a message: clipped, and shown through repr so a control or format character is escaped, never emitted."""
    return repr(_clip(text, limit))


def _escaped(text: str, limit: int) -> str:
    """Clipped text for the ledger with every non-printable character written as a \\uXXXX escape, so nothing in it can drive a terminal."""
    return "".join(c if c.isprintable() else f"\\u{ord(c):04x}" for c in _clip(text, limit))


def _bad_chars(text: str) -> bool:
    """A control, format (zero-width, bidi override, BOM) or line / paragraph separator character: not text a tag or a scheme may carry."""
    return any(unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") for c in text)


def _norm(header: str) -> str:
    """The header key: casefolded, runs of whitespace / underscores / hyphens collapsed to one space. The ONLY normalisation (no fuzzy matching)."""
    return re.sub(r"[\s_\-]+", " ", header.casefold()).strip()


def _where(row: int, col: int, headers: list[str]) -> str:
    return f"row {row}, column {col + 1} ({_q(headers[col], 60)})"


# ------------------------------------------------------------------------------------------------------------------ exact decimals
_PLAIN_DECIMAL = re.compile(r"([+-]?)([0-9]+)(?:\.([0-9]+))?")
_PLACEHOLDERS = frozenset({"tbc", "tbd", "tba", "n/a", "na", "n.a.", "none", "null", "nil", "unknown", "pending", "?", "-", "--", "–", "—", "x"})
_NOT_FINITE = frozenset({"nan", "inf", "+inf", "-inf", "infinity", "+infinity", "-infinity", "+nan", "-nan"})


@dataclass(frozen=True)
class _Dec:
    """mant / 10**scale, exactly. Python integers, so kVA / 1000 and kVA x pf carry no float error before the single, correctly rounded float()."""
    mant: int
    scale: int

    def to_float(self) -> float:
        return float(f"{self.mant}e-{self.scale}")                      # decimal literal -> nearest float: correctly rounded

    def over_1000(self) -> "_Dec":
        return _Dec(self.mant, self.scale + 3)

    def times(self, other: "_Dec") -> "_Dec":
        return _Dec(self.mant * other.mant, self.scale + other.scale)

    def positive(self) -> bool:
        return self.mant > 0

    def at_most_one(self) -> bool:
        return self.mant <= 10 ** self.scale

    def whole(self) -> bool:
        return self.mant % (10 ** self.scale) == 0

    def whole_value(self) -> int:
        return self.mant // (10 ** self.scale)


def _why_not_decimal(s: str) -> str:
    """A specific reason a cell is not a plain decimal, for the commonest ways a schedule gets it wrong. Fallback: the form that is read."""
    low = s.casefold()
    first = s[:1]
    if any(ord(c) > 127 and unicodedata.category(c) == "Nd" for c in s):
        return "it uses non-ASCII digits (Arabic-Indic, full-width, ...); retype it with the digits 0-9"
    if low in _PLACEHOLDERS or s in ("+",):
        return "it is a placeholder, not a value; clear the cell to leave the figure out (the engine then names it as a gap)"
    if low in _NOT_FINITE:
        return "it is not a finite number"
    if first and (first in "=@" or (first in "+-" and len(s) > 1)):
        return f"it starts with {first!r}: it reads as a formula or an expression, which is never evaluated here; write the figure itself"
    if re.fullmatch(r"[+-]?[0-9]{1,3}([,' ][0-9]{3})+(\.[0-9]+)?", s):
        return "it has a thousands separator; write 1600, not 1,600"
    if re.fullmatch(r"[0-9]+(\.[0-9]+)?\s*[x×*]\s*[0-9]+(\.[0-9]+)?", s, re.I):
        return "it is a product (a count times a rating); give the rating and `units` in separate columns"
    if re.fullmatch(r"[+-]?[0-9]+,[0-9]+", s):
        return "it has a comma inside the number (a decimal comma or a thousands separator); write 1.6 or 1600"
    if re.fullmatch(r"[+-]?[0-9]*\.?[0-9]+[eE][+-]?[0-9]+", s):
        return "scientific notation is not read; write the number out"
    if s.endswith("%"):
        return "a percentage is not converted; write the fraction (0.9, not 90%)"
    if re.match(r"[+-]?[0-9.,]+\s*[A-Za-z%/°]", s):
        return "it carries a unit or other text; the unit belongs in the column header, the cell is the bare number"
    return "only digits with an optional sign and fractional part are read (write 0.5, not .5, and 5, not 5.)"


def _decimal(raw: str) -> tuple[_Dec | None, str]:
    """(value, "") for a plain decimal, else (None, the reason). The cell is trimmed of surrounding whitespace first; nothing else is forgiven."""
    s = raw.strip()
    if len(s) > MAX_NUMBER_CHARS:
        return None, f"{_q(s)} is longer than {MAX_NUMBER_CHARS} characters, which is not a figure from a schedule"
    m = _PLAIN_DECIMAL.fullmatch(s)
    if m is None:
        return None, f"{_q(s)} is not a plain decimal number: {_why_not_decimal(s)}"
    sign, whole, frac = m.groups()
    mant = int(whole + (frac or ""))
    return _Dec(-mant if sign == "-" else mant, len(frac or "")), ""


def _json_number(x: float):
    """An integral float is written as an integer (5, not 5.0), so the output reads like the examples and is stable."""
    return int(x) if x == x and abs(x) < 1e15 and float(int(x)) == x else x


# ---------------------------------------------------------------------------------------------------------------- header aliases
@dataclass(frozen=True)
class _Alias:
    slot: str
    unit: str | None = None
    refusal: str | None = None


def _forms(bases, unit: str) -> list[str]:
    """`rating MVA`, `rating (MVA)`, `rating [MVA]` for each base, and the bare `MVA`, `(MVA)`, `[MVA]`."""
    return ([f"{b} {unit}" for b in bases] + [f"{b} ({unit})" for b in bases] + [f"{b} [{unit}]" for b in bases] + [unit, f"({unit})", f"[{unit}]"])


def _suffixed(bases, suffixes) -> list[str]:
    return [b + s for b in bases for s in suffixes]


_FRACTION_OK = ("", " (fraction)", " fraction", " (0-1)")
_PERCENT = (" %", " (%)", " percent", " (percent)")
_FRACTION_REFUSAL = "a percentage is never converted; give the column as a fraction (0.9, not 90) and say so in the header, e.g. `{h} (fraction)`"
_NO_UNIT_RATING = ("the rating column has no unit in its header, so its figures could be kVA, MVA or kW; the unit must be in the header "
                   "(e.g. `{h} ({u})`), and this tool will not guess it")


def _build_aliases(kind: str) -> dict[str, _Alias]:
    table: dict[str, _Alias] = {}

    def add(headers, alias: _Alias) -> None:
        for h in headers:
            n = _norm(h)
            if table.get(n, alias) != alias:                                   # a table that maps one header two ways is a bug, not a choice
                raise RuntimeError(f"header alias {h!r} is ambiguous")
            table[n] = alias

    add(("id", "tag", "name", "asset id", "asset tag", "equipment id"), _Alias("id"))
    add(("units", "qty", "quantity", "count", "number of units"), _Alias("units"))
    add(("redundancy", "redundancy scheme", "configuration"), _Alias("redundancy"))
    add(("status", "state", "installed", "in service", "commissioned"), _Alias("status"))
    if kind == "transformers":
        bases = ("rating", "unit rating", "transformer rating", "nameplate rating")
        add(_forms(bases, "MVA"), _Alias("rating", "MVA"))
        add(_forms(bases, "kVA"), _Alias("rating", "kVA"))
        add(bases, _Alias("rating", refusal=_NO_UNIT_RATING.format(h="rating", u="MVA") + "; a kVA rating is divided by 1000"))
        derating = ("derating", "derating factor")
        add(_suffixed(derating, _FRACTION_OK), _Alias("fraction"))
        add(_suffixed(derating, _PERCENT), _Alias("fraction", refusal=_FRACTION_REFUSAL.format(h="derating factor")))
        lead = ("replacement lead time", "lead time", "transformer lead time")
        weeks = [f"{b} {u}" for b in lead for u in ("weeks", "wks")] + [f"{b} ({u})" for b in lead for u in ("weeks", "wks")] \
            + [f"{b} [{u}]" for b in lead for u in ("weeks", "wks")]
        add(weeks, _Alias("lead"))
        for other in ("months", "month", "mths", "days", "day", "years", "year", "yrs"):
            add([f"{b} {other}" for b in lead] + [f"{b} ({other})" for b in lead] + [f"{b} [{other}]" for b in lead],
                _Alias("lead", refusal=f"the lead time is in {other}; this tool never converts a lead time, so the column must be in weeks"))
        add(lead, _Alias("lead", refusal="the lead-time header does not say its unit; the header must say weeks (e.g. `replacement lead time (weeks)`)"))
    else:
        bases = ("rating", "unit rating", "module rating", "ups rating", "nameplate rating")
        add(_forms(bases, "kW"), _Alias("rating", "kW"))
        add(_forms(bases, "kVA"), _Alias("rating", "kVA"))
        add(bases, _Alias("rating", refusal=_NO_UNIT_RATING.format(h="module rating", u="kW") + "; a kVA rating needs a power-factor column"))
        add(("power factor", "pf", "rated power factor", "output power factor"), _Alias("pf"))
        step = ("step load capability", "step load", "step load acceptance")
        add(_suffixed(step, _FRACTION_OK), _Alias("fraction"))
        add(_suffixed(step, _PERCENT), _Alias("fraction", refusal=_FRACTION_REFUSAL.format(h="step load capability")))
    return table


_ALIASES = {k: _build_aliases(k) for k in KINDS}
_SLOT_WHAT = {"id": "asset id", "rating": "unit rating", "units": "unit count", "redundancy": "redundancy scheme", "fraction": "derating / step-load fraction",
              "lead": "replacement lead time", "pf": "power factor", "status": "installed-or-planned status"}
_ACCEPTED_RATING_HEADERS = {"transformers": "`rating (MVA)`, `unit rating kVA`, `MVA`, `kVA`", "ups": "`module rating (kW)`, `rating kW`, `kW` (or kVA with a power-factor column)"}
_RATING_KEY = {"transformers": "unit_rating_MVA", "ups": "unit_rating_kW"}
_FRACTION_KEY = {"transformers": "derating_factor", "ups": "step_load_capability"}


@dataclass
class _Mapping:
    cols: dict[str, int]                    # slot -> 0-based column
    rating_unit: str                        # the unit the chosen rating column states
    unmapped: list[dict]


def _map_headers(kind: str, headers: list[str], header_row: int, rows_are_installed: bool, problems: list[str]) -> _Mapping | None:
    table = _ALIASES[kind]
    start = len(problems)
    by_slot: dict[str, list[tuple[int, _Alias]]] = {}
    rating_refused = False
    for c, h in enumerate(headers):
        a = table.get(_norm(h))
        if a is None:
            continue
        if a.refusal:                                   # recognised, and refused by name: a lead time in months, a derating in percent, a unit-less rating
            problems.append(f"{_where(header_row, c, headers)}: {a.refusal}")
            rating_refused = rating_refused or a.slot == "rating"
            continue
        by_slot.setdefault(a.slot, []).append((c, a))
    chosen: dict[str, int] = {}
    notes: dict[int, str] = {}

    for slot, hits in by_slot.items():
        if slot == "rating":
            continue
        if len(hits) > 1:
            (c1, _), (c2, _) = hits[0], hits[1]
            problems.append(f"{_where(header_row, c1, headers)}: columns {c1 + 1} ({_q(headers[c1], 60)}) and {c2 + 1} ({_q(headers[c2], 60)}) both give the "
                            f"{_SLOT_WHAT[slot]}; keep one")
        else:
            chosen[slot] = hits[0][0]

    target = "MVA" if kind == "transformers" else "kW"
    ratings = by_slot.get("rating", [])
    in_target = [c for c, a in ratings if a.unit == target]
    in_kva = [c for c, a in ratings if a.unit == "kVA"]
    rating_unit = target
    if len(in_target) > 1:
        problems.append(f"{_where(header_row, in_target[0], headers)}: columns {in_target[0] + 1} ({_q(headers[in_target[0]], 60)}) and {in_target[1] + 1} "
                        f"({_q(headers[in_target[1]], 60)}) both give the unit rating in {target}; keep one")
    elif in_target:
        chosen["rating"] = in_target[0]
        for c in in_kva:
            notes[c] = f"recognised as a kVA rating but not used: the file also has a {target} rating column"
    elif len(in_kva) > 1:
        problems.append(f"{_where(header_row, in_kva[0], headers)}: columns {in_kva[0] + 1} ({_q(headers[in_kva[0]], 60)}) and {in_kva[1] + 1} "
                        f"({_q(headers[in_kva[1]], 60)}) both give the unit rating in kVA; keep one")
    elif in_kva:
        rating_unit = "kVA"
        if kind == "ups" and "pf" not in chosen:
            problems.append(f"{_where(header_row, in_kva[0], headers)}: the UPS rating is in kVA and the file has no power-factor column; kW = kVA x power "
                            f"factor needs the customer's own power factor, which this tool will not assume. Add a `power factor` column or give the rating in kW")
        else:
            chosen["rating"] = in_kva[0]
    if not ratings and not rating_refused:
        problems.append(f"row {header_row}: no column gives the {_RATING_KEY[kind]} (the unit must be in the header; accepted, matched exactly apart from case "
                        f"and spacing: {_ACCEPTED_RATING_HEADERS[kind]}). Headers in this file: {', '.join(_q(h, 40) for h in headers[:12])}"
                        f"{' ...' if len(headers) > 12 else ''}")
    if "id" not in chosen and "id" not in by_slot:
        problems.append(f"row {header_row}: no column gives the asset id (accepted: `id`, `tag`, `name`, `asset id`, `asset tag`, `equipment id`). "
                        f"Headers in this file: {', '.join(_q(h, 40) for h in headers[:12])}{' ...' if len(headers) > 12 else ''}")
    if "status" not in chosen and "status" not in by_slot and not rows_are_installed:
        problems.append(f"row {header_row}: the file has no status column (status / state / installed / in service / commissioned), and a schedule often lists "
                        f"planned equipment while the engine counts everything it is given as installed. Say that every row is installed with "
                        f"--rows-are-installed, or add a status column and the rows that are not installed or in service will be excluded")
    if kind == "ups" and "pf" in chosen and rating_unit != "kVA":
        notes[chosen.pop("pf")] = "recognised as a power factor but not used: the rating is already in kW"
    if len(problems) > start:
        return None                                     # the caller raises with every problem found
    used = set(chosen.values())
    unmapped = []
    for c, h in enumerate(headers):
        if c in used:
            continue
        entry: dict[str, Any] = {"column": c + 1, "header": h}
        if c in notes:
            entry["note"] = notes[c]
        unmapped.append(entry)
    return _Mapping(chosen, rating_unit, unmapped)


# --------------------------------------------------------------------------------------------------------------------- tokenizer
@dataclass
class _Record:
    row: int
    cells: list[str]


def _skip_newline(text: str, i: int, line: int) -> tuple[int, int]:
    if i < len(text):
        if text[i] == "\r":
            return (i + 2 if text[i + 1:i + 2] == "\n" else i + 1), line + 1
        if text[i] == "\n":
            return i + 1, line + 1
    return i, line


def _tokenize(text: str, delim: str) -> tuple[list[_Record], list[tuple[int, str]], int]:
    """RFC 4180 records with the physical line each starts on. Comments (`#` at the start of a record) and blank records are set aside, not parsed.

    A quoted cell may span lines and holds `""` for a quote. A quote anywhere else, or text after a closing quote, is refused: guessing where a cell
    ends is how a value lands in the wrong column. Linear in the size of the text."""
    n, i, line = len(text), 0, 1
    records: list[_Record] = []
    comments: list[tuple[int, str]] = []
    blank = 0
    while i < n:
        if text[i] == "#":
            j = i
            while j < n and text[j] not in "\r\n":
                j += 1
            comments.append((line, text[i:j]))
            i, line = _skip_newline(text, j, line)
            continue
        start = line
        cells: list[str] = []
        while True:
            k = i
            while k < n and text[k] == " ":
                k += 1
            if k < n and text[k] == '"':
                i = k + 1
                buf: list[str] = []
                while True:
                    if i >= n:
                        raise ScheduleImportError(f"row {start}: a quoted cell is never closed (the file ends inside it)")
                    ch = text[i]
                    if ch == '"':
                        if text[i + 1:i + 2] == '"':
                            buf.append('"')
                            i += 2
                            continue
                        i += 1
                        break
                    if ch == "\r":
                        buf.append("\n")
                        line += 1
                        i += 2 if text[i + 1:i + 2] == "\n" else 1
                        continue
                    if ch == "\n":
                        line += 1
                    buf.append(ch)
                    i += 1
                while i < n and text[i] == " ":
                    i += 1
                if i < n and text[i] not in (delim, "\n", "\r"):
                    raise ScheduleImportError(f"row {start}: text follows the closing quote of a cell; quote the whole cell and double any quote inside it")
                cells.append("".join(buf))
            else:
                j = i
                while j < n and text[j] != delim and text[j] not in "\r\n":
                    if text[j] == '"':
                        raise ScheduleImportError(f"row {start}: a quote inside an unquoted cell; quote the whole cell and double any quote inside it")
                    j += 1
                cells.append(text[i:j])
                i = j
            if i < n and text[i] == delim:
                i += 1
                continue
            break
        i, line = _skip_newline(text, i, line)
        if all(not c.strip() for c in cells):
            blank += 1
            continue
        records.append(_Record(start, cells))
    return records, comments, blank


def _sniff_delimiter(text: str) -> str:
    """The delimiter of the header line: whichever of comma, semicolon or tab occurs most outside quotes. A tie is refused, not guessed."""
    for line in re.split(r"\r\n|\n|\r", text):
        if line.startswith("#") or not line.strip(" \t,;"):
            continue
        counts = {}
        for d in (",", ";", "\t"):
            inside, count = False, 0
            for ch in line:
                if ch == '"':
                    inside = not inside
                elif ch == d and not inside:
                    count += 1
            counts[d] = count
        top = max(counts.values())
        if top == 0:
            return ","
        best = [d for d, c in counts.items() if c == top]
        if len(best) > 1:
            names = {",": "commas", ";": "semicolons", "\t": "tabs"}
            raise ScheduleImportError(f"the header line has as many {names[best[0]]} as {names[best[1]]} outside quotes, so the delimiter is ambiguous; "
                                      "export the file with one delimiter")
        return best[0]
    raise ScheduleImportError("the file has no header line (it holds only blank and comment lines)")


# The dialect reader's public names. The load-profile file reader (reporting/load_profile_csv.py) reuses this tokenizer and delimiter sniffer rather than
# writing a second one: `power` may not import `intake`, so `reporting`, which may import both, hands the reader to `power.load_profile.from_csv`.
Record = _Record
sniff_delimiter = _sniff_delimiter
tokenize = _tokenize


# ------------------------------------------------------------------------------------------------------------------- parse a file
def _known_columns(kind: str, cells: list[str]) -> list[str]:
    """The cells that are a header this importer recognises for `kind` (matched exactly as the mapping matches them, casefolded and spacing-collapsed)."""
    table = _ALIASES[kind]
    return [c.strip() for c in cells if c.strip() and _norm(c) in table]


def _title_row_hint(kind: str, text: str, records: list[_Record]) -> str | None:
    """A sentence saying the first row is probably a title, when the headers did not map and that is the likely reason; None otherwise.

    A title row is the first non-blank row having no recognised column name while a later row (within the first TITLE_SCAN_LINES lines) has at least
    two, or having a single non-empty cell. Without this the file is refused with 'no column gives unit_rating_MVA', which does not say what to do."""
    if not records:
        return None
    first = records[0]
    non_empty = [c.strip() for c in first.cells if c.strip()]
    if _known_columns(kind, first.cells):
        return None                                    # the first row IS (at least partly) a header: whatever is wrong is not a title above it
    lines = re.split(r"\r\n|\n|\r", text)
    for number, line in enumerate(lines[:TITLE_SCAN_LINES], start=1):
        if number <= first.row or line.startswith("#") or not line.strip(" \t,;"):
            continue
        try:
            delim = _sniff_delimiter(line)
            cells = _tokenize(line, delim)[0]
        except ScheduleImportError:
            continue
        if cells and len(_known_columns(kind, cells[0].cells)) >= 2:
            found = ", ".join(_q(c, 30) for c in _known_columns(kind, cells[0].cells)[:4])
            return (f"row {first.row}: this looks like a title row, not the header: it has {len(non_empty)} non-empty cell(s) and names no column this "
                    f"importer knows, while row {number} does ({found}). Delete the rows above the header (the header must be the first row of the file, "
                    f"apart from comment lines starting with #) and import again")
    if len(non_empty) == 1:
        return (f"row {first.row}: the first row has a single non-empty cell ({_q(non_empty[0], 60)}), which looks like a title, not a header. Delete the rows "
                f"above the header (the header must be the first row of the file, apart from comment lines starting with #) and import again")
    return None


@dataclass
class Parsed:
    kind: str
    items: list[dict]
    ledger: dict
    excluded: list[dict]
    unmapped: list[dict]
    skipped_comments: list[dict]
    rows_read: int
    delimiter: str


def _check_label(label: str | None) -> str | None:
    if label is None:
        return None
    if len(label) > MAX_LABEL_CHARS or _bad_chars(label):
        raise ScheduleImportError(f"the source label must be plain text of at most {MAX_LABEL_CHARS} characters (no control characters)")
    return label


def parse_schedule(data: bytes, *, file_name: str, kind: str, rows_are_installed: bool = False, source_label: str | None = None) -> Parsed:
    """Read a schedule held in `data` (the file's bytes). Pure: no clock, no file access. Raises ScheduleImportError with every problem found."""
    if kind not in KINDS:
        raise ScheduleImportError(f"kind must be one of {', '.join(KINDS)}, not {_q(str(kind))}")
    label = _check_label(source_label)
    if len(data) > MAX_BYTES:
        raise ScheduleImportError(f"the file is {len(data):,} bytes, over the {MAX_BYTES // 1024} KiB this importer reads; a schedule export is far smaller. "
                                  "Split it, or remove the columns and sheets that are not the schedule")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ScheduleImportError(f"the file is not valid UTF-8 (byte {exc.start}); export it as UTF-8 CSV (a UTF-16 export from a spreadsheet is a common cause)") from None
    if "\x00" in text:
        raise ScheduleImportError(f"the file contains a NUL byte (on line {text.count(chr(10), 0, text.index(chr(0))) + 1}); it is binary, not a CSV export")
    if not text.strip():
        raise ScheduleImportError("the file is empty")
    delim = _sniff_delimiter(text)
    records, comments, blank = _tokenize(text, delim)
    if not records:
        raise ScheduleImportError("the file has no header line (it holds only blank and comment lines)")
    header, rows = records[0], records[1:]
    headers = header.cells
    if len(headers) > MAX_COLUMNS:
        raise ScheduleImportError(f"row {header.row}: the header has {len(headers)} columns, more than the {MAX_COLUMNS} this importer reads")
    problems: list[str] = []
    for c, h in enumerate(headers):
        if len(h) > MAX_HEADER_CHARS or _bad_chars(h):
            problems.append(f"{_where(header.row, c, headers)}: a header must be plain text of at most {MAX_HEADER_CHARS} characters, without control, "
                            f"zero-width or direction-override characters")
    if problems:
        raise ScheduleImportError(problems)
    mapping = _map_headers(kind, headers, header.row, rows_are_installed, problems)
    if problems or mapping is None:
        hint = _title_row_hint(kind, text, records)
        if hint:
            problems.insert(0, hint)
        raise ScheduleImportError(problems or ["the headers could not be mapped"])
    if not rows:
        raise ScheduleImportError(f"row {header.row}: the file has a header and no data rows")
    if len(rows) > MAX_DATA_ROWS:
        raise ScheduleImportError(f"the file has {len(rows)} data rows, more than the {MAX_DATA_ROWS} this importer reads")

    cols = mapping.cols
    has_status = "status" in cols
    items: list[dict] = []
    item_ledger: list[dict] = []
    excluded: list[dict] = []
    seen_ids: dict[str, tuple[int, str]] = {}          # casefolded id -> (the first row that had it, its spelling)
    for rec in rows:
        if len(rec.cells) != len(headers):
            problems.append(f"row {rec.row}: has {len(rec.cells)} cells but the header has {len(headers)}; a short or long row means a delimiter is missing "
                            f"or extra, and a value would land in the wrong column")
            continue
        if has_status:
            raw_status = rec.cells[cols["status"]]
            id_text = rec.cells[cols["id"]].strip()
            if _bad_chars(raw_status) or _bad_chars(id_text):
                problems.append(f"row {rec.row}: the id or status cell holds a control or format character")
                continue
            if _norm(raw_status) not in INSTALLED_STATUSES:
                excluded.append({"row": rec.row, "id": _clip(id_text, MAX_ID_CHARS) or None, "status": _clip(raw_status.strip(), 40)})
                continue
        built = _read_row(kind, rec, headers, mapping, problems)
        if built is None:
            continue
        item, fields, omitted = built
        key = item["id"].casefold()          # `TX-A` and `tx-a` are one bank: counting both moved a date from 160 to 36 weeks
        prior = seen_ids.get(key)
        if prior is not None:
            prior_row, prior_id = prior
            spelled = (f" ({_q(prior_id)}; the two ids differ only in letter case, and ids are compared ignoring case after trimming)"
                       if prior_id != item["id"] else "")
            problems.append(f"{_where(rec.row, cols['id'], headers)}: {_q(item['id'])} repeats row {prior_row}{spelled}; the same equipment listed twice would "
                            f"be counted twice. Give each item its own id (identical machines with different ids are different items; `units` is never "
                            f"inferred from repeats)")
            continue
        seen_ids[key] = (rec.row, item["id"])
        items.append(item)
        item_ledger.append({"id": item["id"], "row": rec.row, "fields": fields, "omitted": omitted})
    if len(items) > MAX_EQUIPMENT_ITEMS:
        problems.append(f"{len(items)} rows count as installed, more than the {MAX_EQUIPMENT_ITEMS} items the loader accepts in one equipment list; identical "
                        f"units are one item with `units`, and a campus is one request per hall")
    if problems:
        raise ScheduleImportError(problems)
    if not items:
        listing = ", ".join(f"{e['id'] or '(no id)'} (row {e['row']}, status {_q(e['status'])})" for e in excluded[:10])
        raise ScheduleImportError(f"no row counts as installed: {len(excluded)} row(s) are excluded by their status ({listing}{' ...' if len(excluded) > 10 else ''}). "
                                  f"Only a status of installed, in service, commissioned or live counts")

    sha = hashlib.sha256(data).hexdigest()
    if has_status:
        basis: dict[str, Any] = {"source": "status_column", "column": cols["status"] + 1, "header": headers[cols["status"]],
                                 "counted_values": sorted(INSTALLED_STATUSES), "operator_assertion_not_applied": bool(rows_are_installed)}
    else:
        basis = {"source": "operator_assertion", "flag": "--rows-are-installed"}
    ledger = {
        "format": LEDGER_FORMAT,
        "kind": kind,
        "source": {"file": Path(file_name).name, "sha256": sha, "bytes": len(data), "label": label},
        "verified": False,
        "note": ("verified is false for every figure: this importer reads a customer's file and cannot verify a document. It assigns no evidence class; the "
                 "loader assigns one when the intake is loaded."),
        "delimiter": delim,
        "header_row": header.row,
        "rows_read": len(rows),
        "installed_basis": basis,
        "items": item_ledger,
        "excluded_rows": excluded,
        "unmapped_headers": mapping.unmapped,
        "skipped_comment_lines": [{"row": r, "text": _escaped(t, 80)} for r, t in comments],
        "blank_lines": blank,
    }
    return Parsed(kind, items, ledger, excluded, mapping.unmapped, ledger["skipped_comment_lines"], len(rows), delim)


def _read_row(kind: str, rec: _Record, headers: list[str], m: _Mapping, problems: list[str]) -> tuple[dict, dict, dict] | None:
    """One installed row -> (item, per-field ledger records, what the item left out), or None with the problems appended."""
    cols = m.cols
    start = len(problems)
    fields: dict[str, dict] = {}
    item: dict[str, Any] = {}
    omitted: dict[str, str] = {}

    def bad(col: int, why: str) -> None:
        problems.append(f"{_where(rec.row, col, headers)}: {why}")

    def cell(slot: str) -> tuple[int, str]:
        c = cols[slot]
        return c, rec.cells[c]

    def record(key: str, value, inputs, conversion=None) -> None:
        item[key] = value
        fields[key] = {"value": value, "row": rec.row, "inputs": inputs, "conversion": conversion, "verified": False}

    def inp(role: str, c: int) -> dict:
        return {"role": role, "column": c + 1, "header": headers[c], "raw": rec.cells[c]}

    def optional_empty(key: str, slot: str) -> bool:
        """True (and the omission recorded) when the column is absent or its cell is empty."""
        if slot not in cols:
            omitted[key] = "no column in the file"
            return True
        c, raw = cell(slot)
        if not raw.strip():
            omitted[key] = f"empty cell (column {c + 1})"
            return True
        return False

    def number(c: int) -> _Dec | None:
        dec, why = _decimal(rec.cells[c])
        if dec is None:
            bad(c, why)
        return dec

    def ceiling(key: str, value: float, c: int, shown: str) -> bool:
        high = PLAUSIBLE_MAX[key]
        if value > high:
            bad(c, f"{shown} is above {high:g}, the most the loader accepts for one item ({key} in gridforge.intake.loader.PLAUSIBLE_MAX). "
                   f"Check the unit and for a stray digit")
            return False
        return True

    # ---- id (required)
    c, raw = cell("id")
    ident = raw.strip()
    if not ident:
        bad(c, "empty required cell (the asset id)")
    elif len(ident) > MAX_ID_CHARS or _bad_chars(ident):
        bad(c, f"an id must be plain text of at most {MAX_ID_CHARS} characters, without control, zero-width or direction-override characters")
    elif ident[0] in "=+-@":
        bad(c, f"{_q(ident)} starts with {ident[0]!r}, which a spreadsheet reads as a formula; rename the asset tag")
    else:
        record("id", ident, [inp("value", c)])

    # ---- rating (required)
    out_key = _RATING_KEY[kind]
    rating_key = f"{kind}.{out_key}"
    c, raw = cell("rating")
    if not raw.strip():
        bad(c, f"empty required cell (the unit rating in {m.rating_unit})")
    else:
        dec = number(c)
        if dec is not None and not dec.positive():
            bad(c, f"{_q(raw.strip())} must be above zero")
        elif dec is not None:
            if kind == "transformers":
                if m.rating_unit == "kVA":
                    val, conv = dec.over_1000(), {"op": "divide", "by": 1000, "from_unit": "kVA", "to_unit": "MVA"}
                    shown = f"{raw.strip()} kVA = {_json_number(val.to_float())} MVA"
                    inputs = [inp("value", c)]
                else:
                    val, conv, shown, inputs = dec, None, f"{raw.strip()} MVA", [inp("value", c)]
            elif m.rating_unit == "kVA":
                pc, praw = cell("pf")
                if not praw.strip():
                    bad(pc, "empty required cell (the power factor needed to turn this kVA rating into kW)")
                    val = None
                else:
                    pf = number(pc)
                    if pf is None:
                        val = None
                    elif not pf.positive():
                        bad(pc, f"{_q(praw.strip())} must be above zero")
                        val = None
                    elif not pf.at_most_one():
                        bad(pc, f"{_q(praw.strip())} must be at most 1 (a power factor is a fraction)")
                        val = None
                    else:
                        val = dec.times(pf)
                        conv = {"op": "multiply", "factors": ["kVA", "power_factor"], "to_unit": "kW"}
                        shown = f"{raw.strip()} kVA x {praw.strip()} = {_json_number(val.to_float())} kW"
                        inputs = [inp("kVA", c), inp("power_factor", pc)]
            else:
                val, conv, shown, inputs = dec, None, f"{raw.strip()} kW", [inp("value", c)]
            if val is not None:
                number_out = val.to_float()
                if ceiling(rating_key, number_out, c, shown):
                    record(out_key, _json_number(number_out), inputs, conv)

    # ---- units (optional at the file level: absent -> a REQUIRED gap named by the loader, never a default)
    if not optional_empty("units", "units"):
        c, raw = cell("units")
        dec = number(c)
        if dec is not None:
            if not dec.positive() or not dec.whole():
                bad(c, f"{_q(raw.strip())} must be a whole number of at least 1 (a count of units; a fraction or zero is not a count)")
            elif ceiling(f"{kind}.units", float(dec.whole_value()), c, raw.strip()):
                record("units", dec.whole_value(), [inp("value", c)])

    # ---- redundancy
    if not optional_empty("redundancy", "redundancy"):
        c, raw = cell("redundancy")
        text = raw.strip()
        canon = text.upper().replace(" ", "")
        if text.isascii() and canon in _REDUNDANCY:
            conv = None if text == canon else {"op": "canonical_scheme", "from": text, "to": canon}
            record("redundancy", canon, [inp("value", c)], conv)
        else:
            bad(c, f"{_q(text)} is not one of {', '.join(sorted(_REDUNDANCY))}, the schemes the loader accepts")

    # ---- the fraction (derating on a transformer, step-load on a UPS)
    fkey = _FRACTION_KEY[kind]
    if not optional_empty(fkey, "fraction"):
        c, raw = cell("fraction")
        dec = number(c)
        if dec is not None:
            if not dec.positive():
                bad(c, f"{_q(raw.strip())} must be above zero (a fraction of 1)")
            elif not dec.at_most_one():
                bad(c, f"{_q(raw.strip())} must be at most 1 (a fraction, not a percentage; 0.9, not 90)")
            else:
                record(fkey, _json_number(dec.to_float()), [inp("value", c)])

    # ---- lead time in weeks (transformers only)
    if kind == "transformers":
        if not optional_empty("replacement_lead_time_weeks", "lead"):
            c, raw = cell("lead")
            dec = number(c)
            if dec is not None:
                if not dec.positive():
                    bad(c, f"{_q(raw.strip())} must be above zero weeks (leave the cell empty to leave the lead time out)")
                else:
                    weeks = dec.to_float()
                    if ceiling("transformers.replacement_lead_time_weeks", weeks, c, f"{raw.strip()} weeks"):
                        record("replacement_lead_time_weeks", _json_number(weeks), [inp("value", c)])

    if len(problems) > start:
        return None
    ordered = {k: item[k] for k in _FIELDS[kind] if k in item}
    ordered_fields = {k: fields[k] for k in _FIELDS[kind] if k in fields}
    ordered_omitted = {k: omitted[k] for k in _FIELDS[kind] if k in omitted}
    return ordered, ordered_fields, ordered_omitted


# ----------------------------------------------------------------------------------------------------------------- files and merge
def _size_message(n: int) -> str:
    return (f"the file is {n:,} bytes, over the {MAX_BYTES // 1024} KiB this importer reads; a schedule export is far smaller. "
            "Split it, or remove the columns and sheets that are not the schedule")


def _read_bounded(path: Path, limit: int, what: str) -> bytes:
    """The file's bytes, refusing a missing file, a directory, an unreadable one, or one over `limit` (without reading all of it)."""
    try:
        is_dir = path.is_dir()
    except (OSError, ValueError):
        is_dir = False                                   # open() below names the real problem
    if is_dir:
        raise ScheduleImportError(f"{path} is a directory, not a {what} file")
    try:
        with open(path, "rb") as fh:
            data = fh.read(limit + 1)
    except FileNotFoundError:
        raise ScheduleImportError(f"no such {what} file: {path}") from None
    except (OSError, ValueError) as exc:                 # ValueError: a path with an embedded NUL, from a caller that is not the command line
        raise ScheduleImportError(f"cannot read the {what} file {path!r}: {getattr(exc, 'strerror', None) or exc.__class__.__name__}") from None
    if len(data) > limit:
        try:
            real = path.stat().st_size
        except OSError:
            real = len(data)
        raise ScheduleImportError(_size_message(real) if what == "schedule" else
                                  f"the {what} file {path.name} is {real:,} bytes, over the {limit // 1024} KiB limit on an intake document")
    return data


def _read_into(path: Path) -> dict:
    data = _read_bounded(path, MAX_INTAKE_BYTES, "--into intake")
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except UnicodeDecodeError:
        raise ScheduleImportError(f"{path.name} is not valid UTF-8, so it is not an intake document") from None
    except json.JSONDecodeError as exc:
        raise ScheduleImportError(f"{path.name} is not valid JSON ({exc.msg}, line {exc.lineno}), so it is not an intake document") from None
    except RecursionError:
        raise ScheduleImportError(f"{path.name} is nested too deeply to be an intake document") from None
    if not isinstance(doc, dict):
        raise ScheduleImportError(f"{path.name} must hold a JSON object, as an intake does, not {type(doc).__name__}")
    return doc


def _dump(obj: Any, what: str) -> str:
    try:
        return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    except RecursionError:
        raise ScheduleImportError(f"the {what} is nested too deeply to write") from None
    except (TypeError, ValueError) as exc:
        raise ScheduleImportError(f"the {what} cannot be written as JSON ({exc})") from None


def _shown(value: Any, limit: int = 40) -> str:
    """A JSON value for a diff line: compact, ASCII-escaped (so a control character is never emitted), clipped."""
    try:
        return _clip(json.dumps(value, ensure_ascii=True), limit)
    except (RecursionError, TypeError, ValueError):
        return "(cannot be shown)"


def _ident(item: Any, n: int) -> str:
    if isinstance(item, dict) and isinstance(item.get("id"), (str, int)) and not isinstance(item.get("id"), bool):
        return _clip(ascii(str(item["id"]))[1:-1], MAX_ID_CHARS)
    return f"#{n}"


def _describe(item: Any) -> str:
    if isinstance(item, dict):
        return ", ".join(f"{k}={_shown(v)}" for k, v in item.items() if k != "id")
    return _shown(item)


def section_diff(existing: Any, imported: list[dict]) -> list[str]:
    """Diff-style lines for replacing `existing` by `imported`, by id: `-` removed, `+` added, `~` changed (field by field), `=` unchanged."""
    lines: list[str] = []
    new_by_id = {_ident(item, n): item for n, item in enumerate(imported)}
    matched: set[str] = set()
    if not isinstance(existing, list):
        lines.append(f"- (the existing value is {type(existing).__name__}, not a list of items)")
    else:
        for n, old in enumerate(existing):
            ident = _ident(old, n)
            new = new_by_id.get(ident)
            if new is None or ident in matched:
                lines.append(f"- {ident}  {_describe(old)}")
                continue
            matched.add(ident)
            if old == new:
                lines.append(f"= {ident}  unchanged")
                continue
            keys = list(old) + [k for k in new if k not in old] if isinstance(old, dict) else list(new)
            changes = []
            for k in keys:
                if k == "id":
                    continue
                has_old, has_new = isinstance(old, dict) and k in old, k in new
                if has_old and has_new and old[k] == new[k]:        # compare values, not their spelling: 5.0 and 5 are the same figure
                    continue
                before = _shown(old[k]) if has_old else "(absent)"
                after = _shown(new[k]) if has_new else "(absent)"
                changes.append(f"{k} {before} -> {after}")
            lines.append(f"~ {ident}: " + ("; ".join(changes) if changes else "changed"))
    for ident, item in new_by_id.items():
        if ident not in matched:
            lines.append(f"+ {ident}  {_describe(item)}")
    return lines


def _is_empty_section(value: Any) -> bool:
    return value is None or (isinstance(value, list) and not value)


@dataclass
class ImportResult:
    """Everything one import produced. Nothing has been written: `write_outputs` does that, after every check has passed."""
    kind: str
    items: list[dict]
    document: dict                      # what -o will hold: the section alone, or the merged intake
    ledger: dict
    out_text: str
    ledger_text: str
    parsed: Parsed
    source_name: str
    merged_into: str | None             # the --into file's name
    replaced: list[str]                 # section_diff lines when an existing, non-empty section was replaced
    gaps: list[Any]                     # DataGap rows the real loader left for THIS section
    warnings: list[str]                 # the loader's warnings about THIS section
    can_issue: bool | None              # None: not assessed (no --into intake)
    other_required_gaps: int | None     # required gaps elsewhere in the --into intake
    evidence: dict[str, dict[str, str]] = field(default_factory=dict)      # id -> {figure: class the LOADER gave it}


def _load_checked(document: dict, base: dict | None, kind: str, into_name: str | None):
    """The real loader on the result. If it refuses, say whose fault: the schedule's, or an intake that does not load whatever the section holds."""
    try:
        return load_document(document)
    except IntakeError as exc:
        if base is not None:
            stripped = dict(base)
            stripped[kind] = []
            try:
                load_document(stripped)
            except IntakeError as base_exc:
                raise ScheduleImportError(f"the intake itself does not load, whatever the {kind} section holds ({into_name}): {base_exc}") from None
            except RecursionError:
                raise ScheduleImportError(f"the intake ({into_name}) is nested too deeply to load") from None
        raise ScheduleImportError(f"the loader refuses the imported {kind} schedule: {exc}") from None
    except RecursionError:
        raise ScheduleImportError("the document is nested too deeply to load") from None


_EVIDENCE_KEYS = {"transformers": ("unit_rating_MVA", "derating_factor", "replacement_lead_time_weeks"), "ups": ("unit_rating_kW", "step_load_capability")}


def _loader_evidence(intake: Any, kind: str, items: list[dict]) -> dict[str, dict[str, str]]:
    """The evidence class the LOADER gave each figure this file supplied. Read back, never set or asserted here."""
    banks = intake.context.power.transformers if kind == "transformers" else intake.context.power.ups
    out: dict[str, dict[str, str]] = {}
    for item, bank in zip(items, banks):
        classes = {}
        for key in _EVIDENCE_KEYS[kind]:
            ev = getattr(getattr(bank, key, None), "evidence", None)
            if key in item and ev is not None:
                classes[key] = ev.short
        out[item["id"]] = classes
    return out


def _in_section(path: str, kind: str) -> bool:
    return path == kind or path.startswith((f"{kind}[", f"{kind}."))


def import_schedule(file: str | Path, kind: str, *, rows_are_installed: bool = False, source_label: str | None = None,
                    into: str | Path | None = None, replace: bool = False) -> ImportResult:
    """Read `file`, merge into the `into` intake if given, run the real loader on the result, and return everything. Writes nothing."""
    path = Path(file)
    try:
        if path.is_file() and path.stat().st_size > MAX_BYTES:
            raise ScheduleImportError(_size_message(path.stat().st_size))
    except OSError:
        pass                                                    # _read_bounded names the real problem
    data = _read_bounded(path, MAX_BYTES, "schedule")
    parsed = parse_schedule(data, file_name=str(path), kind=kind, rows_are_installed=rows_are_installed, source_label=source_label)

    base: dict | None = None
    replaced: list[str] = []
    into_name = Path(into).name if into is not None else None
    if into is not None:
        base = _read_into(Path(into))
        existing = base.get(kind)
        if not _is_empty_section(existing):
            diff = section_diff(existing, parsed.items)
            count = len(existing) if isinstance(existing, list) else 1
            if not replace:
                raise ScheduleImportError(
                    f"{into_name} already holds {count} item(s) in \"{kind}\"; importing would replace them, and nothing is replaced without --replace. "
                    f"What would change:\n" + "\n".join(f"    {line}" for line in diff))
            replaced = diff
        document: dict = dict(base)                              # a shallow copy: key order is kept, the section is replaced in place
        document[kind] = parsed.items
    else:
        document = {kind: parsed.items}

    out_text = _dump(document, "merged intake" if into is not None else "section")
    ledger_text = _dump(parsed.ledger, "ledger")
    intake = _load_checked(document, base, kind, into_name)
    report = intake.report
    gaps = [g for g in report.gaps if _in_section(g.path, kind)]
    warnings = [w for w in report.warnings if w.startswith((f"{kind}[", f"{kind}:"))]
    if base is None:
        # Without the hall, the loader compares the bank with its library placeholders for the site's load; that is not a finding about this file.
        warnings = [w for w in warnings if "grid.current_" not in w]
    other = None if base is None else len([g for g in report.required_gaps if not _in_section(g.path, kind)])
    return ImportResult(kind=kind, items=parsed.items, document=document, ledger=parsed.ledger, out_text=out_text, ledger_text=ledger_text, parsed=parsed,
                        source_name=path.name, merged_into=into_name, replaced=replaced, gaps=gaps, warnings=warnings,
                        can_issue=None if base is None else report.can_issue, other_required_gaps=other,
                        evidence=_loader_evidence(intake, kind, parsed.items))


# ---------------------------------------------------------------------------------------------------------------------- write
def _same_file(a: Path, b: Path) -> bool:
    try:
        if a.exists() and b.exists():
            return os.path.samefile(a, b)
        return a.resolve() == b.resolve()
    except OSError:
        return a.absolute() == b.absolute()


def write_outputs(result: ImportResult, out: str | Path, ledger: str | Path, *, source: str | Path | None = None, into: str | Path | None = None) -> None:
    """Write -o and --ledger, or nothing: every check first, then both files to temporary names beside their targets, then two renames."""
    out_p, led_p = Path(out), Path(ledger)
    problems: list[str] = []
    if _same_file(out_p, led_p):
        problems.append("-o and --ledger are the same file; the output and the ledger are two documents")
    if source is not None:
        for flag, p in (("-o", out_p), ("--ledger", led_p)):
            if _same_file(p, Path(source)):
                problems.append(f"{flag} is the input schedule itself; writing it would destroy the customer's file")
    if into is not None and _same_file(led_p, Path(into)):
        problems.append("--ledger is the --into intake; the ledger is not an intake key and would break it")
    for flag, p in (("-o", out_p), ("--ledger", led_p)):
        if p.is_dir():
            problems.append(f"{flag} {p} is a folder; give a file name")
        elif not p.parent.is_dir():
            problems.append(f"{flag}: the output folder {p.parent} does not exist")
    if problems:
        raise ScheduleImportError(problems)
    staged: list[tuple[Path, Path]] = []
    try:
        for target, text in ((out_p, result.out_text), (led_p, result.ledger_text)):
            tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            staged.append((tmp, target))
            tmp.write_text(text, encoding="utf-8", newline="\n")
        for tmp, target in staged:
            os.replace(tmp, target)
    except (OSError, UnicodeEncodeError) as exc:
        for tmp, _ in staged:
            try:
                tmp.unlink()
            except OSError:
                pass
        raise ScheduleImportError(f"could not write the output ({exc.__class__.__name__}: {getattr(exc, 'strerror', None) or exc}); nothing was written") from None


# --------------------------------------------------------------------------------------------------------------------- report
_DELIMITER_NAME = {",": "comma", ";": "semicolon", "\t": "tab"}


def format_report(result: ImportResult, out: str | Path, ledger: str | Path) -> str:
    """What was read, left out and still missing, for the operator: the unmapped and excluded rows by name, then the loader's own gaps."""
    p, led = result.parsed, result.ledger
    src = led["source"]
    lines = [f"import-schedule {result.kind}: {result.source_name}  (sha256 {src['sha256'][:12]}..., {_DELIMITER_NAME.get(p.delimiter, 'delimiter')}-delimited)"]
    if src["label"]:
        lines.append(f"  source label: {src['label']}")
    basis = led["installed_basis"]
    if basis["source"] == "status_column":
        lines.append(f"  installed rows: decided by the status column {_q(basis['header'], 60)}; only {', '.join(basis['counted_values'])} count"
                     + ("; --rows-are-installed was given and NOT applied" if basis["operator_assertion_not_applied"] else ""))
    else:
        lines.append("  installed rows: every row, because --rows-are-installed was given (the operator's assertion, recorded in the ledger)")
    skipped = [str(c["row"]) for c in p.skipped_comments]
    lines.append(f"  rows read: {p.rows_read}; imported {len(result.items)}, excluded {len(p.excluded)}; skipped {len(skipped)} comment line(s)"
                 + (f" (row {', '.join(skipped[:10])}{' ...' if len(skipped) > 10 else ''})" if skipped else "") + f" and {led['blank_lines']} blank line(s)")
    lines += ["", f"IMPORTED ({len(result.items)}) into \"{result.kind}\""]
    for rec in led["items"]:
        shown = " ".join(f"{k}={_shown(f['value'], 24)}" for k, f in rec["fields"].items() if k != "id")
        lines.append(f"  {rec['id']}  row {rec['row']}  {shown}")
    if p.excluded:
        lines += ["", f"EXCLUDED ({len(p.excluded)}) not counted as installed, and not in the output"]
        lines += [f"  {e['id'] or '(no id)'}  row {e['row']}  status {_q(e['status'])}" for e in p.excluded]
    if p.unmapped:
        lines += ["", f"UNMAPPED headers ({len(p.unmapped)}) never read (listed verbatim; nothing was guessed from them)"]
        lines += [f"  column {u['column']}  {_q(u['header'], 80)}" + (f"  ({u['note']})" if "note" in u else "") for u in p.unmapped]
    if result.replaced:
        lines += ["", f"REPLACED the existing \"{result.kind}\" section of {result.merged_into} (--replace):"] + [f"  {line}" for line in result.replaced]
    lines += ["", "EVIDENCE: this importer assigns no evidence class and asserts none; every ledger figure is verified: false (it reads a file, it cannot "
              "verify a document). The class below is what the loader gave each figure it was handed:"]
    for ident, classes in result.evidence.items():
        lines.append(f"  {ident}: " + (", ".join(f"{k} {v}" for k, v in classes.items()) or "(no rated figure supplied)"))
    lines += ["", f"STILL OPEN for \"{result.kind}\" after the real loader" + ("" if result.merged_into else " (this section checked alone)")]
    if result.gaps:
        for g in sorted(result.gaps, key=lambda g: not g.required):
            lines.append(f"  [{'REQUIRED' if g.required else 'optional'}] {g.path}: {g.label} ({g.unit})")
            lines.append(f"      assumed for now: {g.fallback_description}")
            if g.how_to_get_it:
                lines.append(f"      where it comes from: {g.how_to_get_it}")
    else:
        lines.append("  nothing: every field the loader asks of this section was given")
    if result.warnings:
        lines += ["", f"WARNINGS from the loader about \"{result.kind}\""] + [f"  ! {w}" for w in result.warnings]
    if result.can_issue is None:
        lines += ["", "Issuable as a full study: not assessed (no --into intake was given, so the rest of the hall is not known). Merge with --into to see it."]
    else:
        more = f"; {result.other_required_gaps} required input(s) are open elsewhere in the intake (run `gridforge gaps`)" if result.other_required_gaps else ""
        lines += ["", f"Issuable as a full study: {'yes' if result.can_issue else 'no'}{more}"]
    lines += ["", f"wrote {out}", f"wrote {ledger}  (provenance ledger: data, not an intake key)"]
    return "\n".join(lines)
