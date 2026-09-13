# Delivery runbook

One JSON file per hall. Everything else is a command.

## The engagement, end to end

| Step | Command | Send the client | Charge |
|---|---|---|---|
| 1. First call | `python3 -m gridforge init -o intake.json` | the blank intake | — |
| 2. They send it back part-filled | `python3 -m gridforge gaps intake.json` | the data request, verbatim from the output | — |
| 3. Screen | `python3 -m gridforge screen intake.json -o out/` | `density_screen.pdf` + the gap list | **€4,500**, credited against step 4 |
| 4. Study | `python3 -m gridforge study intake.json -o out/` | `envelope_study.*` + `model_pack.json` | **€22k–€45k** |
| 5. Portfolio | `python3 -m gridforge portfolio examples/intake/*.json -o out/ --client "X"` | ranked table + one model pack per hall | **€60k–€140k** |

`model_pack.json` is part of the deliverable, not an internal artefact. It is what lets a client
re-run the conclusion when their inputs change, and it is what makes the next engagement cheap.

## Rules that do not bend

- **Never issue on assumptions.** `gaps` tells you whether the intake supports a study
  (`can_issue`). If it does not, sell the screen. The reports run in SCREENING mode and carry a
  mandatory evidence disclosure; `ReportMode.ISSUED` will refuse a deliverable whose capacity
  claims sit below their evidence floor, which is the behaviour you want the day a client asks
  their lender to rely on it.
- **The gap list is a product, not an apology.** "Here are the eleven numbers that decide your
  answer, seven of which nobody has measured" is the sentence that sells step 4 from step 3.
- **Ask the objective before you show a ranking.** Max compute, min cost per rack and fastest to
  power routinely disagree. `--objective` sets it and the report states which one drove the answer.
- **Never quote equipment.** The relief options carry indicative capex so the ladder has a shape;
  they are not a bill of materials and we do not take a margin on hardware.

## The engine as a service

```bash
python3 -m gridforge serve --port 8080          # stdlib only, no dependencies
docker build -t gridforge . && docker run -p 8080:8080 -e GRIDFORGE_API_KEYS=... gridforge
```

| Endpoint | Tier | What it is for |
|---|---|---|
| `POST /v1/qualify` | public | The website qualifier. Seven fields, real binding constraint, no priced content. |
| `POST /v1/screen` | key | Screen payload for a client integration. |
| `POST /v1/study` | key | The full model pack. |
| `POST /v1/portfolio` | key | Ranked halls. |
| `GET /v1/platforms`, `/v1/intake/template`, `/v1/version`, `/health` | public | Discovery. |

Set `GRIDFORGE_API_URL` on the website to point at it, and `GRIDFORGE_API_KEY` only if you want the
site to reach the paid endpoints. **With no `GRIDFORGE_API_KEYS` set on the engine, the paid
endpoints refuse rather than open** — a misconfigured deployment must fail closed, not serve the
deliverable for free. With no `GRIDFORGE_API_URL` set on the site, `/qualify` captures the enquiry
and says plainly that no result was produced; it never invents a number.

**The physics exists once.** There is no TypeScript reimplementation of the constraints, and there
must never be: two versions of the truth is precisely what a provenance-first product cannot
survive.

## What CI guarantees before you send anything

`.github/workflows/gridforge.yml` runs, on every push that touches the engine:

- the full test suite on Python 3.11 and 3.13;
- `init` -> `gaps` -> `screen` -> `study` on a **blank** intake, because that is the worst
  input a real client will ever hand back and it must never crash;
- `screen` and `study` for every shipped example intake, and a `portfolio` across all of them;
- the reference project;
- the public qualifier answers and leaks no currency figure, and the paid endpoints refuse
  without a key;
- the website typechecks, lints and builds.

A green build means the commands in this runbook work. A red one means do not send anything.

## Per-project time

Intake assembly and judgement are the only manual work left. Everything the engine does — context
assembly, five scenarios, the ladder, time to power, sensitivity, economics, the report, the
provenance appendix, the model pack — is one command. Track hours per project; when a step keeps
reappearing as manual work, it belongs in here.
