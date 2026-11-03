"""A hall is a physical thing: listing it twice cannot create capacity.

One rule, used by the HTTP portfolio route and the command line, so the two cannot disagree. Two entries are "the same hall" when they carry
the same DECLARED site and hall ids, or are identical documents. Entries whose ids were left to the library default (every sparse intake is
SITE-1 / HALL-1) are not assumed to be one hall.
"""
from __future__ import annotations


def declares_hall_ids(doc) -> bool:
    """True when the document itself names both its site and its hall (rather than leaving them to the library's default ids)."""
    if not isinstance(doc, dict):
        return False
    site, hall = doc.get("site"), doc.get("hall")
    ids = (site.get("id") if isinstance(site, dict) else None, hall.get("id") if isinstance(hall, dict) else None)
    return all(isinstance(v, str) and v.strip() for v in ids)


def is_repeat(doc, earlier_doc) -> bool:
    """Whether `doc` repeats `earlier_doc`, given they resolved to the same (site id, hall id)."""
    return (declares_hall_ids(doc) and declares_hall_ids(earlier_doc)) or doc == earlier_doc


def hall_key(site_id: str, hall_id: str) -> tuple[str, str]:
    """The identity of a hall for the duplicate rule: whitespace-collapsed and case-folded, so ' DH-02 ', 'dh-02' and 'DH-02' are one hall."""
    norm = lambda v: " ".join(str(v).split()).casefold()  # noqa: E731
    return norm(site_id), norm(hall_id)


_IDENTITY_KEYS = {"site": ("id", "name"), "hall": ("id", "name")}


def physics_fingerprint(doc) -> str | None:
    """The document with every identifier and name removed, as canonical JSON, or None when it is not an object. Two halls with the same
    fingerprint are identical in every figure and share, on the face of it, one grid connection and one set of peak figures."""
    import json
    if not isinstance(doc, dict):
        return None
    body = {k: v for k, v in doc.items() if k != "project"}
    for section, keys in _IDENTITY_KEYS.items():
        if isinstance(body.get(section), dict):
            body[section] = {k: v for k, v in body[section].items() if k not in keys}
    try:
        return json.dumps(body, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return None


def identical_physics_warning(index: int, earlier_index: int) -> str:
    return (f"intakes[{index}] is identical to intakes[{earlier_index}] in every figure and differs only in its site and hall identifiers. "
            f"Identical halls share, on the face of it, one grid connection and one set of peak figures, so this is more likely one hall "
            f"listed twice than two halls: if so, the total racks counts it twice. Remove the repeat, or give each hall its own measured "
            f"inputs.")
