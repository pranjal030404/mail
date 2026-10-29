# ARTHVEX Mail — Audit Baseline

Recorded: 2026-10-29 (audit session)
Auditor: independent code/infrastructure review performed inside the repository.

This file records what was actually observed. Anything not executed is labelled
"not verified". No claim in this directory is based on a previous report alone.

## 1. Repository state

| Item | Observed |
| --- | --- |
| Branch | `master` |
| Commits | **None.** `git log` fails with "your current branch 'master' does not have any commits yet". |
| Working tree | Entire project is untracked (`?? backend/ ?? frontend/ ?? docs/ ...`). |
| Rollback point | **None exists.** There is no commit to revert to and no tagged release. |
| Node | v24.18.0 |
| npm | 11.16.0 |
| Database | MariaDB **11.8.8** on `127.0.0.1:3307` (not MySQL 8 — compatibility note in `performance-results.md`) |
| Schema | 37 tables; migrations `001_initial_schema`, `002_platform_admins`, `003_open_free_platform`, `004_webmail_and_access_grants` all applied |
| Mail adapter | `dev` (file-backed simulator) in the local `.env`; no Stalwart instance exists in this environment |
| Secrets | `backend/.env` exists locally and is git-ignored; only `.env.example` templates are tracked |

**Baseline risk:** with zero commits, a deploy cannot be tied to an immutable
revision and no rollback target exists. This is an operational blocker, not a
code defect; it is listed in `production-readiness.md`.

## 2. Commands executed and exact results

Run from the repository root. Exit codes captured directly (no pipeline masking).

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | Backend and frontend TypeScript pass |
| `npm test` | 0 | 9 test files, **76 tests passed** (1.37 s) |
| `npm run test:web` | 0 | 1 test file, **12 tests passed** (2.17 s) |
| `npm run build` | 0 | Vite production build, 308 ms |
| `npm run lint` | **1** | **No lint script is defined anywhere in the workspace**, and no ESLint/Biome configuration exists |
| `npm run db:migrate` | 0 | "Database is up to date" |

Raw evidence: `var/audit/baseline-checks.txt` (local, not committed).

### Test coverage by area (unit level only)

| Test file | Tests | What it covers |
| --- | --- | --- |
| `core/domain.test.ts` | 26 | Domain/address normalization, validation, DNS zone parsing |
| `core/policy.test.ts` | 10 | Roles, quotas, lifecycle, alias loop detection |
| `config/env.test.ts` | 8 | Production configuration guards |
| `modules/mailboxes/access.test.ts` | 6 | Mailbox-level authorization matrix |
| `modules/webmail/dev-webmail.adapter.test.ts` | 7 | Simulated webmail adapter |
| `modules/webmail/jmap-webmail.adapter.test.ts` | 7 | JMAP mapping against a stub |
| `modules/webmail/sanitize.test.ts` | 6 | HTML sanitisation and remote-image blocking |
| `core/access-grant.test.ts` | 3 | Two-person rule and grant expiry rules |
| `modules/auth/totp.test.ts` | 3 | TOTP verification and replay window |
| **Backend total** | **76** | 9 files |
| `frontend/src/tests/ui.test.tsx` | 12 | Public claims, auth routing, admin gating |

There is **no integration or E2E suite**; nothing in the repository previously
exercised the API against a real database. The audit added live API tests
(`scripts/audit/`) to close that gap.

### Checks that did not exist at baseline

- No `lint` script or linter configuration.
- No CI workflow (`.github/workflows` absent).

Both were added after the audit: `npm run lint` now runs ESLint 9 over backend and frontend, and
`.github/workflows/ci.yml` runs lint, typecheck, both test suites and the production build. The
statements above describe the baseline, not the current tree.
- No Stalwart configuration directory under `deploy/` (only Apache, systemd, scripts).
- No automated browser/E2E test.

## 3. Runtime baseline

| Item | Observed |
| --- | --- |
| API reaches `GET /api/v1/health` | 200 (dev server on `127.0.0.1:4000`) |
| Worker | Not continuously running in this environment; jobs were driven explicitly by audit scripts |
| External mail | Never sent or received in this environment |
| DNS | No records published; no registrar/provider access |
| VPS | Not accessible from this environment; deployment review is static only |

## 4. Verification depth (what "verified" means here)

| Depth | Meaning | Available in this audit |
| --- | --- | --- |
| Unit | Pure functions and mocked adapters | Yes |
| Local integration | Real API, real MariaDB, dev mail/webmail simulators | Yes (added by this audit) |
| Staging | Real Stalwart, real DNS, disposable host | **No** |
| Production | Live domain, real internet mail | **No** |

Consequently, no statement in this audit claims real internet mail delivery,
real Stalwart provisioning, real TLS, or real DNS behaviour.

## 5. Pre-existing documents reviewed

`feature.md`, `README.md`, `docs/{architecture,security,deployment,testing,dns-setup,backup-restore,incident-response,production-readiness,licensing-and-costs,implementation-audit,implementation-plan,database-schema,api}.md`,
`docs/openapi.yaml`.

Discrepancies found while reading them are recorded in
`feature-verification.md` and `security-findings.md` rather than repeated here.
