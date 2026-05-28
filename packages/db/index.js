// CommonJS 入口 — 给生产 node (dist/index.js require 时用)
// dev 模式跑 tsx 仍走 src/index.ts (types 字段保持指向 src 让 TS 提示完整)
//
// 历史: 2026-05-28 部署同事 meituan 接入时, dist/services/meituan/cron.js
// 通过 require("@dianjie/db") 加载到此包, 旧 main "./src/index.ts" 让 node
// ESM-parse .ts 抛 SyntaxError: Unexpected identifier 'as'. 加这个 CJS 入口
// 后 node 直接走 .js, 不再触发 .ts 解析路径.

const { PrismaClient } = require('@prisma/client')

const globalForPrisma = globalThis

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'error', 'warn']
      : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

module.exports = {
  prisma,
  ...require('@prisma/client'),
}
