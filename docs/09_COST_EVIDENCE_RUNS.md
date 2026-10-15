# Cost-evidence runs: identity, durable artifact, retrieval

A cost-evidence run is the study re-made with the quotations a named reviewer has **accepted**. Migration
`0023_cost_evidence_artifacts.sql` makes a run a durable, versioned, integrity-checkable record that owns its exact
document. The database row is the authority: a response never carries content that is not the row's stored artifact.

## Identity

`run_fingerprint = sha256(canonical({identity, deliverable_id, intake_digest, accepted_snapshot_digest, engine_fingerprint, options}))`
(`lib/run-identity.ts`, identity label `gridforge/cost-evidence-run/1`).

| Part | Meaning |
| --- | --- |
| `intake_digest` | the exact cleaned intake sent to the engine (`_gridforge` removed) |
| `accepted_snapshot_digest` | every accepted line sent to the engine, sorted by evidence id — **including lines the engine then ignores** |
| `engine_fingerprint` | `provenance.digest` from the engine: its code, cost library (bundled + private) and calibration ledger, by content (`gridforge/provenance.py`, `GET /v1/version`) |
| `options` | the engine request options that shape the output (`/v1/study`, `html`, accepted overlay) |

Not part of the identity: the evidence the engine reports *using* (a result, kept in `evidence_ids` with its 0022 meaning),
and the date printed on the document (`report_date` is recorded beside it). A retry on another day is the same run.
If the engine that answers the study is not the one whose provenance formed the fingerprint, nothing is recorded.

## Writing a run

1. Look up the fingerprint. **If recorded: read its artifact from private storage, verify digest and length, return it. The engine is not called.**
2. Otherwise run the engine once, store the exact bytes at
   `cost-evidence-artifacts/<deliverable>/<fingerprint>/<sha256>.html` (no overwrite), read them back and verify.
3. `gf_record_cost_evidence_run` inserts the run and artifact reference in one statement, unique on
   `(deliverable_id, run_fingerprint)`. On conflict it returns the **existing** row and writes no event.
4. If the row already existed (a lost race) the winner's artifact is verified and returned; the candidate is deleted
   only if the database confirms no run references it. Differing candidates are logged as a determinism warning.
5. Storage failure, read-back mismatch or database failure is a failure response; no run is claimed.

Legacy runs (recorded before 0023) have `run_fingerprint IS NULL` and no artifact; they stay in history as `legacy_unavailable`.

## Retrieval

`GET /api/deliverable/[token]/evidence-run` — history from the database (current/older, evidence offered/used/ignored, engine, integrity).
`GET /api/deliverable/[token]/evidence-run/[runId]/artifact` — verified download. The run is looked up under the deliverable the token resolves;
unknown, foreign and malformed run ids and tokens all answer `404`. Bytes failing the recorded digest/length are never served (`502`).
Supplier quotations and storage references are never in a customer response.

## What is proven, and what is not

**Proven in CI (`real-database` and `real-storage` jobs):** SQL (fresh database and upgrade of legacy rows), the PostgREST contract, the real Python
engines, route behaviour, fail-closed storage handling, races and authorization.

**Proven against the real Storage service (`real-storage` job, mandatory):** the pinned `supabase/storage-api` image
(version and digest in `scripts/realdb-up.sh`) is started against the same database before the migrations are applied, as in a
Supabase project. The whole of `tests/site/cost-evidence.realdb.test.ts` then runs against it, plus a contract block that checks, with
SQL against the service's own schema and direct requests to the service: the bucket created by migration 0023 exists and is private,
no bucket is public and no policy grants it; `putVerified`/`readVerified` store and return exact bytes and the service's own object row agrees
on size; a wrong digest or length is refused without returning bytes; missing object, unavailable store and corrupt data are told apart
using the service's real error responses; a duplicate is accepted only if byte-identical and an existing object is never replaced; an
unauthenticated caller, a bad token, the `anon` and `authenticated` roles and the public route cannot read an artifact; a retry leaves the
authoritative object untouched. `GF_REQUIRE_REAL_STORAGE=1` makes an absent service a failure, not a skip.

Run it locally (needs docker, psql, a PostgreSQL superuser via `PG*`):

    GF_REAL_STORAGE=1 bash scripts/realdb-up.sh && set -a && . /tmp/gf-realdb/realdb.env && set +a
    GF_REQUIRE_REALDB=1 GF_REQUIRE_REAL_STORAGE=1 npx vitest run tests/site/cost-evidence.realdb.test.ts
    docker rm -f gf-storage

How the real service is reached: Supabase's gateway maps `/storage/v1/*` onto the Storage service; the test gateway does the same mapping and nothing
else. Faults (an outage, a truncated write) are injected on that path only for the scenarios that need one; the service never has a response invented for it.

**Not proven, and needs separately authorised production verification:** that the production Supabase project has migration 0023 applied and the
`cost-evidence-artifacts` bucket present and private; that its service key can write, read (`/storage/v1/object/authenticated/...`) and delete there;
that its Storage version behaves like the pinned one (the client keys off `code` in the body, `NoSuchKey`, `KeyAlreadyExists`, which has been stable, but
the hosted gateway and API-key format are not exercised here); backups and retention of the bucket; and real-world latency and size limits. A green
preview deployment proves none of this. Nothing in this repository applies migrations to, or reads from, production.
