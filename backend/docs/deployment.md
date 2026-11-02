# Deployment — ARTHVEX Mail

Status: **templates and procedures only.** Nothing in this document has been applied to a production
VPS. Do not restart services, change firewall rules, overwrite Apache vhosts, or move MX records
without explicit operator authorization and a verified rollback.

## 1. Inventory before touching the shared host

Record answers in the change ticket:

```bash
cat /etc/os-release; nproc; free -h; df -h; ip -brief addr
systemctl list-units --type=service --state=running
apachectl -S; ls -l /etc/apache2/sites-enabled
ss -lntp | grep -E ':(25|80|443|465|993|3306|4000)\b'
mysql -e "SHOW DATABASES; SELECT user,host FROM mysql.user;"
lsblk; ls -la /var/lib/stalwart /var/log/stalwart 2>/dev/null
```

Do not proceed if an existing mail service already owns ports 25/465/993 or if Apache configuration
cannot be added without replacing an existing site.

## 2. Install layout

```
/srv/arthvex/                 application (owned by arthvex)
  backend/                    API + worker
  frontend/dist/              built SPA (Apache DocumentRoot)
  deploy/                     templates/scripts from this repository
/etc/arthvex/backend.env      secrets, 0600 root:arthvex
/etc/apache2/sites-available/arthvex.conf
/etc/systemd/system/arthvex-api.service
/etc/systemd/system/arthvex-worker.service
/var/backups/arthvex/          backups, 0700
```

## 3. Steps (each one reversible)

1. **Create the service user** `arthvex` with no shell login and no sudo.
2. **Clone/release** the repo into `/srv/arthvex`; run `npm ci` and `npm run build`.
3. **Database**: create a dedicated database and a least-privilege user
   (`SELECT, INSERT, UPDATE, DELETE` on that schema; migrations additionally need DDL — run migrations
   with an owner account, not the runtime account, and consider separate migrate credentials).
4. **Environment**: copy `backend/.env.example` to `/etc/arthvex/backend.env`, fill real values,
   `chmod 600`, `chown root:arthvex`. Generate secrets with `openssl rand -base64 32` and
   `openssl rand -base64 48`. Set `NODE_ENV=production`, `COOKIE_SECURE=true`, `APP_BASE_URL=https://…`,
   `ADMIN_MFA_REQUIRED=true`, `MAIL_ADAPTER=stalwart`, `MAILER=smtp`.
5. **Migrate**: `npm run db:migrate` after a verified backup. Then `npm run admin:create` once for the
   platform administrator.
6. **Stalwart**: install/verify separately. Bind JMAP/management to loopback or a private interface;
   never publish the setup wizard. Confirm edition/licence and that the management account holds
   `impersonate` and `sysApiKey*` (needed for per-mailbox webmail keys).
7. **Process manager** — choose one, not both:
   - **systemd**: copy the unit templates, adjust paths/user, `systemctl daemon-reload`,
     `systemctl enable --now arthvex-api arthvex-worker`. Verify `journalctl -u arthvex-api -f`.
   - **PM2** (no Docker, no unit files): run as the `arthvex` user from `/srv/arthvex`:
     ```bash
     npm i -g pm2
     cd /srv/arthvex
     ENV_FILE=/etc/arthvex/backend.env pm2 start ecosystem.config.cjs --update-env
     pm2 save
     pm2 startup systemd -u arthvex --hp /srv/arthvex   # run the printed command once as root
     pm2 logs arthvex-api                               # verify startup
     ```
     `ecosystem.config.cjs` runs the API and worker from `backend/`, sets `NODE_ENV=production`, and
     reads the env file named by `ENV_FILE` (default `backend/.env`). The SPA is still served as
     static files by Apache/nginx, not PM2. Use `deploy/scripts/deploy-pm2.sh` for releases.
8. **Apache**: add a NEW vhost from `deploy/apache/arthvex.conf`, run `apachectl configtest`, then
   `systemctl reload apache2` on Debian/Ubuntu or `systemctl reload httpd` on Fedora/RHEL (reload, not
   restart, to avoid dropping unrelated sites). On Fedora the vhost goes in `/etc/httpd/conf.d/`, the
   log directory is `/var/log/httpd`, and the modules are `mod_ssl mod_proxy mod_proxy_http
   mod_headers mod_rewrite`. Obtain a certificate (certbot) before enabling HSTS.
9. **Firewall**: allow 80/443 publicly, 25/465/993 only if this host is the mail host, and keep the
   management port closed. Do not flush existing rules; add scoped rules.
10. **Health**: `./deploy/scripts/healthcheck.sh`; confirm `/api/v1/health/ready`, worker heartbeat,
    admin dashboard service rows (mail engine, webmail, workers, notifications).
11. **Backups**: install the systemd timer/cron for `deploy/scripts/backup.sh` and schedule
    `restore-test.sh` weekly. Pre-create the restore schema once and grant the runtime user access to
    it, otherwise the restore test cannot run with least-privilege credentials:
    `CREATE DATABASE arthvex_restore_test CHARACTER SET utf8mb4;` then
    `GRANT ALL PRIVILEGES ON arthvex_restore_test.* TO 'arthvex_app'@'127.0.0.1';`.
    Never enable production until at least one restore test passes. The backup script detects
    MariaDB vs MySQL and only passes MySQL-specific dump options to MySQL.

## 4. Mail host specifics

- Confirm static IP, PTR, port 25 inbound/outbound, disk capacity and provider AUP (see
  `docs/dns-setup.md`). If port 25 is blocked, use an authenticated relay and document the SPF/DKIM
  implications; do not claim direct delivery.
- TLS for SMTP/IMAP must be valid before clients connect. Verify with
  `openssl s_client -starttls smtp -connect mail.example.com:25`.
- Do not change customer MX until inbound mail is tested and a rollback MX with lowered TTL is ready.

## 5. Upgrade and rollback

- Upgrade (systemd): `CONFIRM_DEPLOY=yes ./deploy/scripts/deploy.sh` (backs up, tests, migrates,
  restarts, verifies). Review migrations manually first.
- Upgrade (PM2): `CONFIRM_DEPLOY=yes ./deploy/scripts/deploy-pm2.sh` as the PM2 owner.
- Rollback: stop services, restore the pre-deploy database dump and previous release directory,
  start services, verify health. Application rollback without a database restore only works when the
  new migrations are backward compatible; they are not guaranteed to be.
- Never run `db:rollback` on production data without a verified backup; DDL is not transactional.

## 6. Blockers to state honestly

- No production host inventory was performed.
- No Stalwart edition/licence verification was performed.
- No public IP/PTR/port-25/DNS access was available.
- No deployment was executed. The templates above are unapplied.
