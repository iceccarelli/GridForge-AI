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

## The walkthrough deck

```bash
python3 -m gridforge deck intake.json -o out     # out/walkthrough.html
```

Nine slides generated from the same solved model as the written study, so the slide
and the report can never disagree. Arrow keys to advance; `Print to PDF` gives a
landscape deck you can send. No network, no fonts to fetch, no script from anywhere —
a client can open it on a plane.

It ships automatically with a purchased Envelope Study and appears on the client's
deliverable page next to the document. The Screen does not include one: the
walkthrough is part of the Study engagement.

**The chart colours are not the brand accents.** `#00E5FF` and `#FFB020` are interface
colours; as data marks on the panel surface they fall outside the usable lightness
band. The deck uses dimmed steps of the same hues that pass the lightness, chroma,
colour-vision-separation and contrast checks — and every value a mark encodes is also
printed, so nothing is knowable by colour alone.

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

## Hall Watch — the recurring line

```bash
python3 -m gridforge diff was.json now.json -o out    # change_note.{md,html} + change.json
```

A study is a photograph; a hall is not. Contracted power moves, tenancy frees up,
the tenant changes platform, a quotation lands. Six months later the client's question
is never "solve it again" — it is **"what moved, and why."** Nobody else can answer it,
because nobody else is holding the model.

**€6,000 a quarter.** The model is re-solved on schedule and whenever the client updates
an input, and they get a change note: what moved, which input moved it, and whether it
changes the decision. The attribution moves each input on its own and re-solves, so the
note names a cause rather than a delta — and the part the single-input probes do not
explain is **reported as a residual**, not quietly distributed, because constraints
interact and a driver table that adds up to the wrong number is worse than none.

The run that finds nothing still sends a note, in three lines. That matters more than it
sounds: a subscription that manufactures a finding every quarter to justify its fee is
one the client eventually reads for what it is.

**The answer can move without the client touching anything.** When a quotation replaces a
placeholder in the cost library, or a platform's figures are revised, the envelope moves —
and they hear it from us rather than discovering it. That is the argument for the
subscription, and it is true rather than salesmanship.

Plumbing: `/watch/<token>` for the client, `/api/cron/watches` on a weekly Vercel cron
(`vercel.json`, authorised by `CRON_SECRET`), watched halls and annualised recurring
revenue on `/admin/pipeline`. The offer sits under every delivered study.

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

## The worked example, and why it is regenerated by CI

Two things lose deals that the physics never touches. A prospect cannot see what €20k
buys until they have paid for it, and a client who has paid cannot check the arithmetic
without taking our word for it. `/reference` closes both.

It publishes a complete Envelope Study for a synthetic hall — the same document the
engine hands a paying client, from the same code path, with nothing removed. Alongside
it: the walkthrough deck, the proposal, the model pack, and the **working files** — the
CSV bundle the numbers came out of.

```
scenarios.csv        every scenario, its deployable rack count and its binding constraint
headroom_ladder.csv  each rung, what it relieves, what it costs, how long it takes
constraints.csv      all thirteen constraints evaluated, with the margin on each
inputs.csv           every input actually used, with evidence class and source
assumed_inputs.csv   every input we supplied because the client did not — the gap ledger
provenance.csv       each derived quantity, its digest, and the quantities it came from
```

Anyone can rebuild the study from those six files. That is the intent. The moat is not
opacity, it is that reproducing them requires the engine.

**Regeneration.** `bash scripts/build-reference.sh` rewrites `public/reference/` in full.
Report dates are pinned through `GRIDFORGE_REPORT_DATE` (default `2026-09-14`) and the
zip is stamped with a fixed timestamp, so two runs of the same commit are byte-identical.
The `reference` CI job runs the script and fails on `git diff --exit-code public/reference`.

That job is the point of the whole arrangement. A published worked example that has
quietly drifted from the engine is worse than none: it is a specific, checkable promise
we are no longer keeping, in public, on a page we sent prospects to. So when a change to
the engine moves the reference output, CI stops the push and the fix is one command:

```bash
bash scripts/build-reference.sh && git add public/reference
```

If the diff is not one you meant to make, it is not a stale-artefact problem — the engine
moved and you did not know. Read it before you commit it.

**The synthetic notice is load-bearing.** `model_pack.json` carries `"synthetic": true`
and a notice saying so in words, because the pack is downloadable and will be separated
from the page it came from. A modelled figure that travels without its label eventually
gets quoted as a measurement, and that is the one failure mode this business cannot
survive. CI asserts the notice is there.

**Delivered studies carry the same bundle.** Generation stores it on the deliverable
(`working_files`, migration `0006`), the client pulls each file from
`/deliverable/<token>?format=csv&file=<name>`, and admin list views strip the bundle down
to a `has_working_files` flag so it is never fetched by accident. Nothing about the
worked example is a marketing build — it is the product, with the price tag off.

## The accuracy record, and why it starts empty

A competent engineer can rebuild the constraint physics from public sources in a month.
They cannot rebuild a record of where this engine's predictions landed against
instrumented sites, because that accrues one hall at a time and cannot be bought,
inferred or scraped. It is the only thing in the product that is genuinely not
reproducible, and it is worth nothing the moment it can be gamed — so the rules are
enforced in code rather than in intent:

- An observation must be **E5 or above**: site data, a BMS trend, a commissioning record.
  Anything weaker is another run of our own model, and a ledger fed with model output
  validates the engine against itself. `Observation.__post_init__` refuses it.
- **Client names never enter the ledger.** `site_ref()` hashes site and hall into a
  stable, non-reversible reference. The aggregate is intended for publication, and an
  asset that needs a confidentiality review before it can be published is worth far less
  than one that does not.
- **The committed ledger may hold no client data.** `append_observation()` refuses the
  bundled file outright, with no override flag — the one way this leaks is a hurried
  engineer reaching for a convenient default, so the convenient default is impossible.
  Real observations go in `calibration.local.json`, gitignored, same split as the cost
  library.
- **One site-month counted once.** A duplicate inflates n and understates the spread.

States: `uncalibrated` (n=0), `indicative` (1–4 — signals, not statistics; no spread is
quoted, because a range from four halls is fake precision), `calibrated` (n≥5, median
ratio and observed range). Nothing smooths, fits or extrapolates.

**It prints zeros today, and that is the point.** Section 14 of every study says
accuracy has not been established, `/v1/calibration` says it in public, and every API
response carries the same block. A report that omits its accuracy record when the record
is empty has told the reader the question does not matter. Competitors do not print this
because they cannot survive printing it.

Working it:

```bash
python3 -m gridforge calibrate keys      # the fixed vocabulary — 19 outputs
python3 -m gridforge calibrate show      # the record, honest either way
python3 -m gridforge calibrate where     # which ledgers are in effect
python3 -m gridforge calibrate add --key envelope.racks \
    --site "Client A" --hall DH-02 --predicted 26 --observed 24 --unit racks \
    --on 2026-11-30 --method "half-hourly metering, 3 months post-energisation"
```

Every delivered study should end with a reconciliation date in the diary. That is what
Decision Gate 4 is for, it is the argument for the instrumentation we recommend, and it
is how a figure moves from estimated to field-validated. The client gets a better answer
next time; we get an observation we can be held to. Both are real.

## The machine interface — selling to software

The next customer is not a person filling in a form. It is a colo operator's portfolio
tool running two hundred halls, a fund's diligence stack pricing an asset before it bids,
a GPU cloud's siting model choosing between eleven buildings. None of them will read a
PDF, and all of them will pay per call.

```
GET  /v1/tools        every callable, in OpenAI function shape and MCP shape
POST /mcp             Model Context Protocol over JSON-RPC 2.0
GET  /v1/calibration  the accuracy record, public
GET  /v1/usage        this key's metered usage and remaining allowance
GET  /v1/version      the rate card
```

Rendered for humans at `/developers`, from `public/reference/tools.json` — generated by
`gridforge tools --json` and diffed in CI, so the schema an integrator reads is the one
the server validates against rather than a hand-written copy that drifted two releases
ago.

**Metering.** Units, not calls: a qualify and a forty-hall portfolio run do not cost the
same and must not bill the same. Rates are published (`/v1/version`) because a meter whose
rate is secret is a meter nobody integrates against. The free tier bills zero and is never
metered into a quota — a demo that can exhaust an allowance is a trap.

Keys carry their plan: `GRIDFORGE_API_KEYS=sk_x:acme:5000` is key, account, monthly units.
Bare `sk_x` still works, so billing can be added to a running deployment without breaking
anyone. Set `GRIDFORGE_USAGE_FILE` or `/v1/usage` will say, correctly, that nothing is
durable and no invoice should be raised from it.

**Over quota is 402, never 429.** To a machine those are different instructions: 429 says
retry later, 402 says buy more. An agent told to retry a call it can never afford will
retry it forever, and the first thing the customer will notice is the bill.

**The evidence discipline does not relax for machines — it tightens.** Every response
carries evidence classes, provenance digests and the calibration block, and the MCP
handshake instructs the model not to present an E0 or E1 figure as a property of a
physical asset. A modelled number loose inside an agent loop is more dangerous than one
in a board pack, because nobody reads the footnote and nothing catches it downstream.
