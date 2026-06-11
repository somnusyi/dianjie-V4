// ══════════════════════════════════════════════════════
// 滇界云管 V4 · PM2 生产配置
// 部署位置: /app/dianjie-v4/ecosystem.config.cjs  (生产，由 deploy.sh 同步)
//
// 端口拓扑：
//   dianjie-v4-api  :4004  (Fastify, /api/*)
//   dianjie-v4-web  :3204  (Next standalone)
//   dianjie-v4-cmb  :5001  (Flask 招行国密微服务, 只对内 localhost)
//
// 对外: nginx :8080 → :4004 + :3204；:5001 仅 localhost
//
// 敏感信息从 /app/dianjie-v4/.env 读取，此文件不含密码
// ══════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      name: 'dianjie-v4-api',
      cwd: '/app/dianjie-v4/apps/api',
      script: 'dist/index.js',
      env_file: '/app/dianjie-v4/.env',
      env: { PORT: '4004', API_PORT: '4004' },
      node_args: '--experimental-require-module',
      // 600M: 上传时整文件 buffer 进内存, 50MB 视频 concat 瞬时 ~2x, 给足余量 (2026-06)
      max_memory_restart: '600M',
      exec_mode: 'fork',
      out_file: '/var/log/pm2/dianjie-v4-api.out.log',
      error_file: '/var/log/pm2/dianjie-v4-api.err.log',
    },
    {
      name: 'dianjie-v4-web',
      cwd: '/app/dianjie-v4/apps/web/apps/web',
      script: 'server.js',
      env_file: '/app/dianjie-v4/.env',
      env: { PORT: '3204', HOSTNAME: '0.0.0.0' },
      max_memory_restart: '400M',
      exec_mode: 'fork',
      out_file: '/var/log/pm2/dianjie-v4-web.out.log',
      error_file: '/var/log/pm2/dianjie-v4-web.err.log',
    },
    {
      // 招行新直联（免前置）国密 HTTP 微服务
      // 文档: docs/cmb/2026-05-13-招行BB1PAY-报文规范.md
      // 仅暴露 localhost，cmbPayment.ts 通过 http://localhost:5001 调
      name: 'dianjie-v4-cmb',
      cwd: '/app/dianjie-v4/apps/cmb',
      script: 'python3',
      args: 'app.py',
      interpreter: 'none',                // PM2 不要再次嵌套 node 解释器
      env_file: '/app/dianjie-v4/.env',
      env: { CMB_SERVICE_PORT: '5001' },
      max_memory_restart: '256M',
      exec_mode: 'fork',
      out_file: '/var/log/pm2/dianjie-v4-cmb.out.log',
      error_file: '/var/log/pm2/dianjie-v4-cmb.err.log',
      // Python 进程崩溃 5 秒内重启
      restart_delay: 5000,
    },
  ],
}
