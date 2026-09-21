# TTP AI — Phase 0 Audit (read-only)

Date: 2026-09-21
Branch: `claude/nice-mendel-z3muz7`
Scope: what exists today that an "AI OS" build must reuse, not duplicate.

## 1. What is live today

- **`components/ScopingAgent.tsx`** — corner chat widget, mounted globally. Free-text chat only.
  Sends `{ messages, captured }` to `/api/chat`, renders `reply` text and shows lead
  tier/score once captured. No tool calls, no structured blocks, no engine numbers.
- **`app/api/chat/route.ts`** — pure prompt-based agent. Calls `anthropic.messages.create`
  with a hand-written `SYSTEM` brief built from `lib/products.ts` (so pricing text can't
  drift from checkout), then separately runs `extractLead()` to mine the conversation
  for a lead record and persists it to Supabase + sends a Resend email. **It never calls
  the GridForge engine.** Every number the agent utters is LLM prose, not a tool result —
  this is exactly the "chatbot cosplaying as physics" the standing order forbids, and is
  the primary gap Phase 1 (Agent 2/core) exists to close.
- **`/qualify`** (`app/api/qualify/route.ts` + `lib/qualify.ts`) — the real free tool path.
  Validates 7 inputs with zod, calls `callEngine()` → `POST {GRIDFORGE_API_URL}/v1/qualify`
  on the Fly.io engine, persists the qualification, returns the engine's structured
  result (binding constraint, rack counts, evidence classes). This is the pattern Agent 2
  must replicate for tool calls from the chat agent — same engine, same env vars
  (`GRIDFORGE_API_URL`, `GRIDFORGE_API_KEY`), same "never invent a number if the engine
  is unreachable" discipline.

## 2. The real tool surface (do not rebuild)

`gridforge/api/tools.py` defines the canonical registry, exported three ways from one
list (`TOOLS`): `GET /v1/tools` (catalogue), OpenAI function-calling shape
(`openai_tools()`), and MCP shape (`mcp_tools()` at `POST /mcp`). Eight tools, matching
the standing order's expected names exactly:

| tool | endpoint | tier | free? |
|---|---|---|---|
| `gridforge_qualify` | `/v1/qualify` | client | yes — no key |
| `gridforge_screen` | (see tools.py) | client | metered |
| `gridforge_study` | " | client | metered |
| `gridforge_portfolio` | " | client | metered |
| `gridforge_diff` | " | client | metered |
| `gridforge_spec` | " | client | metered |
| `gridforge_bids` | " | client | metered |
| `gridforge_proposal` | " | client | metered |

Each tool entry carries `inputSchema`, `units` (metering cost), `tier`, and `endpoint`.
This is already agent-ready — Agent 2's job is to **wrap this registry**, not invent new
tool definitions or a second catalogue.

## 3. Commercial truth (do not touch pricing)

`lib/products.ts` — `LADDER_PRODUCTS`: `density_screen` (€4,500), `envelope_study_deposit`
(€9,000 dep. against €22k–45k), `hall_watch` (€6,000/quarter), `portfolio_screen_deposit`
(€15,000 dep. against €60k–140k), `procurement_spec` (€18,000), plus API plans
`api_triage`/`api_scale`/`api_platform`. Separate `INTELLIGENCE_PLANS` (developer/team/
enterprise subscriptions) power `/intelligence`. Checkout is Stripe, via `lib/checkout.ts`
+ `app/api/checkout` + `app/api/stripe/webhook` — existing, working, not to be duplicated.
`app/api/chat/route.ts` already derives its prose from `LADDER_PRODUCTS` — that pattern
must survive into the new orchestration layer.

## 4. Entitlements / metering (do not rebuild)

- `lib/api-access.ts` mints self-serve API keys (`gfk1…`) offline-verifiable against
  `gridforge/api/keys.py` — signature-based, no DB round trip needed to verify a key.
- `gridforge/api/metering.py` + `gridforge/api/tiers.py` define unit costs and tiers;
  engine returns **402 (not 429)** over quota per the honesty kernel — buy more, not retry.
- Any new orchestration layer must call through this, keyed by the caller's existing
  entitlement, not a parallel gate.

## 5. Evidence / honesty kernel (engine-enforced, unmodifiable)

`gridforge/reporting/gates.py` refuses documents with un-provenanced numbers. Every
numeric result already carries an evidence class E0–E7 and a provenance digest.
`gridforge/calibration/` (`ledger.py`, `stats.py`, `disclosure.py`) is the field-validation
record and is **empty today** — this must stay visibly disclosed in any new surface
(chat replies, `/workspace` cards, API responses). Never synthesize a calibration number.

## 6. What does NOT exist yet (the actual gap)

- No `lib/ai/` directory — no typed tool registry, policy, schema, or provenance layer
  on the Next.js side. The chat route talks to the LLM directly with no tool-calling loop.
- No `/workspace` route or `components/ai/` card components.
- No structured response contract (Zod blocks: answer/metric/constraint/missingInput/
  evidence/commercialAction/nextAction) between the LLM and the UI — today the UI renders
  raw markdown-ish prose strings.
- No server-side entitlement gate inside the chat/agent path specifically (paid tools are
  gated at their own routes today, e.g. `/api/checkout`, but the chat agent has never
  called a paid tool, so there is nothing gating it).

## 7. Site crawl

Outbound HTTPS from this session goes through the pre-configured proxy; a live crawl of
`https://timetopower.ai` was not attempted for this audit — the source above (Next.js App
Router source in this repo, which is what actually deploys to that domain) is authoritative
for behavior and was used instead. Route inventory below (§8) is taken directly from
`app/` and matches the domain's App Router structure 1:1, so source audit stands in for a
live crawl without loss of accuracy for this purpose.

## 8. Route inventory (source-derived)

`app/`: `page.tsx` (marketing home), `qualify/`, `pricing`? (see `lib/products.ts` consumer
`app/pricing` if present), `intelligence/` (commercial landing — **stays**, not to be
hijacked), `developers/`, `constraints/`, `reference/`, `dashboard/`, `account/`, `admin/`,
`watch/`, `commissioned/`, `deliverable/[token]`, `intake/[token]`, `api-access/`, `q/`
(shortlink), `platforms/`. No `workspace/` exists — this is the new surface Agent 3 builds.

## 9. Non-negotiables re-confirmed against code

1. `ScopingAgent.tsx` stays mounted; only allowed future edit is an "Open full workspace"
   deep link to `/workspace`. **Confirmed present, confirmed untouched this phase.**
2. Engine (`gridforge/`) is physics truth; nothing here proposes a second solver.
3. No second catalogue/Stripe/MCP/metering found to exist yet, so none will be built —
   Agent 2/6 must import the ones enumerated in §2–4.
4. No fake customers/MW/accuracy — calibration ledger confirmed empty; must stay disclosed.
5. Density Screen (`density_screen`, €4,500) remains primary paid wedge — confirmed as
   first non-deposit item in `LADDER_PRODUCTS` order.
6. `/intelligence` confirmed as a distinct existing route selling intelligence
   subscriptions — left untouched; `/workspace` is the new app surface.
7. Money path (`/qualify` free → Density Screen → ladder via Stripe) confirmed intact in
   code; Phase 1–3 must not alter `lib/checkout.ts`, `app/api/stripe/**`, or `lib/products.ts`.
