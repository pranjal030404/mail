# Reliability results — provisioning and background jobs

Command:

```bash
cd backend
DB_NAME=arthvex_email_test npx tsx --env-file-if-exists=.env ../scripts/audit/reliability.ts
```

Result: **21/21 checks passed**, exit 0. Raw output: `var/audit/reliability-results.json`.

The audit runs against the isolated `arthvex_email_test` database with an in-memory development mail
engine, so provider failures are injected deterministically (`failNext`, `setUnavailable`). A clean
schema is required: drop the tables in `arthvex_email_test` and re-run `db:migrate` before repeating.

## Results

| # | Scenario | Outcome |
| --- | --- | --- |
| 1 | Create mailbox and run job | activated, status `active` |
| 2 | Replay the same completed job | no duplicate engine account (1 → 1) |
| 3 | Provider unavailable twice | two `retrying` outcomes with backoff, not failure |
| 4 | Provider recovers | job `succeeded`, mailbox active |
| 5 | Retries after outage | still exactly one account per address |
| 6 | Failure after the provider applied the change ("uncertain") | job `retrying` with `needs_reconcile=1` |
| 7 | Retry of an uncertain job | adopts the existing account, status `active`, no duplicate |
| 8 | Worker lease expires mid-flight | `reclaimExpired` moves the job to `retrying`, `needs_reconcile=1`, code `lease_expired` |
| 9 | Reclaimed job runs again | completes; account count unchanged |
| 10 | Two workers claim concurrently | `FOR UPDATE SKIP LOCKED` gave exactly one claim from two attempts |
| 11 | Deletion grace period expires | mailbox moved to `deleting`, job queued |
| 12 | Deletion job runs | engine account removed, `status=deleted`, address claim removed |
| 13 | Engine account removed | no longer present in the engine |
| 14 | Unmanaged engine account | reconciliation reports `orphan_in_engine` |
| 15 | Orphan safety | account was not deleted automatically |
| 16 | Suspension drift | reconciliation with `repair:true` suspended the engine account |
| 17 | Expired domain verification token | rejected with `token_expired` |
| 18 | Engine account owned by another record | `needs_manual_review` with `engine_conflict`; existing account not overwritten |
| 19 | Conflicting mailbox record | marked `provisioning_failed` for an operator |
| 20 | Deletion cancelled before the grace period | `startDueDeletions` did nothing after the state change |
| 21 | Queue health after the run | no job left `running` with a live lease |

## What this proves

- Mailbox creation is idempotent across retries, duplicate delivery and lease recovery.
- An "applied but unacknowledged" provider call converges instead of duplicating the mailbox.
- Failures are classified: retryable outages retry, conflicts stop for an operator.
- Deletion is irreversible only after the grace period, and cancellation is stable across restarts.
- Reconciliation detects drift and only repairs safe, reversible fields.

## Not covered

- **Database failure injection** (connection lost mid-transaction, MySQL restart, replica lag). The
  handlers rely on MySQL transactions, but no fault was injected into the database layer.
- **Real Stalwart** error shapes, timeouts and partial responses.
- **Notification delivery** failures; admin notification errors are caught, but no failure was forced.
- **Multi-worker contention at volume**; only two concurrent claims were tested once.
- **Queue growth/backpressure** under sustained load; see `performance-results.md` for the volume tests
  that were feasible.
