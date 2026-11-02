# Security findings — ARTHVEX Mail

Date: 2026-10-29. Scope: the code in this repository, tested live against the local API + MariaDB with
development adapters. No production system was touched.

## Method

- Code review of authentication, sessions, tenant authorization, mailbox authorization, admin routes,
  exceptional access grants, webmail content handling and deployment configuration.
- Live attack tests: `node scripts/audit/security.mjs` — **81/81 passed**, exit 0.
- Live feature tests: `node scripts/audit/features.mjs` — 17/17 passed.
- Configuration guard review plus a live run with `ADMIN_MFA_REQUIRED=true` on a second API instance.
- Rate-limit behaviour exercised against the default-configured instance.

Every status below is an observed HTTP status or a specific code path.

## Confirmed defects and fixes

### MEDIUM — backup script produced an empty archive on MariaDB

- Evidence: `deploy/scripts/backup.sh` passed `--set-gtid-purged=OFF`, a MySQL-only option.
  Running it against MariaDB 11.8.8 exited 7 with `mysqldump: unknown variable 'set-gtid-purged=OFF'`
  and left a **20-byte** `.sql.gz` in the backup directory.
- Impact: no usable database backups on a MariaDB host; the leftovers could be mistaken for backups.
- Fix: detect the server flavour (`SELECT VERSION()`), pass the GTID flag only to MySQL, fail the
  script if the dump pipeline fails, delete the incomplete archive, and record the failure.
- Regression evidence: the script now completes and writes a 32,838-byte verified archive in the
  audit environment (`var/audit/backup-script/`). See `backup-restore-results.md`.

### MEDIUM — restore test could not run with the documented database grants

- Evidence: `deploy/scripts/restore-test.sh` ran `CREATE DATABASE`, which the least-privilege
  application user cannot do: `ERROR 1044 (42000): Access denied ... to database
  'arthvex_restore_test_183600'`, exit 1. The documented deployment grants no DDL to the runtime user.
- Impact: the only automated restore verification fails on a correctly hardened deployment, so
  backups are never proven restorable.
- Fix: restore into a pre-created, separately named schema (`RESTORE_DB`, default
  `arthvex_restore_test`), refuse to target the live `DB_NAME`, validate the archive before import,
  and clear only the restore schema afterwards. Clear instructions are printed when access is missing.
- Regression evidence: `restore-test.sh` restored 37 tables / 18 users / 8 mailboxes and recorded
  success in 4 s. See `backup-restore-results.md`.

### MEDIUM — backup and restore runs were never recorded in `backup_runs`

- Evidence: both scripts inserted `started_at` using ISO-8601 (`2026-10-29T18:37:19Z`). The column is
  `DATETIME`, so MySQL rejected it: `Incorrect datetime value ... for column backup_runs.started_at`.
  The error was swallowed by `2>/dev/null || true`, so the scripts reported success while
  `backup_runs` stayed empty. Confirmed after a successful restore: `SELECT ... FROM backup_runs`
  returned no rows.
- Impact: the admin dashboard always reports the last backup as stale, failed runs are invisible, and
  operators cannot audit whether backups or restore tests actually happened.
- Fix: write a SQL-compatible UTC timestamp (`YYYY-MM-DD HH:MM:SS`) and print a warning instead of
  silently discarding a bookkeeping failure.
- Regression evidence: after the fix, a backup and a restore test each produced a `succeeded` row with
  the correct size and duration (`docs/audit/backup-restore-results.md`).

No critical or high-severity vulnerabilities were found.

## Controls verified working

| Area | Evidence |
| --- | --- |
| Cross-tenant reads | 13 list/read endpoints returned 404 for a foreign workspace, domain, mailbox, message, usage, alias, member and ticket |
| Cross-tenant writes | 6 create/suspend/delete/rename/verify operations returned 404 |
| Foreign object IDs | Foreign membership ID could not be promoted through another tenant (404); foreign message ID on own mailbox returned 404 |
| CSRF | Missing token, wrong token, another session's token and a cross-origin write all returned 403 |
| Sessions | Logout and revoke-others invalidated old cookies (401); MFA-pending session refused on protected routes (401) but allowed on `/me` |
| Mailbox scoping | A linked `mailbox_user` read only their mailbox; a sibling mailbox returned 404; mailbox list filtered to one row; creation denied (403); member list denied (403); usage scoped to their own mailbox |
| Suspension/deletion | Suspended mailbox content returned 409 immediately; scheduled deletion returned 409 immediately; cancellation restored access |
| Admin separation | Customer session on `/admin/metrics` → 403; operations role could not change settings (403) or approve grants (403) |
| Exceptional access | Reason required; self-approval 403; unapproved grant read 403; second super admin approval works; another operator cannot use the grant (403); each read audited and counted; expiry enforced without a worker; revocation immediate; no write scope exists (400) |
| Admin content boundary | `/admin/tenants/:id` returned metadata only; `/admin/mailboxes` returns addresses and status |
| MFA enforcement | With `ADMIN_MFA_REQUIRED=true`, an enrolled-less admin session got `403 mfa_setup_required` on `/admin/metrics` |
| Webmail content | `script`, `iframe`, `javascript:` removed; remote image blocked and counted; sender spoofing via request body impossible; executable attachments 400; oversize 413; too many 413 |
| Attachments | Foreign blob 404; download sets `X-Content-Type-Options: nosniff` and attachment disposition; CRLF in a file name cannot inject headers |
| Account security | Duplicate registration 202; password reset request indistinguishable (202/202); reset token single-use (200→400); weak password 400; five bad logins lock the account and the correct password still fails |
| Rate limits | Login: 10×401 then 429; registration: 5×202 then 429 |
| Secret exposure | Admin metrics contain no credential fields; API errors expose only a correlation ID; production build contains no secret names; production config refuses dev adapters, insecure cookies, missing admin MFA, test domains and non-HTTPS origins |

## Accepted risks / lower-severity observations

| Severity | Observation | Position |
| --- | --- | --- |
| Low | `/tenants/:id/usage` returns workspace-wide counts and limits to a `mailbox_user`; the mailbox list itself is correctly filtered to their own mailbox. | Accepted: counts are not message content. Tighten if tenants consider mailbox counts sensitive. |
| Low | Exceptional-access reason text and mailbox addresses are visible to every platform role with `admin.read`, including `operations`. | Accepted: reasons are written by staff, not customers. Restrict if reasons may contain customer data. |
| Low | Rate limits are per source IP. Five sign-ups per hour and ten logins per minute are shared by everyone behind one NAT/proxy. | Availability risk, not a bypass. Consider per-email limits or a higher cap after launch. |
| Low | The application forces every database session to UTC. Any external tool writing `DATETIME` in the server's local timezone makes jobs appear "not due yet" (observed during this audit when a harness wrote local-time rows). | Documented requirement: run MySQL in UTC. |
| Info | At audit time there was no lint script or CI configuration, and the repository had **zero commits**. | Lint and CI were added afterwards; the repository was committed, giving a rollback revision. |
| Info | The worker runs scheduled maintenance inline before polling jobs. A slow reconciliation pass delays provisioning. | Not reproduced as a failure here; monitor queue latency after launch. |

## Not tested

- Real Stalwart authentication, SMTP AUTH, relay restrictions, rate limiting inside Stalwart, spam
  filtering and outbound abuse controls — no mail server exists in this environment.
- Real message headers, SPF/DKIM/DMARC validation and spoofing at the SMTP layer.
- Browser-level XSS against the production CSP and iframe sandbox — only server-side sanitisation and
  unit tests were exercised.
- Database fault injection (connection loss mid-job) — simulated provider failures only.
- Load testing at production scale and DDoS behaviour.
