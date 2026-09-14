# GridForge-AI

**How much AI compute can an existing data hall actually carry, what binds first, and what does each step of extra density cost?**

A zero-dependency Python engine that solves that question against thirteen electrical,
thermal and physical constraints, and a Next.js site that sells the answer — as fixed-fee
engineering engagements, as a metered API, and as a machine-callable MCP endpoint.

No equipment is sold. No margin is taken on hardware. No physical asset is owned.

---

## The honesty kernel

Every number the engine produces carries an **evidence class** and a **provenance
digest**, and arithmetic propagates the *weakest* class of its inputs. A figure computed
from an assumption is an assumption, whatever else went into it.

```
E0 assumed          E4 validated against test data
E1 modelled         E5 measured at site (customer data)
E2 simulated        E6 field-validated (our model reconciled against site performance)
E3 estimated        E7 observed in operation
```

This is enforced, not intended. Report gates run before any document leaves the engine
and refuse to emit one that carries an un-provenanced number, an evidence class above
its inputs, or measurement language it has not earned. `gridforge/reporting/gates.py`.

**The engine also publishes how wrong it is.** `gridforge/calibration/` holds a ledger of
what the model predicted next to what instrumented sites turned out to be. Today it is
empty, and every study says so in section 14, `/v1/calibration` says so in public, and
the block rides on every API response. A report that omits its accuracy record when the
record is empty has told the reader the question does not matter.

---

## What can be bought

| | | |
|---|---|---|
| **Density Screen** | €4,500 · 5 days | What binds, racks as found and after the ladder, the item that sets the date |
| **Capacity & Density Envelope Study** | €22k–€45k · 25 days | Five architectures compared, the full ladder, time to power, sensitivity, economics, model pack |
| **Procurement Specification** | €18,000 · 12 days | The tender document the study implies, and your bids ranked in racks and weeks |
| **Portfolio Screen** | €60k–€140k · 45 days | Five to fifteen halls under one methodology |
| **Hall Watch** | €6,000 / quarter | The model stays live; a change note names the input that moved the answer |
| **API — Triage** | €900 / month | Metered access for software: 600 units |
| **API — Scale** | €2,900 / month | 2,500 units; portfolio billed per hall |
| **API — Platform** | €7,500 / month | 10,000 units, a named engineer, redistribution terms |

Prices live in `gridforge/commercial.py` (what proposals quote) and `lib/products.ts`
(what checkout charges). `tests/test_catalogue_parity.py` fails the build if they
disagree, and `tests/test_stack_consistency.py` fails if anything priced cannot be
bought, generated or delivered.

---

## The engine

```bash
python3 -m gridforge init -o intake.json          # the blank intake a client fills in
python3 -m gridforge gaps intake.json             # what is missing and why it binds
python3 -m gridforge screen intake.json -o out    # the Density Screen
python3 -m gridforge study intake.json -o out --csv   # the Study, with working files
python3 -m gridforge deck intake.json -o out      # the walkthrough for the client session
python3 -m gridforge proposal intake.json -o out  # a proposal that opens with a real finding
python3 -m gridforge portfolio halls/*.json -o out
python3 -m gridforge diff before.json after.json -o out   # what moved, and which input moved it
python3 -m gridforge spec intake.json --list      # what on this ladder can be tendered
python3 -m gridforge bids intake.json a.json b.json --ingest
python3 -m gridforge cost list                    # the cost library and its evidence
python3 -m gridforge calibrate show               # the accuracy record, honest either way
python3 -m gridforge key issue --account acme --plan api_scale
python3 -m gridforge reference                    # the thirteen constraints, published
python3 -m gridforge reference platforms          # the platform library and its absences
python3 -m gridforge tools                        # the machine-callable surface
python3 -m gridforge serve --port 8080            # the HTTP API
```

Python 3.11+. **No third-party packages**, enforced by `tests/test_architecture.py` —
which also enforces the dependency rule that stops the domain packages growing into each
other.

```
gridforge/
  validation/      evidence classes, provenance DAG, interval arithmetic, units
  constraints.py   the constraint protocol and registry          ← kernel
  costs.py         the cost library and its evidence ladder       ← kernel
  site/ power/ compute/ thermal/     schemas, libraries, constraints
  envelope/        the solver, the headroom ladder, time to power
  scenario/        architectures compared under one objective
  economics/       capex, energy, AACE accuracy class
  calibration/     what the model said vs what sites turned out to be
  procurement/     specifications, bid evaluation, cost-library ingest
  reference/       the public constraint reference: authored prose, engine numbers
  reporting/       documents, report gates, deck, proposal, change note, specification
  api/             HTTP, metering, signed keys, tool schemas, MCP
  integrations/    ports for GridOS / ThermalForge / DERIM, each raising NotWired
                   until it is genuinely wired. An adapter that quietly returns a
                   plausible number is the worst possible failure in this product.
```

---

## The machine interface

```
GET  /v1/tools        every callable, in OpenAI function shape and MCP shape
POST /mcp             Model Context Protocol over JSON-RPC 2.0
GET  /v1/calibration  the accuracy record, public
GET  /v1/usage        this key's metered usage and remaining allowance
GET  /v1/version      the rate card
```

**The transport is open; each tool keeps its own tier.** `gridforge_qualify` works
over MCP with no key and no account — one paste into an AI client and an operator has
the binding constraint for their own hall. Every paid tool refuses without a key and
names the free one when it does. The paid tiers sell because the free one already
answered something true.

```bash
claude mcp add --transport http gridforge https://gridforge-engine.fly.dev/mcp
```

Metered in **units, not calls** — a qualify and a forty-hall portfolio run are not the
same work. Rates are published, because a meter whose rate is secret is a meter nobody
integrates against. Over quota returns **402, not 429**: to a machine those are different
instructions, and an agent told to retry a call it can never afford will retry it forever.

Keys are signed (`gfk1.<payload>.<signature>`) and verified offline, so self-serve
subscriptions issue working keys in seconds without giving the engine a database. The
website mints and the engine verifies with no shared runtime, so `tests/test_api_keys.py`
mints one in Node, verifies it in Python, and asserts both produce the identical string.

---

## The site

Next.js 15 App Router, Tailwind, Supabase (REST, service-role), Stripe, Resend.

```
/                      the argument, and the free qualifier
/qualify               seven numbers in, the binding constraint out
/llms.txt              the machine index: what this site contains, where the
                       canonical JSON lives, and how to read an evidence class
/constraints           all thirteen, each with the governing relation, a worked example
                       you can check by hand, what relieves it and how many weeks
/constraints/<slug>    one constraint in full
/platforms             rack power, liquid fraction, residual air, flow, floor loading —
                       and what is deliberately absent, because nobody published it
/reference             the complete deliverable, published — study, deck, proposal,
                       specification, model pack, and the CSVs behind every number
/developers            the machine interface, and metered plans you can buy
/pricing               the engagement ladder, derived from the catalogue
/intake/<token>        a client fills in the hall
/deliverable/<token>   what they bought, plus the working files to check it
/api-access/<token>    a customer's API key, shown once
/watch/<token>         a watched hall and its change notes
/admin/pipeline        engagements, watched halls, API accounts, and what binds across all of them
```

`/reference` is regenerated by `scripts/build-reference.sh` and CI fails on
`git diff --exit-code public/reference`. A published worked example that has quietly
drifted from the engine is worse than none: it is a specific, checkable promise, in
public, that we are no longer keeping.

---

## Receiving a change

Patches land in `inbox/`, never at the repository root:

```bash
# drop 00NN-something.patch into inbox/, then
bash scripts/apply-inbox.sh
```

It applies each patch in order, runs the tests, and commits the result **with the
patch removed in the same commit** — rolling back if the tests fail. A patch is an
instruction, not a source file.

`.gitignore` is no defence here and never was: a GitHub web upload commits directly,
and an ignore rule only stops an *untracked* file being added. So the guard is a
test — `tests/test_stack_consistency.py` declares every file allowed at the root and
fails on anything else, on any committed `.patch`, and on a patch left in `inbox/`.

## Running it

```bash
python3 -m pytest tests -q        # the engine, the gates, the catalogue, the deploy script
npm ci && npx tsc --noEmit && npm run build
bash scripts/build-reference.sh   # must leave public/reference unchanged
bash scripts/deploy-engine.sh --check   # dry run; touches nothing
```

Environment, engine side: `GRIDFORGE_API_KEYS`, `GRIDFORGE_KEY_SECRET`,
`GRIDFORGE_USAGE_FILE` (on a mounted volume), `GRIDFORGE_ALLOWED_ORIGINS`,
`GRIDFORGE_COST_LIBRARY`, `GRIDFORGE_CALIBRATION_LEDGER`, `GRIDFORGE_REPORT_DATE`.

Environment, site side: `GRIDFORGE_API_URL`, `GRIDFORGE_API_KEY`,
`GRIDFORGE_KEY_SECRET` (the same value as the engine), `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`RESEND_API_KEY`, `RESEND_FROM`, `ADMIN_PASSWORD`, `CRON_SECRET`.

`scripts/deploy-engine.sh` **never rotates a credential.** Minting requires
`--bootstrap`, and when the secret list cannot be read it refuses to write rather than
guessing. Two earlier versions did guess, and each one silently invalidated the live key
on every deploy. `tests/test_deploy_script.py` runs it against a fake `fly` and proves it.

---

## What is deliberately not here

- **No owned assets.** No cooling inventory, no energy assets, no hardware, no
  warehouses, no speculative installations. Physical deployment is customer-funded.
- **No equipment sold and no margin on hardware.** Specifications state duty and
  interfaces; the supplier proposes the equipment. That is why a client can hand our
  document to their own procurement without a conflict to declare.
- **No platform whose rack power the manufacturer has not published.** Absent by design;
  `/v1/platforms` lists what is missing and why. An invented number in a capacity study
  is how an engineering reputation ends.
- **No quotation in the committed cost library.** Supplier prices are confidential and
  live in a gitignored local library. The same rule applies to the calibration ledger:
  client site data never enters the repository.

---

## Documentation

`docs/00_COMMERCIAL_SPINE.md` (the strategy and the ICP) ·
`docs/01_PRODUCT_SPEC` · `docs/02_ENGINEERING_REFERENCE` (the physics and its sources) ·
`docs/03_TARGET_ARCHITECTURE` · `docs/04_MARKET_EVIDENCE` ·
`docs/06_AUDIT_FINDINGS` · **`docs/07_DELIVERY_RUNBOOK.md`** — how the work is actually
delivered, and the one to read first.

---

© GridForge AI · Founder: [Vincenzo Grimaldi](https://igrimaldi.engineering) · Frankfurt, DE · Toronto, CA

Legal pages (`/legal/*`) are honest templates and flag where real entity details and
counsel review are still required before relying on them.
