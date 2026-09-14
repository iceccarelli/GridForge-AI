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

## The money loop, once the engine is deployed

```
/qualify  ->  Commission the Density Screen (Stripe, EUR 4,500)
          ->  webhook opens a deliverable and emails an intake link
          ->  client fills /intake/<token> with the hall's numbers
          ->  engine generates the document  (automatic)
          ->  YOU release it                 (deliberately not automatic)
          ->  client reads /deliverable/<token>
```

Release is a separate human act and must stay one. Generating a document from an
intake is leverage; publishing an unreviewed engineering opinion with your name on it
is not a business, it is a liability. Release with:

```bash
curl -X PATCH https://<site>/api/admin/deliverables \
  -H 'content-type: application/json' -b "gf_admin=<cookie>" \
  -d '{"token":"<token>","action":"release"}'
```

Deploy the engine first, or none of this runs. One command, from a Codespace or any
Linux shell — it installs flyctl if it is missing, creates the app, generates the key,
deploys, and prints the two variables the website needs:

```bash
bash scripts/deploy-engine.sh
```

`render.yaml` is there if you prefer Render. Either way the engine has no database and
no dependencies, so it scales to zero and costs single-digit euros a month.

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

## The cost library — the line that compounds

Every relief price starts as a placeholder with a -50%/+100% band, and the study says
so on its own face: *"7 of 8 priced lines are library placeholders."* Each quotation
you record replaces one, raises the evidence class of everything derived from it, and
tightens the whole estimate. The AACE accuracy class follows the **weakest** line, so
one placeholder still drags a study back to Class 5 — averaging would be dishonest.

```bash
python3 -m gridforge cost list
python3 -m gridforge cost add --key tapoff.unit --label "tap-off unit and rack feed" \
  --unit EUR/rack --value 5200 --basis firm_quote \
  --supplier "Acme" --quoted-on 2026-09-01 --valid-until 2026-12-31 --region DE
```

Bases, weakest first: `library_default` (E0) · `published_benchmark` (E1) ·
`budgetary_quote` (E3) · `firm_quote` (E5) · `contracted` (E7, what was actually paid).
An expired quotation is automatically demoted to a modelled figure — a price with a
lapsed validity date is not a price.

**Quote the constraint that binds first.** On a typical hall that is the tap-off rating
or the transformer, and one quotation there moves the headline number more than five
elsewhere. Two real quote sets turn this library into something no competitor can
reconstruct from public sources, and it is worth more with every engagement.

## Proposals that open with a finding

```bash
python3 -m gridforge proposal intake.json --engagement density_screen -o out
```

Or one click from `/admin/pipeline` on any qualified hall — it generates the document,
stores it with its own link, and opens it.

The proposal names the binding constraint, the deployable racks and the date-setting
item **before** it names a price, because the engine has already run. A consultancy
cannot send that, since producing the finding is their engagement. The data request in
section 3 is the same gap list the engine generates, so the proposal tells the client
exactly what to go and measure whether or not they buy.

`gridforge/commercial.py` and `lib/products.ts` are two price lists in two languages;
a test parses the TypeScript and fails the build if they ever disagree. A proposal that
quotes a different number from the checkout page is worse than no proposal.

## Working the pipeline

`/admin/pipeline` is where the money is. It shows every purchased engagement with its
state, what is sitting in **draft waiting on your review**, and every hall anyone has
run through the qualifier — as found, after the ladder, and what bound it.

The section titled *What actually binds* is the one to watch. It is the distribution of
binding constraints across every hall that has been through the engine, with the median
tap-off rating, busway ampacity, plant supply temperature and contracted headroom
behind it. Anyone competent can rebuild the physics. Nobody else is accumulating that.
At a few dozen halls it is a sales argument; at a few hundred it is a paper nobody can
write without you.

## Per-project time

Intake assembly and judgement are the only manual work left. Everything the engine does — context
assembly, five scenarios, the ladder, time to power, sensitivity, economics, the report, the
provenance appendix, the model pack — is one command. Track hours per project; when a step keeps
reappearing as manual work, it belongs in here.
