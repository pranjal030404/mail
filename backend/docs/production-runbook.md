# Production runbook — ARTHVEX Mail

Operational procedures for the existing VPS. Nothing here authorises a change to unrelated websites,
firewall rules, MX records or the mail-engine management interface.

## 0. Preconditions

- A tagged release exists (currently the repository has **no commits**; this must be fixed first).
- `/etc/arthvex/backend.env` is 0600, owned by root, readable by the `arthvex` service user.
- A verified backup younger than `BACKUP_MAX_AGE_HOURS` exists.
- The restore schema `arthvex_restore_test` exists and the app user can write to it.
- `NODE_ENV=production`, `COOKIE_SECURE=true`, `ADMIN_MFA_REQUIRED=true`, `MAIL_ADAPTER=stalwart`,
  `MAILER=smtp`, `ALLOW_TEST_DOMAINS=false`, `APP_BASE_URL=https://…`.

## 1. Health and readiness

```bash
curl -fsS https://<mail-host>/api/v1/health
curl -fsS https://<mail-host>/api/v1/health/ready
systemctl is-active arthvex-api arthvex-worker
journalctl -u arthvex-api -u arthvex-worker --since '15 min ago' --no-pager | tail -50
```

Admin metrics should show: database ok, mail engine ok (not `dev`), webmail ok, at least one live
worker heartbeat, `simulatedMail: false`, and a fresh successful backup.

## 2. Routine operations

| Task | Procedure |
| --- | --- |
| Deploy a release | Tagged checkout → `CONFIRM_DEPLOY=yes ./deploy/scripts/deploy.sh` (backs up, tests, migrates, restarts, health-checks) |
| Restart one service | `systemctl restart arthvex-worker` (safe); restart `arthvex-api` only in a maintenance window |
| Change settings | Admin UI → settings, with reason and confirmation; audit row is written |
| Rotate a mailbox password | Tenant admin resets credentials; the password is returned once and never stored |
| Investigate a stuck job | Admin → provisioning jobs; retry only after reading `last_error_code`; reconciliation runs first |
| Suspend abusive account | Admin → user/mailbox suspend with reason; sessions revoked for users; engine mailbox suspended |
| Maintenance mode | Admin → settings; health and platform staff remain reachable |

## 3. Exceptional mailbox access

1. Confirm the request is support- or legal-driven and record the ticket id.
2. Request access with a specific mailbox and a ≥10-character reason.
3. A **different** super admin reviews and approves; the grant is read-only and short-lived.
4. Read only what the ticket requires; every request is audited and increments `use_count`.
5. Revoke the grant when finished. Expiry happens automatically even if nobody revokes it.

Never share mailbox passwords, disable the two-person rule, or query message content directly from the
mail server outside this workflow.

## 4. Backup and restore

```bash
# backup (DB + mail store)
sudo -u arthvex ENV_FILE=/etc/arthvex/backend.env BACKUP_DIR=/var/backups/arthvex \
  STALWART_DATA_DIR=/var/lib/stalwart ./deploy/scripts/backup.sh

# verify restorability (isolated schema, never production)
sudo -u arthvex ENV_FILE=/etc/arthvex/backend.env ./deploy/scripts/restore-test.sh
```

Expected: verified `.sql.gz`, `.tar.gz`, `SHA256SUMS-*`, and a `backup_runs` row with `succeeded`.

If `restore-test.sh` reports missing access, pre-create and grant the restore schema:

```sql
CREATE DATABASE arthvex_restore_test CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON arthvex_restore_test.* TO 'arthvex_app'@'127.0.0.1';
```

A failed backup must page an operator. An empty or missing archive is never acceptable.

## 5. Rollback

1. Announce maintenance; stop `arthvex-worker` and `arthvex-api`.
2. Restore the pre-deploy database dump into a fresh database; point the env file at it only after the
   restore verifies.
3. Check out the previous release directory; run `npm ci --omit=dev=false` and `npm run build`.
4. Start services, then verify health, worker heartbeat and one mailbox login.
5. Record the rollback and the reason.

Application rollback without a database restore only works if the newer migrations are backward
compatible; they are not guaranteed to be. Never run `db:rollback` on production data without a
verified backup.

## 6. Incident playbooks

| Symptom | First checks | Immediate action |
| --- | --- | --- |
| Mail not delivered inbound | MX points at host? port 25 open? Stalwart listener/logs? queue depth? | Fix DNS/firewall; keep MX rollback plan ready |
| Outbound mail rejected/spam | SPF/DKIM/DMARC results, PTR, blocklist status, queue retries | Pause sending for the affected domain; correct DNS; contact blocklist |
| Abuse / spam complaint | abuse queue, sending logs, account usage | Suspend mailbox/tenant, revoke sessions, preserve logs |
| Worker down | `systemctl status arthvex-worker`, heartbeat, queue depth | Restart worker; leases recover automatically after restart |
| API 5xx spike | journal, database reachability, disk, memory cap | Roll back release or scale resources; keep `/health` available |
| Suspected data exposure | audit log, access grants, sessions | Revoke sessions and grants, rotate `SESSION_SECRET`/`APP_ENCRYPTION_KEY` per policy, follow incident-response.md |
| Lost `APP_ENCRYPTION_KEY` | backup of env file | Restore the key from the secrets manager; without it MFA secrets and webmail keys must be re-created |

## 7. Secrets and certificates

- Rotate `SESSION_SECRET` by deploying a new value during a maintenance window (all sessions invalidate).
- `APP_ENCRYPTION_KEY` cannot be rotated by simple replacement; existing encrypted values become
  unreadable. Plan a re-encryption migration before changing it.
- Certificates: `certbot renew --dry-run`, monitor expiry ≥ 21 days, reload Apache (not restart).
- Never log or paste passwords, cookies, API keys, DKIM private keys or message contents into tickets.

## 8. DNS and mail-server changes

- Publish MX/SPF/DKIM/DMARC from the values the engine generated; do not invent selectors or keys.
- Lower TTLs before a migration; keep the old mail path until inbound tests pass.
- DMARC starts at `p=none` with reporting, then moves to `quarantine`/`reject` after all senders align.
- Keep the Stalwart management API and setup wizard off the public internet.

## 9. Verification after any change

```bash
npm run typecheck && npm test && npm run test:web && npm run build
curl -fsS https://<mail-host>/api/v1/health/ready
sudo -u arthvex ENV_FILE=/etc/arthvex/backend.env ./deploy/scripts/restore-test.sh
```

For mail changes, additionally perform the external send/receive test in
`docs/audit/mail-delivery-results.md` and record the message ids and authentication headers.
