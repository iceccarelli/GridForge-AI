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
