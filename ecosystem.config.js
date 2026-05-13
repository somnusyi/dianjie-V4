// ══════════════════════════════════════════════════════
// 滇界云管 · PM2 生产配置
// 敏感信息从 .env 读取，此文件不含密码
// ══════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      name: 'dianjie-api',
      cwd: '/app/dianjie/apps/api',
      script: 'npx',
      args: 'tsx src/index.ts',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      error_file: '/var/log/dianjie/api-error.log',
      out_file: '/var/log/dianjie/api-out.log',
      merge_logs: true,
      kill_timeout: 5000,
      listen_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        API_PORT: '4000',
        API_HOST: '0.0.0.0',
      },
    },
    {
      name: 'dianjie-web',
      cwd: '/app/dianjie/apps/web',
      script: 'npx',
      args: 'next start -p 3000',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      error_file: '/var/log/dianjie/web-error.log',
      out_file: '/var/log/dianjie/web-out.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
