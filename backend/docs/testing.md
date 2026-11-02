# Testing — ARTHVEX Mail

## Commands

```bash
npm run typecheck      # backend + frontend TypeScript
npm test               # backend unit tests (vitest)
npm run test:web       # frontend component tests (vitest + jsdom)
npm run build          # frontend production build
npm run db:migrate     # apply migrations to the configured database
```

There is no browser E2E harness or disposable Stalwart fixture yet. Those are required before a
production release (see `docs/production-readiness.md`).

Linting and CI are configured: `npm run lint` (ESLint 9, backend + frontend) and
`.github/workflows/ci.yml` (lint, typecheck, backend tests, frontend tests, build). The live audit
harnesses need a database and a running API, so they are not part of CI.

## Live audit harnesses

Added by the 2026-10-29 audit. They drive the real API and database rather than mocks.

```bash
# start an API with rate limits off for bulk fixtures (dev only)
(cd backend && API_PORT=4010 RATE_LIMIT_ENABLED=false npx tsx --env-file-if-exists=.env src/server.ts)
(cd backend && npx tsx --env-file-if-exists=.env src/worker/index.ts)

node scripts/audit/security.mjs   # 81 authorization/CSRF/session/webmail checks
node scripts/audit/features.mjs   # 17 alias/DNS/usage/notification/abuse/admin checks

# isolated database required; reset the schema before each run
cd backend
DB_NAME=arthvex_email_test npx tsx ../scripts/audit/reliability.ts
DB_NAME=arthvex_email_test npx tsx ../scripts/audit/performance.ts
```

The reliability harness injects provider failures into the in-memory dev adapter (`failNext`,
`setUnavailable`) and uses the `arthvex_email_test` schema. Results are written to
`var/audit/*.json` and summarised in `docs/audit/`.

## Backend suite

| File | Covers |
| --- | --- |
| `core/domain.test.ts` | Domain normalization/validation, DNS zone parsing |
| `core/policy.test.ts` | Roles, quotas, mailbox lifecycle, alias loop detection |
| `core/access-grant.test.ts` | Two-person approval rule, TTL expiry, read-only scope |
| `modules/auth/totp.test.ts` | TOTP generation/verification and replay window |
| `modules/webmail/sanitize.test.ts` | Script/event/frame removal, remote-image blocking and opt-in, `cid:` handling, link hardening, text fallback |
| `modules/webmail/dev-webmail.adapter.test.ts` | Mailbox isolation, seeding, draft update-in-place, send-to-Sent, search scoping, read state, move/delete, attachment download, empty-recipient rejection |
| `modules/webmail/jmap-webmail.adapter.test.ts` | Session discovery with bearer key, folder/role mapping, query filters/pagination, body/attachment mapping, create→submit→move-to-Sent, draft preserved on submission failure, 401 handling, attachment upload + multipart body |
| `config/env.test.ts` | Production fail-closed checks (dev adapter/mailer, cookies, HTTPS, admin MFA, test domains, attachment cap, missing secrets) |
| `modules/mailboxes/access.test.ts` | Automated negative authorization: non-member 404, mailbox-user self-only, manage denial, suspended workspace, billing role |

Latest local result: **9 files, 76 tests, all passing** (`npm test`).

## Frontend suite

`frontend/src/tests/ui.test.tsx` covers public claims, routing, authentication boundaries, and that a
non-admin cannot reach `/admin`. Latest result: **12 tests, all passing**.

Webmail component tests are not yet written; the webmail contract is covered by backend adapter tests
and manual API tests below. Adding jsdom tests for compose validation and read-state updates is the
next testing task.

## Manual API verification performed (development adapter)

Against the local dev API (`tsx watch`, MariaDB on 127.0.0.1:3307) using a session created in the dev
database and a test workspace:

| Check | Result |
| --- | --- |
| `GET /me`, folders, inbox list | 200; folders `inbox/drafts/sent/archive/junk/trash` with counts |
| Create draft, then send with `draftId` | draft `msg-1`, send 200 `msg-2`; drafts folder empty afterwards |
| Sent search for the sent subject | 1 message, correct subject, read state |
| Mark read PATCH | 200 |
| Cross-tenant access (outsider session, test tenant/mailbox) | **404** |
| Outsider using their own tenant id with the test mailbox id | **404** |
| Grant request by admin A | 201 pending |
| Admin A self-approval | **403** (two-person rule) |
| Admin A reads content before approval | **403** |
| Admin B approves | active with expiry |
| Admin A reads folders under the grant | 200; `useCount` incremented |
| Admin B tries to use A's grant | **403** |
| Revoke, then read | **403** |
| Audit rows | request, approve, use, two denied attempts, revoke recorded |

These used the **development webmail simulator**. They prove authorization, audit and workflow, not
real JMAP behaviour.

## Not yet verified

- Real Stalwart JMAP with a mailbox-scoped API key (requires a live v0.16 server and an admin
  credential with `impersonate` + `sysApiKey*`).
- Real SMTP inbound/outbound, SPF/DKIM/DMARC results at external providers, bounces, queue retries,
  attachment size behaviour at the receiving MTA.
- Browser E2E (register → verify → workspace → domain → mailbox → webmail → send/receive).
- Load and abuse-rate testing.

## Test data rules

- Tests must never send mail to arbitrary recipients. External delivery tests require an explicitly
  configured domain/mailbox controlled by the operator.
- Do not run destructive database tests against production. Use a disposable database and the
  development adapters; both refuse production configuration.
- No demo seed ships with the application. Create fixtures only in a disposable database whose name
  ends in `_test`; the integration harness refuses anything else.
