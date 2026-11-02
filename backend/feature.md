# ARTHVEX Email — Features

Free, open-source (MIT), multi-tenant control plane for business and personal email on your own domain. It drives a **Stalwart Mail Server** through an adapter; it does not implement SMTP/IMAP itself.

## 1. Accounts and sign-in
- Open registration (admin can switch to invite-only or closed in Settings); optional invitation code
- Email verification, resend verification email
- Sign in / sign out, forgot and reset password, change password
- Show/hide (eye) button on password fields
- Two-factor authentication (TOTP authenticator app) with recovery codes; enable, confirm, disable
- Active session list, revoke one session, "sign out everywhere else"
- Profile (name, timezone, locale)
- Notifications inbox and per-event notification preferences

## 2. Workspaces (companies and individuals)
- Create a company or personal workspace (limit per user is configurable)
- Switch between workspaces
- Roles: **owner**, **admin**, **mailbox user**
- Members: invite by email, change role, remove; accept-invitation link
- Workspace rename and settings

## 3. Domains (bring your own domain)
- Add a domain to a workspace
- Ownership verification by DNS TXT token; rotate token; re-verify
- Automatic background re-check of pending ownership
- DNS diagnostics for mail records (MX, SPF, DKIM, DMARC) with recommended records to copy
- Periodic DNS re-check of mail records
- Removal-impact preview before deleting a domain; delete domain
- Reconcile a domain with the mail server

## 4. Mailboxes
- Create mailboxes on a verified domain
- Per-mailbox quota; edit mailbox
- Reset credentials (one-time password reveal)
- Suspend / reactivate
- Delete with a grace period and **cancel deletion**
- Email-client setup page: IMAP, SMTP (SSL and STARTTLS), JMAP and webmail details with copy buttons

## 5. Aliases and forwarding
- Create and delete aliases per domain
- External forwarding with recipient confirmation link
- Catch-all (plan-controlled)

## 6. Usage and limits
- Usage dashboard: domains, mailboxes, aliases, storage vs. plan limits
- Usage history and automatic collection every 5 minutes
- Warning thresholds at 75 / 90 / 100 %
- Plans with limits for domains, mailboxes, aliases, quotas, attachment size, daily/hourly send limits

## 7. Support and abuse
- Support tickets with message threads (customer side)
- Public abuse-report form
- In-app notifications and email notifications

## 8. Super admin (platform administrator)
Separate admin account type and table, sign-in at `/admin`. Never a customer user.
- **Overview:** active/suspended tenants, verified domains, mailboxes, failed provisioning, open abuse reports and tickets, storage; service health (database, mail engine, workers, notifications)
- **Tenants:** list, view detail, suspend / reactivate, edit quotas
- **Mailboxes:** suspend / reactivate any mailbox
- **Provisioning:** view jobs, retry / cancel failed jobs
- **Abuse:** review and resolve reports
- **Support:** view all tickets and reply
- **Users & invites:** list customer users, suspend, revoke sessions; create signup invitations; list and suspend other admins
- **Settings:** signup mode (open / invite-only / closed), maintenance mode and message, default plan, mailbox deletion grace days, max workspaces per user, mailbox-creation rule, terms version
- **Plans:** view the plan catalogue
- **Audit log:** every sensitive action recorded with the actor and reason
- Admin roles: `super_admin` and `operations`; admin MFA can be required (mandatory in production)
- Create/update the admin with `npm run admin:create`

## 9. Background worker
- Provisioning job queue with leases and retries
- Scheduled deletions, ownership rechecks, usage collection, DNS recheck, mail-server reconciliation, cleanup
- Worker heartbeat shown on the admin overview

## 10. Mail engine and delivery
- Stalwart adapter (production) and a development simulator (no real mail)
- SMTP mailer for platform notifications; development file outbox
- Development-mode banner on the admin overview when mail is simulated

## 11. Security and operations
- Argon2 password hashing, encrypted secrets, cookie sessions with CSRF protection
- Rate limiting, account lockout, session revocation
- Production safety checks (refuses to start with dev mail, insecure cookies, no HTTPS, no admin MFA, or test domains)
- Health endpoints: `/health`, `/health/ready`
- Backup and restore-test tracking (stale-backup warning shown in production)
- Database migrations (`db:migrate`, `db:rollback`) and dev seed data

## 12. Public site
- Landing, features, setup guide, plans and limits, security, help
- Privacy, acceptable use, terms, report abuse
- Responsive React + Vite frontend with accessibility basics (skip link, labelled fields)

## Not included yet
- Real internet mail flow without a configured Stalwart server
- Built-in webmail UI (links to your webmail URL)
- Billing or payments (the platform is free)
- Legal review of the policy pages
