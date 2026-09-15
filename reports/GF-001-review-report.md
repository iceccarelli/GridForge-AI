# GF-001 — Review Report

## STATUS

**PASS**

## WHAT WAS TESTED

The final diff, read in full, against four questions: does it duplicate anything
that already existed; does it weaken a guard to make a test pass; does any new code
path report success it has not earned; and is every claim in these reports backed by
something that was executed.

## WHAT ACTUALLY WORKS

**No engine was duplicated and no working system was rewritten.** The mission's
whole footprint in shipped code is 8 files:

| File | Change | Why not a duplicate |
|---|---|---|
| `lib/subscribers.ts` (new) | Server-only data layer for `subscriptions` + `scenarios` | Modelled directly on the existing `lib/watches.ts` / `lib/api-access.ts` pattern — `rest()` helper, `res.ok` on every call. It *replaces* three inline copies rather than adding a fourth. |
| `app/api/scenarios/route.ts` | Rewired onto that layer | Same surface, same methods; the inline fetches are gone |
| `app/api/subscription-status/route.ts` | Rewired | ditto |
| `app/api/stripe/webhook/route.ts` | Third product resolved on all three lifecycle events | Extends the existing pattern the file already applied to `api_accounts` and `watches` |
| `app/api/siting-analysis/route.ts` | Gate fails closed | The check already existed; it was conditional on its own dependency |
| `app/api/chat/route.ts` | `res.ok` on the lead insert | 8 lines |
| `app/account/page.tsx` | "Could not check" ≠ "not subscribed"; reversible optimistic delete | The client half of the same defect |
| `scripts/apply-inbox.sh` | Refuses to run without a working test runner | The script's own contract, enforced |

Plus two migrations, one vitest config, and the test tree.

**No guard was weakened to make anything pass.** Three of the repository's own
guards went red during this work and all three were fixed by changing the *code*,
never the assertion:

- root hygiene rejected `vitest.config.ts` → declared in `ROOT_FILES` with a reason;
- the one-domain rule rejected hardcoded URLs in the new tests → the tests now read
  `siteUrl()` from the registry like every other file;
- the new `res.ok` guard rejected two further routes → both were fixed.

Two guards were *strengthened*: `SUBSCRIPTION_LOOKUPS` gained the third recurring
product its own comment had asked for, and the one-price-list rule gained a
cents-aware companion that makes its blind spot explicit.

**Every new code path was checked for earned success.** The three that return 200
do so only after a `res.ok`: `recordSubscription` returns the row or `null`,
`createScenario` returns the row or `null`, `deleteScenario` returns whether
anything actually matched. `deleteScenario` uses `return=representation` precisely
so a cross-tenant attempt is a miss rather than a silent success.

**Every claim was executed.** The negative control in the test report — reverting
each fixed file and re-running the new tests — is the evidence that the suite is not
vacuous: 13/24, 9/16, 5/9 and 2/9 fail against the pre-fix code.

## WHAT DOES NOT WORK

Nothing found in review that is not already declared in the test report.

One judgement worth flagging for a human: `recordSubscription` failing now returns
**500** so Stripe redelivers. That is correct — a customer must not be welcomed to
an entitlement that was not written — but it does mean that if the migrations are
never applied, Stripe will retry the event and eventually mark it failed in the
dashboard. That is the intended, visible outcome; the previous behaviour was a
green checkmark over a lost customer.

## MOCKS / PLACEHOLDERS REMAINING

None in shipped code. One declared test double (`tests/site/postgrest-fake.ts`),
which exists to reproduce a missing table and would be useless if it threw.

## KNOWN RISKS

As listed in the test report. The one this review adds: `tests/site/` now has to be
maintained alongside the routes. That is the cost of having executable tests at all,
and it is a better cost than the one it replaces.

## COMMERCIAL WORKFLOW

Reviewed against the master mission's Product 01 requirement. Every stage from
project creation to commercial workflow is classified VERIFIED in the capability
matrix, with the evidence named per stage.

## DEPLOYMENT

Reviewed; see the deployment report. The migration step is a genuine prerequisite
and is stated as one rather than buried.

## NEXT ACTION

Merge, apply the two migrations, then re-run the purchase cycle in Stripe test mode
against the hosted project.
