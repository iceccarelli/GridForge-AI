# GF-001 — Capability Matrix

**Mission:** GridForge — AI Data-Center Time-to-Power Decision Platform
**Branch:** `factory/GF-001`  ·  **Baseline:** `ea1f62d`
**Classification:** CONCEPT · SHELL · PARTIAL · WIRED · VERIFIED · PRODUCTION_READY

"VERIFIED" below means *executed in this session* — a test run, a CLI run, or an
HTTP request against a running server. Nothing is classified from reading code.

---

## 1. The domain engine (`gridforge/`, Python, zero runtime dependencies)

| Capability | Class | Evidence |
|---|---|---|
| 13 electrical / thermal / physical constraints | **VERIFIED** | 393 pytest tests; `gridforge screen` names the binding constraint on real intake |
| Evidence ladder E0–E7 with a provenance DAG | **VERIFIED** | `tests/test_validation.py`, `tests/test_report_gates.py`; arithmetic propagates the weakest class |
| Interval arithmetic and envelope solver | **VERIFIED** | `tests/test_constraints.py`; ran over `examples/intake/reference_hall.json` |
| Time-to-power / headroom ladder | **VERIFIED** | `tests/test_btm_and_time_to_power.py`; study names the item that sets the date |
| Scenario comparison, sensitivity, change notes | **VERIFIED** | `tests/test_change.py`; CLI `diff` run in CI |
| Costs, proposals, procurement spec, bid evaluation | **VERIFIED** | `tests/test_costs_and_proposal.py`, `tests/test_procurement.py` |
| Report gates (refuse to emit an un-provenanced number) | **VERIFIED** | `tests/test_report_gates.py` |
| Calibration ledger, honest about being empty | **VERIFIED** | `gridforge calibrate show` states no record established |
| CLI (`init`/`gaps`/`screen`/`study`/`proposal`/`deck`/…) | **VERIFIED** | Run end-to-end this session; documents written |
| HTTP API + MCP, signed offline-verifiable keys, metering | **VERIFIED** | Engine served on :8080; `/health`, `/v1/version`, `/v1/qualify` answered live |

**The engine is not a shell and was not rebuilt.** Every change in this mission sits
at the joins around it.

## 2. The commercial site (`app/`, `lib/`, Next.js 15)

| Capability | Before | After | Evidence |
|---|---|---|---|
| Free capacity qualifier → real engine | WIRED | **VERIFIED** | Live POST `/api/qualify` → engine → "28 GB300 racks after the ladder", no priced content leaked |
| Shareable capacity read `/q/<token>` | absent (unapplied patch) | **VERIFIED** | Landed patch 0024; live GET returned 200 with the hall's read, `noindex`, unknown token 404 |
| Engagement deposit checkout (Stripe) | WIRED | WIRED | Price is catalogue-driven — verified. Post-payment redirect was caller-controlled; fixed |
| **Density Screen fulfilment** (€4,500) | WIRED | **VERIFIED** | Purchase → intake → engine → draft → human release → customer reads it. Driven over HTTP; see §3 |
| **Hall Watch delivery** (recurring) | WIRED | **VERIFIED** | Baseline → "nothing moved" → a real input change → *"-19 racks (28 to 9); -4 weeks to full capacity"* → cancellation stops the cron |
| **Screen → Study follow-on offer** | **PARTIAL (always generic)** | **VERIFIED** | Named the customer's own constraint only if working files existed, which a Screen never produces. Now renders *"…relieves rack feed / tap-off rating"* on the live page |
| Metered API accounts, self-serve keys | **VERIFIED** | **VERIFIED** | `tests/test_api_keys.py`; cross-language key agreement in CI |
| **GridForge Intelligence subscription** | **SHELL** | **VERIFIED** | Was: money in, nothing stored. Now: full lifecycle driven over HTTP — see §3 |
| **Saved scenarios (paid surface)** | **SHELL** | **VERIFIED** | Was: no table, `ok:true` on every write. Now: save → list → cross-tenant refusal → delete, live |
| **AI siting analyst gate** | **PARTIAL (bypassable)** | **VERIFIED** | Gate was skipped entirely when Supabase was unset; now fails closed, 9 executable tests |
| Lead capture from the AI agent | PARTIAL | WIRED | A rejected insert was silent; now logged with the record |
| Admin dashboard, deliverable release | WIRED | WIRED | Unchanged by this mission |

## 3. The required Product 01 workflow, end to end

| Stage | Class | How it was verified this session |
|---|---|---|
| project creation | **VERIFIED** | `gridforge init` produced a blank intake; a paid engagement opens its own row and intake token |
| real inputs | **VERIFIED** | `reference_hall.json`; qualifier accepted seven live numbers over HTTP |
| real evidence / validation | **VERIFIED** | `gridforge gaps` reported 100% completeness, 16 supplied, 0 assumed; qualifier returned a precise 422 on a mistyped field |
| real analysis | **VERIFIED** | `gridforge screen` / `study` over the real constraint set |
| binding constraints | **VERIFIED** | "Rack feed / tap-off rating" returned live by the engine through the site |
| scenarios | **VERIFIED** | 0 racks as found → 28 after the ladder; saved, listed and deleted through the paid surface |
| uncertainty | **VERIFIED** | Interval quantities and evidence classes on every output; calibration state reported as uncalibrated |
| implications | **VERIFIED** | "Chilled-water plant capacity" named as the item that sets the date |
| report / artifact | **VERIFIED** | `envelope_study.md/.html` + `model_pack.json` written |
| delivery | **VERIFIED** | `/q/<token>` served the read to a second reader, noindex, 404 on an unknown token. The paid document is withheld as a draft (409), released by an authenticated human, then readable — and a released engagement cannot be regenerated |
| commercial workflow | **VERIFIED** | Purchase → entitlement → paid surface → retry grace → cancellation → surface closes, over HTTP with real Stripe signatures. Verified for all three recurring products and for the one-off engagement |
| repeat / upsell | **VERIFIED** | The follow-on offer now names the hall's own binding constraint, rendered on the released deliverable page |

## 4. What is still not verified, and why

| Item | Class | Why not higher |
|---|---|---|
| Supabase schema applied to a real project | **WIRED** | Migrations `0009`/`0010` are written and were parsed and served by a local PostgREST stand-in built from those exact files. They have **not** been run against a hosted Supabase project. |
| Stripe API calls (session creation) | **WIRED** | Signature verification and every webhook branch are verified, as is the price being catalogue-driven. Creating a real Checkout Session needs live keys. |
| Intake completeness policy | **OPEN — a decision, not a defect** | The schema and the form require 12 physics fields; the file's own docstring, its sibling `compact()`, the page copy and the engine all say blanks become named assumptions. A Density Screen buyer with incomplete data cannot submit. See the gap analysis. |
| Transactional email (Resend) | **WIRED** | Deliberately unset during testing; no outbound mail was sent. |
| Anthropic-backed chat / analyst answers | **WIRED** | Gates verified; the model was never called. |
| Any engine output against a real site | **E0–E1** | The repository's own position, unchanged: nothing is field-validated, and the calibration ledger says so. |
