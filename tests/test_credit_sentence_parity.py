"""'Credits in full' states its conditions on every surface, engine documents included.

The website's one sentence (lib/credits-terms.ts SCREEN_CREDIT_SENTENCE) says what the code that honours the credit applies: once, for the same
email address after the buyer is confirmed, whole and only while deposit plus credit stay within the fee, never cash, nothing for a refunded or
disputed purchase. The delivered Density Screen and the proposal used to say 'This screen's fee credits in full against it' and 'Credits in full
against the envelope study' with none of that (found by the account-and-billing track, finished here).
"""
import ast
import re
from pathlib import Path

from gridforge.commercial import SCREEN_CREDIT_SENTENCE, engagement
from gridforge.intake.loader import load
from gridforge.reporting import to_markdown
from gridforge.reporting.proposal import build as build_proposal
from gridforge.reporting.screen import build as build_screen
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]


def _ts_sentence() -> str:
    src = (ROOT / "lib" / "credits-terms.ts").read_text(encoding="utf-8")
    body = src.split("export const SCREEN_CREDIT_SENTENCE =", 1)[1].split(";", 1)[0]
    return "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', body))


def test_the_engine_sentence_is_the_websites_sentence():
    assert SCREEN_CREDIT_SENTENCE == _ts_sentence()


def _solved():
    intake = load(ROOT / "examples" / "intake" / "reference_hall.json")
    return intake, run_all(intake.context, intake.scenarios)


def test_the_proposal_states_the_conditions_not_credits_in_full():
    intake, results = _solved()
    md = to_markdown(build_proposal(intake, results, engagement("density_screen")))
    assert SCREEN_CREDIT_SENTENCE in md
    assert "Credits in full against" not in md


def test_the_delivered_screen_states_the_conditions_not_credits_in_full():
    intake, results = _solved()
    md = to_markdown(build_screen(intake, results))
    assert SCREEN_CREDIT_SENTENCE in md
    assert "credits in full against it" not in md


def test_the_delivered_screen_has_no_credit_promise_anywhere_in_it_footer_included():
    intake, results = _solved()
    report = build_screen(intake, results)
    md = to_markdown(report)
    assert not PROMISE.search(re.sub(r"\s+", " ", md)), "the rendered Density Screen still says 'credits in full'"
    assert SCREEN_CREDIT_SENTENCE in report.footer


# ---- a tree scan, so the unconditional promise cannot survive in a string nobody listed -------------------------------------------------------
# The tests above name the Screen and the proposal. The delivered Screen's FOOTER ("credits in full against a Capacity & Density Envelope
# Study") survived them, because it was split across two adjacent string literals and none of them looked at it. This reads every string in
# gridforge/ the way the interpreter does: adjacent literals joined, `+` folded, f-string text kept, ' '.join of literals folded, then every
# run of whitespace one space. Docstrings and comments are not scanned: they are not output. The deposit's wording, "credited in full against
# the agreed fee", names its condition and is not matched ("credited" is not "credits").

PROMISE = re.compile(r"credits?\s+in\s+full", re.IGNORECASE)


def _fold(node: ast.AST) -> str | None:
    """The string a constant expression evaluates to, or None when any part of it is not constant text."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(v.value if isinstance(v, ast.Constant) and isinstance(v.value, str) else "\0" for v in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _fold(node.left), _fold(node.right)
        return None if left is None or right is None else left + right
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "join" and len(node.args) == 1
            and isinstance(node.args[0], (ast.List, ast.Tuple))):
        sep = _fold(node.func.value)
        parts = [_fold(e) for e in node.args[0].elts]
        return None if sep is None or any(p is None for p in parts) else sep.join(p for p in parts if p is not None)
    return None


def _strings_of(source: str) -> list[tuple[int, str]]:
    tree = ast.parse(source)
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                docstrings.add(id(first.value))
    found: list[tuple[int, str]] = []

    def visit(node: ast.AST) -> None:
        if id(node) in docstrings:
            return
        text = _fold(node)
        if text is not None:
            found.append((getattr(node, "lineno", 0), re.sub(r"\s+", " ", text)))
            return
        for child in ast.iter_child_nodes(node):
            visit(child)

    visit(tree)
    return found


def test_the_scanner_sees_the_shapes_the_promise_was_typed_in():
    shapes = [
        'x = ("The fee for this screen "\n     "credits in full against a Study.")',
        'x = "The fee credits " + "in full"',
        'x = f"The fee {y} credits\\nin full"',
        'x = " ".join(["The fee credits", "in full against a Study"])',
        'x = ("credits\\n"\n     "   in full")',
        'x = "Credits in full against the envelope study"',
    ]
    for src in shapes:
        assert any(PROMISE.search(t) for _, t in _strings_of(src)), src
    # Not output, or conditioned: a docstring, and the deposit's own wording.
    assert not any(PROMISE.search(t) for _, t in _strings_of('def f():\n    """It credits in full."""\n    return 1'))
    assert not any(PROMISE.search(t) for _, t in _strings_of('x = "A deposit on commissioning, credited in full against the agreed fee."'))


def test_credits_in_full_is_typed_nowhere_in_the_engine():
    offenders = []
    for path in sorted((ROOT / "gridforge").rglob("*.py")):
        for line, text in _strings_of(path.read_text(encoding="utf-8")):
            if PROMISE.search(text):
                offenders.append(f"{path.relative_to(ROOT)}:{line}")
    assert offenders == [], "an unconditional credit promise in an engine string (use SCREEN_CREDIT_SENTENCE): " + ", ".join(offenders)


def test_the_non_python_files_of_the_engine_carry_no_such_promise():
    offenders = []
    for path in sorted((ROOT / "gridforge").rglob("*")):
        if path.is_file() and path.suffix in {".json", ".md", ".html", ".txt", ".yaml", ".yml"}:
            if PROMISE.search(re.sub(r"\s+", " ", path.read_text(encoding="utf-8"))):
                offenders.append(str(path.relative_to(ROOT)))
    assert offenders == []


def test_the_deposit_wording_that_stays_names_its_condition():
    src = (ROOT / "gridforge" / "commercial.py").read_text(encoding="utf-8")
    texts = [t for _, t in _strings_of(src) if re.search(r"credit(?:s|ed)?\s+in\s+full", t, re.IGNORECASE)]
    assert texts, "the deposit wording is expected in commercial.py"
    for t in texts:
        assert "credited in full against the agreed fee" in t
        assert not PROMISE.search(t)
