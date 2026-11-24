// PM2 process file for NSFWComix.
//
//   pm2 start scripts/deploy/ecosystem.config.cjs     first start
//   pm2 sendSignal SIGHUP nsfwcomix                    zero-downtime reload after a deploy
//   pm2 restart nsfwcomix --update-env                 full restart (after changing .env or this file)
//   pm2 save && pm2 startup                           start again after a reboot
//
// PM2 supervises one launcher (cluster.mjs). The launcher runs WEB_CONCURRENCY
// copies of `node api/src/server.ts` on the same port with node:cluster and
// makes sure exactly one of them runs the background jobs: every other copy is
// started with NO_JOBS=1. PM2's built-in cluster mode cannot be used here
// because it does not run server.ts as the main module (see cluster.mjs).
//
// Secrets (DATABASE_URL, APP_SECRET, CRON_SECRET ...) are NOT in this file.
// They live in /path/to/nsfwcomix/.env on the server, which is never committed.
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

module.exports = {
  apps: [
    {
      name: 'nsfwcomix',
      cwd: root,
      script: 'scripts/deploy/cluster.mjs',
      interpreter: 'node',
      // Node reads .env itself; nothing secret passes through PM2's dump file.
      node_args: '--env-file-if-exists=.env',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      // The launcher stops its workers gracefully; give it time before PM2 kills it.
      kill_timeout: 30000,
      // Restart-loop containment: after 10 fast crashes PM2 marks the app
      // "errored" instead of spinning forever and starving the box.
      max_restarts: 10,
      min_uptime: '15s',
      restart_delay: 5000,
      // PORT (default 4000) and WEB_CONCURRENCY (how many API processes; default
      // 4, or the number of CPU cores if lower) come from .env. Values set here
      // would win over .env, so only NODE_ENV is. Each API process holds up to
      // 20 Postgres connections: keep WEB_CONCURRENCY * 20 well under
      // max_connections (default 100).
      env: {
        NODE_ENV: 'production',
      },
      out_file: '/var/log/pm2/nsfwcomix-out.log',
      error_file: '/var/log/pm2/nsfwcomix-error.log',
      merge_logs: true,
      time: false, // the API logs carry their own timestamps
    },
  ],
};
