"""Where observations live, and the rule about what may be committed.

Same split as the cost library, for the same reason. A client's metered hall data
is confidential and is frequently the most commercially sensitive number they
have. It must never enter the repository or the Docker image.

    BUNDLED   gridforge/data/calibration.json   — the published aggregate, and only
                                                   observations we are free to publish
    PRIVATE   calibration.local.json            — gitignored, overlaid at runtime

The bundled file ships empty on purpose. An empty ledger is a true statement about
where this business is; a seeded one would be the first lie in a product whose only
durable advantage is that it does not tell them.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from .schema import Observation, ObservationError

BUNDLED_PATH = Path(__file__).resolve().parents[1] / "data" / "calibration.json"
PRIVATE_FILENAME = "calibration.local.json"


def private_path() -> Path:
    env = os.environ.get("GRIDFORGE_CALIBRATION_LEDGER")
    return Path(env) if env else Path.cwd() / PRIVATE_FILENAME


@dataclass
class Ledger:
    observations: list[Observation] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    #: True when a private ledger was found and merged.
    private_loaded: bool = False

    def keys(self) -> list[str]:
        return sorted({o.key for o in self.observations})

    def for_key(self, key: str) -> list[Observation]:
        return [o for o in self.observations if o.key == key]

    def to_dict(self) -> dict:
        return {"observations": [o.to_dict() for o in self.observations]}


def _read(path: Path) -> list[Observation]:
    if not path.exists():
        return []
    text = path.read_text().strip()
    if not text:
        return []          # a touched-but-empty ledger is empty, not corrupt
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ObservationError(f"{path}: not valid JSON ({exc})")
    raw = doc.get("observations") if isinstance(doc, dict) else doc
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ObservationError(f"{path}: 'observations' must be a list")
    return [Observation.from_dict(d) for d in raw]


def load_ledger(published_only: bool = False) -> Ledger:
    """The ledger in effect. `published_only` drops the private overlay — used when
    the output is going somewhere public, so client site data cannot escape through
    a build script that forgot which ledger it was reading."""
    obs = _read(BUNDLED_PATH)
    sources = [str(BUNDLED_PATH)] if BUNDLED_PATH.exists() else []
    if published_only:
        return Ledger(observations=obs, sources=sources, private_loaded=False)
    p = private_path()
    private = _read(p)
    if private:
        sources.append(str(p))
    return Ledger(observations=obs + private, sources=sources,
                  private_loaded=bool(private))


def append_observation(obs: Observation, path: Path | None = None) -> Path:
    """Write one observation to the private ledger.

    Refuses the bundled file outright. There is no flag to override this: the one
    way client site data ends up published is a hurried engineer reaching for a
    convenient default, so the convenient default must be impossible.
    """
    target = Path(path) if path else private_path()
    if target.resolve() == BUNDLED_PATH.resolve():
        raise ObservationError(
            "the bundled ledger is published with the engine and may not hold client "
            f"site data. Write to {PRIVATE_FILENAME} (gitignored) instead.")
    existing = _read(target)
    for o in existing:
        if (o.key, o.site_ref, o.observed_on) == (obs.key, obs.site_ref, obs.observed_on):
            raise ObservationError(
                f"{obs.key} for {obs.site_ref} on {obs.observed_on} is already recorded — "
                f"an observation counted twice inflates n and understates the spread")
    existing.append(obs)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(
        {"observations": [o.to_dict() for o in existing]}, indent=2) + "\n")
    return target
