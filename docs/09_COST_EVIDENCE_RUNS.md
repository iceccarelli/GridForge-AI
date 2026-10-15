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

Proven in CI-style local runs: SQL (fresh database and upgrade of legacy rows), PostgREST contract, the real Python engine, route behaviour,
fail-closed storage handling, races, authorization.

**Not proven: Supabase Storage.** Tests use `tests/site/storage-stub.ts`, a deterministic stub of the Storage HTTP contract that persists exact bytes.
Before relying on it in production an operator must confirm, on the real project: migration 0023 applied; bucket `cost-evidence-artifacts` exists and is **private**;
the service-role key can create, read via `/storage/v1/object/authenticated/…`, and delete objects in it; a 400/404 for a missing object is handled as "missing".
The migration creates the bucket only where `storage.buckets` exists. Nothing here was applied to production.
