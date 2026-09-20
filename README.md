# Time to Power

## Power-Capacity Intelligence for AI Infrastructure

**Know how much AI compute a site can actually support, what blocks it, what fixes it, what the fix costs, and when the compute can go live.**

Time to Power is the commercial product and category.

**GridForge Engine** is the deterministic engineering engine underneath it.

`GridForge-AI` is the engineering repository.

The company does **not** sell GPUs, generators, cooling equipment, batteries, data centers, or hardware.

It sells the **decision about the infrastructure**.

---

## The problem

AI infrastructure is no longer constrained only by chips.

It is constrained by:

* electrical capacity;
* grid connection and interconnection timing;
* transformer and switchgear limits;
* UPS and distribution topology;
* rack power density;
* liquid-cooling capability;
* floor loading and physical limits;
* equipment lead times;
* capital cost;
* and, ultimately, the date on which useful compute can actually be energized.

The economic question is simple:

> **What useful AI compute can this site deliver, under which architecture, at what cost, and on what date?**

That is the question Time to Power is built to answer.

---

# What Time to Power does

Give the system the technical information for an existing or proposed AI site.

The engine determines:

**site envelope → deployable AI capacity → binding constraint → relief options → cost → lead time → time-to-power → procurement → validation**

The output is not a generic “AI readiness” score.

It is an engineering decision with:

* a binding constraint;
* a deployable rack / compute envelope;
* a costed Headroom Ladder;
* time-to-power implications;
* scenarios;
* uncertainty;
* provenance;
* evidence class;
* and, where available, measured and field-validated outcomes.

---

# The core product

## Time to Power Capacity OS

The long-term product is a decision system for AI infrastructure capacity.

It answers:

### 1. What can the site support now?

### 2. What binds first?

### 3. How much additional AI capacity can be unlocked?

### 4. Which intervention unlocks it?

### 5. What does that intervention cost?

### 6. How long does it take?

### 7. Which supplier response actually changes the date?

### 8. Did the model eventually match reality?

The final question is the moat.

A model without field feedback is an engineering model.

A model continuously reconciled against reality becomes infrastructure intelligence.

---

# What can be bought today

The current catalogue is deliberately narrow.

## 1. Density Screen

**€4,500 · 5 working days**

One hall.

The answer to:

> What binds this hall first, how many target-platform racks does it support, and what determines the date?

Includes:

* binding constraint;
* deployable racks as found;
* first headroom steps;
* item setting the energisation date;
* cooling architecture screen;
* assumptions and missing data.

The screen is credited in full against the full study.

---

## 2. Capacity & Density Envelope Study

**€22,000–€45,000 · approximately 25 working days**

The core engineering engagement.

Includes:

* complete capacity envelope;
* thirteen constraint families;
* power + thermal + physical interaction;
* Headroom Ladder;
* scenario comparison;
* sensitivity analysis;
* time-to-power;
* screening economics;
* uncertainty;
* provenance;
* engineering risk register;
* machine-readable model pack;
* engineering walkthrough.

This is the high-value answer to:

> **How much AI compute can this site actually carry, and what is the cheapest/fastest path to more?**

---

## 3. Procurement Specification

**€18,000 · approximately 12 working days**

The step between an engineering conclusion and a purchase decision.

The system turns a binding constraint into:

* a tender-ready technical specification;
* numeric requirements derived from the model;
* a structured supplier response schedule;
* bid comparison;
* cost per rack / capacity unlocked;
* and the effect of each response on the energisation date.

The product does not sell the equipment.

It evaluates whether the supplier response actually relieves the constraint.

---

## 4. Portfolio Screen

**€60,000–€140,000**

Five to fifteen halls under one methodology.

The output compares:

* deployable compute;
* time-to-power;
* capital requirements;
* binding constraints;
* and portfolio-level bottlenecks.

This is the beginning of infrastructure investment intelligence.

---

## 5. Hall Watch

**€6,000 per quarter**

A previously analysed site remains live.

When an input changes, the model is re-solved and the customer receives a change note explaining:

* what changed;
* which input changed;
* what constraint moved;
* how the capacity moved;
* and whether the energisation date changed.

Recurring revenue is earned by solving a recurring decision.

It is not a subscription bolted onto a one-off report.

---

# The three products Time to Power is building toward

## Product 1 — Capacity OS

**Site → capacity → constraints → headroom → cost → time**

This is the primary product.

The existing Density Screen, Envelope Study, solver, scenario engine, provenance layer and time-to-power engine are the foundation.

---

## Product 2 — Verified Powered-Site Intelligence

**Which sites can actually support my AI deployment?**

The future site layer combines:

* location;
* grid connection;
* firm capacity;
* available capacity;
* transformers;
* electrical distribution;
* cooling;
* AI rack density;
* time-to-power;
* intervention cost;
* evidence;
* confidence;
* historical changes;
* and eventually observed operating performance.

This is not a generic real-estate map.

It is a **physical infrastructure verification layer**.

The long-term unit of value is the **verified site**.

---

## Product 3 — Procurement & Bid Intelligence

**Which intervention actually gets me powered?**

The system converts:

**constraint → specification → supplier responses → comparison → procurement intelligence → actual result**

Every procurement engagement creates potentially reusable information about:

* equipment cost;
* region;
* capacity;
* lead time;
* intervention type;
* supplier response;
* installed result;
* and model accuracy.

That transaction history is a compounding asset.

---

# The moat

The moat is not the word “AI”.

The moat is not the website.

The moat is not the Python solver alone.

The moat is:

# Verified infrastructure data + calibrated models + transaction history

The intended data loop is:

```text
SITE
  ↓
ENGINEERING INPUTS
  ↓
MODEL
  ↓
CAPACITY DECISION
  ↓
CONSTRAINT
  ↓
INTERVENTION
  ↓
PROCUREMENT
  ↓
SUPPLIER RESPONSE
  ↓
DEPLOYMENT
  ↓
MEASURED OUTCOME
  ↓
CALIBRATION
  ↓
BETTER MODEL
  ↓
BETTER DECISION
  ↓
MORE CUSTOMERS
```

Every customer should make the next customer cheaper, faster or more accurate.

---

# Evidence is a product feature

Every number carries an evidence class and provenance.

```text
E0  assumed
E1  modelled
E2  simulated
E3  engineering estimate
E4  validated against test data
E5  measured at site
E6  field-validated
E7  observed in operation
```

The engine propagates the weakest evidence class through calculations.

A number cannot become more trustworthy merely because it passed through more software.

A customer report must never imply measurement where only a model exists.

A future platform decision should be able to answer:

> Where did this number come from?

and:

> How wrong has this model historically been?

---

# Calibration

The calibration ledger is intentionally honest.

At the current stage the field-validation dataset is empty or insufficient.

That means:

**UNVALIDATED ≠ BAD**

but also:

**UNVALIDATED ≠ PROVEN**

The first objective is therefore not another feature.

The first objective is:

# Get real projects and measure what happened.

Every paid project should create the opportunity for a future field-validation record.

---

# The engineering engine

The engine is Python 3.11+ and intentionally has no third-party runtime dependencies.

```text
gridforge/
  validation/       evidence, provenance, interval arithmetic, units
  constraints.py    shared constraint protocol
  costs.py          cost library
  site/             site schemas and physical constraints
  power/            electrical schemas and constraints
  compute/          workload and platform definitions
  thermal/          cooling schemas and constraints
  envelope/         solver, Headroom Ladder, time-to-power
  scenario/         architecture/scenario comparison
  economics/        CAPEX/OPEX and estimating logic
  calibration/      predicted vs observed outcomes
  procurement/      specifications and bid evaluation
  reference/        generated engineering reference
  reporting/        reports, proposals, decks, specifications
  api/              HTTP, metering, authentication, MCP
  integrations/     explicit integration ports
```

The central algorithm is deliberately explainable:

```text
solve site
    ↓
evaluate constraints
    ↓
find binding constraint
    ↓
apply relief
    ↓
solve again
    ↓
repeat
    ↓
produce Headroom Ladder
```

The explanation is part of the product.

---

# Current machine interface

The engine already exposes a machine-callable surface.

## Core HTTP surfaces

```text
GET  /v1/tools
GET  /v1/version
GET  /v1/usage
GET  /v1/calibration

POST /v1/qualify
POST /v1/screen
POST /v1/study
POST /v1/portfolio
POST /v1/diff
POST /v1/spec
POST /v1/bids
POST /v1/proposal
```

## MCP

```text
POST /mcp
```

Protocol:

```text
JSON-RPC 2.0
Model Context Protocol
```

The intended model is:

> an AI agent can ask the deterministic engineering engine questions, but it cannot manufacture physical truth.

---

# Available machine tools

```text
gridforge_qualify
gridforge_screen
gridforge_study
gridforge_portfolio
gridforge_diff
gridforge_spec
gridforge_bids
gridforge_proposal
```

The free qualifier returns a screening result without requiring an account.

Paid tools are metered.

The distinction is deliberate:

```text
free → discovery / qualification

paid screen → engineering screening

paid study → engineering opinion

paid procurement → decision execution

API → machine-scale screening / monitoring
```

---

# Current API commercial model

```text
API — Triage       €900 / month
API — Scale        €2,900 / month
API — Platform     €7,500 / month
```

The API is not an issued engineering opinion.

It is a machine-scale screening and intelligence interface.

A named engineering opinion remains a separate commercial product.

---

# Current technical stack

## Engineering

```text
Python 3.11+
Zero third-party runtime dependencies
Deterministic constraint engine
```

## Web

```text
Next.js 15
React
TypeScript
Tailwind
Framer Motion
Recharts
```

## Infrastructure

```text
Supabase
Stripe
Resend
Fly.io
Vercel
```

The repository contains CI and tests that enforce catalogue parity, provenance rules, architecture boundaries, API consistency, deliverable consistency and production-stack behavior.

---

# Current website product surfaces

```text
/                       company argument + free qualifier
/qualify                seven-input free qualifier
/q/<token>              shareable qualification result
/constraints            public engineering reference
/constraints/<slug>     individual constraint
/platforms              platform capability/reference data
/reference              generated deliverables/reference corpus
/developers             API/MCP machine interface
/pricing                commercial catalogue
/intake/<token>         paid engagement intake
/deliverable/<token>   customer deliverable
/watch/<token>          monitored site
/api-access/<token>    API credentials
/admin/pipeline         internal operational pipeline
```

The public website is a commercial interface to the engine, not a separate product.

---

# The market

The market is large enough to justify building the company.

Current external evidence includes:

### Global data-center expansion

JLL forecasts approximately:

```text
~100 GW of new data-center capacity by 2030
~14% CAGR through 2030
~$3T of combined sector expenditure through 2030
```

JLL identifies **speed to power** as the primary site-selection criterion.

### Electricity demand

The IEA's 2026 outlook projects:

```text
485 TWh data-center electricity consumption in 2025
950 TWh in 2030
```

AI-focused electricity consumption grows substantially faster than the overall data-center market.

### European AI demand

CBRE reported:

```text
420 MW
AI-focused European colocation signings
H1 2026

vs.

89 MW
H1 2025
```

### Density reality

Uptime Institute's 2025 survey reports approximately:

```text
82%    highest-density rack below 30 kW
17%    highest-density rack at 30–49 kW
9%     facilities reporting ≥50 kW
```

The consequence is important:

> Do not sell “AI-ready.”

Sell the **defensible maximum under actual infrastructure constraints**.

---

# What these statistics do NOT prove

They do not prove Time to Power has product-market fit.

They do not prove that customers will pay €4,500.

They do not prove that customers will pay €30,000.

They do not prove the API will be used.

They do not prove that the model is accurate in the field.

They do not prove that Time to Power will become a large company.

They prove that the underlying infrastructure problem is economically important.

Customer behavior must prove the rest.

---

# PMF test

The primary PMF metric is:

# money received from an external customer for the actual product

Not:

```text
website traffic
GitHub stars
AI agent calls
demo requests
newsletter subscribers
social engagement
```

The commercial progression we need to prove is:

```text
visitor
  ↓
free qualifier
  ↓
€4,500 screen
  ↓
€22k–€45k study
  ↓
€18k procurement
  ↓
portfolio / watch
  ↓
recurring account
  ↓
API / machine integration
```

The key question is:

> **Does the customer continue buying after the first answer?**

---

# Operating benchmarks

The following are company targets, not forecasts.

## 2026

Prove:

```text
external paying customers
repeatable paid screen
first full studies
first procurement engagement
first calibrated observation
first real case study
```

The company should optimize:

```text
cash collected / founder-hour
```

before optimizing software valuation.

---

## 2027

Target:

```text
repeat customers
multi-site engagements
measured site outcomes
supplier quote ingestion
first meaningful recurring revenue
first enterprise/API contracts
```

The software should increasingly reduce founder-hours per delivered euro.

---

## 2028

Target:

```text
capacity model becomes a reusable customer system
monitored sites become recurring revenue
portfolio intelligence becomes a product
data acquisition happens automatically during customer workflows
```

Services should increasingly exist to create and validate the software/data layer.

---

## 2029

Target:

```text
verified site registry
regional cost/lead-time intelligence
API-first infrastructure intelligence
agent-readable site and capacity records
enterprise data contracts
```

The company begins selling information about infrastructure, not just engineering hours.

---

## 2030

Target state:

```text
high recurring revenue
high gross margin
high net retention
hundreds of economically important customers/sites
large proprietary site/constraint/procurement/outcome dataset
machine-readable infrastructure graph
strong field-validation record
```

The system should be capable of answering:

> Which sites can support this AI workload?

> How much capacity can they actually deliver?

> What blocks deployment?

> What intervention fixes it?

> What will it cost?

> Who can supply it?

> When will it be powered?

> How reliable is that answer?

---

# SaaS economics benchmark

The software business must eventually be judged against software economics.

Current 2026 private B2B SaaS benchmarks show approximately:

```text
22% median annual growth across the surveyed population
20% median growth for bootstrapped companies
103% median NRR for bootstrapped companies in the $3M–$20M ARR band
42.3% 90th-percentile growth for that bootstrapped ARR band
```

The lesson is not to copy a benchmark.

The lesson is:

> **Recurring revenue without retention is not a moat.**

The long-term company should target:

```text
strong gross margin
>100% NRR
high enterprise ACV
low founder involvement per account
repeatable customer acquisition
```

---

# Valuation reality

As of August 2026, the median SaaS EV/revenue multiple in Aventis' benchmark was approximately:

```text
4.6× revenue
```

This is a market benchmark, not a valuation promise.

Therefore:

```text
€1M ARR at 4.6× ≈ €4.6M EV
€5M ARR at 4.6× ≈ €23M EV
€10M ARR at 4.6× ≈ €46M EV
€20M ARR at 4.6× ≈ €92M EV
```

Higher multiples require evidence of:

* stronger growth;
* retention;
* margin;
* differentiation;
* category leadership;
* and defensibility.

The objective is therefore not:

> “Build a €100M website.”

The objective is:

> **Build a business whose economics justify a high software/data multiple.**

---

# What not to build

Do not become:

```text
a generic AI consultancy
a generic data-center map
a generic DCIM product
a GPU marketplace
a hardware reseller
an EPC
a generator owner
a BESS owner
a data-center owner
```

Do not build features solely because they look impressive in a demo.

Do not publish synthetic metrics as customer results.

Do not publish AI-generated “accuracy” without measurements.

Do not create a second pricing system.

Do not create a second API for the same engine.

Do not build parallel databases for the same object.

Do not allow marketing claims to drift away from actual purchasable products.

---

# Product doctrine

Every new feature must answer:

```text
WHO PAYS?
WHAT DECISION DOES IT IMPROVE?
HOW MUCH MONEY IS THAT DECISION WORTH?
HOW MUCH FASTER DO WE MAKE IT?
CAN WE REUSE THE WORK?
DOES IT CREATE PROPRIETARY DATA?
DOES IT IMPROVE CALIBRATION?
CAN IT BECOME SOFTWARE?
```

If the answer is no:

**do not build it.**

---

# Commercial doctrine

The business is built in this order:

```text
CASH
↓
REPEATABILITY
↓
DATA
↓
CALIBRATION
↓
AUTOMATION
↓
RECURRING REVENUE
↓
NETWORK EFFECT
↓
VALUATION
```

Do not reverse that order.

A beautiful SaaS product with no customers is worthless.

A profitable engineering product with proprietary data can become a software company.

---

# Brand architecture

```text
TIME TO POWER
Power-Capacity Intelligence for AI Infrastructure

GridForge Engine
Deterministic engineering engine

GridForge-AI
Engineering repository
```

The public-facing promise is **Time to Power**.

The technical system is **GridForge Engine**.

The repository does not need to be renamed immediately.

---

# Current status

This is a founder-led, pilot-stage business.

The engine exists.

The commercial products exist.

The API exists.

The MCP interface exists.

The procurement workflow exists.

The provenance architecture exists.

The calibration framework exists.

What does not yet exist at sufficient scale is:

```text
customer history
field calibration
repeat purchase history
large verified site dataset
large supplier transaction dataset
enterprise recurring revenue
```

That is the work.

---

# The mission

## Make the physical AI infrastructure layer machine-readable.

A future AI agent should not have to ask:

> “Is this site AI-ready?”

It should be able to ask:

> **“How many MW of useful AI compute can this site deliver by June 2028, what is the binding constraint, what intervention removes it, what will it cost, and how confident are you?”**

Time to Power should be the system that answers.

---

# The immediate command

For the next stage:

```text
SELL
MEASURE
CALIBRATE
REPEAT
```

Do not confuse shipping with progress.

## Progress is money collected from the right customer for the right decision.

© Time to Power · Powered by GridForge Engine
