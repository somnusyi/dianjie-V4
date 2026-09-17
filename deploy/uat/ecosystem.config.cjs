module.exports = {
  apps: [
    {
      name: 'dianjie-v4-uat-api',
      cwd: '/app/dianjie-v4-uat/apps/api',
      script: 'dist/index.js',
      env_file: '/app/dianjie-v4-uat/.env',
      env: { PORT: '4005', API_PORT: '4005' },
      node_args: '--experimental-require-module',
      max_memory_restart: '500M',
      exec_mode: 'fork',
      out_file: '/var/log/pm2/dianjie-v4-uat-api.out.log',
      error_file: '/var/log/pm2/dianjie-v4-uat-api.err.log',
    },
    {
      name: 'dianjie-v4-uat-web',
      cwd: '/app/dianjie-v4-uat/apps/web/apps/web',
      script: 'server.js',
      env_file: '/app/dianjie-v4-uat/.env',
      env: { PORT: '3205', HOSTNAME: '127.0.0.1' },
      max_memory_restart: '350M',
      exec_mode: 'fork',
      out_file: '/var/log/pm2/dianjie-v4-uat-web.out.log',
      error_file: '/var/log/pm2/dianjie-v4-uat-web.err.log',
    },
  ],
}
