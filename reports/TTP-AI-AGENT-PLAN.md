# TTP AI — Agent Plan (Phase 0 output)

Coordinator: this session. Integration branch: `claude/nice-mendel-z3muz7`.
PRs are opened against `main`, stacked as noted, from dedicated agent branches.

## Assignment

| # | Agent | Branch | Status | Owns | Forbidden |
|---|---|---|---|---|---|
| 1 | Architect | `claude/nice-mendel-z3muz7` | done (this doc) | Audit, matrix, plan | product code |
| 2 | Core (engine integration) | `agent/ttp-ai-core` | **spawn now** | `lib/ai/**`, `app/api/chat/route.ts` orchestration rewrite, tool/policy tests | `app/page.tsx` redesign, `/workspace` UI, ScopingAgent removal, engine physics, prices |
| 3 | Workspace UI | `agent/ttp-ai-workspace` | **spawn now** | `app/workspace/**`, `components/ai/**` (new), optional ScopingAgent deep-link only | `lib/ai` tool adapters, engine, pricing, checkout |
| 4 | Multimodal | — | HOLD | — | — |
| 5 | Projects/memory | — | HOLD | — | — |
| 6 | Billing/entitlements wiring | `agent/ttp-ai-billing` | after 2 merges | AI `commercialAction` → existing checkout helpers, analytics/log events | new prices/SKUs, new Stripe implementation |
| 7 | Red team | — | after 2+3 | — | — |
| 8 | Evals | — | after 2 | — | — |
| 9 | Commercial review | — | read-only, parallel-ok | notes only | any code |
| 10 | Integrator | this session | continuous | merges, cross-tests, PR body | — |

## Why 2 and 3 can run in parallel safely

No file overlap: Agent 2 touches `lib/ai/**` (new) and `app/api/chat/route.ts` only.
Agent 3 touches `app/workspace/**` (new) and `components/ai/**` (new) only. Agent 3
consumes the response contract (Zod block shapes) as documented in this plan rather than
importing Agent 2's code, so it can build against a local stub/mock and swap the real
route once Agent 2 lands — no blocking dependency.

## Shared contract (both agents build to this; Agent 2 implements the producer, Agent 3 the consumer)

Response blocks (Zod-validated on the server, part of `lib/ai/responses.ts`):
`answer | metric | constraint | missingInput | evidence | commercialAction | nextAction`.
Rules Agent 2 enforces server-side and Agent 3 must assume are already true:
- Every numeric field for capacity/racks/MW/dates originates from a real
  `gridforge_*` tool result — never LLM-generated.
- Every numeric block carries its evidence class (E0–E7) and provenance digest,
  passed straight through from the engine.
- Calibration state is never omitted or invented; when asked, surface the engine's
  actual (currently empty) ledger state.
- Paid tools are gated server-side by existing entitlements (`lib/api-access.ts`,
  engine tiers/metering); free `gridforge_qualify` always available.
- `commercialAction` blocks link to existing checkout only (`lib/checkout.ts` /
  `lib/products.ts` product ids) — never a fabricated price.

## Agent 2 — Core (branch `agent/ttp-ai-core`)

Build `lib/ai/`: `agent.ts`, `context.ts`, `policy.ts`, `tools.ts`, `schemas.ts`,
`responses.ts`, `entitlements.ts`, `provenance.ts`, `prompts/`, `adapters/`.

`tools.ts` is a typed registry wrapping the **existing** engine tools — read
`gridforge/api/tools.py`'s `TOOLS` list (8 tools: `gridforge_qualify`, `_screen`,
`_study`, `_portfolio`, `_diff`, `_spec`, `_bids`, `_proposal`) and either fetch
`GET {GRIDFORGE_API_URL}/v1/tools` at build/runtime or mirror the schemas by calling
the same HTTP endpoints `lib/qualify.ts` already calls (`callEngine` pattern: read
`GRIDFORGE_API_URL`/`GRIDFORGE_API_KEY`, 20s timeout, never fabricate on failure).

Rewrite `/api/chat` to: model → tool choice → real HTTP call to the matching
`/v1/*` engine endpoint → structured Zod-validated result → explanation text.
Preserve the existing lead-capture/persist/email side effects (`extractLead`,
`persistLead`, Resend confirmation) — do not remove, only extend. Preserve the
existing `SYSTEM` prompt's constraints (no bankable numbers for free, always disclose
uncalibrated, in-scope boundaries) and extend it to describe tool use rather than
memorized figures.

Tests: authz (paid tool without entitlement → refused, matches engine's 402
semantics, not 429), missing required input → `missingInput` block not a guess,
no-hallucinated-metric (any numeric answer must trace to a tool call in the same
turn), evidence class propagates unchanged from engine response to UI block.

PR1 → `main`: "Phase 1: AI orchestration calls real GridForge tools" (stacked on PR0).

## Agent 3 — Workspace UI (branch `agent/ttp-ai-workspace`)

Build `/workspace`: three-pane layout — left conversation, center engineering canvas,
right project/context (stub acceptable this phase). Landing prompt: "What are you
trying to power?" with actions Scope site / Analyze hall / Compare scenarios / Upload
info / Review constraint.

Card components in `components/ai/`: `BindingConstraintCard`, `CapacityCard`,
`HeadroomLadderCard`, `TimeToPowerCard`, `EvidenceCard`, `MissingInputCard`,
`CommercialActionCard`, `ToolActivity`, `ProjectPanel` (stub). Each renders one of the
shared-contract block types above; while Agent 2 is in flight, mock the `/api/chat`
response shape locally against the documented contract, then point at the real route.

Starter prompts for hall capacity / binding constraint / headroom / time-to-power /
missing data. Mobile-usable (Playwright screenshots desktop+mobile as evidence).
Charts only from engine-backed series via the existing chart lib — no invented series.

`ScopingAgent.tsx` itself is not to be removed or replaced; the only permitted touch is
adding an "Open full workspace" action that deep-links to `/workspace`.

PR2 → `main`: "Phase 2: /workspace AI engineering OS (ScopingAgent remains)"
(stacked on PR1).

## Agent 6 — Billing wiring (branch `agent/ttp-ai-billing`, after PR1 exists)

Wire `commercialAction` blocks to existing checkout: free qualify → Density Screen
(catalogue price) → study/spec/watch/API via `lib/checkout.ts` / `app/api/checkout`.
No new prices, no new Stripe integration. Add event logging
(`ai_session_started`, `ai_tool_call`, `ai_qualify_completed`, `ai_checkout_started`,
`ai_checkout_completed`) — reuse existing analytics if present, else structured
`console.log`/server log lines, matching the existing `[GridForge]` log prefix
convention seen in `/api/chat`.

PR3 → `main`: "Phase 6: AI commercial handoff uses existing Stripe/catalogue"
(stacked on PR2).

## Merge order & integration checks (Integrator, this session)

PR0 (this) → PR1 (core) → PR2 (workspace) → PR3 (billing). Before each merge:
`ScopingAgent` still mounted in `app/layout.tsx`; `/workspace` loads; chat path can
invoke a real tool in dev; no duplicate catalogue/Stripe/MCP/metering introduced;
`npm run typecheck`/`npm test`/`npm run build` and relevant `pytest` green; production
smoke on `/`, `/qualify`, `/pricing`, `/workspace`, `/intelligence`, `/developers`.

## Next action

Open PR0 with this report set, then spawn Agent 2 and Agent 3 in parallel on their
branches per this plan.
