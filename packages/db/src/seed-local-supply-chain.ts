/** 本地沙盒专用的内部供应链账号。严禁对生产库运行。 */
import { PrismaClient, Role } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

function requireLocalSandbox() {
  const raw = process.env.DATABASE_URL || ''
  const phone = process.env.LOCAL_SUPPLY_CHAIN_PHONE?.trim() || ''
  const password = process.env.LOCAL_SUPPLY_CHAIN_PASSWORD || ''
  const tenantSlug = process.env.LOCAL_TENANT_SLUG?.trim() || 'dianjie'

  let url: URL
  try { url = new URL(raw) } catch { throw new Error('DATABASE_URL 格式不正确') }
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.PREVIEW_MODE !== 'true' ||
    !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
    !database.includes('dianjie_v4_local')
  ) {
    throw new Error('安全护栏：只允许在本机 dianjie_v4_local 预览库创建沙盒账号')
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('LOCAL_SUPPLY_CHAIN_PHONE 必须是 11 位手机号')
  if (password.length < 6 || password.length > 72) throw new Error('LOCAL_SUPPLY_CHAIN_PASSWORD 必须为 6-72 位')
  return { phone, password, tenantSlug }
}

async function main() {
  const { phone, password, tenantSlug } = requireLocalSandbox()
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } })
  if (!tenant) throw new Error(`找不到本地租户 slug=${tenantSlug}，请先同步或初始化数据`)

  const passwordHash = await bcrypt.hash(password, 12)
  const existing = await prisma.user.findUnique({
    where: { tenantId_phone: { tenantId: tenant.id, phone } },
  })
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          name: '本地供应链沙盒', role: Role.SUPPLY_CHAIN, status: 'ACTIVE',
          password: passwordHash, supplierId: null, storeId: null, storeIds: [], authVersion: { increment: 1 },
        },
      })
    : await prisma.user.create({
        data: {
          tenantId: tenant.id, name: '本地供应链沙盒', phone,
          email: `local-supply-chain-${phone}@sandbox.invalid`, password: passwordHash,
          role: Role.SUPPLY_CHAIN, status: 'ACTIVE', storeIds: [],
        },
      })

  console.log(JSON.stringify({ ok: true, userId: user.id, phone, role: user.role, tenantSlug }))
}

main()
  .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
