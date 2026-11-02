# Implementation plan — ARTHVEX Mail

Companion to `docs/implementation-audit.md`. Phases mirror master prompt §20; only work that is
actionable in this repository is marked as the current cycle.

## Phase status

| Phase | State | Notes |
| --- | --- | --- |
| 0 — Audit and feasibility | done | `docs/implementation-audit.md` |
| 1 — Foundation | done (pre-existing) | schema, migrations, env validation, error handling, health, secure config |
| 2 — Identity and workspaces | done (pre-existing) | auth, MFA, sessions, signup policy, membership, invitations, tenant isolation |
| 3 — Domain and mailbox control plane | done (pre-existing) | verification, diagnostics, quotas, lifecycle, aliases, provider interface |
| 4 — Real Stalwart integration | implemented, unverified live | adapter + durable jobs; live engine verification blocked (no Stalwart host/credentials) |
| 5 — Integrated webmail | **this cycle** | JMAP proxy, per-mailbox credentials, dev simulator, full UI |
| 6 — Platform administration | mostly done; exceptional access **this cycle** | grants workflow + audited content access |
| 7 — Production security and deployment | partially done | config hardening exists; deployment assets/docs added this cycle, live deploy not authorized |
| 8 — Verification and release | in progress | local checks; real mail delivery blocked |

## This cycle: ordered work

1. **Schema and configuration**
   - Migration `004_webmail_and_access_grants`: mailbox webmail credentials, mailbox webmail
     preferences, `admin_access_grants`; down migration drops only these objects.
   - Environment: `WEBMAIL_ENABLED`, `WEBMAIL_JMAP_URL`, `WEBMAIL_MAX_ATTACHMENT_BYTES`,
     `WEBMAIL_DEV_STATE`, `ADMIN_ACCESS_GRANT_TTL_MINUTES`; production validation refuses an
     enabled webmail without a real mail engine.
2. **Mail engine boundary**
   - Add `setMailboxWebmailSecret` / `revokeMailboxWebmailSecret` to the adapter interface.
   - Stalwart adapter writes a second, non-management `Password` credential under a fixed key
     (`arthvex-webmail`) and can rotate/revoke it. The customer's own password is never touched.
   - Development adapter records credential status only.
3. **Webmail module**
   - `webmail.interface.ts`: provider-neutral folders/messages/send/download contract.
   - `jmap-webmail.adapter.ts`: RFC 8620/8621 client for the Stalwart user JMAP endpoint using the
     per-mailbox proxy credential (never the management credential).
   - `dev-webmail.adapter.ts`: file-backed simulated mailbox store for development and tests.
     Production cannot construct it.
   - `sanitize.ts`: server-side HTML sanitisation, remote-image blocking with a count, link/attr
     hardening. Remote images are never fetched by the server.
   - `webmail.service.ts`: mailbox authorization, credential provisioning, folder/flag/move/search,
     draft persistence, send with resumable failure, attachments (type/size limits), preferences.
   - `webmail.routes.ts`: tenant-scoped endpoints; every operation re-authorizes the mailbox.
   - Admin exceptional access: request → approval by a *different* super admin → short-lived grant
     with scope `read`, explicit reason/ticket, per-use audit, revocation and expiry.
4. **Frontend**
   - `/dashboard/webmail`: folder navigation, list + reading pane, send/reply/forward, drafts,
     search, read/unread, move/delete, attachments, signature preference, responsive layout,
     keyboard shortcuts, empty/loading/error states, sandboxed HTML rendering.
   - `/admin/access`: request/approve/revoke grants and read a mailbox only while a valid grant is
     active.
5. **Tests and verification**
   - Unit: sanitisation, remote-image blocking, grant state/approval rules, dev webmail isolation,
     JMAP request mapping against a fake fetch, attachment limits.
   - Integration (dev server, dev DB): sign in as the platform administrator, list folders/messages, send a message,
     confirm it appears in Sent, verify cross-tenant/mailbox access is denied.
   - `npm run typecheck`, `npm test`, `npm run test:web`, `npm run build`, `npm run db:migrate`.

## Acceptance criteria

| Area | Criterion |
| --- | --- |
| Webmail auth | Browser never receives the Stalwart admin credential or a usable mailbox secret; every request re-checks tenant + mailbox authorization |
| Isolation | A user who is not a member of the tenant receives 404 for any webmail route; a `mailbox_user` can only reach their linked mailbox |
| Sending | Send succeeds through JMAP `EmailSubmission/set` in production, is recorded as Sent, and a failed send preserves the draft |
| Rendering | HTML is sanitised server-side; scripts/forms/iframes removed; remote images blocked unless opted in; content rendered in a sandboxed iframe |
| Attachments | Type and total-size limits enforced server-side; oversized uploads rejected with a clear error |
| Drafts | Draft create/update is idempotent and survives navigation; send converts the draft instead of duplicating |
| Admin access | No mailbox content without an `active` grant; grant requires reason; approval by another super admin; short TTL; every use audited; revocation blocks immediately |
| Production safety | Dev webmail adapter refused in production; startup fails on unsafe config |

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Stalwart credential model differs from the assumed second-password credential | Isolated behind two adapter methods; documented; integration test with real Stalwart required before enabling in production |
| JMAP property/method drift between Stalwart versions | Typed adapter + fake-fetch tests; health check reports management API only; webmail errors are surfaced, not hidden |
| HTML sanitisation bypass | Strict allowlist sanitiser + sandboxed iframe + blocked remote images; no scripts allowed |
| Per-mailbox credential leak | AES-256-GCM at rest (same `SecretBox` as TOTP), never returned to clients, rotatable/revocable, excluded from logs |
| Admin access abuse | Two-person rule, short TTL, reason + optional ticket, per-use immutable audit, no bulk export |
| Large attachments/DoS | Route-level body limit, per-file and total limits, MIME blocklist, rate limits |

## Blocked items

- Real inbound/outbound internet mail: needs a public IP, port 25 both directions, PTR, TLS and a
  live Stalwart host. Not available or authorized in this environment.
- Live Stalwart edition/licence verification and JMAP credential behaviour.
- VPS deployment, Apache vhost install, systemd unit installation, firewall changes, DNS changes.
- Real external delivery tests (must never send unsolicited mail).

Each blocker is restated with the exact next action in `docs/production-readiness.md`.

## Commands

```bash
npm install
npm run db:migrate          # applies 004 on the dev database
npm run admin:create        # platform admin from backend/.env
npm run dev:api             # API on :4000
npm run dev:worker          # background jobs
npm run dev:web             # UI on :5173

npm run typecheck
npm test                    # backend unit/integration
npm run test:web            # frontend component tests
npm run build
```
