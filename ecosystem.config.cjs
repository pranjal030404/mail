// PM2 process definitions for a no-Docker deployment.
//
//   cd /srv/arthvex
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup systemd -u arthvex --hp /srv/arthvex   # follow the printed command once
//
// Both processes run from backend/ and read backend/.env. In production put the real
// configuration in /etc/arthvex/backend.env and point ENV_FILE at it, or copy it to
// backend/.env (chmod 600). The frontend is a static build served by Apache/nginx, not by PM2.
const path = require('node:path');

const ROOT = __dirname;
const BACKEND = path.join(ROOT, 'backend');
const TSX = path.join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENV_FILE = process.env.ENV_FILE || '.env';

/** @param {string} name @param {string} entry */
function app(name, entry) {
  return {
    name,
    cwd: BACKEND,
    script: TSX,
    args: `--env-file-if-exists=${ENV_FILE} ${entry}`,
    interpreter: 'node',
    node_args: '--enable-source-maps',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 30000,
    max_memory_restart: '1G',
    time: true,
    env: { NODE_ENV: 'production' },
  };
}

module.exports = {
  apps: [app('arthvex-api', 'src/server.ts'), app('arthvex-worker', 'src/worker/index.ts')],
};
