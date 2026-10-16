# Public engine proxies: the request guard

Some free routes call the capacity engine with the **site's** platform key (`GRIDFORGE_API_KEY`), so every call spends
metered units that belong to the business. `lib/rate-limit.ts` bounds that, before the engine is asked.

## What is guarded

| Route | Engine work per request | Policy |
| --- | --- | --- |
| `POST /api/power/compare` | `/v1/compare`, 1 unit | `compare` |
| `POST /api/projects/[token]/compare` | `/v1/compare` with the project's quotations, 1 unit | `compare` (shared) |
| `POST /api/projects/[token]/comparisons` | `/v1/compare` again to store the answer, 1 unit | `compare` (shared) |
| `POST /api/power/deploy/cases` | `/v1/power/deploy/assess`, 5 units | `deploy` |
| `POST /api/power/deploy/cases/[token]` | the same, on every revision | `deploy` (shared) |

A project token is free to obtain (`POST /api/projects`), so the project routes are as public an engine proxy as the
open one and share its allowance. Validation, size caps and token lookups run first and cost no engine unit; an invalid
request neither spends a counter hit nor reaches the engine.

Not guarded, and why: `/api/qualify` and the chat widget's qualify tool call a **0-unit** endpoint; paid-engagement
intake and regeneration routes are behind a purchase token; admin, cron and subscriber routes are authenticated.

## How it decides

1. **Per-caller counter** `<route>:ip:<pseudonym>` first, then the **route-wide counter** `<route>:all`. Both must admit.
   The order matters: a caller already over its own limit is refused without touching the route-wide counter, so one
   flooding address cannot use up everyone's allowance by itself.
2. Each counter is one atomic `INSERT … ON CONFLICT DO UPDATE` inside `gf_rate_limit_hit` (migration
   `0025_rate_limits.sql`), a fixed window. The row lock serialises concurrent callers whatever the number of
   serverless instances; there is no in-memory counter anywhere, not even as a fallback.
3. Over the limit: `429`, `Retry-After`, `RateLimit-Limit/Remaining/Reset`, and a stable body:
   `{ ok:false, code:"rate_limited", scope:"caller"|"all", limit, window_seconds, retry_after_seconds, error }`.
4. A guard that cannot decide is **fail-closed**: `503`, `Retry-After: 5`, `{ ok:false, code, error }` with `code` one of
   `rate_limiter_unconfigured` (no store), `rate_limiter_unavailable` (store error, timeout after 3 s, malformed answer),
   `caller_identity_unavailable` (see below). The free tool is then paused rather than unprotected; nothing is computed.

## Caller identity (the trusted-proxy boundary)

| Deployment | Source read | Why it is trusted |
| --- | --- | --- |
| Vercel (`VERCEL=1`) | `x-vercel-forwarded-for`, else `x-real-ip` (in a list, the last element) | Vercel sets them to the client's public IP and, per its documentation, overwrites `X-Forwarded-For` rather than forwarding an external one "to prevent IP spoofing" (vercel.com/docs/headers/request-headers) |
| Anything else, `GF_TRUSTED_IP_HEADER=<name>` | that header | the operator asserts their own proxy sets and overwrites it |
| Anything else, nothing named | none | **no caller header is trusted**; every caller shares one bucket per route, which still bounds the engine spend |

The address is canonicalised before it is hashed: an IPv4-mapped IPv6 address becomes its IPv4 form, an IPv6 address is
reduced to its /64 prefix (so rotating within a /64 does not mint new buckets), and zone ids or non-addresses are rejected.
When a trusted header carries a list, the **last** element (the nearest trusted proxy's observation) counts; elements the
client supplied are ignored.

On a trusted source, a missing or unparseable address is `503 caller_identity_unavailable`, never a pass and never the
shared bucket. A caller-supplied `X-Forwarded-For` / `X-Real-IP` is never read off-platform. If the site is ever put
behind another proxy on Vercel (Cloudflare etc.), Vercel's `x-vercel-forwarded-for` is the proxy's address, not the
client's: either enable Vercel's trusted-proxy feature (Enterprise) or name the proxy's header in `GF_TRUSTED_IP_HEADER`.

## Privacy

No IP address is stored or logged. The bucket is `HMAC-SHA256(key, ip)` truncated to 128 bits, with `key` =
`GF_RATE_LIMIT_KEY`, else derived from `SUPABASE_SERVICE_ROLE_KEY`. **Rotating the key** gives every caller a fresh bucket
(windows reset; nothing else changes). Rotating the service-role key does the same when no explicit key is set; set
`GF_RATE_LIMIT_KEY` if that coupling is unwanted. Each hit also deletes up to 100 expired rows (older than two days) from any bucket, plus the bucket's own old windows, so
the table stays bounded without a scheduled job.
Logs carry constant strings only: never an address, token, header, body or facility detail.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GF_RATE_LIMIT_COMPARE` | `20/600` | hits per seconds, per caller, comparison routes |
| `GF_RATE_LIMIT_COMPARE_ALL` | `300/600` | route-wide ceiling for comparison routes |
| `GF_RATE_LIMIT_DEPLOY` | `10/600` | per caller, deployment cases |
| `GF_RATE_LIMIT_DEPLOY_ALL` | `120/600` | route-wide ceiling for deployment cases |
| `GF_TRUSTED_IP_HEADER` | unset | header name set by the operator's own proxy (off Vercel only) |
| `GF_RATE_LIMIT_KEY` | derived | HMAC key for caller pseudonyms |
| `GF_RATE_LIMIT_DEV_BYPASS` | unset | literal `1` skips the guard **only** when there is no store **and** the runtime is not production (`NODE_ENV`/`VERCEL_ENV`); logs `BYPASSED` |

A limit is `<hits>/<seconds>` with a window of at most 86400 seconds (the function enforces the same cap). A malformed value falls back to the default; it can never switch the guard off. The route-wide ceiling is the real
bound on engine spend: size it to what the site's engine plan can pay for in a window.

## Rollout (nothing here is done by merging)

1. Apply migration `0025_rate_limits.sql` to the production Supabase project **before** deploying this code. Without it
   every guarded route answers `503 rate_limiter_unavailable` (fail-closed by design).
2. Confirm the deployment sets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (already required by the site) and, off
   Vercel, `GF_TRUSTED_IP_HEADER`.
3. Optionally set `GF_RATE_LIMIT_KEY` and the limits above.
4. After deploying: `curl` the route in a loop from one address and confirm the `429`; confirm the engine's
   `GET /v1/usage` `by_endpoint` rose by no more than the allowance.

## What is and is not proven

Proven here: the decision logic and its failure behaviour (unit tests with an injected limiter, and four mutations of the
guard each caught); the real route handlers and real engine (in-memory store); **PostgreSQL's atomicity** (30 parallel
sessions admit exactly the limit, `tests/test_projects_migration.py`; 40 parallel requests through the real routes,
PostgREST and engine admit exactly the allowance and the engine's own meter rises by exactly that,
`tests/site/verified-power-record.realdb.test.ts`); the production build against the stand-in store (`npm run verify:local`).

Known limits: a fixed window admits up to twice the limit across a window boundary. Off Vercel with no
`GF_TRUSTED_IP_HEADER`, all callers share one bucket per route, so the free tool is protected but one caller can use the whole
allowance. A flood from many distinct addresses can exhaust the route-wide ceiling and deny honest callers; that trades
availability for protecting the engine key, deliberately.

Not proven: that the production Supabase project has migration 0025 or the environment above; Supabase's hosted
PostgREST gateway; Vercel's header behaviour on this deployment (taken from its documentation, not observed). Until step 1
of the rollout is done in production the guarded routes are **closed (503)**, not open and not protected.
