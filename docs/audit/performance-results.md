# Performance and database results

Command:

```bash
cd backend
DB_NAME=arthvex_email_test npx tsx --env-file-if-exists=.env ../scripts/audit/performance.ts
```

Result: **8/8 checks passed**, exit 0. Raw output: `var/audit/performance-results.json`.

## Environment (important limitations)

| Item | Value |
| --- | --- |
| Database | MariaDB 11.8.8, same host as the API |
| Runtime | Node 24.18.0, single process |
| Mail/webmail engine | development adapters (no network latency to Stalwart) |
| Dataset | 2,000 synthetic mailbox rows in one workspace |
| Load | sequential calls plus a 40-request concurrent burst; no sustained load test |
| Production target | **no target established; nothing here is a scalability claim** |

## Measurements

Service-level timings (in-process, 5 runs):

| Operation | p50 | p95 |
| --- | --- | --- |
| Mailbox list, page 1, 25 rows | 39.59 ms | 44.92 ms |
| Mailbox list, page 40, 25 rows (offset 1,000) | 24.14 ms | 33.49 ms |
| Mailbox address search (`LIKE '%…%'`) | 26.10 ms | 30.48 ms |
| Workspace usage aggregation over 2,000 mailboxes | 30.48 ms | 35.97 ms |

Run-to-run variance on this shared dev host was large (the same page-1 query measured ~14 ms p95 in an
earlier run, ~45 ms here), so treat these as order-of-magnitude figures, not benchmarks.

HTTP (against the dev API):

| Operation | p50 | p95 | Errors |
| --- | --- | --- | --- |
| `GET /health` ×100 | 2.15 ms | 3.52 ms | 0 |
| 40 concurrent `GET /health` | 19 ms total | — | 0 |

## Correctness under concurrency

| Test | Result |
| --- | --- |
| 5 concurrent creations of the same address | exactly 1 mailbox, 1 address claim, 4 conflicts |
| 5 concurrent creations with only 1 plan slot left | exactly 1 accepted; total never exceeded the limit |
| Pagination | requested page size honoured; `total` correct (2,000) |
| Retention cleanup | expired sessions and verification/reset tokens removed |

## Query plan

`EXPLAIN` for the mailbox list:

```
type: range
key: ix_mailboxes_tenant_status
rows: 2000
Extra: Using index condition; Using filesort
```

The `ORDER BY created_at DESC, id` still sorts in memory because the index is on
`(tenant_id, status)`. At 2,000 rows this is well within budget. At very large tenants a composite
index such as `(tenant_id, status, created_at)` would avoid the sort; that is an optimisation, not a
current defect, and was not applied without a measured production need.

## Observations

- Address search uses `LIKE '%term%'`, which cannot use an index. Acceptable for small workspaces;
  becomes the first scaling bottleneck for tenants with tens of thousands of mailboxes.
- `usage` aggregation scans all mailboxes of a tenant per request. 2,000 mailboxes cost ~20–24 ms;
  caching or a periodic rollup would be needed at larger sizes.
- Session resolution touches the database on every request; `last_seen_at` writes are throttled to once
  per minute per session.
- Body size is bounded (`bodyLimit` 256 KB generally, `WEBMAIL_MAX_ATTACHMENT_BYTES + 512 KB` for
  compose), and the webmail route schema caps base64 input, so attachments cannot be unbounded reads.
- API error rate under the 40-request burst was zero on `/health`; DB-backed endpoints under sustained
  concurrency were not load-tested.

## Not measured

- Latency against a real Stalwart instance (JMAP, IMAP, SMTP submission).
- End-to-end sending/receiving under load.
- Peak memory during maximum-size attachment handling.
- Sustained throughput, connection-pool saturation and multi-worker behaviour at volume.
- MySQL (as opposed to MariaDB) query plans.
