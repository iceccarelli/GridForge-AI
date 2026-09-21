# TTP AI — Capability Matrix (Phase 0)

Legend: ✅ yes · ⚠️ partial · ❌ no · — n/a

| Capability | EXISTS | WIRED | PRODUCTION | TESTED | AI-ACCESSIBLE | TOOL-ACCESSIBLE | PAID | PUBLIC | MISSING | RISK |
|---|---|---|---|---|---|---|---|---|---|---|
| Site chat (ScopingAgent) | ✅ | ✅ (`/api/chat`) | ✅ | ⚠️ no tool-call tests | ✅ (LLM) | ❌ never calls engine | ❌ free | ✅ | Tool-calling loop, structured output | LLM invents directional numbers with no engine backing — honesty-kernel risk today |
| Free qualify (`/qualify`) | ✅ | ✅ | ✅ | ✅ (`tests/test_api.py` etc.) | ❌ chat agent doesn't call it | ✅ `gridforge_qualify` (MCP+HTTP) | free | ✅ | Chat agent invocation | none — solid |
| Density Screen | ✅ (`lib/products.ts`) | ✅ Stripe checkout | ✅ | ⚠️ | ❌ | ⚠️ `gridforge_screen` exists, unclear if chat can reach checkout | ✅ €4,500 | ✅ | AI → commercialAction handoff | none, just unwired from AI |
| Envelope study | ✅ | ✅ (deposit product) | ✅ | ⚠️ | ❌ | ✅ `gridforge_study` | ✅ deposit €9k | ✅ | AI handoff | — |
| Portfolio | ✅ | ✅ (deposit product) | ✅ | ⚠️ | ❌ | ✅ `gridforge_portfolio` | ✅ deposit €15k | ✅ | AI handoff | — |
| Procurement spec | ✅ | ✅ | ✅ | ⚠️ | ❌ | ✅ `gridforge_spec` | ✅ €18k | ✅ | AI handoff | — |
| Bid compare | ✅ (engine) | ⚠️ site surface unclear | ⚠️ | ⚠️ | ❌ | ✅ `gridforge_bids` | ✅ | ⚠️ | Confirm site route | verify in Phase 1 |
| Hall Watch | ✅ | ✅ (`app/watch/`) | ✅ | ⚠️ | ❌ | ⚠️ via `gridforge_screen`/diff cadence | ✅ €6k/qtr | ✅ | AI handoff | — |
| Intelligence subs | ✅ (`app/intelligence`) | ✅ Stripe | ✅ | ⚠️ | — | — | ✅ | ✅ | n/a — stays separate from `/workspace` | do not hijack (non-negotiable #6) |
| API access | ✅ (`app/api-access`) | ✅ (`lib/api-access.ts`) | ✅ | ✅ (`test_api_keys.py`) | — | — | ✅ | ✅ | — | — |
| MCP (`/mcp`) | ✅ (`gridforge/api/server.py`) | ✅ Fly.io | ✅ | ✅ | ✅ (agents can call directly today) | ✅ canonical | mixed (qualify free) | ✅ | Site-side agent doesn't use it yet | — |
| Deliverables (PDF etc.) | ✅ (`gridforge/reporting/`) | ✅ | ✅ | ✅ (`test_report_gates.py`) | ❌ | ⚠️ implicit via tool outputs | ✅ | ⚠️ (`app/deliverable/[token]`) | AI-triggered generation | gates already enforce evidence — safe to call |
| Intake | ✅ (`app/intake`, `gridforge/intake`) | ✅ | ✅ | ✅ | ❌ | ⚠️ | — | ✅ | AI-assisted intake fill | — |
| Accounts | ✅ (`app/account`) | ✅ | ✅ | ⚠️ | — | — | — | ✅ | — | — |
| Auth | ✅ (Supabase) | ✅ | ✅ | ⚠️ | — | — | — | — | — | — |
| Stripe | ✅ | ✅ | ✅ | ✅ (webhook) | — | — | — | — | — | do not duplicate (non-negotiable #4) |
| Supabase | ✅ | ✅ | ✅ | ⚠️ | — | — | — | — | — | — |
| Calibration | ✅ ledger module | ✅ | ✅ (empty) | ✅ (`test_calibration.py`) | ❌ not surfaced in chat | ⚠️ readable, not yet a tool | — | ✅ (disclosed empty) | Chat/workspace must surface "empty" explicitly | **must never be faked** (non-negotiable #4) |
| Live market/grid | ✅ (`app/api/market`, `lib/market.ts`) | ✅ | ✅ | ⚠️ | ❌ | ❌ | — | ✅ | — | keep read-only, no invented figures |
| Reference corpus | ✅ (`app/reference`, `gridforge/reference`) | ✅ | ✅ | ✅ | ❌ | ❌ | — | ✅ | AI citation of reference studies | — |
| Constraints (13) | ✅ (`app/constraints`, `gridforge/constraints.py`) | ✅ | ✅ | ✅ | ❌ | ⚠️ implicit in qualify/screen outputs | — | ✅ | — | — |
| Scenarios | ✅ (`gridforge/scenario`, `app/api/scenarios`) | ✅ | ✅ | ⚠️ | ❌ | ⚠️ | — | ⚠️ | AI-driven scenario compare | — |
| Diff | ✅ (`gridforge_diff`) | ✅ | ✅ | ⚠️ | ❌ | ✅ | ✅ | — | AI handoff | — |
| Proposal | ✅ (`gridforge_proposal`, `gridforge/reporting/proposal.py`) | ✅ | ✅ | ⚠️ | ❌ | ✅ | ✅ | — | AI handoff | — |
| Site intelligence (SEO/JSON-LD) | ✅ (`components/JsonLd.tsx`, `app/llms.txt`) | ✅ | ✅ | — | — | — | — | ✅ | — | — |
| Developers page | ✅ (`app/developers`) | ✅ | ✅ | — | — | ✅ documents MCP | — | ✅ | Could link `/workspace` | — |

**Headline gap Phase 1/2 close:** the chat agent (`/api/chat`) is the only AI-accessible
surface today, and it is tool-blind — it narrates instead of calling
`gridforge_qualify`/`screen`/`study`/etc. Everything the tools need already exists,
tested, metered, and evidence-gated on the engine side. This is an orchestration gap, not
a missing-feature gap.
