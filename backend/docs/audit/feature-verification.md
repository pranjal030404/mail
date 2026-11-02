# Feature verification — ARTHVEX Mail

Classification legend:

- **Verified (local)** — exercised through the real HTTP API and MariaDB with development adapters.
- **Insufficiently tested** — implemented and partly exercised, but a material path was not tested.
- **Defective** — a confirmed defect was found (see `security-findings.md`).
- **Missing** — not implemented.
- **Blocked** — cannot be verified without external infrastructure.

Nothing here is verified against a real Stalwart server or the public internet.

## Accounts and access

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Registration with terms acceptance | Verified (local) | 202; duplicate address returns the same 202; weak passwords 400 |
| Email verification tokens | Verified (local) | token from the dev outbox accepted once; single-use enforced in a transaction |
| Password reset | Verified (local) | request indistinguishable for unknown addresses; reset works; replay 400; weak password 400; sessions revoked |
| Login lockout | Verified (local) | 5 bad attempts → locked; correct password still 401; lock expiry stored |
| Session lifecycle | Verified (local) | HttpOnly/SameSite=Lax cookie; logout and revoke-others invalidate old cookies; idle and absolute expiry in the resolver |
| MFA enforcement (admin) | Verified (local) | with `ADMIN_MFA_REQUIRED=true`, an unenrolled admin session gets 403 `mfa_setup_required` |
| MFA enrolment / recovery codes | Insufficiently tested | setup, TOTP verification, replay protection and recovery-code use exist; no end-to-end TOTP flow was executed in this audit |
| Account enumeration | Verified (local) | identical status/body for register, reset request and login failures; dummy hash for unknown users |

## Workspaces, roles, tenancy

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Personal and company workspaces | Verified (local) | workspace creation through the API; ownership membership created |
| Invitations | Verified (local) | invite email, token acceptance 200, replay 400; linked mailbox delivered to the member |
| Role matrix | Verified (local) | `owner/admin/billing/mailbox_user`; mailbox user cannot create mailboxes, list members or read sibling mailboxes |
| Tenant isolation | Verified (local) | 19 cross-tenant read/write attempts all returned 404 |
| Workspace suspension | Insufficiently tested | admin suspend/reactivate cascades mailbox suspension; not exercised end-to-end against a real engine |
| Member removal / last-owner protection | Insufficiently tested | implemented with locking; only code-reviewed |

## Domains and DNS

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Add domain, claim uniqueness | Verified (local) | creation and duplicate-claim rejection |
| Ownership verification | Insufficiently tested | token issuance, expiry (`token_expired`) and TXT lookup code exist; no public DNS record was published, so a passing verification was never observed |
| DNS diagnostics (MX/SPF/DKIM/DMARC) | Verified (local, negative case) | `dns-check` returns per-record statuses and reports unpublished DNS as not ready |
| Domain removal impact | Verified (local) | impact endpoint lists mailboxes/aliases and refuses removal while in use |
| Automatic re-checks / regression notifications | Insufficiently tested | scheduler code exists; not run against real DNS |
| Catch-all | Missing | schema and plan flags exist; no customer UI or routing configuration |

## Mailboxes and aliases

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Create mailbox (durable job) | Verified (local) | 202 then active through the real job runner; concurrent duplicates yield one row |
| Quota and plan limits | Verified (local) | quota race with one slot left accepted exactly one request |
| Suspend / reactivate | Verified (local) | content returns 409 while suspended; restored after reactivation |
| Delete with grace period / cancel | Verified (local) | access stops immediately; cancellation restores; grace expiry deletes engine account and claim |
| Credential reset | Insufficiently tested | adapter call and audit path exist; no real engine to confirm the password applies to IMAP/SMTP |
| Aliases to a mailbox | Verified (local) | created, reached `active` in the engine, duplicate 409, delete accepted |
| External forwarding | Verified (local, gating) | refused (403) because the free plan disallows it; confirmation-token flow not exercised |
| Catch-all restrictions | Missing | see above |

## Mail engine and webmail

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Stalwart provisioning adapter | Blocked | no Stalwart instance; management API, API-key creation and reconciliation against the real server unverified |
| Inbound/outbound internet mail | Blocked | no DNS, public IP, port 25 or external mailbox |
| Integrated webmail UI | Verified (local, simulator) | folders, paging, search, read state, move/delete, drafts, send, attachments exercised through the API with the dev adapter |
| JMAP adapter | Insufficiently tested | typed JMAP calls including `EmailSubmission/set`; only unit-tested against a stub |
| HTML sanitisation / remote images | Verified (local) | script, iframe and `javascript:` removed; remote image blocked and counted |
| Attachment limits and download | Verified (local) | blocklist, per-file/size/count limits, cross-tenant 404, `nosniff` |
| Mail queue metrics | Missing | admin metrics states the mail queue is not yet collected by the control plane |

## Administration and operations

| Feature | Status | Evidence / gap |
| --- | --- | --- |
| Separate platform admin accounts | Verified (local) | separate table/principal; admin session has no tenant memberships; admin login cannot act as a customer |
| Role enforcement | Verified (local) | operations cannot change settings or approve grants |
| Exceptional mailbox access | Verified (local) | reason, second-approver rule, scope, expiry, revocation, per-use audit, use counter |
| Admin metadata views | Verified (local) | tenant detail contains no message bodies; mailbox search returns address/status |
| Audit log | Verified (local) | grant reads and security actions recorded; metadata sanitiser strips secret-like keys |
| Plan catalogue editing | Missing | read-only plan list; limits change only through SQL |
| Staff support queue | Insufficiently tested | list and reply exist; no assignment, canned replies or full ticket workflow |
| Abuse reports | Verified (local) | public intake 202 and admin queue listing |
| Backups | Defective → fixed | see `backup-restore-results.md`; database backup and restore now work, mail store not verified |
| Deployment templates | Insufficiently tested | Apache/systemd/scripts reviewed statically; never executed on a host |
| Health endpoints | Verified (local) | `/health` 200; readiness and admin service rows inspected in code |

## Cross-cutting gaps

| Gap | Consequence |
| --- | --- |
| No lint/CI at baseline (now fixed) | `npm run lint` and a CI workflow were added after the audit; the audit harnesses still need a database and are not in CI |
| Zero git commits | No immutable release or rollback revision exists |
| No browser E2E suite | UI flows are only covered by 12 jsdom tests and API-level checks |
| MySQL/MariaDB timezone must be UTC | The app forces UTC sessions; external tools writing local-time rows misalign scheduling |
| Free plan limits are 2 mailboxes / 1 domain | Matches the "Free" plan name but is far below the "create mailboxes for a team" expectation in `feature.md`; plan editing is missing |
| Worker runs `tsx` at runtime | Dev dependencies are required in production (`deploy.sh` installs them); moving to a compiled build would reduce the runtime surface |
