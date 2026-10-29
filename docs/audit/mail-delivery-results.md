# Real email delivery results — ARTHVEX Mail

**Overall result: NOT VERIFIED.** No message was sent to or received from the public internet during
this audit. The environment contains no Stalwart instance, no public mail hostname, no DNS control, no
port 25 reachability and no external mailbox. Any claim of working internet mail would be false.

## Environment facts

| Requirement | Observed |
| --- | --- |
| Mail server | `MAIL_ADAPTER=dev` — file-backed simulator in `backend/var/dev-mail-engine/state.json` |
| Public hostname | `MAIL_HOSTNAME=mail.lab.test` (reserved test name) |
| Public IPv4 / PTR | None |
| DNS records | None published; `.example` test domains used by the audit harness |
| Port 25 inbound/outbound | Not tested; no host with a public IP is reachable from here |
| External mailbox | None |
| TLS certificates | None |
| Stalwart edition/licence | Not installed, so not validated |

Production configuration refuses the development stack (`assertSafeConfig`): `MAIL_ADAPTER=dev`,
`MAILER=dev`, missing admin MFA, insecure cookies, test domains and non-HTTPS origins all block startup.
That was verified by code review and by the configuration tests in `backend/src/config/env.test.ts`.

## What was verified (code and local behaviour only)

| Item | Result |
| --- | --- |
| Outbound path in the application | Webmail send calls JMAP `EmailSubmission/set` against Stalwart; the browser never holds SMTP or provider credentials |
| Mailbox-scoped credentials | Per-mailbox API keys are created through the Stalwart management API, encrypted with AES-256-GCM, and never returned to the browser |
| Development simulator refusal | Production startup rejects `MAIL_ADAPTER=dev` and `MAILER=dev` |
| Sender identity | `from` is taken from the mailbox record, not the request body; a spoofed `from` field in the compose payload was ignored |
| Sanitisation | Scripts, iframes and `javascript:` URLs removed; remote images blocked and counted |
| Attachment limits | Per-file and total limits enforced (10 MB default), executable extensions blocked, count capped |
| DNS plan generation | Stalwart adapter returns MX, SPF, DKIM and DMARC expectations from the engine; no real values exist to publish |
| Local mail-flow simulation | Messages are stored in the dev adapter and never leave the machine; this is explicitly labelled in the UI and API |

## Blocking gaps before any delivery claim

1. Provision a host with a static public IPv4 and correct PTR for the mail hostname.
2. Open inbound and outbound TCP 25 (provider may block outbound 25 by default), plus 465/993/443.
3. Publish MX, SPF, DKIM and DMARC for the sending domain; DMARC starts at `p=none` while validating.
4. Install and licence Stalwart; confirm the edition supports the required multi-tenancy and API-key
   features.
5. Configure TLS certificates for SMTP/IMAP/HTTP and verify with `openssl s_client`.
6. Run the acceptance test below with at least two independent providers.

## Required acceptance test (not executed)

| # | Test | Evidence to capture |
| --- | --- | --- |
| 1 | ARTHVEX mailbox → external provider | submission result, queue id, provider delivery status |
| 2 | External provider → ARTHVEX mailbox | MX delivery log, message in webmail/IMAP |
| 3 | Header authentication | `Authentication-Results` showing `spf=pass`, `dkim=pass`, `dmarc=pass` |
| 4 | PTR/hostname consistency | `dig -x <ip>` matches the SMTP banner |
| 5 | Spam placement | inbox vs spam at two providers, with the exact message ids |
| 6 | Bounce and retry | invalid recipient bounce received; temporary failure retried and delivered |
| 7 | Size and quota limits | over-size message rejected; over-quota mailbox refuses new mail |
| 8 | Abuse controls | unauthenticated relay attempt rejected; authenticated send rate limited |

Until every row above has captured evidence on the real host, the mail service must be described as
unverified. Nothing in this repository proves internet delivery.
