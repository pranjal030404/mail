# ARTHVEX Mail

Self-hosted, multi-tenant email control plane for **Stalwart Mail Server**. It manages customer
accounts, workspaces, domains (DNS ownership + diagnostics), mailboxes, aliases, quotas, built-in
webmail and platform administration.

The repository has two independent folders and no Docker requirement:

```
backend/    Fastify 5 API, background worker, MySQL/MariaDB migrations, docs, deploy templates
frontend/   React 19 + Vite single-page app (built to frontend/dist)
```

Requirements: Node.js >= 22.12, MySQL 8 or MariaDB 10.11+, and (for real mail) a reachable
Stalwart Mail Server. The application does not speak SMTP/IMAP itself.

## Development

```bash
# Backend
cd backend
cp .env.example .env          # set APP_ENCRYPTION_KEY, SESSION_SECRET and DB credentials
npm install
npm run db:start              # project-local MariaDB on 127.0.0.1:3307 (optional)
npm run db:migrate
npm run admin:create          # platform administrator from ADMIN_* in .env
npm run dev                   # http://127.0.0.1:4000

# Frontend (second terminal)
cd frontend
npm install
npm run dev                   # http://127.0.0.1:5173, proxies /api to :4000
```

No demo users, domains or mailboxes are seeded. Development mail is simulated and written to
`backend/var/dev-outbox`; production refuses the simulator.

## Production deployment (PM2, no Docker)

The deployment user runs the API and worker under PM2; Apache or nginx serves the built SPA and
proxies `/api` to loopback. MySQL is a normal local or managed service.

1. **Host and layout**

   ```bash
   sudo useradd --system --home /srv/arthvex --shell /sbin/nologin arthvex
   sudo mkdir -p /srv/arthvex /etc/arthvex /var/backups/arthvex
   sudo chown arthvex:arthvex /srv/arthvex /var/backups/arthvex
   # release the repository into /srv/arthvex (git clone or rsync)
   ```

2. **Database** (run as a MySQL administrator)

   ```sql
   CREATE DATABASE arthvex_email CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'arthvex_app'@'127.0.0.1' IDENTIFIED BY '<strong-password>';
   GRANT ALL PRIVILEGES ON arthvex_email.* TO 'arthvex_app'@'127.0.0.1';
   FLUSH PRIVILEGES;
   ```

3. **Configuration**

   ```bash
   sudo cp backend/.env.production.example /etc/arthvex/backend.env
   sudo chmod 600 /etc/arthvex/backend.env
   sudo chown root:arthvex /etc/arthvex/backend.env
   sudo -e /etc/arthvex/backend.env   # real domain, secrets, DB, Stalwart, SMTP
   ```

   Generate secrets with `openssl rand -base64 32` (encryption key) and
   `openssl rand -base64 48` (session secret). Production startup refuses `MAIL_ADAPTER=dev`,
   `MAILER=dev`, insecure cookies, test domains or a non-HTTPS `APP_BASE_URL`.

4. **Install, migrate, start**

   ```bash
   sudo -u arthvex -H bash
   cd /srv/arthvex/backend && npm ci
   cd /srv/arthvex/frontend && npm ci && npm run build
   cd /srv/arthvex/backend && set -a && . /etc/arthvex/backend.env && set +a
   npm run db:migrate
   npm run admin:create
   cd /srv/arthvex
   npm i -g pm2
   ENV_FILE=/etc/arthvex/backend.env pm2 start ecosystem.config.cjs --update-env
   pm2 save
   pm2 startup systemd -u arthvex --hp /srv/arthvex   # run the printed command once as root
   ```

5. **Web server**: use `backend/deploy/apache/arthvex.conf` (Apache 2.4) or an equivalent nginx
   vhost. DocumentRoot is `/srv/arthvex/frontend/dist`, `/api/` proxies to `http://127.0.0.1:4000`.
   Terminate TLS before enabling HSTS. Do not proxy Stalwart's management listener.

6. **Verify**

   ```bash
   curl -fsS http://127.0.0.1:4000/api/v1/health/ready
   ENV_FILE=/etc/arthvex/backend.env /srv/arthvex/backend/deploy/scripts/healthcheck.sh
   pm2 logs arthvex-api
   ```

   Then sign in at `https://<your-domain>/admin/login`.

Releases: `CONFIRM_DEPLOY=yes ENV_FILE=/etc/arthvex/backend.env backend/deploy/scripts/deploy-pm2.sh`.
Backups: `backend/deploy/scripts/backup.sh`; see `backend/docs/deployment.md` and
`backend/docs/backup-restore.md`.

> Real mail delivery also requires a public static IP with PTR, port 25 reachability, published
> MX/SPF/DKIM/DMARC and a configured Stalwart instance. See `backend/docs/production-readiness.md`.

## Checks

```bash
cd backend  && npm run typecheck && npm test && npm run lint
cd frontend && npm run typecheck && npm test && npm run lint && npm run build
```
# mail
