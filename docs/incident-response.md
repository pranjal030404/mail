# Incident response — ARTHVEX Mail

## Severity

| Level | Examples | First response |
| --- | --- | --- |
| SEV1 | Mail delivery stopped, data loss, credential compromise, open relay | Page on-call, contain, notify customers |
| SEV2 | Webmail down, provisioning failing broadly, DNS regression | On-call within 30 min |
| SEV3 | Single mailbox issue, stale usage, cosmetic admin defect | Next business day |

Never put passwords, tokens, MFA secrets or message content in tickets, chat or logs. Use correlation
ids and mailbox/tenant ids.

## Immediate containment

```bash
systemctl status arthvex-api arthvex-worker stalwart
curl -fsS http://127.0.0.1:4000/api/v1/health/ready
journalctl -u arthvex-api -u arthvex-worker --since '30 min ago' --no-pager | tail -200
ss -lntp | grep -E ':(25|465|993|443|4000)\b'
```

Suspected open relay or compromised mailbox: suspend the mailbox/tenant from the admin console (which
blocks SMTP auth and sending), then close the management port if exposed. Do not delete data before
preserving evidence.

## Runbook: outbound queue / delivery failure

1. Check Stalwart queue and logs (`journalctl -u stalwart`, queue metrics).
2. Verify port 25 outbound and PTR from the host.
3. Check DNS (SPF/DKIM/DMARC) for the affected domain in the domain diagnostics page.
4. Retry/reconcile from admin provisioning; inspect `provisioning_jobs` for stuck states.
5. If the provider blocked port 25, switch to the documented relay, update SPF with the relay's
   sender, and communicate the change; never silently change MX.

## Runbook: DNS failure after a change

1. Revert the record to the previous value; keep TTLs low during changes.
2. Re-run domain re-check and diagnostics; confirm MX and DKIM resolve from multiple resolvers.
3. Pending ownership re-checks resume automatically every 10 minutes; do not claim verification while
   DNS still returns the old value.

## Runbook: database or mail-store restore

Follow `docs/backup-restore.md`. Announce maintenance, stop services in the right order, verify the
backup checksum, restore, then verify with the healthcheck and a real mailbox login. If the encryption
key is lost, treat MFA secrets and webmail keys as compromised/invalid and force re-enrolment.

## Runbook: credential compromise

1. Revoke all platform-admin sessions (`/admin/admins/:id/revoke-sessions` or SQL) and rotate the
   Stalwart management credential.
2. Rotate `SESSION_SECRET` (invalidates all sessions) and, if the encryption key leaked, rotate
   `APP_ENCRYPTION_KEY` and plan re-enrolment.
3. Rotate SMTP credentials, database password and any API tokens.
4. Review `audit_logs` for the compromise window, including `admin.access_grant.*` and
   `admin.mailbox.read`.
5. Notify affected customers per policy; preserve logs.

## Runbook: exceptional access dispute

Export the grant row and all related audit entries (`admin.access_grant.request/approve/deny/use/expire/revoke`,
`admin.mailbox.read`) for the requested period. The audit log is append-only from the application's
perspective; do not edit it. Report retention and disclosure per `docs/security.md`.

## Service rollback

Stop API/worker, restore the previous release directory and its database backup, start services,
verify health. Application-only rollback is safe only when no destructive migration ran. Record the
decision and notify customers if mail was delayed.

## Post-incident

Write a short timeline, impact, root cause, what detected it, and follow-up actions with owners.
Update this runbook and add a regression test where possible.
