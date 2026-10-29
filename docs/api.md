# API — ARTHVEX Mail

Base path: `/api/v1`. JSON only. Errors use one shape:

```json
{ "error": { "code": "validation_failed", "message": "Some fields are invalid.", "details": [{ "field": "email", "message": "Invalid email" }], "correlationId": "..." } }
```

Authentication is a cookie session (`__Host-arthvex_sid` in production) plus `x-csrf-token` on every
authenticated write. `GET /me` returns the current CSRF token. Session-authenticated requests with a
mismatched `Origin` are rejected. Rate-limited routes return `429`.

A machine-readable summary is in `docs/openapi.yaml`. It is maintained by hand and covers the primary
routes; route schemas in code remain authoritative.

## Health

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness |
| GET | `/health/ready` | none | DB readiness (no credentials exposed) |

## Authentication and account

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | Signup policy enforced; anti-enumeration response |
| POST | `/auth/verify-email` | Single-use hashed token |
| POST | `/auth/resend-verification` | Throttled, generic response |
| POST | `/auth/login` | Lockout, MFA-pending session |
| POST | `/auth/logout` | Revokes current session |
| POST | `/auth/forgot-password` / `/auth/reset-password` | Hashed, expiring, single-use |
| POST | `/auth/change-password` | Requires current password; revokes other sessions |
| POST | `/auth/mfa/setup`, `/auth/mfa/confirm`, `/auth/mfa/verify`, `/auth/mfa/disable` | TOTP + recovery codes |
| GET | `/auth/sessions`, DELETE `/auth/sessions/:id`, POST `/auth/sessions/revoke-others` | Session management |
| GET/PATCH | `/me` | Profile; returns CSRF token and memberships |
| GET/POST | `/notifications`, `/notifications/read-all`, `/notification-preferences` | In-app notices |

## Workspaces, members, domains, mailboxes

All tenant paths begin `/tenants/:tenantId`. Non-members receive `404`; members without permission
receive `403`; writes to a suspended workspace are refused.

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/tenants` | List/create workspace |
| GET/PATCH | `/tenants/:tenantId` | Details/rename |
| GET/POST/PATCH/DELETE | `/tenants/:tenantId/members...`, `/invitations...` | Membership and invitations |
| GET/POST | `/tenants/:tenantId/domains` | List/add domain (TXT ownership token) |
| POST | `/tenants/:tenantId/domains/:domainId/verify`, `/rotate-token`, `/recheck` | Ownership |
| GET | `/tenants/:tenantId/domains/:domainId/diagnostics`, `/removal-preview` | DNS diagnostics and safe delete |
| POST | `/tenants/:tenantId/domains/:domainId/reconcile` | Mail-engine reconciliation |
| GET | `/tenants/:tenantId/mailboxes` | List (mailbox users see only their mailbox) |
| POST | `/tenants/:tenantId/domains/:domainId/mailboxes` | Create (verified domain only) |
| GET/PATCH | `/tenants/:tenantId/mailboxes/:mailboxId` | Detail/update |
| POST | `.../reset-credentials`, `.../suspend`, `.../reactivate`, `.../cancel-deletion` | Lifecycle |
| DELETE | `.../mailboxes/:mailboxId` | Grace-period deletion with typed address confirmation |
| GET | `.../client-settings` | IMAP/SMTP/JMAP settings from configuration |
| GET/POST/DELETE | `/tenants/:tenantId/aliases...` | Aliases and forwarding |
| POST | `/forwarding/confirm` | Public confirmation for external forwarding |
| GET | `/tenants/:tenantId/usage`, `/usage/history` | Usage and limits |

## Webmail

All routes re-authorize the tenant and mailbox. Responses never include the mailbox credential.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `.../webmail/folders` | Folder list with unread/total counts |
| GET | `.../webmail/messages?folderId&q&page&pageSize` | Paged, mailbox-scoped search |
| GET | `.../webmail/messages/:messageId?images=true` | Message, sanitised HTML, attachments, blocked-image count |
| PATCH | `.../webmail/messages/:messageId` | `{ "read": true }` |
| POST | `.../webmail/messages/:messageId/move` | `{ "folderId": "..." }` |
| DELETE | `.../webmail/messages/:messageId` | Trash, or permanent when already in Trash |
| POST | `.../webmail/drafts` | Create/update draft (`draftId`) |
| POST | `.../webmail/send` | Submit; failed submission keeps the draft |
| GET | `.../webmail/attachments/:blobId?name&type` | Attachment download (authorization checked) |
| GET/PATCH | `.../webmail/preferences` | Signature, remote-image preference |

Send/draft bodies accept up to `WEBMAIL_MAX_ATTACHMENT_BYTES` and are validated server-side for file
count, size, recipient syntax and blocked extensions.

## Support, abuse, notifications

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/tenants/:tenantId/support-tickets` | Tickets |
| GET/POST | `/tenants/:tenantId/support-tickets/:ticketId[/messages]` | Thread |
| POST | `/abuse-reports` | Public, rate-limited abuse report |
| GET/POST | `/notifications`, `/notification-preferences` | User notices |

## Platform administration

Requires a platform-admin session (never a customer). Actions are audited. Sensitive writes include
`reason` and `confirm: true`.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/admin/metrics` | `admin.read` |
| GET | `/admin/tenants`, `/admin/tenants/:id` | `admin.read` |
| POST | `/admin/tenants/:id/suspend`, `/reactivate` | `admin.tenants.manage` |
| PATCH | `/admin/tenants/:id/quotas` | `admin.plans.manage` |
| POST | `/admin/mailboxes/:id/suspend`, `/reactivate` | `admin.mailboxes.manage` |
| GET | `/admin/provisioning-jobs`, POST `.../retry`, `.../cancel` | `admin.read` / `admin.jobs.manage` |
| POST | `/admin/domains/:id/reconcile` | `admin.jobs.manage` |
| GET/PATCH | `/admin/abuse-reports[/:id]` | `admin.abuse.manage` |
| GET | `/admin/users`, `/admin/admins` | `admin.users.manage` |
| POST | `/admin/users/:id/revoke-sessions`, `/suspend`; `/admin/admins/:id/...` | `admin.users.manage` |
| POST | `/admin/signup-invitations` | `admin.users.manage` |
| GET/PATCH | `/admin/settings` | `admin.read` / `admin.settings.manage` |
| GET | `/admin/plans` | `admin.read` |
| GET | `/admin/audit` | `admin.read` |
| GET/POST | `/admin/support-tickets...` | `admin.read` / `admin.users.manage` |

### Exceptional mailbox access

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/admin/access-grants` | `admin.read` | List; `mine=true` filter |
| GET | `/admin/mailboxes?q=` | `admin.read` | Mailbox picker (metadata only) |
| POST | `/admin/access-grants` | `admin.access.request` | `mailboxId`, reason (≥10 chars), optional ticket, scope `read` |
| POST | `/admin/access-grants/:id/approve` | `admin.access.approve` | Must be a *different* super admin |
| POST | `/admin/access-grants/:id/deny` | `admin.access.approve` | Different super admin |
| POST | `/admin/access-grants/:id/revoke` | `admin.access.approve` | Immediate |
| GET | `/admin/access-grants/:id/folders`, `/messages`, `/messages/:messageId`, `/attachments/:blobId` | `admin.read` | Only the requesting operator, only while active; every call audited |

Grant lifetime is `ADMIN_ACCESS_GRANT_TTL_MINUTES` (5–240, default 60). Expired grants are swept by the
worker and also rejected on use. Write scope is not implemented in this release.
