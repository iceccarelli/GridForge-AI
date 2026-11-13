"""Every image the site serves from public/ is one something actually uses.

public/og.png was served at timetopower.ai/og.png and referenced nowhere. It still carried the positioning
the company moved away from ("Behind-the-meter power . DC distribution . physics-informed EMS", a bar
labelled "On-site (GridForge) 18 mo", "4.5 yrs recovered"), which says the opposite of what the company is:
GridForge is an engineering and decision platform; it supplies no power, sells no equipment and owns no
megawatts. A file nobody links to is a file nobody reviews, so it kept saying that to anyone who found it.

The rule: an image under public/ must be named (by file name or by path) in the site's own sources, or sit on
ALLOWED_UNREFERENCED with the reason it is served anyway. The reference check is word-bounded, so
`big-og.png` is not a reference to `og.png`.
"""
from __future__ import annotations

import re
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico", ".gif"}

#: Where a reference counts: the app, its libraries and components, the scripts that build or check assets, the
#: framework configuration, and the manifests that live inside public/ itself. Tests do not count: a test that
#: names a file proves the file is checked, not that anything shows it.
SOURCE_DIRS = ("app", "lib", "components", "scripts")
SOURCE_FILES = ("next.config.ts", "vercel.json")
SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".css", ".md", ".mdx", ".html", ".xml", ".txt", ".webmanifest", ".svg"}

#: file (relative to public/) -> one line saying why it is served though no source names it. Empty on purpose: the
#: icons are named by app/layout.tsx and app/manifest.ts, favicon.ico by app/layout.tsx and the share-card check,
#: logo.png by lib/entity.ts, and the photographs by lib/ttp-images.ts. Add an entry only with a reason.
ALLOWED_UNREFERENCED: dict[str, str] = {}


def images(public: Path) -> list[Path]:
    return sorted(p for p in public.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)


def source_text(root: Path, public: Path) -> list[tuple[Path, str]]:
    files: list[Path] = [root / f for f in SOURCE_FILES if (root / f).is_file()]
    for d in SOURCE_DIRS:
        base = root / d
        if base.is_dir():
            files += [p for p in base.rglob("*") if p.is_file() and p.suffix.lower() in SOURCE_SUFFIXES]
    # Manifests and pages inside public/ (e.g. a web manifest or an HTML reference page naming its own images).
    files += [p for p in public.rglob("*") if p.is_file() and p.suffix.lower() in {".json", ".webmanifest", ".html", ".xml", ".txt", ".md"}]
    out: list[tuple[Path, str]] = []
    for p in files:
        if "node_modules" in p.parts:
            continue
        try:
            out.append((p, p.read_text(encoding="utf-8")))
        except (UnicodeDecodeError, OSError):
            continue
    return out


def referenced(image: Path, public: Path, sources: list[tuple[Path, str]]) -> list[Path]:
    """Sources that name the image by its file name or its path under public/, as a whole token."""
    rel = image.relative_to(public).as_posix()

    # A reference must not be glued to more of a file name on either side: `big-og.png`, `og.png.bak` and `x/og.pngx` are not `og.png`.
    def token(name: str) -> re.Pattern[str]:
        return re.compile(r"(?<![A-Za-z0-9_.\-])" + re.escape(name) + r"(?![A-Za-z0-9_\-]|\.[A-Za-z0-9])")

    patterns = [token(image.name), token(rel)]
    hits = []
    for src, text in sources:
        if src == image:
            continue
        if any(p.search(text) for p in patterns):
            hits.append(src)
    return hits


def unreferenced(root: Path) -> list[str]:
    public = root / "public"
    sources = source_text(root, public)
    return [
        i.relative_to(public).as_posix()
        for i in images(public)
        if i.relative_to(public).as_posix() not in ALLOWED_UNREFERENCED and not referenced(i, public, sources)
    ]


# --- the repository ---------------------------------------------------------------------------------------------------------


def test_every_public_image_is_referenced_or_explicitly_allowed():
    orphans = unreferenced(ROOT)
    assert not orphans, (
        "images served from public/ that nothing in app/, lib/, components/, scripts/ or the public manifests names "
        "(delete them, reference them, or add them to ALLOWED_UNREFERENCED with a reason):\n  " + "\n  ".join(orphans)
    )


def test_the_stale_open_graph_card_is_gone():
    """The share card each page serves is generated from its own data (lib/share-content.ts, lib/page-cards.ts). The old
    static one showed a supply-power story the company does not tell."""
    assert not (ROOT / "public" / "og.png").exists()


def test_the_allow_list_does_not_rot():
    public = ROOT / "public"
    sources = source_text(ROOT, public)
    for rel, reason in ALLOWED_UNREFERENCED.items():
        assert reason.strip() and "\n" not in reason, f"{rel}: one line of reason is required"
        f = public / rel
        assert f.is_file(), f"{rel} is on the allow-list but does not exist; remove the entry"
        assert not referenced(f, public, sources), f"{rel} is now referenced; remove it from the allow-list"


# --- the checker itself (a rule that cannot fail is not a rule) -------------------------------------------------------------------


def _tree(files: dict[str, str | bytes]) -> Path:
    root = Path(tempfile.mkdtemp(prefix="public-assets-"))
    for name, body in files.items():
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body if isinstance(body, bytes) else body.encode())
    return root


def test_the_checker_flags_an_image_nothing_names():
    root = _tree({"public/og.png": b"x", "public/logo.png": b"x", "lib/entity.ts": 'siteUrl("/logo.png")'})
    assert unreferenced(root) == ["og.png"]


def test_a_longer_file_name_is_not_a_reference():
    root = _tree({"public/og.png": b"x", "lib/a.ts": 'const a = "/cards/big-og.png"; const b = "og.png.bak"; const c = "x/og.pngx"'})
    assert unreferenced(root) == ["og.png"]


def test_a_path_or_a_bare_name_in_a_source_is_a_reference():
    root = _tree({
        "public/images/a.webp": b"x",
        "public/b.ico": b"x",
        "lib/p.ts": 'src: "/images/a.webp"',
        "app/layout.tsx": '{ url: "/b.ico", sizes: "any" }',
    })
    assert unreferenced(root) == []


def test_a_reference_from_a_test_does_not_count():
    root = _tree({"public/og.png": b"x", "tests/site/x.test.ts": 'readFileSync("public/og.png")'})
    assert unreferenced(root) == ["og.png"]


def test_the_image_naming_itself_is_not_a_reference():
    root = _tree({"public/icon.svg": '<svg><!-- icon.svg --></svg>'})
    assert unreferenced(root) == ["icon.svg"]


def test_an_image_in_a_public_manifest_counts():
    root = _tree({"public/c.png": b"x", "public/site.webmanifest": '{"icons":[{"src":"/c.png"}]}'})
    assert unreferenced(root) == []
