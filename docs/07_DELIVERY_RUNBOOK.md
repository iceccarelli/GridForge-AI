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

## Selling the machine interface without a salesperson

`/developers#plans` takes a card and, within seconds, the buyer has a working key.
Nobody touches it. Three plans, monthly, cancel any time:

| Plan | €/month | Units | Per unit |
| --- | --- | --- | --- |
| API — Triage | 900 | 600 | €1.50 |
| API — Scale | 2,900 | 2,500 | €1.16 |
| API — Platform | 7,500 | 10,000 | €0.75 |

A constraint screen is 1 unit, a full solve 5, a portfolio run 1 per hall. **No
overage billing**: over the allowance the engine returns 402 and they upgrade or wait
for the reset. An invoice a customer did not expect costs more than the units.

Prices live in two files — `gridforge/commercial.py` (what proposals quote) and
`lib/products.ts` (what checkout charges). `tests/test_catalogue_parity.py` parses
the TypeScript and fails if they disagree. That test is new; `commercial.py` had
claimed it existed since patch 0001 and it did not.

### Keys are signed, not stored

A key is `gfk1.<payload>.<signature>`: account, key id, monthly quota, scope, issue
and expiry dates, HMAC-SHA256 with `GRIDFORGE_KEY_SECRET`. The engine verifies
arithmetic it can do itself — no database, no network call, no latency floor, and a
stateless container stays stateless.

**The same secret must be set on the engine and on the website.** The website mints
with it (`lib/api-access.ts`), the engine verifies with it
(`gridforge/api/keys.py`), and the two implementations must agree byte for byte on
what gets signed — sorted keys, tight separators. `tests/test_api_keys.py` mints one
in Node and verifies it in Python, and asserts both produce the identical string. A
divergence would not fail loudly; it would issue keys that quietly do not work, to
customers who have just paid.

**We never store a key.** The database holds the id of the live key and the ids we
have revoked. The key is shown once, at the moment it is minted. A database that can
hand somebody a working credential is a database worth stealing, and there is no
reason for this one to be.

**Revocation.** Keys are minted for 35 days, not 30 — a subscription renewing on the
1st must not leave a customer's agents dark while a webhook lands. A cancelled
subscription simply stops being renewed and the key dies inside the period they paid
for. For anything that cannot wait, `/admin/pipeline` prints the exact command:

```bash
fly secrets set GRIDFORGE_REVOKED_KEYS="<ids>" -a gridforge-engine
```

### Operating it

```bash
python3 -m gridforge key plans                       # the rate card
python3 -m gridforge key issue --account acme --plan api_scale
python3 -m gridforge key issue --account prospect --quota 100 --scope trial --days 14
python3 -m gridforge key inspect gfk1....            # why did this stop working?
```

`key inspect` reads a key it cannot trust, which is the question support actually
gets: not "is this valid" but "what does this say and why was it refused". Expired,
revoked and forged are reported as three different things, because "invalid key"
sends an integrator hunting a typo when their subscription lapsed three days ago.

Usage aggregates under the **account**, not the key. A customer who rotates a key
mid-month has not started a new month, and a meter that thinks otherwise hands out a
fresh allowance on every rotation.

## Two deployment bugs that were live, and are now fixed

**`deploy-engine.sh` rotated the production API key on every run.** It generated a
fresh `GRIDFORGE_API_KEYS` unconditionally, so every deploy invalidated the key in
Vercel and paid deliverable generation started returning 401 until somebody noticed
and re-pasted it. It also failed to detect the existing app, because it grepped
`fly apps list` output whose format has changed. The script now asks the app about
itself, adds only missing secrets, and prints `<unchanged>` rather than a new key.

A deploy script that breaks production on success is worse than one that fails,
because nothing tells you.

**`GRIDFORGE_USAGE_FILE=/data/usage.json` with no volume mounted discarded every
usage record.** With `min_machines_running = 0` that is every few minutes, and it
looks identical to a working configuration until the first invoice. Three changes:
`fly.toml` now declares the mount and the path, the deploy script creates the volume,
and the meter **probes the path at startup** — if it cannot write, it says so at
`/v1/usage` instead of reporting `durable: true` on a path that silently throws
everything away.

Check after any deploy:

```bash
curl -s https://gridforge-engine.fly.dev/v1/version | python3 -m json.tool | head -30
```

`auth_configured`, `signed_keys` and `metering.durable` are the three that matter.
The deploy script now calls out each one that is false.

## The Procurement Specification — €18,000, and the flywheel under it

A study ends with "the transformer sets the date at 52 weeks". The client then has to
go and buy a transformer, and between the finding and the purchase order sits three
weeks of an engineer writing a specification, arguing about what to ask for, and
comparing four quotations that answer four different questions.

That gap is the product.

```bash
python3 -m gridforge spec intake.json --list        # what on this ladder can be tendered
python3 -m gridforge spec intake.json --constraint busway_ampacity \
    --reference TND-2026-001 --return-by 2026-11-15 -o out
python3 -m gridforge bids intake.json out/Alpha.json out/Beta.json \
    --constraint busway_ampacity --ingest --basis firm_quote --region DE
```

**Every numeric requirement names the constraint it came from.** That is the whole
argument for buying this rather than writing it in Word: a requirement nobody can
trace back to a physical limit is one somebody invented, and those are how a tender
specifies equipment the hall does not need. `SpecPackage.validate()` refuses a
mandatory numeric requirement with no constraint behind it.

**Duties are sized for the end state, not the rung.** A ladder rung often unlocks
three racks. Nobody buys a transformer for three racks — they buy it for the hall
they intend to end up with. Sizing to the rung's own delta produces a specification
that is technically traceable and commercially absurd, which is worse than one that
is neither.

**Duties are quoted at the site's own conditions.** A CDU rated at a 5 K approach,
installed on a site running a 24 K approach, is the commonest way a liquid retrofit
under-delivers. The specification puts that in capitals where a supplier cannot miss
it, and asks for the selection output at our conditions rather than a datasheet.

**We name no make, no model and no supplier.** We state duty and interfaces; the
supplier proposes the equipment; we take no margin on hardware. That is the same line
the engagement scope draws, and it is why a client can hand this to their own
procurement without a conflict to declare. A test asserts no manufacturer name
appears in the document.

**Bids are compared in racks and weeks.** The item exists to unlock compute on a
date: the bid that is 12% cheaper and 14 weeks slower is the expensive one, and the
evaluation weighting says so (35 compliance, 30 programme, 20 price, 15 judged). A
non-compliant bid is never ranked above a compliant one, whatever its price — that
ordering is the entire point of a "shall".

Installation method and evidence quality are **15 points the tool does not score**.
It says so rather than filling the column with a computed number, because those two
need an engineer and a tool that pretended otherwise would be inventing the part that
needs judgement.

### The flywheel

This is why the engagement is worth selling at a price that looks low next to the
study. A study rests on library defaults with a −50%/+100% band and an AACE Class 5.
A returned bid is a **dated, attributable, project-specific price** — and
`--ingest` prints the exact `gridforge cost add` commands it implies:

```
library_default      E0   a placeholder with a band
budgetary_quote      E3   a supplier's indicative number
firm_quote           E5   a written quotation with a validity date
contracted           E7   what was actually paid
```

The moment that line lands in the library, every future study touching it gets
stronger and its accuracy class improves. **Procurement work pays twice.**

The commands are printed for review, never run. A price that enters the library
unreviewed is one nobody can defend when a client asks where it came from.

**The conversion is the dangerous part and is tested hardest.** A supplier quotes one
delivered number. The library holds `tapoff.unit` per rack, `ups.per_kW` per kW and
`busway.replacement` as a lump sum. Entering a lump sum on a per-rack line is wrong by
the rack count, it carries a *quotation's* evidence class, and every future study
inherits it with a straight face — worse than having no flywheel at all. The basis
comes from `costs.declared_unit()`, a registry populated by the constraint that prices
each key, not guessed from a step's already-multiplied total.

### Machine interface

`/v1/spec` (3 units) and `/v1/bids` (2 units), and `gridforge_spec` / `gridforge_bids`
over MCP. A portfolio tool can generate a specification and rank the responses without
a person in the loop; the screening-mode disclosure rides on the document either way.

### On the reference page

`/reference` publishes a complete specification and its response schedule alongside
the study. A prospect can read the document they would actually send to suppliers
before paying for anything — same argument as publishing the study, one step further
down the sales cycle.

## Consistency is enforced, not intended

Three things shipped broken in a row, and each was the same shape: a fact stated in two
places, one of them updated.

- The Procurement Specification shipped priced, documented and **absent from the
  engagement ladder** — because the ladder was a hand-written array of ids inside a
  component and nobody edited it.
- That same product, once bought, would have generated a **Density Screen**, because the
  intake route branched on the kind inline: `kind === "envelope_study_deposit" ? "study"
  : "screen"`. A client pays €18,000 and receives a different document; nothing objects.
- `commercial.py` claimed for fourteen patches that a parity test existed. It did not.

`tests/test_stack_consistency.py` now asserts the **joins** rather than the parts:

- every product declares a `surface` (no default — something unsellable has to be
  declared unsellable on purpose);
- the ladder is derived from the catalogue, and the test fails if a literal `ORDER` array
  reappears in the component;
- every product with `producesDeliverable: true` names an `endpoint`, and every endpoint
  the site names exists on the engine;
- the intake route reads `deliverableEndpoint()` rather than branching, and an unmapped
  kind fails loudly instead of generating the wrong document;
- every engagement the engine quotes can be paid for on the site;
- every paid route is metered and reachable by a machine (`/v1/deck` is the one
  deliberate exception, and the test names it as deliberate);
- `public/reference/tools.json` matches the engine's live schemas and unit rates;
- the README names every product and every package, and does not still describe a
  behind-the-meter EMS practice;
- the commercial spine lists what is actually purchasable;
- every CLI command appears in this runbook.

That last one means adding a command to `cli.py` without writing it down here fails the
build. It is meant to.

## A test that created a real Fly app

`tests/test_deploy_script.py` put a fake binary named `fly` on `PATH` and trusted the
script to find it. The script resolved `command -v flyctl` first, found the **real**
flyctl installed in the Codespace, and ran `fly apps create test-engine` against a live
Fly.io account. A test that touches production is a worse bug than the one it was written
to catch.

Fixed three ways, because one was clearly not enough:

1. `FLY_BIN` names the binary explicitly, and the script honours it.
2. The fake is installed under **both** `fly` and `flyctl`.
3. `_assert_fake()` refuses to run the script at all unless the binary it will use is the
   one the test wrote, and asserts afterwards that no real account was reached.

And when `FLY_BIN` is set the script no longer offers to install flyctl. A test or a CI
job that silently downloads a real flyctl is one step from a test that uses it.

**If you still have a stray `test-engine` app on your Fly account, delete it:**

```bash
fly apps destroy test-engine
```


## The public constraint reference — why we give the physics away

`/constraints` publishes all thirteen in full: what physically runs out, the relation
that governs it, a worked example reproducible by hand, how to tell whether it binds in
your own hall, what relieves it, what that relief costs beyond money, and the indicative
lead time. `/platforms` publishes the platform library, including the platforms that are
**deliberately absent** because no manufacturer has published a rack power.

The commercial argument is not content marketing. Anyone deciding whether to pay for a
capacity study first wants to understand the problem, and what they read today is vendor
reference designs written by companies whose every document ends in their own bill of
materials. There is no independent, quantitative, public account of what actually stops a
hall. Being that account is worth more than the information is worth withholding — and
every page ends at a free tool that answers the question for the reader's own hall.

Two properties make it defensible rather than merely generous:

- **The prose is authored; every number is not.** Worked examples, residual air loads,
  floor loadings, approach temperatures and cost evidence classes are computed from the
  same libraries the engine solves with. A competitor can copy thirteen good pages in a
  week. Keeping them consistent with a working solver for two years, while the libraries
  move and quotations replace placeholders, is a different undertaking.
  `tests/test_reference_layer.py` doubles a platform's rack power and asserts at least
  four pages move.
- **The absences are the most credible thing we publish.** Every competitor's platform
  table carries a row for the parts nobody has published, filled with somebody's estimate.
  Ours names them and says why they are not there.

```bash
python3 -m gridforge reference             # the thirteen, with lead times
python3 -m gridforge reference platforms   # the library and its absences
```

Both are built into `public/reference/` by `scripts/build-reference.sh` and covered by
the same drift guard as the worked example. The site reads them from disk rather than
calling the engine: these are the most-read pages we have and they must not depend on a
service being up.

What the tests refuse to let a page do: claim a track record (`proven`, `guaranteed`,
`case study`, `we have achieved`), name any manufacturer of relief equipment, publish a
constraint the engine does not evaluate, or omit one it does. Coverage is asserted in
both directions, so a constraint added to the engine without a page fails the build — and
so does a page for a constraint that does not exist.

`app/sitemap.ts` generates the constraint URLs from the same file, so a new constraint is
indexed without anyone remembering to add it.


## Distribution: the free tier had to be reachable by a machine

The MCP transport was key-gated end to end. Every paid tool inside it already checked
its own tier, so the only thing that gate protected was the free tier from being used —
and with it the single best distribution channel this product has: a stranger adding
GridForge to their AI client and getting a real answer about their own hall in thirty
seconds.

It is open now. `gridforge_qualify` needs no key and no account; every paid tool refuses
without one and names the free tool when it does, so an agent always knows what it can
call. `tools/list` shows everything whatever the caller holds — an agent that cannot see
a paid tool cannot tell its user the answer exists, which costs us more than it costs
them.

One paste, on `/developers`:

```bash
claude mcp add --transport http gridforge https://gridforge-engine.fly.dev/mcp
```

The handshake instructions are load-bearing. They tell the model that the free tool
exists and what it needs, that an E0 or E1 figure is modelled rather than measured and
must not be presented as a property of a physical asset, and that the calibration record
currently says uncalibrated. A modelled number loose inside an agent loop is more
dangerous than one in a board pack: nobody downstream reads the footnote.

## Being the source a model cites

`/llms.txt` is the machine index — what the site contains, where the canonical JSON
lives, how to read an evidence class, and how to call the free tool. Generated from the
same catalogue the pages render, so it cannot go stale.

Every constraint also has a JSON twin at `/reference/constraints/<slug>.json`, carrying
the notice with it. A crawler scraping rendered HTML gets our prose and loses the
evidence class, the lead time and the arithmetic; the twin hands over the structure. A
twin that travelled without the notice would be a naked number, so CI checks for it.

`/api/cite` gives the citation, the BibTeX and the **required caveat** in one call. The
friction that stops a niche citing you is usually clerical — nobody knows what to put in
the footnote — so we write it, and the footnote carries the caveat so a modelled figure
cannot travel without its label.

**robots.txt welcomes AI crawlers explicitly** — GPTBot, ClaudeBot, PerplexityBot,
Google-Extended, CCBot and the rest — while keeping every token-addressed path closed to
everyone. Most of this niche is now blocking them. We want the opposite: when an operator
asks a model what stops their hall taking AI racks, we would rather the answer came from
a constraint reference that names its evidence class than from a vendor reference design
that ends in a bill of materials.

That is not altruism and should not be described as such. Being the source is worth more
than any single engagement, and the reference is how somebody arrives already believing
the tool.


## How a change gets in, and why not through the root

Two things reached public `main` by being uploaded to the repository root: a patch
file, and `nb` — a build tool belonging to an entirely different project, which then
could not run because it hardcoded a path to that project's workspace.

Neither was caught. Every test asked whether what we had was correct; none asked
whether something we had not put there had arrived.

**`.gitignore` was never going to stop it.** `/*.patch` has been in that file the
whole time. A GitHub web upload commits through the API, and an ignore rule only
prevents an *untracked* file being staged by `git add`. Once a file is tracked the
rule is silent. That is worth knowing in general: ignore rules are a convenience for
`git add`, not a policy about what may exist in a repository.

**And it compounds.** A file at the root that you have also touched locally — even
just `chmod +x` — makes `git pull` abort with "local changes would be overwritten".
Every command after that then fails for reasons that have nothing to do with the
real problem: the patch you were trying to fetch never arrives, the test run is on
stale code, the commit records a mode change under a message about something else,
and the push is rejected as non-fast-forward. One cause, five symptoms, none of them
pointing at it.

### The arrangement now

```bash
# upload 00NN-something.patch anywhere in the repo — the root is fine — then
bash scripts/apply-inbox.sh
```

`inbox/` is tracked, so an upload has somewhere to land, and holds nothing but its
own README, so nothing accumulates. The script applies each patch with `git am`,
folds the removal of the patch file into the same commit with `--amend`, runs the
tests, and resets hard to the previous HEAD if they fail. One commit per patch, and
the instruction does not survive its own execution.

`--dry-run` says what would apply and changes nothing.

Four tests hold it: nothing undeclared at the root, no dead entries in that
declaration, no `.patch` committed anywhere, and nothing left in `inbox/`. A fifth
reads the script itself and fails if the removal stops being folded into the commit,
because a patch that survives in history is the problem coming back quietly.

### Two things the script learned afterwards, both on live main

**It sweeps the root itself.** Telling a human to `git mv` a file every time the
web uploader drops it in the wrong place is not a workflow, it is a chore with a
failure rate. The script now moves any `*.patch` at the root into `inbox/` and
commits the move when the file is tracked. Upload it wherever it lands.

**It no longer punishes an innocent patch.** The script used to run the whole suite
after applying and roll back on any red. That is wrong whenever the suite was
already red: a stray patch file at the root was failing the root-hygiene test, and a
correct, unrelated patch was reverted twice for it — the guard was right and the
script's reading of it was wrong. It now records the failing test ids *before* it
applies anything and rolls back only on **new** failures. Pre-existing ones are
printed by name at the start and again at the end, so they still get fixed. A patch
that repairs a baseline failure shrinks the baseline, so a later patch in the same
run cannot quietly reintroduce it.

`tests/test_patch_intake.py` drives the script against a throwaway repository and
asserts all of it: the sweep, the tracked-file sweep with its commit, the refusal to
overwrite an existing inbox entry, the innocent patch surviving a red baseline, the
guilty patch still being rolled back, and the baseline shrinking when it is fixed.


## The answer had to be able to leave the browser tab

The free qualifier produced a real engineering read — the binding constraint with
its basis, racks as found and after the ladder, the item that sets the date — and
then lost all of it when the tab closed.

That is not a cosmetic gap. **The person who types seven numbers into a capacity
qualifier is an operations engineer. The person who signs off a five-figure study is
a director.** The distance between them is a link, and there was not one, so every
read stopped at whoever happened to be at the keyboard.

`/q/<token>` is that link. It carries the engineering rather than a summary of it:
the binding constraint, one click from its full reference page, what it takes to
move and how many weeks that takes, what nobody has measured, and the same
disclosure the paid document carries. A shareable page that softened any of that
would be a brochure, and a director who has read one brochure recognises the next.

The share block sits directly under the headline, not at the end. The moment to
forward something is the moment you have just read the thing worth forwarding.

### The benchmark is the reason it gets forwarded

The page tells a reader how their hall compares with every other hall the engine has
seen — *"tap-off rating binds first in 11 of 34 halls; 19 of those deploy zero racks
as they stand."* That is the only sentence on the page a competitor cannot write,
and it costs us nothing to give away because giving it away is what produces the
next row.

It respects the same privacy floor as `/api/insights` — a test asserts the two
numbers are equal, so lowering one silently publishes on the shared page what the
public route withholds. The query selects two columns, `binding_constraint` and
`racks_as_found`, and a test asserts nothing else can creep into it.

### What the tests hold

- No link is offered when the row was not written. `persist()` now throws instead of
  logging and moving on, because a share link to a row that was never written is a
  404 sent to somebody's director.
- The token is minted **before** the engine runs, so an unreachable engine still
  leaves a row we can come back to, and the page says a read was not produced rather
  than inventing one.
- 18 random bytes, base64url. A short token on a page holding a customer's site
  figures is not a token.
- `/q/` is disallowed for every crawler and the page is `noindex`, like every other
  token-addressed path.
- The migration backfills before it constrains — a unique index added first refuses
  on the existing nulls, and fails on exactly the deployments that already have data.


## The site was two companies

This repository began as a behind-the-meter power practice and became a density
engine. Both were live on the same domain at the same time, and neither knew about
the other.

**/pricing rendered two fee structures, one above the other.** Power Audit
€25k–€45k and Feasibility Study €45k–€95k at the top, then the real engagement
ladder from €4,500 below it. Neither of the upper bands existed anywhere in
`gridforge/commercial.py`, so the parity test could not see them and nothing failed.

**/infrastructure sold megawatts.** A whole page of containerised behind-the-meter
power blocks — gensets, BESS, footprints, weeks-to-energised. *"Stand up a megawatt
while the queue says 2031."* The homepage carried the same offer three more times:
reference architectures to 120 MW+, a configurator that sized campus builds, and a
single-line diagram of a facility we would design.

We do not build, own, finance or operate any of it, and the capital rule puts it out
of scope permanently. Sizing envelopes for plant we would never supply are fictitious
capacity wearing the clothes of a product sheet.

**The assistant was the worst of it.** `/api/chat`'s system prompt was a confident,
detailed briefing for the company that no longer exists: REF-01 hybrid microgrids,
a 400–800 V DC bus, an EMS doing FCR/aFRR, and that same phantom fee list. A page
can be skimmed; an assistant answers the specific question a buyer actually asked,
in a tone that sounds like it knows. Its engagement list is now generated from
`lib/products.ts`, so the prompt cannot drift from what checkout charges, and it is
told plainly what to refuse.

### One domain

Six files hardcoded `gridforge-ai.vercel.app` — layout metadata, JSON-LD, robots,
sitemap, llms.txt and the citation endpoint — while seven hardcoded
`timetopower.ai` for emails, Stripe success URLs and deliverable links.

Every canonical URL, every sitemap entry and the citation we *ask people to use*
pointed at a preview domain. That splits search authority away from the domain that
actually serves the site, and the whole reference and agent-distribution layer was
advertising the wrong home.

`SITE_URL` in `lib/site.ts` is now the only definition, overridable with
`NEXT_PUBLIC_SITE_URL` for previews. A test walks every tracked `.ts`/`.tsx` file
and fails on any hardcoded site URL outside the registry.

### What the tests hold

- No file hardcodes a site URL except `lib/site.ts`.
- No euro figure exists outside `lib/products.ts` and `lib/commerce.ts`. That test
  is what found the €25k–€45k still sitting in the chat prompt.
- `SERVICES` may not offer a microgrid, HVDC distribution, an EMS or a Power Audit,
  and must name the engagements that exist.
- No file offers `POWER_BLOCKS`, `CONFIG_VARIANTS`, "Megawatts in months", "Power
  blocks you can deploy" or "Stand up a megawatt" — comments recording why they were
  removed are stripped before the check, so the history can stay in the file.
- `/infrastructure` is gone from the routes, the navigation and the sitemap.
- `MARKET_STATS` must still exist with its sources. Removing our own invented
  capacity is not a reason to remove sourced figures about the market the buyer
  actually lives in.

### The band that could not be checked

"Deposit against €22k–€45k" had the 22 in the engine and the 45 typed into a React
component. Half of every quoted range was unsourceable. `Engagement.price_eur_max`
now carries the top of the band, `opensBandCents` mirrors it into the catalogue, the
ladder renders from that, and the parity test asserts the two agree.
