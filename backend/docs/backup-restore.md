# Backup and restore — ARTHVEX Mail

## What must be backed up

| Data | Location | Consequence if lost |
| --- | --- | --- |
| Control-plane MySQL | `arthvex_email` database | Users, workspaces, domains, mailbox metadata, jobs, audit, access grants |
| Mail store | Stalwart data directory (e.g. `/var/lib/stalwart`) | **All email content, attachments, DKIM private keys** |
| Stalwart configuration | `/etc/stalwart` | Listeners, TLS, storage, auth configuration |
| Application env/secrets | `/etc/arthvex/backend.env` | Cannot decrypt MFA secrets or webmail keys |
| TLS certificates/ACME state | `/etc/letsencrypt` | Certificate renewal continuity |
| Apache + systemd units | `/etc/apache2`, `/etc/systemd/system` | Rebuildable from repository templates |

Losing `APP_ENCRYPTION_KEY` makes existing MFA secrets and webmail mailbox keys undecryptable. MFA
users must re-enrol; webmail keys are recreated on next use (the old engine keys are orphaned and
should be revoked). Store the key in a secrets manager and in the encrypted backup set.

## Schedule

- Database + mail store: every 6 hours (or at least daily), retained 14 days locally.
- Weekly restore test into a dedicated restore schema (records `backup_runs.restore_test`).
- Monthly off-site copy, encrypted (age or GPG) to object storage with versioning.
- Alert if the last successful backup is older than `BACKUP_MAX_AGE_HOURS` (26 by default); the admin
  dashboard shows this and production startup surfaces the same data.

## Running a backup

```bash
sudo -u arthvex ENV_FILE=/etc/arthvex/backend.env \
  BACKUP_DIR=/var/backups/arthvex STALWART_DATA_DIR=/var/lib/stalwart \
  ./deploy/scripts/backup.sh
```

The script writes `arthvex-db-<stamp>.sql.gz`, `arthvex-mail-<stamp>.tar.gz`, a `SHA256SUMS-<stamp>`
file, verifies both gzip streams, and records the run in `backup_runs`. It only deletes files matching
its own prefixes inside `BACKUP_DIR`.

The dump options are chosen from the server flavour: `--set-gtid-purged=OFF` is passed only to MySQL.
MariaDB rejects that option (`unknown variable`), so a MariaDB deployment would previously produce an
empty archive. On any dump failure the incomplete `.sql.gz` is deleted and the run is recorded as
failed, so an empty file is never reported as a successful backup.

Encrypted example (optional):

```bash
BACKUP_ENCRYPT_CMD="age -r age1example..." ./deploy/scripts/backup.sh
```

## Restore test

```bash
sudo -u arthvex ENV_FILE=/etc/arthvex/backend.env ./deploy/scripts/restore-test.sh
```

It loads the newest dump into `arthvex_restore_test`, checks table count, users, mailboxes and applied
migrations, then clears only that schema (tables are dropped; the schema itself is kept) and records
the result.

The application database user normally has no `CREATE DATABASE` privilege, and the script now handles
that: pre-create the restore schema once and grant the app user access to it.

```sql
CREATE DATABASE arthvex_restore_test CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON arthvex_restore_test.* TO 'arthvex_app'@'127.0.0.1';
```

The script refuses to run when `RESTORE_DB` equals the live `DB_NAME`, verifies the gzip archive before
importing, and prints explicit instructions if neither creation nor access is possible. Restore tests
never touch production data.

Alternatively set `RESTORE_DB` to another pre-created, disposable schema that the app user may write
to; never point it at the live database.

## Full restore procedure

1. Take the service out of rotation: stop `arthvex-api` and `arthvex-worker`; announce maintenance.
2. Verify the backup checksum and decrypt it if encrypted.
3. Restore MySQL into a fresh database, then point the env file at it; do not overwrite the live
   database until you are sure the backup is good.
4. Restore the Stalwart data directory and config while Stalwart is stopped; preserve ownership
   (`stalwart:stalwart`) and permissions.
5. Restore `/etc/arthvex/backend.env` only from a trusted, encrypted source. Never reconstruct
   `APP_ENCRYPTION_KEY` — a new key invalidates existing encrypted values.
6. Start MySQL, Stalwart, API and worker in that order. Run migrations only if the backup predates the
   deployed schema, and review them first.
7. Verify: `/health/ready`, admin dashboard, one mailbox sign-in, webmail folder list, an inbound test
   message, and a support ticket read. Run the restore test again to confirm the backup pipeline.
8. Record the restore in `backup_runs` and the incident log.

## RPO/RTO guidance

- Target RPO: ≤ 6 hours with 6-hourly backups; ≤ 1 hour if binlogs and mail snapshots are replicated.
- Target RTO: 2–4 hours for a single host with a verified local backup.
- Test the restore at least quarterly; an untested backup is not a backup.

## Retention and deletion

Backups may contain personal data of deleted accounts. Apply the same retention policy as production
(no more than 30–90 days unless legally required), and ensure off-site storage honours deletion.
Database dumps include audit logs and access-grant metadata; protect them accordingly.
