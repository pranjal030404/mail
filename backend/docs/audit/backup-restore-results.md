# Backup and restore results

Date: 2026-10-29. Isolated environment only. No production data was read or overwritten.

## Defects found and fixed

1. **`backup.sh` failed on MariaDB.** `--set-gtid-purged=OFF` is MySQL-only; MariaDB returned
   `unknown variable`, the script exited 7 and left a 20-byte empty archive.
2. **`restore-test.sh` could not create its target database.** The least-privilege application user is
   not granted `CREATE DATABASE`; the script failed with MySQL error 1044.
3. **Neither script recorded its run.** `started_at` was inserted in ISO-8601 form into a `DATETIME`
   column, which MySQL rejects; the error was discarded (`2>/dev/null || true`), leaving `backup_runs`
   empty after a “successful” restore. This was found by querying the table after the restore passed.

All three are documented in `security-findings.md` (Medium). The scripts were repaired and re-tested;
both a backup and a restore test now create their `backup_runs` rows.

## Backup execution (after the fix)

```
ENV_FILE=/tmp/audit-db-env BACKUP_DIR=<repo>/var/audit/backup-script \
  STALWART_DATA_DIR=/nonexistent bash deploy/scripts/backup.sh
```

| Item | Result |
| --- | --- |
| Server detected | `11.8.8-MariaDB` |
| Dump options | MySQL-only GTID flag omitted automatically |
| Exit code | 0 |
| Archive | `arthvex-db-20261029T185513Z.sql.gz`, **37,689 bytes** |
| Checksums | `SHA256SUMS-20261029T183719Z` written |
| Mail store | `STALWART_DATA_DIR` absent → database-only backup, warning printed |
| Failure handling | empty archives are removed and the run is recorded as failed |

## Restore execution (after the fix)

Target: pre-created `arthvex_email_test` schema (stand-in for `arthvex_restore_test`).

```bash
ENV_FILE=/tmp/audit-db-env BACKUP_DIR=<repo>/var/audit/backup-script \
  RESTORE_DB=arthvex_email_test bash deploy/scripts/restore-test.sh
```

| Item | Result |
| --- | --- |
| Exit code | 0 |
| Duration | **3 s** for the import |
| Tables restored | 37 |
| Migrations | 4 (`001`–`004`) |
| Users / mailboxes | 20 / 10 |
| `backup_runs` record | `restore_test` = succeeded, `tables=37 users=20 mailboxes=10 seconds=3` |

The earlier run (before the timestamp fix) restored 18 users / 8 mailboxes in 4 s but wrote no
`backup_runs` row; the table query is what exposed the third defect.

Row counts compared with the source database and matched exactly:

| Table | Source | Restored |
| --- | --- | --- |
| users | 18 | 18 |
| tenants | 7 | 7 |
| mailboxes | 8 | 8 |
| domains | 7 | 7 |
| audit_logs | 167 | 167 |
| sessions | 35 | 35 |
| provisioning_jobs | 23 | 23 |

Counts from the first restore run, compared immediately after import. Later audit activity grew the
source database before the confirmation run (20 users / 10 mailboxes).

## Functional check against the restored database

A dedicated verified account was created, the database was dumped, restored into the test schema, and a
second API instance was started against it (`DB_NAME=arthvex_email_test`, port 4013):

| Check | Result |
| --- | --- |
| Login with the pre-restore password | 200 |
| CSRF token issued | yes |
| `GET /me` | 200, correct email |
| `GET /tenants` | 200 |

This proves the restored control plane preserves password hashes, sessions infrastructure and
workspace membership.

## Not verified

- **Mail store restore.** No Stalwart data directory exists; the message-content archive was not
  produced or restored, and message integrity after restore is unproven.
- **Secrets restore.** `APP_ENCRYPTION_KEY` handling was reviewed, not exercised; a wrong key would
  make MFA secrets and webmail keys unreadable (documented in `docs/backup-restore.md`).
- **Encryption pipeline.** `BACKUP_ENCRYPT_CMD` was not executed (no encryption tool configured).
- **Off-site copy and retention deletion.** Not executed.
- **Recovery time at production size.** 4 s for a small dev dataset says nothing about a large mailbox
  store; the documented 2–4 h RTO remains an estimate.
- **Stalwart configuration restore** (`/etc/stalwart`), TLS/ACME state, and systemd/Apache files.
