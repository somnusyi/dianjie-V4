import { PrismaClient } from '@prisma/client'

function assertSandboxDatabaseIsolation() {
  if (process.env.PREVIEW_MODE !== 'true' && process.env.SANDBOX_MODE !== 'true') return

  const raw = process.env.DATABASE_URL || ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('本地沙盒已拒绝启动：DATABASE_URL 缺失或格式不正确')
  }

  const database = decodeURIComponent(url.pathname.slice(1))
  const localHost = new Set(['localhost', '127.0.0.1', '::1']).has(url.hostname)
  if (!localHost || !database.includes('dianjie_v4_local')) {
    throw new Error(
      `本地沙盒已拒绝连接非本地数据库（host=${url.hostname || '空'}, database=${database || '空'}）`,
    )
  }
}

assertSandboxDatabaseIsolation()

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'error', 'warn']
      : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

export * from '@prisma/client'
