# Architecture — ARTHVEX Mail

## Shape

Modular monolith control plane, three processes on one host:

```
browser ──HTTPS──> Apache ──┬─ /            → frontend/dist (SPA)
                            └─ /api/        → arthvex-api (Fastify, 127.0.0.1:4000)
                                                 │            │
                                                 │            └── MySQL (control-plane metadata)
                                                 │
                                                 └── Stalwart JMAP management API (127.0.0.1, not public)

arthvex-worker ── MySQL job queue + scheduler ──> Stalwart management API
               └── usage/DNS/reconciliation/grants sweep

Stalwart ── SMTP 25, submissions 465, IMAPS 993, JMAP https ──> internet + mailbox storage
```

There is no Redis, no Kubernetes and no second database. MySQL provides both metadata storage and a
durable job queue (`provisioning_jobs` with leases and `FOR UPDATE SKIP LOCKED`). Background work is
isolated in the worker process so API latency never depends on DNS, mail-engine or usage calls.

## Backend modules

| Module | Responsibility |
| --- | --- |
| `auth` | Registration, verification, sessions, CSRF, MFA (TOTP + recovery codes), password reset, lockout |
| `tenants` | Workspaces, memberships, invitations, the only tenant authorization entry point |
| `domains` / `dns` | Ownership verification, DKIM/MX/SPF/DMARC diagnostics, reconciliation |
| `mailboxes` | Lifecycle, quotas, credential reset, grace deletion, mailbox authorization helper |
| `aliases` | Aliases, external forwarding confirmation, loop detection |
| `mail-server` | Provider adapter (Stalwart + development simulator), durable provisioning, reconciliation |
| `webmail` | Mailbox-scoped JMAP proxy, sanitisation, attachments, preferences |
| `admin` | Separate platform identity, platform operations, exceptional access grants |
| `jobs` | Idempotent enqueue, leases, retries, backoff, manual review |
| `usage` | Five-minute mailbox/tenant usage snapshots and threshold notifications |
| `notifications` | In-app notifications, preference-aware email via SMTP/dev outbox |
| `support` / `abuse` | Tickets and abuse reports |
| `audit` | Append-only audit rows with actor separation and metadata redaction |

`AppContext` (`backend/src/context.ts`) injects config, DB, mail engine, webmail adapter, mailer, DNS
resolver, secrets and logger. Tests substitute fakes; production graph is built in `bootstrap.ts`.

## Trust boundaries

1. **Public edge** — Apache terminates TLS, adds security headers, forwards a fixed client IP, and
   never proxies the Stalwart management port (`8080` in the lab) or its setup UI.
2. **Control plane** — authenticated cookie session (`httpOnly`, `Secure`, `SameSite=Lax`) plus an
   HMAC CSRF token bound to the session. Tenant authorization is checked per request, then every
   query filters by the authorized tenant.
3. **Platform staff** — a different principal type (`platform_admins`) with separate sessions, MFA
   and audit attribution. Customer accounts cannot be promoted to admin.
4. **Exceptional mailbox access** — requires a second super-admin approval, short TTL, read scope,
   per-use audit. Ordinary admin privilege never returns message content.
5. **Mail engine** — the management API credential stays server-side. Webmail uses a per-mailbox
   API key created by Stalwart, stored encrypted, and never sent to the browser.
6. **Mail content** — messages and attachments stay in Stalwart. MySQL stores metadata, preferences,
   encrypted webmail key material and audit rows only.

## Data flow: provisioning

1. API validates the request and writes the desired state plus a job row in one MySQL transaction.
2. Worker claims the job (`FOR UPDATE SKIP LOCKED`), leases it, and calls the adapter.
3. The adapter is idempotent: it reads engine state first and adopts an account it created before an
   uncertain failure.
4. Retries use exponential backoff; `unavailable` retries, `uncertain` retries with reconciliation,
   `invalid`/`conflict` move to operator review. Terminal failures mark the mailbox/domain failed and
   notify workspace admins.

## Data flow: webmail

1. Browser calls `/api/v1/tenants/:tenantId/mailboxes/:mailboxId/webmail/...` with the session cookie.
2. API re-authorizes tenant membership and mailbox ownership (a `mailbox_user` only reaches the
   mailbox linked to their membership).
3. API obtains the mailbox's encrypted API key (creating it through the management API on first use).
4. API speaks JMAP (RFC 8620/8621) to Stalwart with `Authorization: Bearer <mailbox key>`.
5. HTML is sanitised, remote images removed by default, and the UI renders it in a sandboxed iframe.
6. Attachments are streamed through the API after the same authorization check and a `nosniff`,
   `Content-Disposition: attachment` response.

The development adapter replaces steps 3–4 with a local JSON store. It is refused in production.

## Deployment topology (target, not yet applied)

- Apache vhost: static SPA + `/api` reverse proxy, HSTS, CSP, TLS via existing certificates.
- `arthvex-api.service` and `arthvex-worker.service` run as an unprivileged user with a protected env
  file (`0600`).
- `stalwart.service` binds SMTP/IMAP/JMAP; its management listener is bound to loopback only.
- MySQL local socket/TCP with a least-privilege application user.
- Backups: MySQL dump plus Stalwart data directory snapshot, encrypted off-site, with restore tests.
