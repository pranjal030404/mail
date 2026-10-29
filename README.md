# ARTHVEX Email Hosting Platform

Self-hosted, multi-tenant control plane for business email on customers' own domains. It manages
users, workspaces, domains (DNS ownership + diagnostics), mailboxes, aliases, quotas, integrated
webmail and platform administration, and drives **Stalwart Mail Server** through its documented
management API. It does not implement SMTP/IMAP itself.

> **Free and open source (MIT).** Anyone can register, create a workspace and bring their own domain;
> the platform super-admin manages tenants through a separate identity. Real internet mail flow and
> live Stalwart integration are **not verified in this repository**: no production host, public IP,
> port 25, DNS control or Stalwart instance is configured here. See `docs/production-readiness.md`.

## Layout

```
backend/            Fastify API, shared domain rules, worker, DB migrations
  src/core/         Shared rules (validation, roles, lifecycle, access grants)
  src/modules/      Feature modules (auth, tenants, domains, mailboxes, webmail, admin, ...)
  src/worker/       Background job runner + scheduler
  migrations/       MySQL migrations (001–004)
  var/              Local runtime data (dev mail engine, webmail, outbox, MySQL data)
frontend/           React + Vite single-page app
docs/               Audit, plan, architecture, API, security, deployment, runbooks
deploy/             Apache, systemd, backup/restore/healthcheck/deploy templates
```

The frontend proxies `/api` to the backend on `http://127.0.0.1:4000`.

## Quick start (development, simulated mail and webmail)

```bash
cp backend/.env.example backend/.env   # set APP_ENCRYPTION_KEY, SESSION_SECRET, DB creds
npm install
npm run db:migrate                     # includes 004_webmail_and_access_grants
npm run db:seed:dev                    # prints a demo user + password
npm run admin:create                    # platform admin from backend/.env

npm run dev:api                         # API on :4000
npm run dev:worker                      # background jobs/scheduler
npm run dev:web                         # UI on :5173
```

The development adapters simulate mailbox provisioning and webmail and write notification emails to
`backend/var/dev-outbox`. They are refused in production. The demo domain is marked verified without
DNS proof and is labelled as demo data.

Open `/dashboard/webmail` after signing in as the demo user. Sign-in to webmail uses the ARTHVEX
session; the server talks to the mail engine with a per-mailbox API key, never the management
credential.

## Webmail

- Folders, message list/reading pane, pagination, unread state, move/delete, mailbox-scoped search.
- Compose, reply, reply-all, forward, Cc/Bcc, attachments (server-enforced limits), drafts that survive
  failed sends, signature and remote-image preference.
- HTML is sanitised server-side and rendered in a sandboxed iframe; remote images are blocked by
  default.
- Production path: JMAP (RFC 8620/8621) against Stalwart with a mailbox-scoped API key created by the
  platform, stored AES-256-GCM encrypted and never sent to the browser.

## Exceptional mailbox access

Platform operators cannot read message content with ordinary privileges. A grant requires a documented
reason, approval by a **different** super admin, read-only scope, a short TTL, and audits every use.
See `docs/security.md` and `/admin/access`.

## Testing

```bash
npm run typecheck      # backend + frontend
npm test               # backend unit tests (76)
npm run test:web       # frontend component tests (12)
npm run build          # frontend production build
```

## Documentation

- `docs/implementation-audit.md` — what existed before this cycle and the gap analysis
- `docs/implementation-plan.md` — phases, acceptance criteria, risks, blockers
- `docs/architecture.md`, `docs/database-schema.md`, `docs/api.md`, `docs/openapi.yaml`
- `docs/dns-setup.md`, `docs/licensing-and-costs.md`
- `docs/security.md`, `docs/deployment.md`, `docs/backup-restore.md`, `docs/incident-response.md`
- `docs/testing.md`, `docs/production-readiness.md`

## Platform administrators

Platform staff live in the separate `platform_admins` table, never in customer `users`. Sign in at
`/admin`. `admin:create` reads `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_ROLE` and `ADMIN_PASSWORD` from
`backend/.env` (or arguments); re-running updates that address. Admin MFA is mandatory in production.

## Known limitations

- No real internet mail delivery is verified; this needs a host with public IP, PTR, port 25 and a live
  Stalwart installation.
- Live Stalwart API-key behaviour must be verified against the deployed version before enabling webmail
  in production.
- No browser E2E or disposable mail-server integration suite yet.
- Billing is intentionally absent; catch-all and plan-catalogue management are not exposed in the UI.
- Legal pages are drafts and require review.
