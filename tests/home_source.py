"""The homepage's source, now several files.

The homepage used to be one client component, components/HomeClient.tsx, and a number of tests read that file as text to check its copy,
section ids and CTAs. It is a Server Component page (app/page.tsx) assembling components/home/*.tsx. Tests that mean "the homepage" read
the concatenation of those files through HOME_PATH, so they keep checking what a visitor reads, wherever the markup lives.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: The path the older tests used for the homepage. Reading it returns the whole homepage source.
HOME_PATH = "components/HomeClient.tsx"


def home_files() -> list[Path]:
    return [ROOT / "app" / "page.tsx", *sorted((ROOT / "components" / "home").glob("*.tsx"))]


def read_text(rel: str) -> str:
    if rel == HOME_PATH:
        return "\n".join(p.read_text(encoding="utf-8") for p in home_files())
    return (ROOT / rel).read_text(encoding="utf-8")
