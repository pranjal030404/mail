# Licensing and costs — ARTHVEX Mail

## Application licence

ARTHVEX Mail itself is MIT-licensed (`LICENSE`). Self-hosted use, modification and redistribution are
permitted with attribution and the licence text.

## Dependency licences (direct dependencies)

| Package | Licence | Notes |
| --- | --- | --- |
| fastify, @fastify/* | MIT | API framework, cookie, helmet, rate limit |
| mysql2 | MIT | MySQL driver |
| zod | MIT | Runtime validation |
| nodemailer | MIT | SMTP notification mailer |
| @node-rs/argon2 | MIT / Apache-2.0 | Native Argon2id binding; prebuilt binaries |
| sanitize-html | MIT | Server-side HTML sanitisation for webmail |
| react, react-dom, react-router-dom | MIT | Frontend |
| vite, @vitejs/plugin-react | MIT | Build/dev server |
| lucide-react | ISC | Icons |
| vitest (dev) | MIT | Tests |

No dependency requires a paid runtime licence. Run `npm audit` and a licence scan in CI before every
release; transitive licences can change with upgrades. Pin compatible versions through
`package-lock.json`.

## Stalwart Mail Server

Stalwart is dual-licensed under **AGPL-3.0** and a commercial enterprise licence. This project targets
the open-source v0.16 JMAP management API.

Facts that matter for this deployment:

- The Stalwart documentation marks `memberTenantId`, `externalId` and tenant-scoped administration as
  **enterprise** features. Native Stalwart multi-tenancy is therefore **not** assumed.
- ARTHVEX implements tenancy at the application layer (workspaces, membership checks, per-mailbox
  accounts/API keys). This boundary is enforced by ARTHVEX; it is **not** native Stalwart tenant
  isolation. The mail engine sees ordinary accounts in one installation.
- Mailbox-scoped API keys, JMAP, SMTP/IMAP and DKIM generation are used through the documented API.
  Whether every one of those is available in the exact deployed edition must be verified against the
  running server before enabling webmail in production.
- Do not bypass licence checks or enterprise restrictions. If a required capability is enterprise-only,
  options are: (a) keep the application-level implementation, (b) replace the capability with an
  open-source component, or (c) purchase a licence. No paid subscription is recommended by this
  repository; that is an operator decision.

If AGPL obligations apply to a modified Stalwart distributed as a service, review them with counsel.
Running unmodified Stalwart as a separate process and calling its documented API does not change
ARTHVEX's MIT licence.

## Free vs paid capability matrix (verify against the installed version)

| Capability | Expected in Community | Used by ARTHVEX |
| --- | --- | --- |
| SMTP/IMAP/POP3/JMAP, DKIM, spam filter | yes (open source) | yes |
| Account provisioning via JMAP management API | yes | yes |
| Mailbox-scoped API keys (app passwords/API keys) | yes, verify version | webmail |
| Native multi-tenant isolation | enterprise | **not used** (application tenancy) |
| SCIM / externalId | enterprise | not used |
| Advanced telemetry/tenants features | enterprise | not used |

## Hosting cost model

All figures are planning ranges, not quotes; verify with the chosen providers.

| Item | Typical driver | Notes |
| --- | --- | --- |
| VPS | 4–8 vCPU, 8–16 GB RAM, local SSD | Mail storage grows with customers; separate data disk preferred |
| Block storage | per GB/month | Mailbox storage + snapshots; plan 2× current usage |
| Public IPv4 | monthly | Required for port 25 and PTR |
| Backups | storage + egress | Encrypted off-site, tested restores |
| DNS | free at most registrars | DMARC report mailbox may add storage |
| TLS | free (Let's Encrypt) | Automate renewal |
| Optional outbound relay | per 1,000 messages | Only if the VPS IP reputation/port 25 is unsuitable |
| Monitoring | free tiers possible | Health checks, disk and queue alerts |
| Support/on-call | staff time | No SLA is offered by this project |

The product is free; there is no billing module. Optional relay/provider use is the main variable cost.
If port 25 is blocked, an authenticated relay is the safe alternative; it must preserve SPF/DKIM
alignment for customer domains and is documented in `docs/deployment.md`.

## Compliance notes

- Privacy/terms/acceptable-use pages are drafts and require legal review.
- Exceptional mailbox access must be disclosed in the privacy policy and handled per
  `docs/security.md`.
- Data retention and deletion are documented in `docs/database-schema.md` and `docs/backup-restore.md`.
