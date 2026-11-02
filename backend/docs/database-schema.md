# Database schema — ARTHVEX Mail

MySQL 8.x / MariaDB, InnoDB, `utf8mb4`, UTC `DATETIME(3)`. IDs are 26-character ULIDs (opaque).
Migrations live in `backend/migrations` and are applied in filename order; `schema_migrations`
records versions. Never edit an applied migration — add a new one.

## Entity map

| Area | Tables |
| --- | --- |
| Identity | `users`, `sessions`, `mfa_credentials`, `mfa_recovery_codes`, `email_verification_tokens`, `password_reset_tokens`, `terms_acceptances`, `notification_preferences`, `notifications` |
| Platform staff | `platform_admins`, `admin_mfa_credentials`, `admin_mfa_recovery_codes`, `admin_access_grants` |
| Workspaces | `tenants`, `tenant_memberships`, `tenant_quotas`, `subscriptions`, `plans`, `signup_invitations` |
| Domains | `domains`, `domain_verification_tokens`, `domain_dns_checks` |
| Mail | `mailboxes`, `address_claims`, `aliases`, `mailbox_webmail_credentials`, `mailbox_preferences` |
| Operations | `provisioning_jobs`, `usage_daily`, `audit_logs`, `worker_heartbeats`, `backup_runs`, `platform_settings` |
| Support | `support_tickets`, `support_ticket_messages`, `abuse_reports` |

## Invariants and constraints

- `address_claims.address` is a global primary key for hosted addresses, so a mailbox and an alias can
  never share an address. `mailboxes.claim_address` and `aliases.claim_address` are unique and become
  `NULL` when the object is deleted, freeing the name.
- Domains use `claim_name` with a unique key for the same reason; `name` stays for history.
- `uq_mailboxes_claim_address`, `uq_aliases_claim_address`, `uq_domains_claim_name` enforce uniqueness
  at the database layer, not only in application code.
- `provisioning_jobs.idempotency_key` is unique: enqueueing the same key returns the existing job.
- `notifications(user_id, dedupe_key)` is unique so the same condition does not spam the user.
- `admin_access_grants` references `platform_admins` for both requester and approver with
  `ON DELETE RESTRICT`; grant history cannot be silently erased by deleting an admin.
- `mailbox_webmail_credentials.secret_encrypted` is `v1:` AES-256-GCM ciphertext. There is no column
  anywhere for a customer password, an email body, an attachment, an MFA secret in plaintext, a
  session token, or a verification token in plaintext (only SHA-256 hashes).

## Mailbox lifecycle

`draft → provisioning → active ⇄ suspended → deletion_scheduled → deleting → deleted`
(plus `provisioning_failed`, `retained`). Transitions are validated in `core/lifecycle.ts` and applied
with a conditional `UPDATE ... WHERE status = <expected>` so two concurrent requests cannot both win.
`status_before_deletion` allows cancelling a scheduled deletion and restoring the previous state.

## Audit model

`audit_logs` is append-only in practice: the application only inserts. It records actor type
(`user`, `platform_admin`, `system`, `worker`, `anonymous`), actor id columns kept separate so a
customer id can never be confused with an admin id, tenant, action, target, outcome, reason,
correlation id, IP and redacted JSON metadata. `sanitizeMetadata()` strips keys matching
password/secret/token/key/otp/code/cookie/authorization.

## Migration 004

Adds:

- `mailbox_webmail_credentials` — one mailbox-scoped Stalwart API key id + encrypted secret, cascade
  with the mailbox.
- `mailbox_preferences` — webmail signature and remote-image preference.
- `admin_access_grants` — request/approval lifecycle with TTL, scope, use counter and audit links.

The down migration drops only those three tables. It cannot lose mail content (content lives in the
mail engine) but it does discard access-grant history; export it first in production.

## Backups and retention

- `usage_daily` rows and `domain_dns_checks` are pruned by the worker (90 days for DNS checks,
  180 days for completed jobs). `audit_logs` is retained according to the policy in
  `docs/security.md`; do not prune it without a documented retention decision.
- `sessions` are deleted 30 days after expiry/revocation.
- Deleting a user/tenant cascades membership, notification, token and session rows; mailbox rows are
  retained long enough to keep audit references, and mail content is removed by the mail engine when
  the mailbox deletion job runs.

## Commands

```bash
npm run db:migrate          # apply pending migrations
npm run db:rollback         # roll back the last migration (guarded in production)
npm run admin:create        # create the platform administrator (no demo data is seeded)
```

Production rollbacks require a verified backup and `CONFIRM_ROLLBACK=yes`. Destructive DDL on live
data must be reviewed by an operator; never reset the schema on a production database.
