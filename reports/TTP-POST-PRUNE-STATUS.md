# Post-prune status — money path on current main

Checked 2026-09-22. Prune mission (branch cleanup) is done — Vincenzo completed
it directly in Codespaces after this session's PR #20 (docs-only: branch audit
+ ops checklist) merged. This report covers the follow-up mission only: prove
the money path still works on the tip that resulted, fix only real breakage.

## Tip and remotes

- `origin/main` tip: `43b96e6a750e1833f7b0fbe4b6e792b23d023a2b`
  ("Merge pull request #20 from iceccarelli/chore/prune-stale-branches",
  2026-09-22 00:01:12 +0200)
- `git branch -r` (after `git fetch --prune`): **only `origin/main`**. No
  other remote branches exist. Nothing was deleted or created by this
  session — the list was already clean when checked.

## Code map on this tip

| Concern | File |
|---|---|
| Catalogue (single source of prices/SKUs) | `lib/products.ts` |
| Checkout route | `app/api/checkout/route.ts` |
| Stripe webhook | `app/api/stripe/webhook/route.ts` |
| Chat/scoping route | `app/api/chat/route.ts` |
| Qualify route | `app/api/qualify/route.ts` |
| Workspace page | `app/workspace/page.tsx`, `app/workspace/WorkspaceClient.tsx` |
| commercialAction assembly | `lib/ai/responses.ts` (builds from `PRODUCTS.density_screen`), schema in `lib/ai/schemas.ts` |

Only one catalogue file exists (`find . -iname "products.ts"` returns exactly
`./lib/products.ts`); no second catalogue was found.

## Mock chat path

`components/ai/mock.ts` **does not exist** on this tip
(`git cat-file -e origin/main:components/ai/mock.ts` fails). `/api/chat`
runs the real tool-calling loop in `lib/ai/agent.ts` against the live
GridForge engine (`lib/ai/tools.ts` → `lib/qualify.ts` HTTP pattern) — no
narrated/mocked numeric claims.

## Density Screen price — single source confirmed

`lib/products.ts:74` — `amountCents: 450_000, // €4,500` is the only
definition. Every other occurrence of "4,500"/"€4,500" in the codebase
(`app/layout.tsx` metadata copy, `lib/ui.ts`, `lib/deliverables.ts`,
`lib/engagement-intake.ts`, comments in `app/api/stripe/webhook/route.ts`)
is descriptive text/comments, not a second price definition. Both
`app/api/checkout/route.ts` (`unit_amount: product.amountCents`) and
`lib/ai/responses.ts` (`const product = PRODUCTS.density_screen`) read the
price from `lib/products.ts` — no hardcoded duplicate.

## Nav, canonical, robots

- `/workspace` is linked from `components/ScopingAgent.tsx` (`href="/workspace"`)
  and referenced in `components/StickyMobileCTA.tsx`.
- Public pages set `alternates: { canonical: ... }` in their metadata:
  `app/page.tsx` → `/`, `app/qualify/page.tsx` → `/qualify`,
  `app/pricing/page.tsx` → `/pricing`.
- `app/workspace/page.tsx` sets `robots: { index: false, follow: false }` —
  noindex confirmed, as required.

## Live proof — blocked at the network layer

This session's outbound egress to `timetopower.ai` is denied by
organization policy (agent-proxy status: `connect_rejected` /
"gateway answered 403 to CONNECT (policy denial or upstream failure)" on
every attempt, confirmed via `curl -sS $HTTPS_PROXY/__agentproxy/status`).
No route, chat, or checkout call against the live domain could be made from
here. All live-proof rows are marked HUMAN in
`reports/TTP-OPS-CHECKLIST.md` — this is a code-path proof only, not a
production observation.

## Conclusion

No breakage found in the code path (catalogue, checkout, webhook, chat,
workspace nav/canonical/robots). **No fix branch opened** — nothing to fix.
