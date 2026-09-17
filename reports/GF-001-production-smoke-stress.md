# GF-001 — production smoke and stress

**Target:** https://timetopower.ai · **Engine:** https://gridforge-engine.fly.dev
**Date:** 2026-09-17, 21:15–21:25 UTC
**Method:** real HTTP against production. Every number below was measured by a
command in this session. Nothing here is estimated, extrapolated or illustrative.

Production was serving the merged PR #3 at the time of the run (confirmed by the
Density Screen CTA appearing in the served HTML).

---

## 1. Smoke — PASS

### Pages

| URL | HTTP | TTFB | audit CTAs | "power audit" | `Density Screen — €4,500 · 5 days` | verdict |
|---|---|---|---|---|---|---|
| https://timetopower.ai/ | 200 | 0.286 s | 0 | 0 | 10 | **PASS** |
| https://timetopower.ai/qualify | 200 | 0.362 s | 0 | 0 | 3 | **PASS** |
| https://timetopower.ai/pricing | 200 | 0.445 s | 0 | 0 | 3 | **PASS** |

"audit CTAs" counts `Request a power audit`, `Request audit` and the
`gridforge:open-audit` event name in the served HTML.

### Money path

| Step | URL | HTTP | Latency | Result | Verdict |
|---|---|---|---|---|---|
| Qualify | `POST /api/qualify` | 200 | 2.770 s | binding constraint **Residual air load removal per rack**, 0 racks as found, 120 after the ladder; persisted, share `/q/n00MFp76CKXfvouZZthvNP92` | **PASS** |
| Checkout | `POST /api/checkout` `{"product":"density_screen"}` | 200 | 0.586 s | `cs_test_a1Isgdkz9…` | **PASS** |

The session was then read back from the Stripe API rather than trusted from the
redirect URL:

```
amount_subtotal   450000
amount_total      450000
currency          eur
metadata.kind     density_screen
mode              payment
success_url       https://timetopower.ai/commissioned?session_id={CHECKOUT_SESSION_ID}
```

**€4,500, `density_screen`. PASS.**

### Engine authentication

| Call | Key | HTTP | Verdict |
|---|---|---|---|
| `GET /health` | — | 200 `{"ok":true,"service":"gridforge","version":"0.9.0"}` | **PASS** |
| `POST /v1/qualify` | none (public tier) | 200, real result | **PASS** |
| `GET /v1/version` | — | 200 | **PASS** |
| `POST /v1/screen` | **none** | **401** `{"error":"an API key is required for this endpoint"}` | **PASS** |
| `POST /v1/screen` | deliberately wrong key | **401** | **PASS** |
| `POST /v1/screen` | the key quoted in the standing order, as `X-API-Key` | **401** | **see below** |
| `POST /v1/screen` | the same key, as `Authorization: Bearer` | **401** | **see below** |

**The paid tier refuses unauthenticated callers. That is the property that
matters and it holds.**

#### Finding: the key in the standing order is not accepted by the deployed engine

`sk_gf_C5qyg…:gridforge-site:0` returns 401 on both header forms. The engine reads
both (`gridforge/api/server.py:632`), so the header is not the problem. The refusal
text is the generic one, which per `gridforge/api/metering.py:166` is what you get
when a key is treated as *static* and is absent from `GRIDFORGE_API_KEYS` — a
signed key that failed verification would name its own reason ("expired",
"revoked", "forged").

**This is not blocking and the site is not affected.** The site's own server-side
`GRIDFORGE_API_KEY` works: production generated a real 16,101-byte Density Screen
through `/v1/screen` at 18:22 UTC the same day (see
`GF-001-phase0-money-path-proof.md`). So the deployed `GRIDFORGE_API_KEYS`
contains a key the site holds and does not contain the one quoted in the order —
most likely rotated since it was written down. Worth reconciling before anyone
hands that string to a customer or pastes it into a runbook.

---

## 2. Stress — PASS

### 20 parallel `POST /api/qualify` against production

Each request carried different hall figures. Latency is curl `time_total`.

| Metric | Measured |
|---|---|
| Requests | 20, issued concurrently |
| Wall clock for all 20 | **4.537 s** |
| HTTP 200 | **20 / 20** |
| Errors (non-200, timeouts, resets) | **0 (0.0 %)** |
| Returned a real binding constraint | **20 / 20** |
| min | 2.063 s |
| median | 3.806 s |
| mean | 3.527 s |
| p90 | 4.432 s |
| p95 | 4.474 s |
| max | 4.474 s |

### Serial baseline, same endpoint, same payload

| # | HTTP | Latency |
|---|---|---|
| 1 | 200 | 0.973 s |
| 2 | 200 | 0.888 s |
| 3 | 200 | 0.972 s |
| 4 | 200 | 0.950 s |
| 5 | 200 | 0.747 s |

Serial median **0.950 s**; 20-concurrent median **3.806 s**.

### What that means, and only what it means

At 20 concurrent free-qualifier calls the endpoint **degrades about 4× in latency
and does not fail**: every request completed, every one returned a real result
from the engine, nothing timed out and nothing 5xx'd. The wall clock of 4.537 s
against a 0.950 s serial baseline says the requests are queueing rather than
being served in parallel — consistent with a single small engine machine and
per-request Supabase writes, both of which are serial work.

Not measured, and therefore not claimed: the breaking point, behaviour above 20
concurrent, sustained throughput over time, or cold-start cost. One burst of 20
supports one conclusion — 20 concurrent is survivable with zero errors — and no
projection beyond it.

### Cleanup

The run wrote 25 `GF-001 LOADTEST` rows and 1 `GF-001 Smoke` row to
`qualifications`. **All 26 were deleted** after measurement. That table is not
scratch space: `summariseQualifications()` aggregates it into the binding-constraint
statistics rendered on the home page and in `/admin`, so leaving 25 identical
synthetic halls in it would have published a fabricated figure — the exact defect
this branch exists to remove.

---

## Not covered here

- **A completed payment.** The hosted Stripe Checkout page needs a browser; no
  extension is connected in this session and no Stripe API completes a hosted
  session. Session *creation* is proven above; the webhook hop is covered in
  `GF-001-phase0-money-path-proof.md`.
- **Third-party market-data vendors.** Not called. The site's EPEX/aWATTar and
  Fraunhofer integrations already degrade to an honest "unavailable" state and
  were left alone.
- **`/dashboard` signed in.** The portal now requires a verified Supabase session;
  exercising it end to end needs a real magic-link login, which is a human step.
  Its signed-out state and its API are covered by `tests/site/sell-surface.test.ts`.
