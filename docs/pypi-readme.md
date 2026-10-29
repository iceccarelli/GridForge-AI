# gridforge: capacity envelope engine for AI data-centre halls

Answers one question: **how much AI compute can this hall carry, what binds first, and what does each step of extra density cost?**

It takes a description of a hall (grid connection, transformers, UPS, low-voltage distribution, rack feed, cooling plant, floor and white space) and a GPU platform, and solves every constraint at once. The result is a rack count, the constraint that binds first, and a headroom ladder: relieve the binding constraint, solve again, and see what the next one is.

```bash
pip install gridforge

gridforge init -o intake.json         # a blank intake to send a client
gridforge gaps    intake.json         # the data request: what is missing and why it matters
gridforge screen  intake.json -o out  # a Density Screen
gridforge study   intake.json -o out  # a Capacity & Density Envelope Study
gridforge portfolio halls/*.json -o out
```

```python
from gridforge.intake.loader import load
from gridforge.envelope import solve, ladder

intake = load("intake.json")
result = solve(intake.context)    # max racks, binding constraint, every constraint evaluated
steps = ladder(intake.context)    # the Headroom Ladder
```

## What it is, and what it is not

- **No required dependencies.** The engine imports only the Python standard library (Python 3.11 or newer), so it can be reviewed and run in an air-gapped environment. One optional economics adapter uses GridOS and NumPy if you install them, and reports that it is not wired if you do not.
- **A screening model, not a design.** It is not a design package, carries no design liability, and does not replace a structural, electrical or thermal engineer's sign-off.
- **Every input carries an evidence class (E0 to E7), and every result carries the weakest class that went into it.** A figure the intake did not supply is filled from a library default, labelled as an assumption, and listed in the data request. Nothing is filled in silently.
- **The calibration ledger shipped in this package is empty.** The models have not been checked against measured data from a real hall, and the outputs say so.
- **A missing cost, lead time or availability is never treated as zero** and never produces a date.
- **Lead times are labelled.** A date that rests on an assumed lead time is reported as an assumed lead time, not as a date.

The hosted API, human-reviewed engagements and the source repository are at https://github.com/iceccarelli/GridForge-AI.
