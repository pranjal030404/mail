# Implementation audit — ARTHVEX Mail

Date: 2026-10-29. Scope: the repository as found (no commits yet; all files untracked).

## 1. How this audit was produced

- Read `feature.md`, `README.md`, both `package.json` files, all TypeScript sources under
  `backend/src` and `frontend/src`, the three migrations, `backend/.env.example`, and the local
  development database (`backend/var/mysql-dev`, MariaDB on 127.0.0.1:3307).
- Ran the existing checks (all green before any change):

  | Command | Result |
  | --- | --- |
  | `npm run typecheck` | pass (backend + frontend) |
  | `npm test` | 3 files, 39 tests pass |
  | `npm run test:web` | 1 file, 12 tests pass |
  | `npm run build` | pass (frontend `dist/`) |

- No production VPS was contacted, no service was restarted, and no live DNS or Apache
  configuration was touched. `backend/var/stalwart-lab` is a local lab data directory only; it is
  not a configured Stalwart deployment in this environment.
- Git reports `fatal: your current branch 'master' does not have any commits yet`. There is no
  history to preserve, but the working tree is treated as user-owned code.

## 2. What exists

### Control plane (backend)

- Fastify 5 modular monolith registered under `/api/v1`, with Helmet, rate limiting, central error
  handling, request correlation IDs, `no-store` responses, liveness/readiness endpoints.
- MySQL 8/MariaDB migrations (`001` initial schema, `002` separate platform admins, `003` open free
  platform defaults) with foreign keys, checks-by-constraint, opaque ULID primary keys and
  `schema_migrations`.
- Argon2id password hashing, cookie sessions with HMAC CSRF tokens, absolute + idle expiry,
  revocation, MFA (TOTP + recovery codes), account lockout, anti-enumeration registration/reset
  responses, signup modes (open/invite-only/closed), terms acceptance versions, notification
  preferences.
- Workspaces, memberships and invitations with `authorizeTenant()` as the single authorization
  entry point; tenant-scoped queries. Domain add/verify/rotate/recheck, DNS diagnostics
  (MX/SPF/DKIM/DMARC + SRV), expected records generated from the adapter's real DKIM zone data.
- Mailbox lifecycle (create/provision/suspend/reactivate/quota/grace deletion/cancel), aliases with
  external-recipient confirmation and loop detection, usage collection every 5 minutes with
  threshold notifications, support tickets, public abuse reports.
- Durable MySQL job queue with idempotency keys, `FOR UPDATE SKIP LOCKED` claims, leases,
  exponential backoff, reconciliation flags, terminal failure states, retry/cancel.
- Mail engine adapter boundary with a real Stalwart v0.16 JMAP management adapter and a
  development simulator. Production startup refuses the simulator, the dev file mailer, insecure
  cookies, missing HTTPS, disabled admin MFA, test domains, or missing engine credentials.
- Platform admin as a separate principal (`platform_admins`, separate MFA tables, admin sessions,
  audit attribution), dashboard, tenant/mailbox suspension, job retry, abuse/support, settings,
  plans, audit search.

### Frontend

React 19 + Vite SPA with public pages, auth flows, workspace dashboard (overview, domains,
mailboxes, aliases, usage, members, support, client setup, account security/notifications/profile),
and a platform admin area. Component tests cover routing, auth boundaries and honest public claims.

## 3. Gap analysis against `feature.md`

Legend: **implemented** = code path + tests/checks where practical; **partial** = works but a stated
sub-feature is missing; **missing** = no implementation; **blocked** = needs infrastructure,
credentials or a licensing decision that cannot be verified here.

| # | Feature area | Status | Evidence / gap |
| --- | --- | --- | --- |
| 1 | Registration, verification, login, reset, change password | implemented | `auth.service.ts`, `auth.routes.ts`, CSRF/session plugin |
| 1 | TOTP MFA + recovery codes | implemented | `totp.ts`, MFA routes, `totp.test.ts` |
| 1 | Active sessions, revoke one/all | implemented | `/auth/sessions*` |
| 1 | Profile, notifications, preferences | implemented | `/me`, `/notifications*` |
| 2 | Workspaces, roles, invites, rename/switch | implemented | tenants module, `policy.test.ts` |
| 3 | Domain add/verify/rotate/reverify/diagnostics/removal preview/reconcile | implemented | domains + dns modules, zone parser tests |
| 4 | Mailbox lifecycle, quota, credential reset, grace deletion | implemented | mailboxes module + provisioning jobs |
| 5 | Aliases, external forwarding confirmation, catch-all | implemented | aliases module; catch-all adapter method exists, **no customer UI toggle** → partial |
| 6 | Usage, 5-minute collection, thresholds, plans | implemented | usage module, scheduler |
| 7 | Support tickets, abuse form, notifications | implemented | support module; staff ticket detail UI is a reply box → partial |
| 8 | Separate super-admin, dashboard, tenant/mailbox/jobs/abuse/support/users/settings/audit | implemented | admin module |
| 8 | Plan catalogue management | partial | read-only `/admin/plans`; no create/edit endpoint |
| 9 | Durable jobs, leases, retries, heartbeat | implemented | jobs repository, worker, scheduler |
| 10 | Stalwart adapter + dev simulator | implemented (adapter) / unverified against a live engine | adapter targets v0.16 JMAP management API; no live Stalwart is configured in this environment |
| 10 | **Built-in webmail UI** | **missing** | `feature.md` lists it as not included; only links to `WEBMAIL_URL` |
| 10 | Real inbound/outbound internet mail | blocked | requires a public IP, port 25, PTR, TLS and a live Stalwart instance — not available/authorized here |
| 11 | Production safety checks, health, backup tracking | implemented | `assertSafeConfig`, `/health*`, `backup_runs` |
| 12 | Public site and policy pages | implemented | `Info.tsx`, `Landing.tsx` |
| — | **Audited exceptional mailbox access** (master prompt §11) | **missing** | no grant table, workflow or admin content access |
| — | OpenAPI specification | **missing** | no generated or hand-written spec |
| — | Customer catch-all UI | missing | adapter supports it, routes/UI do not |
| — | Per-mailbox webmail authentication for a server-side proxy | **missing** | mailbox passwords are deliberately never stored |
| — | `docs/` directory | **missing** | all required deliverables absent |

## 4. Bugs and risks found

1. **Admin frontend contract drift.** `frontend/src/lib/types.ts` declares `Me.user.platformRole`, and
   `AdminLayout` branches on it. The API returns the field, and admin sessions normalise platform
   admins into the same shape, so this works — but the customer `/admin` route is also guarded by
   client state only. Server-side `requirePlatform()` is the real boundary and is present.
2. **`/me` for admins returns `mfaSetupRequired` but no memberships**, which is intended; refreshing
   after enabling MFA is required and the UI redirects to `/dashboard/security`, a customer page
   inside `RequireAuth`. Acceptable, but the admin security page should eventually live under
   `/admin/account`.
3. **Catch-all is policy-controlled in the database but unreachable** from the customer API/UI.
4. **Super-admin creation is env-based** (`admin:create`), which is documented but means MFA is only
   enforced at request time, not at first login for existing admins. `ADMIN_MFA_REQUIRED` blocks
   admin API calls until MFA is configured via `/dashboard/security`; that page is reachable because
   admins can call `/auth/mfa/*`. Works, but fragile UX.
5. **No automated DB-backed API integration tests.** Only pure unit tests and frontend component
   tests exist; the test database `arthvex_email_test` is created but unused.
6. **`bodyLimit: 256 KiB` globally** would block any realistic attachment upload; webmail needs a
   scoped higher limit.
7. **No OpenAPI document**, so the API surface is only discoverable from code.
8. **`sessions` FK to admins** and the admin split migration are sound, but the dev database already
   contains migrated data and must not be reset.

## 5. Hosting and infrastructure assumptions (not verified)

- The project targets an existing VPS with Apache as reverse proxy and systemd units. No deployment
  assets, Apache vhost template, systemd units, backup scripts or monitoring configuration exist in
  the repository yet.
- No public IPv4/IPv6, PTR, port 25 reachability, TLS certificate or DNS control was available to
  verify. These remain **blocked** and are documented in `docs/deployment.md` and
  `docs/production-readiness.md`.
- Stalwart edition/licence was not verified against a running server; the integration targets the
  open-source v0.16 management API. `docs/licensing-and-costs.md` records the assumptions and the
  required verification.

## 6. Priority for this implementation cycle

1. Integrated webmail (largest missing customer-facing feature; required by master prompt §8):
   server-side JMAP proxy with per-mailbox revocable credentials, development simulator, sanitised
   rendering, attachment limits, drafts, search, flags and folder operations, plus tests.
2. Audited exceptional mailbox access for platform operators (§11), because it is a security control
   that must exist before any operator needs to inspect a mailbox.
3. Documentation set required by §21 and honest production-readiness reporting.

Everything else in the table above is either implemented, blocked by infrastructure, or explicitly
deferred and recorded in `docs/implementation-plan.md`.
