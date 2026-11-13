"""A hall is a physical thing: listing it twice cannot create capacity.

One rule, used by the HTTP portfolio route and the command line, so the two cannot disagree. Two entries are "the same hall" when they carry
the same DECLARED site and hall ids, or are identical documents. Entries whose ids were left to the library default (every sparse intake is
SITE-1 / HALL-1) are not assumed to be one hall.

A site is not a hall, and a grid connection is not a hall's: two DIFFERENT halls that declare the same site.id most likely draw on one connection,
and halls under different site ids that declare an identical grid block are a likely shared connection. ``declares_site_id``, ``site_key`` and
``grid_fingerprint`` read that from the documents (reporting.portfolio says it and brackets the totals; nothing is merged or solved).
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


def declares_site_id(doc) -> bool:
    """True when the document itself names its site. A site left to the library default (SITE-1) is not a declaration, so two such documents
    are never assumed to be at one site."""
    site = doc.get("site") if isinstance(doc, dict) else None
    sid = site.get("id") if isinstance(site, dict) else None
    return isinstance(sid, str) and bool(sid.strip())


def site_key(doc) -> str | None:
    """The declared site id, whitespace-collapsed and case-folded (the hall rule's normalisation), or None when the document declares none."""
    if not declares_site_id(doc):
        return None
    return hall_key(doc["site"]["id"], "")[0]


def grid_fingerprint(doc) -> str | None:
    """The document's grid block as canonical JSON, or None when it has fewer than three figures. Notes, evidence labels and the
    {value: ...} wrapping are not part of it, and 12 equals 12.0: two grid blocks with the same fingerprint declare the same figures for
    the connection. Used to say that halls under DIFFERENT site ids most likely draw on one connection; it never merges them. One or two
    round numbers in common (12 MW contracted at two sites) are a coincidence and not evidence, so a block needs at least three figures
    (the reference grid block has four; the qualifier form's has three to four) before its identity is read as a shared connection."""
    import json
    grid = doc.get("grid") if isinstance(doc, dict) else None
    if not isinstance(grid, dict) or not grid:
        return None
    leaves: dict[str, object] = {}

    def walk(v, path: str) -> None:
        if isinstance(v, dict):
            if "value" in v:
                walk(v["value"], path)
                return
            for k, x in v.items():
                walk(x, f"{path}.{k}" if path else str(k))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, f"{path}[{i}]")
        elif v is not None:
            leaves[path] = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v

    walk(grid, "")
    if len(leaves) < 3:
        return None
    try:
        return json.dumps(sorted(leaves.items()), default=str)
    except (TypeError, ValueError):
        return None


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
