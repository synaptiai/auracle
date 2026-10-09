---
title: Ledger Implementation Design
tags: [ledger, implementation, v1]
created_at: 2026-08-24T21:35:21Z
updated_at: 2026-08-24T21:35:21Z
---

# Ledger Implementation Design

Bridges the prose rules in `docs/v1-architecture.md` (sections 3.4 and 4.2) to concrete code shape for the ledger component.

## Authority

The decisions DEC-04 (Postgres ledger and transactional outbox), DEC-24 (semantic idempotency key), DEC-27 (partition per ticket) and DEC-28 (fencing epoch) govern this document. Where this document and `docs/v1-architecture.md` disagree, the architecture wins.

## Schema

Plain SQL files under `db/`, applied by a small script. No migration framework; a migration procedure is V2 open item 7.

Four tables, as specified in section 4.2:

- `run` — one row per run. Carries `partition` (DEC-27: `hash(ticket_id) % N`) and `epoch` (DEC-28 fencing token). Version fields `prompt_ver`, `model_ver` exist because of DEC-26.
- `ticket_epoch` — highest epoch accepted per ticket. The insert path compares against it.
- `step_journal` — write-before-act journal per step.
- `outbox` — pending actions. `UNIQUE (idem_key)` enforces DEC-24 at the schema level. `delivery` comes from the action class (DEC-29).

## Module layout

```
src/ledger/
  keys.ts        idempotency key derivation
  insert.ts      the atomic fenced write
  apply.ts       DDL application script (or scripts/db/apply.ts)
db/
  001_ledger.sql
```

## The atomic fenced write

One function owns the only write path to `run` + `outbox`. In one transaction:

1. Read the highest accepted epoch from `ticket_epoch`.
2. If the incoming run's epoch is lower, refuse. Return `stale_epoch`.
3. Upsert `ticket_epoch` with the incoming epoch.
4. Write the new run state.
5. Insert the outbox record.

Two properties are mandatory:

1. State change and outbox insert commit together or not at all (section 4.2).
2. An insert of zero rows is a distinct result, not an ignored success. It moves the run to `superseded` and stops. This is the liveness rule: a run that loses the insert must never reach `queued`.

## Idempotency key derivation

The key is a function of action semantics: action class, ticket id, and the semantically meaningful payload fields (for example refund amount and currency). It is never a function of `run_id`, timestamps or random values.

Test cases derived from section 3.4:

- Two runs performing "refund 50 EUR on ticket T" produce identical keys.
- "Refund 50" and "refund 100" on ticket T produce different keys. The unique constraint does not collapse them; correctness comes from derivation, not collision luck.
- Re-running with a different `run_id` produces the same key.

## Concurrency rules under test

Each rule from section 3.4 maps to at least one test:

| Rule | Test |
|---|---|
| Concurrent runs collide at insert; loser must stop | Two inserts, same key, different epochs; loser gets zero rows and lands `superseded` |
| Loser must not reach `queued` | After losing insert, run state is `superseded` and no relay picks it up |
| Stale process writes refused | Write with epoch below `ticket_epoch.max` returns `stale_epoch` |
| Fencing holds across rebalance overlap | Interleaved epochs accepted then rejected in order |

## Dev environment

Docker Compose runs Postgres 16 with pgvector. Tests connect through `DATABASE_URL`; compose sets the default.
