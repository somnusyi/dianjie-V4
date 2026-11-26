// Parse only this deployment's environment; PM2 does not load env_file.
const { readFileSync } = require('node:fs')
const { parseEnv } = require('node:util')
const deploymentEnv = parseEnv(readFileSync('/app/dianjie-v4-uat/.env', 'utf8'))

module.exports = {
  apps: [
    {
      name: 'dianjie-v4-uat-api',
      cwd: '/app/dianjie-v4-uat/apps/api',
      script: 'dist/index.js',
      env: { ...deploymentEnv, PORT: '4005', API_PORT: '4005' },
      node_args: '--experimental-require-module',
      max_memory_restart: '500M',
      restart_delay: 3000,
      exec_mode: 'fork',
      autorestart: true,
      min_uptime: 10000,
      max_restarts: 10,
      kill_timeout: 10000,
      out_file: '/var/log/pm2/dianjie-v4-uat-api.out.log',
      error_file: '/var/log/pm2/dianjie-v4-uat-api.err.log',
    },
    {
      name: 'dianjie-v4-uat-web',
      cwd: '/app/dianjie-v4-uat/apps/web/apps/web',
      script: 'server.js',
      env: { ...deploymentEnv, PORT: '3205', HOSTNAME: '127.0.0.1' },
      max_memory_restart: '350M',
      restart_delay: 3000,
      exec_mode: 'fork',
      autorestart: true,
      min_uptime: 10000,
      max_restarts: 10,
      kill_timeout: 10000,
      out_file: '/var/log/pm2/dianjie-v4-uat-web.out.log',
      error_file: '/var/log/pm2/dianjie-v4-uat-web.err.log',
    },
  ],
}
