# Production readiness — ARTHVEX Mail

> **Update 2026-10-31:** the demo seed script and all demo/audit rows were removed, the deployment
> scripts were fixed for the `backend/` + `frontend/` layout, and a PM2 (no-Docker) path was added
> (`ecosystem.config.cjs`, `deploy/scripts/deploy-pm2.sh`). The mail-delivery blockers in section 5
> still apply: real production requires Stalwart, a public IP/PTR, port 25 and published DNS.

Audit date: 2026-10-29
Auditor scope: repository review, live API/database testing against development adapters, static
deployment review. No production host, DNS zone or mail server was accessed.

## Overall status

# NOT READY

Reason: **real internet mail delivery is unverified**. The platform has no Stalwart instance in this
environment, no published DNS, no public IP/PTR and no port 25 reachability. A mail hosting service
cannot be called production-ready before a mailbox actually sends and receives external mail. Two
Three Medium defects in the backup pipeline were found and fixed, but they are not the deciding
factor.

This is not permission to deploy. A controlled launch requires the manual actions in section 9.

## 1. Repository and baseline

| Item | Observed |
| --- | --- |
| Branch | `master`, **zero commits**; entire tree untracked |
| Node / npm | v24.18.0 / 11.16.0 |
| Database | MariaDB 11.8.8; migrations `001`–`004` applied; 37 tables |
| Mail/webmail | development adapters; production refuses them |
| Lint | `npm run lint` (ESLint 9 flat config) — passes |
| CI | `.github/workflows/ci.yml` — lint, typecheck, tests, build |

Details and raw command results: `docs/audit/baseline.md`.

## 2. Confirmed defects and fixes

| Severity | Defect | Fix status |
| --- | --- | --- |
| Medium | `backup.sh` passed a MySQL-only flag to MariaDB, exited 7 and left a 20-byte empty archive | Fixed; detected server flavour, fail-fast, remove partial archive; re-run produced a verified 37,689-byte dump |
| Medium | `restore-test.sh` required `CREATE DATABASE`, which the documented least-privilege user lacks (error 1044) | Fixed; restores into a pre-created, name-guarded schema with clear instructions; restore verified |
| Medium | Backup and restore runs were never recorded: ISO-8601 timestamps were rejected by the `DATETIME` column and the error was swallowed, leaving `backup_runs` empty | Fixed; SQL-compatible UTC timestamps and visible warnings; both a backup and a restore now create `succeeded` rows |

No critical or high-severity security defect was found. Full detail:
`docs/audit/security-findings.md`.

## 3. Checks executed

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass (backend + frontend), exit 0 |
| `npm test` | 9 files, 76 tests passed, exit 0 |
| `npm run test:web` | 12 tests passed, exit 0 |
| `npm run build` | success, exit 0 |
| `node scripts/audit/security.mjs` | **81/81**, exit 0 |
| `node scripts/audit/features.mjs` | 17/17, exit 0 |
| reliability harness (isolated DB) | **21/21**, exit 0 |
| performance harness (isolated DB) | 8/8, exit 0 |
| `backup.sh` (live against dev DB) | exit 0, verified archive |
| `restore-test.sh` (isolated schema) | exit 0, 37 tables / 18 users / 8 mailboxes |
| `npm run lint` | pass, exit 0 (ESLint 9, backend + frontend) |
| `npm run db:migrate` | database up to date |

The audit harnesses live in `scripts/audit/` and are re-runnable; they are not part of the application
runtime and are not covered by `npm test`.

## 4. Security summary

Verified live: tenant isolation (19 cross-tenant attempts → 404), CSRF, session revocation, MFA
enforcement, mailbox-user scoping, suspension/deletion lockout, admin/customer separation, audited
exceptional access with two-person approval and expiry, sanitisation, attachment controls, account
lockout, rate limits and secret-exposure checks.

Accepted low risks: workspace-wide counts visible to mailbox users (their own mailbox list is scoped),
grant reasons visible to all operations staff, per-IP rate limits behind NAT, and the requirement that
MySQL run in UTC.

## 5. Mail delivery: blockers

No message left or entered the machine. Required before any delivery claim:

1. Public host with static IP and matching PTR.
2. Inbound/outbound TCP 25 plus 465/993/443 open; provider must not block port 25.
3. MX, SPF, DKIM and DMARC published from real engine values.
4. Stalwart installed, licensed and reachable over JMAP/management API.
5. TLS certificates for SMTP/IMAP/HTTP, verified with `openssl s_client`.
6. Bidirectional test with an independent provider, capturing SPF/DKIM/DMARC results.

Full test matrix: `docs/audit/mail-delivery-results.md`.

## 6. Infrastructure and deployment review (static)

- Apache template is a **new** vhost: TLS 1.2/1.3, HSTS, CSP, no management-port proxy, API proxied to
  loopback. `LimitRequestBody 20971520` must stay at least `WEBMAIL_MAX_ATTACHMENT_BYTES + slack`.
- systemd units run unprivileged with `ProtectSystem=strict`, `NoNewPrivileges`, memory caps and separate
  API/worker services. Both execute `tsx` from `node_modules`; `deploy.sh` installs dev dependencies, so
  production must not use `npm ci --omit=dev`.
- Health endpoints exist (`/health`, `/health/ready`); worker heartbeats and service state appear in the
  admin metrics.
- No live VPS inspection was possible: existing Apache sites, ports 25/465/993, firewall, disk,
  MySQL grants on the real host and certificate renewal remain unchecked.

## 7. Backup and recovery

Database backup and an isolated restore were executed and passed (3 s import, exact row-count match in
the first run, login against the restored schema succeeded, and `backup_runs` now records both runs).
Not verified: Stalwart mail-store backup/restore, secret recovery with `APP_ENCRYPTION_KEY`,
encrypted/off-site copies, and recovery time at production size.
See `docs/audit/backup-restore-results.md`.

## 8. Performance

Measured on MariaDB with 2,000 synthetic mailboxes: list page p95 16 ms, deep page p95 33 ms, usage
aggregation p95 24 ms, health p95 3.5 ms, 40 concurrent health requests all 200. No production target
exists and no real mail engine was measured. `LIKE '%…%'` search and per-request usage aggregation are
the known scaling limits. See `docs/audit/performance-results.md`.

## 9. Remaining manual actions (in order)

1. **Put the repository under version control.** Commit the current tree, tag a release, and make
   deploys reference that tag. Without this there is no rollback revision.
2. **Prepare the mail host.** Static IP, PTR, port 25 both directions, TLS, Stalwart installed and
   licensed; verify edition features used by the adapter (multi-tenancy, API keys, impersonation).
3. **Publish DNS** for the first domain and verify ownership; run `dns-check` until MX/SPF/DKIM/DMARC
   pass. Do not move existing customer MX until inbound mail is proven.
4. **Run the external delivery matrix** in `mail-delivery-results.md`; record headers and provider
   results.
5. **Create the restore schema** (`arthvex_restore_test`) and grant the app user access; schedule
   backup + weekly restore test; confirm the admin dashboard shows a fresh successful backup.
6. **Deploy on the existing VPS** with the templates, without modifying unrelated Apache sites or
   firewall rules. Confirm health, worker heartbeat and a real mailbox login.
7. ~~Add CI and a lint configuration.~~ Done: `npm run lint` and `.github/workflows/ci.yml` (lint,
   typecheck, backend tests, frontend tests, build). The audit harnesses still need a database and are not
   part of CI.
8. **Decide the free-plan limits.** The "Free" plan still allows 1 domain and 2 mailboxes, and there is
   no plan-editing UI. Reconcile with the product promise or document the limits publicly.
9. **Complete missing product surfaces**: catch-all configuration, plan editing, and the full staff
   support workflow.

## 10. Licensing and cost

Free software does not remove infrastructure cost. Stalwart is AGPL-3.0 / commercial dual-licensed;
verify that the required features are present in the Community edition. VPS capacity, IPv4 reputation,
backup storage, DNS and TLS are operational costs. See `docs/licensing-and-costs.md`.

## 11. Rollback and incidents

See `docs/production-runbook.md` and `docs/incident-response.md`. Minimum rollback: stop API/worker,
restore the pre-deploy database dump and previous release, restart, verify health. Never run
`db:rollback` on production without a verified backup.
