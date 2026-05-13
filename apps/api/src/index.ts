// dotenv 必须在 Sentry / Prisma / 其他任何读 process.env 的 import 之前加载。
// 见 docs 事故记录：pm2 restart --update-env 会从 ecosystem.config.js 重刷
// env，如果 DATABASE_URL 不在那里就会被抹掉，API 启动即 PrismaClientInit
// 失败。让 tsx 启动时从 apps/api/.env 直接读，脱离对 pm2 传入 env 的依赖。
import 'dotenv/config'

import * as Sentry from '@sentry/node'

// Sentry 必须在其他 import 之前初始化
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.2,         // 采样 20% 的请求做性能追踪
    beforeSend(event) {
      // 过滤掉 4xx 业务错误，只上报 5xx 和未捕获异常
      if (event.exception?.values?.[0]?.value?.includes('statusCode')) return null
      return event
    },
  })
  console.log('📡 Sentry 监控已启用')
}

import Fastify from 'fastify'
import { prisma } from '@dianjie/db'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import { authRoutes } from './routes/auth'
import { publicApplyRoute, applicationRoutes } from './routes/applications'
import { inviteRoutes, inviteAcceptRoutes } from './routes/invites'
import { openingTaskRoutes } from './routes/openingTasks'
import { budgetRoutes } from './routes/budgets'
import { storeRoutes } from './routes/stores'
import { supplierRoutes } from './routes/suppliers'
import { productRoutes } from './routes/products'
import { supplierStockRoutes } from './routes/supplierStock'
import { supplierInsightRoutes } from './routes/supplierInsights'
import { financeReconcileRoutes } from './routes/financeReconcile'
import { receiptRoutes } from './routes/receipts'
import { reconciliationRoutes } from './routes/reconciliations'
import { paymentRoutes } from './routes/payments'
import { dashboardRoutes } from './routes/dashboard'
import { scheduleRoutes } from './routes/schedules'
import { logRoutes } from './routes/logs'
import { startScheduler } from './services/scheduler'
import { purchaseOrderRoutes } from './routes/orders'
import { registerIdempotency } from './lib/idempotency'
import { lossClaimRoutes } from './routes/lossClaims'
import { paymentRuleRoutes } from './routes/paymentRules'
import { revenueRoutes } from './routes/revenue'
import { userRoutes } from './routes/users'
import { inventoryRoutes } from './routes/inventory'
import { profitRoutes } from './routes/profit'
import { cashbookRoutes } from './routes/cashbook'
import { notificationRoutes } from './routes/notifications'
import { opsRoutes } from './routes/ops'
import { invoiceRoutes } from './routes/invoices'
import { invoicePaymentRoutes } from './routes/invoicePayments'
import { capitalRoutes } from './routes/capital'
import { v2DashboardRoutes } from './routes/v2Dashboard'
import { documentRoutes } from './routes/documents'
import multipart from '@fastify/multipart'
import { uploadRoutes } from './routes/upload'

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
})

async function bootstrap() {
  // ── 插件 ──────────────────────────────
  await app.register(helmet)
  await app.register(cors, {
    // 详见 docs/mobile/TECH_PLAN.md §5
    // 允许：
    //  - 配置的前端域名（FRONTEND_URL）
    //  - 本地开发：localhost:3000
    //  - Capacitor 原生：capacitor://localhost (iOS) / http://localhost (Android)
    //  - Tauri 桌面：tauri://localhost (Windows/Mac/Linux)
    //  - 生产 IP 和 dianjie.cc 域名（HTTP + HTTPS）
    origin: (origin, cb) => {
      // origin 为 undefined 表示同源、原生 fetch 或 curl，放行（受 JWT 鉴权保护）
      if (!origin) return cb(null, true)
      const allowed = new Set([
        process.env.FRONTEND_URL || 'http://localhost:3000',
        'http://localhost:3000',
        'capacitor://localhost',
        'http://localhost',
        'https://localhost',
        'tauri://localhost',
        'http://tauri.localhost',
        'https://tauri.localhost',
        'http://116.62.32.162',
        'https://116.62.32.162',
        'http://dianjie.cc',
        'https://dianjie.cc',
        'http://www.dianjie.cc',
        'https://www.dianjie.cc',
      ])
      if (allowed.has(origin)) return cb(null, true)
      // dianjie.cc 任意子域名
      if (/^https?:\/\/[a-z0-9-]+\.dianjie\.cc$/.test(origin)) {
        return cb(null, true)
      }
      // 局域网调试：允许 http://192.168.*.*:* 和 http://10.*.*.*:*
      if (/^https?:\/\/(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(origin)) {
        return cb(null, true)
      }
      cb(new Error(`CORS 拒绝: ${origin}`), false)
    },
    credentials: true,
  })
  await app.register(rateLimit, {
    max: process.env.NODE_ENV === 'test' ? 2000 : 200,
    timeWindow: '1 minute',
  })
  await app.register(jwt, {
    secret: process.env.JWT_SECRET || 'change_me_in_production',
  })

  // ── 认证装饰器 ────────────────────────
  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify()
    } catch (err) {
      reply.status(401).send({ error: '未授权，请先登录' })
    }
  })

  // ── 幂等中间件（双击/重试保护）──────────
  registerIdempotency(app)

  // ── 路由 ──────────────────────────────
  await app.register(authRoutes,           { prefix: '/api/auth' })
  await app.register(publicApplyRoute,     { prefix: '/api/auth' })
  await app.register(applicationRoutes,    { prefix: '/api/applications' })
  await app.register(inviteRoutes,         { prefix: '/api/invites' })
  await app.register(inviteAcceptRoutes,   { prefix: '/api/invite-accept' })
  await app.register(openingTaskRoutes,    { prefix: '/api/opening-tasks' })
  await app.register(budgetRoutes,         { prefix: '/api/budgets' })
  await app.register(dashboardRoutes,      { prefix: '/api/dashboard' })
  await app.register(storeRoutes,          { prefix: '/api/stores' })
  await app.register(supplierRoutes,       { prefix: '/api/suppliers' })
  await app.register(productRoutes,        { prefix: '/api/products' })
  await app.register(supplierStockRoutes,  { prefix: '/api/supplier/stock' })
  await app.register(supplierInsightRoutes, { prefix: '/api/supplier/insights' })
  await app.register(financeReconcileRoutes, { prefix: '/api/finance' })
  await app.register(receiptRoutes,        { prefix: '/api/receipts' })
  await app.register(reconciliationRoutes, { prefix: '/api/reconciliations' })
  await app.register(paymentRoutes,        { prefix: '/api/payments' })
  await app.register(scheduleRoutes,       { prefix: '/api/schedules' })
  await app.register(logRoutes,            { prefix: '/api/logs' })
  app.register(purchaseOrderRoutes, { prefix: '/api/orders' })
  app.register(lossClaimRoutes, { prefix: '/api/loss-claims' })
  app.register(paymentRuleRoutes, { prefix: '/api/payment-rules' })
  app.register(revenueRoutes, { prefix: '/api/revenue' })
  app.register(userRoutes,    { prefix: '/api/users' })
  app.register(inventoryRoutes, { prefix: '/api/inventory' })
  app.register(profitRoutes, { prefix: '/api/profit' })
  app.register(cashbookRoutes, { prefix: '/api/cashbook' })
  app.register(notificationRoutes, { prefix: '/api/notifications' })
  app.register(opsRoutes, { prefix: '/api/ops' })
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })
  app.register(uploadRoutes, { prefix: '/api' })
  app.register(invoiceRoutes, { prefix: '/api/invoices' })
  app.register(invoicePaymentRoutes, { prefix: '/api/invoice-payments' })
  app.register(capitalRoutes, { prefix: '/api/capital' })
  app.register(v2DashboardRoutes, { prefix: '/api/v2/dashboard' })
  app.register(documentRoutes, { prefix: '/api/documents' })

  // ── 健康检查（含数据库连接验证）──────
  app.get('/health', async () => {
    let db = 'ok'
    try {
      await prisma.$queryRaw`SELECT 1`
    } catch {
      db = 'error'
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version: '1.1.0',
      db,
    }
  })

  // ── 404 处理 ──────────────────────────
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: `路由不存在: ${request.url}` })
  })

  // ── 错误处理（含 Sentry 上报）────────
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error)
    if (error.validation) {
      return reply.status(400).send({ error: '请求参数错误', details: error.validation })
    }
    // 5xx 错误上报 Sentry
    const statusCode = error.statusCode || 500
    if (statusCode >= 500) {
      Sentry.captureException(error, {
        extra: { url: request.url, method: request.method, statusCode },
      })
    }
    reply.status(statusCode).send({
      error: error.message || '服务器内部错误',
    })
  })

  // ── 启动账期调度器 ────────────────────
  await startScheduler()

  // ── 监听 ──────────────────────────────
  const port = parseInt(process.env.API_PORT || '4000')
  const host = process.env.API_HOST || '0.0.0.0'

  await app.listen({ port, host })
  console.log(`\n🚀 API 服务启动成功`)
  console.log(`   本地地址: http://localhost:${port}`)
  console.log(`   健康检查: http://localhost:${port}/health\n`)

  // ── 优雅关闭 ──────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n⏹ 收到 ${signal}，正在优雅关闭...`)
    await app.close()
    await prisma.$disconnect()
    console.log('✅ 数据库连接已关闭，进程退出')
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

bootstrap().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
