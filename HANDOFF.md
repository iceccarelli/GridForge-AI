# HANDOFF — GridForge-AI

**For:** the next AI agent working on this repository with Vincenzo Grimaldi.
**Repository:** `github.com/iceccarelli/GridForge-AI`, branch `main`, one branch only.
**Site:** `https://timetopower.ai` (Vercel). **Engine:** `gridforge-engine` (Fly.io).
**State at handoff:** 388 tests passing, `tsc --noEmit` clean, `npm run build` clean.

Read this file before you write a line of code. It is the whole contract: what the
business is, what is built, what is enforced, what is still open, and why any of it
is worth money.

---

## 0. The rules you inherit. These are not negotiable and not yours to relax.

**Sequence.** CUSTOMER PROBLEM → ENGINEERING SERVICE → CASH → REPEATABILITY →
AUTOMATION → SOFTWARE → RECURRING REVENUE. Do **not** start by building a SaaS
platform. Do **not** build hardware.

**Capital rule, verbatim from the founder:**

> Absolutely no: owned cooling inventory; owned energy assets; data-center hardware;
> warehouses; speculative installations; large capex. Physical deployment must be
> customer-funded.

We sell engineering opinion and machine-readable models. We quote no equipment, we
take no margin on hardware, and we own no megawatts. Anything on the website that
implies otherwise is a bug — one such page (`/infrastructure`, which sold capacity
we do not have) was deleted in patch 0022 for exactly this reason.

**Evidence discipline, verbatim:**

> Every output must identify ASSUMPTIONS / INPUT DATA / MODEL / UNCERTAINTY /
> OUTPUT / VALIDATION STATUS. Never present modeled output as measured customer
> data. No fake precision. Do not claim electrical capacity without appropriate
> engineering evidence.

**Repositories.** GridForge-AI is MAIN. ThermalForge: integrate selectively. DERIM:
selective. GridOS: future only. *Do not blindly combine these repositories.*

**Every patch:** small, reversible, tested, documented, commercially justified. If
you cannot say which of those five a change satisfies, do not send it.

**ICP:** existing colocation operators retrofitting air-cooled halls to 80–130
kW/rack. Not hyperscalers, not greenfield.

**Delivery format the founder asked for:** code, a `.patch`, the command lines, and
what to do next. Not essays, not audits, not "here is what I would do".

---

## 1. Why anyone pays. The commercial case, stated plainly.

The market problem is specific and it is a choke point. An operator with a 6 MW
air-cooled hall is being asked for 100 kW/rack. Nobody in the building can say what
stops them first — the busway, the transformer, the chilled-water plant, the CDU
approach temperature, the floor loading, or the grid connection queue — or what
relieving it costs, or what it does to the date. The consultants who can answer it
answer it in twelve weeks for a six-figure fee and hand back a PDF. The vendors who
answer it for free are selling the equipment in the answer.

We answer it in five days, for €4,500, with every number traceable to a named
source, and we sell nothing in the answer. That is the wedge.

### The ladder (one price list, `gridforge/commercial.py` ⟷ `lib/products.ts`, parity-tested)

| # | Product | Price | Turnaround | The question it answers |
|---|---------|-------|-----------|--------------------------|
| 10 | **Density Screen** | €4,500 | 5 days | What stops this hall first, and how far can it go? |
| 20 | **Capacity & Density Envelope Study** | €22,000–€45,000 | 25 days | How much AI compute can this hall carry, what binds first, what does each step of density cost? |
| 30 | **Procurement Specification** | €18,000 | 12 days | What exactly do we buy, and which bid actually moves the date? |
| 40 | **Portfolio Screen** | €60,000–€140,000 | 45 days | Which of these halls should carry the compute, and in what order? |
| 50 | **Hall Watch** | €6,000/quarter | continuous | What changed, and which input changed it? |

Density Screen credits against the Envelope Study. That is deliberate: the screen is
a paid qualification, not a loss leader, and the credit removes the buyer's reason
to hesitate at the top of the ladder.

### Sold to software, not to people (`surface: "developers"`)

| Plan | Price | Units/month | Audience |
|------|-------|------------|----------|
| **API — Triage** | €900/mo | 600 | One team screening a portfolio it already owns |
| **API — Scale** | €2,900/mo | 2,500 | A platform or fund pricing halls continuously |
| **API — Platform** | €7,500/mo | 10,000 | Embedding the engine in someone else's product |

Metering is in **units, not calls** (a screen is 1, a full solve is 5, a portfolio is
1 per hall). Over quota returns **402, never 429** — 429 says "slow down", 402 says
"pay us", and they are different commercial events. Usage aggregates by **account**,
not by key, so rotating a key does not reset a bill.

The API is deliberately *not* the engagement, and the difference is printed on every
response: an engagement is an engineering opinion with a named signatory, an ISSUED
status and indemnity behind it; the API returns screening-mode output with none of
those. Anyone who confuses the two finds the distinction in the payload.

### The two assets that cannot be bought, scraped or rebuilt by a good technician

This matters more than the ladder, because the ladder is copyable and these are not.

1. **The cost library** (`gridforge/costs.py`, `cost_library.local.json`). Every
   relief carries a cost and an evidence class, and the class *upgrades* as real
   money touches it: `library_default` (E0) → `published_benchmark` (E1) →
   `budgetary_quote` (E3) → `firm_quote` (E5) → `contracted` (E7). Every Procurement
   Specification we run ingests real supplier bids and upgrades the library. After
   twenty engagements our screening economics are quoted from firm quotes while a
   competitor is still quoting from a handbook. The committed seed holds **no**
   quotations; the real one is gitignored and is the asset.

2. **The calibration ledger** (`gridforge/calibration/`). Every time a modelled
   envelope meets a measured one, the delta is recorded against the constraint that
   bound. Observations must be ≥E5. Client names are hashed through `site_ref()`; the
   bundled ledger *refuses* to accept client data. The ledger states its own status:
   `UNCALIBRATED`, `INDICATIVE` (1–4 observations), `CALIBRATED` (≥5). Today most of
   it is UNCALIBRATED and it says so on every response — that honesty is the point.
   In two years it is the only artefact in the market that can say "our busway model
   has been wrong by −3.1% across nine measured halls", and no amount of engineering
   talent substitutes for having done the nine halls.

Both compound per engagement. Both are why the sequence in §0 is CASH before
SOFTWARE: the software is only defensible once the engagements have fed it.

### The distribution loop

Free MCP qualifier (any agent, no key) → shareable `/q/<token>` capacity read that
leaves the browser tab → benchmark against ≥8 anonymised halls → the published
constraint reference at `/constraints/*` (thirteen pages, every number generated by
the engine) → `/llms.txt` and `/api/cite` so a model citing the physics cites us.

The reference layer is the long game: when an LLM is asked "what limits rack density
in a retrofit", the answer should be our page, with our numbers, naming our engine.
That is not marketing, it is the cheapest possible distribution for a business whose
buyers increasingly ask a model before they ask a consultant.

---

## 2. Architecture

### Engine — `gridforge/` (Python 3.11+, **zero third-party dependencies**)

The dependency ban is enforced by `tests/test_architecture.py`. It is not
minimalism for its own sake: the engine is deployed, sold, and called by agents; a
transitive package is a supply-chain risk we cannot audit and a reason a client's
security review stalls for three weeks.

- **`quantity.py`** — `Quantity` carries a value, a unit, an evidence class and a
  provenance DAG. Arithmetic propagates the **minimum** evidence class of its
  inputs, so a conclusion can never be more certain than its weakest input. Interval
  arithmetic, unit algebra, and significant-figure rounding keyed to evidence class
  (an E0 assumption does not get printed to four figures).
- **Evidence classes E0–E7:** `ASSUMPTION → MODEL → SIMULATION →
  ENGINEERING_ESTIMATE → EXPERIMENTAL → CUSTOMER_DATA → FIELD_VALIDATED → DEPLOYED`.
- **`constraints/`** — thirteen constraints over one `EnvelopeContext`:
  `rack_feed_tapoff`, `busway_ampacity`, `transformer_capacity`, `ups_capacity`,
  `grid_firm_capacity`, `plant_capacity`, `cdu_capacity`, `hydraulic_flow`,
  `tcs_supply_achievable`, `residual_air_removal`, `architecture_capability`,
  `floor_space`, `floor_loading`. The envelope is the **min**; the binding
  constraint is the **argmin**. Adding a fourteenth means adding it here and to
  `CONSTRAINT_IDS` in the calibration schema — a test enforces the join.
- **Headroom ladder** — each rung relieves one constraint, with cost, lead time and
  the racks it unlocks. **Time to power** names the item that sets the date.
  **Change engine** (`change.py`) reports what moved and which input moved it, with
  an explicit residual so unattributed change cannot hide.
- **`costs.py`**, **`calibration/`**, **`procurement/`**, **`reference/`** — see §1
  and §3.
- **`api/`** — `VERSION = "0.9.0"`. Routes: `/health`, `/v1/version`,
  `/v1/platforms`, `/v1/intake/template`, `/v1/qualify`, `/v1/screen`, `/v1/study`,
  `/v1/portfolio`, `/v1/proposal`, `/v1/deck`, `/v1/diff`, `/v1/spec`, `/v1/bids`,
  `/v1/calibration`, `/v1/tools`, `/v1/usage`, `/mcp`.
- **`cli.py`** — `init gaps screen study deck proposal diff cost serve portfolio
  spec bids calibrate key tools reference`. Every command is documented in
  `docs/07_DELIVERY_RUNBOOK.md`, and a test fails if one is not.
- **`clock.py`** — `report_date()` reads `GRIDFORGE_REPORT_DATE` so document builds
  are byte-reproducible. It is deliberately **not** used by `api/keys.py`: a build
  flag must never be able to extend a credential.

### Report gates (CI-enforced, `tests/test_report_gates.py`)

A generated document fails the build if it contains a number with no provenance, an
evidence class above its own inputs, or banned measurement language ("measured",
"as-built", "verified" applied to modelled output). Every document declares ISSUED
or SCREENING mode and carries `DISCLOSURE_MARKER = "EVIDENCE DISCLOSURE:"`.

This is the honesty kernel in code rather than in a style guide. The rule the
founder set — *never present modeled output as measured customer data* — is a test,
not an intention.

### Authentication — `gridforge/api/keys.py`

Keys are `gfk1.<payload>.<sig>`, HMAC-SHA256 over the payload with
`GRIDFORGE_KEY_SECRET`. Verified **offline** — no database round-trip on the hot
path — with a 35-day expiry and a `GRIDFORGE_REVOKED_KEYS` deny-list. Minted
identically in Python and in Node; a cross-language test asserts byte equality, so
the site and the engine can never disagree about what a valid key looks like.

### MCP — `POST /mcp`

JSON-RPC 2.0, protocol `2025-06-18`, implemented in the standard library. The
**transport is PUBLIC**; each tool keeps its own tier. `gridforge_qualify` is free
and always will be. This was a deliberate reversal: the transport used to be
key-gated end to end, which protected nothing (the paid tools were already gated)
while blocking the single best distribution channel we have.

### Site — Next.js 15.5 App Router

React **18.3.1 — do not bump to 19**. Tailwind 3.4, Supabase REST (service-role),
Stripe, Resend, framer-motion, jspdf. Deployed on Vercel.

- **`lib/site.ts`** is the single domain registry. `SITE_URL` and `siteUrl(path)`.
  Nothing else may hardcode a domain; a test enforces it.
- **`lib/products.ts`** is the catalogue and the only place a euro figure may
  appear. `surface: "ladder" | "developers" | "upsell" | "hidden"` is **required
  with no default** — something unsellable has to be declared unsellable on purpose.
  `deliverableEndpoint(kind)` maps a purchase to what gets generated.
- **`lib/qualify.ts`** — `newQualificationToken()` (18 random bytes, base64url),
  `benchmark()` over a minimum of 8 halls, selecting only `binding_constraint` and
  `racks_as_found` so a benchmark can never leak a hall.
- Public reference: `/constraints`, `/constraints/[slug]`, `/platforms`.
  Agent surface: `/llms.txt`, `/api/cite`, `/api/constraints`.
  Share surface: `/q/[token]` (noindex, `force-dynamic`).

---

## 3. The test suite, and the failure each part exists to prevent

Do not treat these as chores. Every one of them was written after the failure it
describes reached `main`, production, or a price.

| Suite | Exists because |
|-------|----------------|
| `test_architecture.py` | The zero-dependency rule is a promise to clients' security reviews. |
| `test_report_gates.py` | A modelled number was one careless sentence away from reading as measured. |
| `test_stack_consistency.py` | A fact stated in two places with only one updated. Asserts the **joins**: every catalogue entry reaches a surface, every deliverable reaches an endpoint, every endpoint the site calls exists on the engine, every engagement the engine quotes can be paid for. |
| `test_catalogue_parity.py` | `commercial.py` claimed for fourteen patches that a parity test existed. It did not. Two languages, one price list. |
| `test_one_company.py` | The site sold megawatts we do not own, on a second domain, at a second price list. One domain, one price list, no fictitious plant. |
| `test_deploy_script.py` | The deploy script rotated the live API key on **three separate occasions**. Runs the script against a fake `fly`. |
| `test_patch_intake.py` | The intake script reverted a good patch twice for a failure it did not cause. (New in 0023 — see §4.) |
| `test_api_keys.py` | A key format that Python and Node disagreed about would fail open or fail closed at random. |
| `test_calibration.py` | The ledger must refuse client data and must state its own status honestly. |
| `test_shareable_read.py` | `persist()` swallowed failures and would have handed out a share link to a row that was never written. |
| `test_procurement.py` | Duties must be sized for the **end state**, not the rung's delta; a lump-sum bid must convert onto the library's own unit. |
| `test_reference_layer.py` | Every number on a public reference page must be generated, never typed. |
| `test_agent_distribution.py`, `test_machine_interface.py` | The free tier must stay free and the metered tier must stay metered. |
| `test_working_files.py` | The worked example published on the site must be reproducible from the working files published beside it. |

**Recurring failure pattern, named so you can watch for it:** *a fact stated in two
places, only one of them updated.* Prices, domains, constraint IDs, endpoint names,
CLI commands. When you add anything that exists in two languages or two files, add
the test that asserts they agree, in the same patch.

---

## 4. Patch history — what each one bought

| # | Title | What it bought commercially |
|---|-------|------------------------------|
| 0001 | capacity envelope engine | The thing we sell: a defensible answer to "what stops this hall". |
| 0002 | BTM, time to power, GridOS audit | The date, which is the number the buyer actually cares about. |
| 0003 | intake, CLI, model pack, screen, portfolio | Repeatability — the same answer twice without the same effort twice. |
| 0004 | fix blank-intake crash, smoke tests, CI | A demo that does not fall over in front of a client. |
| 0005 | engine API + capacity qualifier | The free read at the top of the funnel. |
| 0006 | sell and deliver the Density Screen | First cash. €4,500, checkout to deliverable, end to end. |
| 0007 | admin pipeline and deploy | Knowing what is in the funnel without asking anyone. |
| 0008 | cost library and proposals | The first compounding asset, and a priced proposal that opens with a real finding. |
| 0009 | walkthrough deck, cost-library safety | The 90-minute session that closes the study, and a library that cannot leak a quote. |
| 0010 | change engine and Hall Watch | Recurring revenue against a real recurring need, not a subscription bolted onto a one-off. |
| 0011 | funnel and published dataset | Distribution: the qualifier on the homepage, the binding-constraint dataset in public. |
| 0012 | reference worked example | Proof, published, reproducible from the working files beside it. |
| 0013 | calibration ledger + machine interface | The second compounding asset, and the engine as something software can buy. |
| 0014 | self-serve API, deploy fixes | Revenue without a sales call. |
| 0015 | Procurement Specification + deploy safety | €18,000 product, and a deploy that cannot rotate a live key. |
| 0016 | stack consistency | Nothing priced may be unbuyable, ungeneratable or undeliverable. |
| 0017 | public constraint reference | Thirteen generated pages. The authority layer. |
| 0018 | agent distribution | Free tier opened to agents; the reference made citable. |
| 0019 | root hygiene | The root is the first thing a stranger reads. |
| 0020 | patch intake | Patches land in `inbox/` and do not survive being applied. |
| 0021 | shareable capacity read | The read had to be able to leave the browser tab — `/q/<token>`. |
| 0022 | one company | One domain, one price list, no fictitious plant. Deleted `/infrastructure`. |
| 0023 | intake baseline | The intake script stopped punishing innocent patches. See below. |

### What 0023 fixed, in detail, because it bit twice

A patch uploaded through the GitHub web interface lands at the **repository root**,
never in `inbox/`. The root-hygiene test correctly went red. `apply-inbox.sh` then
applied an unrelated, correct patch (0021), ran the whole suite, saw red, and rolled
0021 back. Twice. The guard was right; the script's reading of it was wrong — it
could not tell *"this patch broke the repository"* from *"the repository was already
broken"*.

0023 does two things, both tested in `tests/test_patch_intake.py`:

1. **The script sweeps `*.patch` off the root into `inbox/` itself**, committing the
   move when the file is tracked. The web uploader has no usable folder picker;
   telling a human to `git mv` every time is not a workflow.
2. **The script records which tests were already failing before it applies
   anything**, and rolls back only on **new** failures. Pre-existing failures are
   printed, by name, at the start and at the end — loudly, so they still get fixed —
   but they no longer revert someone else's work. A patch that *fixes* a baseline
   failure shrinks the baseline, so a later patch in the same run cannot smuggle it
   back in.

---

## 5. How to work on this repository

```bash
git clone https://github.com/iceccarelli/GridForge-AI && cd GridForge-AI
python3 -m pytest tests -q          # expect all green
npm ci && npx tsc --noEmit && npm run build
```

Applying a patch — the only supported route:

```bash
# Upload the .patch anywhere in the repo (root is fine now) or drop it in inbox/
bash scripts/apply-inbox.sh         # sweeps, baselines, applies, tests, commits
npx tsc --noEmit && npm run build
git push origin main
```

`apply-inbox.sh --dry-run` says what would apply and changes nothing. If a patch is
rolled back, **the file is gone from `inbox/`** — re-upload your copy.

Local engine:

```bash
python3 -m gridforge.cli serve      # stdlib HTTP, no dependencies
python3 -m gridforge.cli reference  # regenerate the public constraint pages
python3 -m gridforge.cli key --help # mint/inspect signed API keys
```

---

## 6. OPEN — everything not done. Work from this list.

### 6a. Operational, blocking, needs the founder's credentials

1. **Vercel:** set `NEXT_PUBLIC_SITE_URL=https://timetopower.ai`. Until this is set,
   `lib/site.ts` falls back to the literal default and any preview deployment emits
   canonical URLs for production.
2. **Supabase:** run migrations `0002_qualifications.sql` … `0008_qualification_token.sql`.
   **`0008` gates the `/q/<token>` share link** — the share surface shipped in 0021
   does not function until it is applied.
3. **Vercel:** set `CRON_SECRET` (the weekly Hall Watch cron in `vercel.json` is
   unauthenticated without it).
4. **Rotate `GRIDFORGE_API_KEYS`.** A key was pasted into a chat transcript. Mint a
   new one with `gridforge key`, set it on Fly and on Vercel, add the old key to
   `GRIDFORGE_REVOKED_KEYS`.
5. **`fly apps destroy test-engine`.** A stray Fly app created by an early version of
   `test_deploy_script.py`, which resolved the real `flyctl` instead of the fake. The
   test is fixed; the app may still exist and may still bill.

### 6b. Governance and legal

6. **Neither GridForge-AI nor ThermalForge has a `LICENSE` file** (audit finding A2).
   A public repository with no licence is "all rights reserved" by default, which is
   probably what we want — but it should be a decision written down, not an omission.
7. **`docs/00_COMMERCIAL_SPINE.md` is publicly readable** and names the ICP, the
   target operator list, the pricing logic and the steelman against us. This is the
   venture thesis. **The founder has not yet answered whether to move it to a private
   repository.** Ask before the next push. Nothing else in `docs/` has this problem.
8. Terms, privacy and security pages exist (`/legal/*`) but have never been reviewed
   by a lawyer. The engagement scope-out language in `commercial.py` is the real
   liability boundary and it is currently only in the deliverable, not in the terms.

### 6c. Product — built but not finished

9. **A cancelled Hall Watch keeps being delivered.** Billing is fine — checkout runs
   in Stripe subscription mode (`recurring: { interval: "month", intervalCount: 3 }`)
   and renews by itself. The gap is the other direction: in
   `app/api/stripe/webhook/route.ts`, `customer.subscription.deleted` and
   `invoice.payment_failed` resolve the subscription id against **`api_accounts`
   only**. A `watches` row is never looked up, so its status never leaves `active`,
   and `dueWatches()` (which filters on `status=eq.active`) keeps generating and
   sending quarterly change notes to someone who has stopped paying. Fix: resolve
   both tables in those two handlers, and add the test — this is the same
   "a fact stated in two places" pattern as everything in §3.
10. **The calibration ledger is empty.** Every response says `UNCALIBRATED`, which is
    honest and also the weakest thing on the site. The first paid engagement must end
    with `gridforge calibrate` and a real observation. Nothing else on this list
    creates as much value per hour spent.
11. **The cost library seed holds no quotations**, by design — so screening economics
    are E0/E1 throughout. The first Procurement Specification should ingest real bids
    through `gridforge/procurement/ingest.py` and upgrade the library. Build the
    habit into the delivery runbook so it is not optional.
12. **No portfolio deliverable template.** `/v1/portfolio` returns a ranking; the
    €60k–€140k engagement promises "one model pack per hall" and that packaging step
    is manual.
13. **The Procurement Specification's bid comparison has no supplier-facing artefact.**
    We hand the client a response schedule; we do not hand the supplier a form. That
    is one generator away and it makes the product land better.
14. **`/api/chat` (the scoping agent) has no conversation persistence.** A buyer who
    reloads loses the scoping conversation that was about to become a lead.
15. **No email sequence.** Resend is wired for transactional mail only. A `/q/<token>`
    read that nobody follows up on is a lead we paid for and discarded.

### 6d. Engineering — known gaps in the model itself

16. **No CFD and no intention to add one** — it is scoped out of every engagement.
    But `residual_air_removal` is the constraint most likely to be wrong without one,
    and we should know by how much. A sensitivity study against published hall data
    would tell us whether the scope-out is safe or whether it is exposure.
17. **`floor_loading` is a screening calculation only** and says so. If a client ever
    acts on it structurally we have a problem the disclaimer may not cover.
18. **Thirteen constraints, no thermal transient.** Everything is steady-state. A hall
    that survives steady-state and fails on a chiller restart is a real failure mode
    we do not model and do not currently disclose as unmodelled.
19. **ThermalForge integration is still selective and undocumented.** Nobody but the
    founder knows which parts were taken and which were rejected. Write that down
    before the knowledge is lost.
20. **The platform library** (`gridforge/platforms.py`) hardcodes accelerator
    families. It needs a refresh cadence and an owner, or it silently ages into
    wrongness — and it is the input a buyer is most likely to check first.

### 6e. Distribution

21. **`/llms.txt` and `/api/cite` are live but nothing points at them.** No submission
    to any model-facing index, no schema.org dataset markup on the constraint pages.
22. **The benchmark needs 8 halls and we have fewer.** Until then `benchmark()`
    returns nothing, and the qualifier's best hook is dark.
23. **No case study.** The published worked example is synthetic and labelled as such.
    One real, anonymised engagement converts more than every reference page combined.

---

## 7. What to do first

In order, and the order is the founder's sequence from §0, not a preference:

1. Clear **6a** — the site and the share link do not work correctly without it. This
   is an hour of the founder's time and it unblocks everything downstream.
2. Get **one paid Density Screen delivered**, then immediately do **6c #10** and
   **#11** — the calibration observation and the cost-library upgrade. CASH before
   REPEATABILITY before AUTOMATION. The assets only compound if they are fed.
3. Answer **6b #7** before the next push. It is the only item here where delay is
   irreversible.
4. Then **6c #9** (Hall Watch renewal), because recurring revenue that does not
   recur is the single largest gap between what the price list claims and what the
   code does.

Everything else is real work and none of it is urgent before those four.

---

## 8. One thing to internalise before you change anything

The founder's word for what we are building is *authority*. Authority in this market
is not a bigger model or a nicer site. It is being the only party whose numbers can
be traced to a named source file, whose accuracy record is published including where
it is unflattering, and who sells nothing in the answer.

Every guard in this repository exists to stop us degrading that by accident. When a
test blocks you, the test is almost certainly right — that is the whole history of
this codebase, documented patch by patch above. Fix the cause. Do not weaken the
guard.
