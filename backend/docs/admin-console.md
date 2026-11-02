# Admin console: users, mailboxes, roles, invitations

## Permissions and roles
Platform permissions (`backend/src/core/permissions.ts`) are persisted in `rbac_permissions`; roles in `rbac_roles` / `rbac_role_permissions`; `platform_admins.role_id` assigns one role. Permissions are read from MySQL on every request, so role edits apply immediately. Role assignment ends the target's sessions. API start-up runs `syncPermissionCatalog` (idempotent).

| Permission group | Super Admin | Operations | Support |
|---|---|---|---|
| dashboard.read, tenants.read, domains.read, mailboxes.read, users.read | yes | yes | yes |
| users.create/update/delete, tenants.create/update/delete, mailboxes.create/delete/credentials.reset/quota.update, domains.create/update/delete | yes | no | no |
| users.suspend, users.sessions.revoke, tenants.suspend, mailboxes.update/suspend, domains.verify | yes | yes | sessions.revoke only |
| users.password_reset | yes | no | yes |
| provisioning.read/retry, notifications.manage, abuse.manage | yes | yes | read only (provisioning, notifications, abuse) |
| support.read/respond | yes | yes | yes |
| settings.update, plans.update, roles.*, admins.manage, mailbox_access.approve | yes | no | no |
| audit.read, settings.read, plans.read, mailbox_access.request | yes | yes | no |

Tenant Administrator / Tenant Member remain workspace roles (`owner`, `admin`, `mailbox_user`, `billing`; `backend/src/core/roles.ts`) and never grant platform permissions.
Rules: a grantor can only grant permissions it holds; system roles are immutable; a role in use cannot be deleted; the last active Super Administrator cannot be demoted or suspended.

## Create user / invitation flow
`POST /api/v1/admin/users` creates a `pending_verification` user (unusable random password), optional workspace + membership, optional mailbox (job queue -> Stalwart adapter; reported as `provisioning`, never `active` until confirmed), then issues a single-use invitation. Only SHA-256 of the token is stored; the link (`/activate#token=...`) lives encrypted in `email_outbox` until sent, then is wiped. `POST /auth/activate` consumes it atomically. No password is ever emailed. Mailbox set-up instructions are sent once the mailbox is active AND the account activated.

## Email delivery
`email_outbox` (queued/sending/sent/failed/cancelled), worker polls every 5 s, backoff 1m,4m,16m,64m,2h up to `OUTBOX_MAX_ATTEMPTS` (6). Admins retry failures at `/admin/notifications`. Config test: `POST /admin/notifications/test`.
Env (all optional, see `config/env.ts`): `INVITE_TTL_HOURS=72`, `INVITE_RESEND_COOLDOWN_SECONDS=60`, `OUTBOX_MAX_ATTEMPTS=6`, `PASSWORD_RESET_TTL_MINUTES=30`, plus existing `MAILER=smtp`, `SMTP_*`, `MAIL_FROM`, `APP_BASE_URL`.

## Migration / deploy / rollback
Migration `005_rbac_and_invitations` is additive (new tables + `platform_admins.role_id`, enum widened) and backfills `role_id` from the old `role`. Deploy: back up DB, `npm ci`, `npm run db:migrate`, `npm run build`, restart API **and worker**. Rollback: `npm run db:rollback` (restores the 2-value enum; support/custom admins fall back to operations) and redeploy the previous commit. Verified up/down/up on the test DB.

## Tests
`npm test` (backend; integration suite uses database `arthvex_email_test` and is skipped if unreachable), `npm run test:web`, `npm run typecheck`, `npm run lint`, `npm run build`.
