/**
 * 本地开发专用 · 瑶海测试租户 bootstrap
 *
 * 创建可重复的「测试租户 + 瑶海门店 + 店长测试账号」，供本地登录与功能验收。
 * 幂等：重复运行只 upsert，不产生重复数据。
 *
 * ⚠ 安全护栏（三重确认，任一不满足直接退出，绝不写库）：
 *   1. NODE_ENV 不能是 production
 *   2. PREVIEW_MODE 必须为 'true'
 *   3. DATABASE_URL 必须指向本地隔离库（含 'dianjie_v4_local'）
 * 不复制任何生产人员或真实凭据；密码为本地测试口令。
 *
 * Usage:
 *   pnpm --filter @dianjie/api exec tsx scripts/bootstrap-local-yaohai.ts
 */
import 'dotenv/config' // 加载 apps/api/.env（含 PREVIEW_MODE / PREVIEW_TENANT_SLUG）
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

// 与 apps/api/.env 的 PREVIEW_TENANT_SLUG 保持一致
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const TENANT_NAME = '瑶海测试（本地）'
const STORE_NO = 'YH001'
const STORE_NAME = '合肥瑶海店'

// 本地测试店长账号（非生产凭据）
const MANAGER_NAME = '瑶海店长（测试）'
const MANAGER_EMAIL = 'manager@yaohai.test'
const MANAGER_PHONE = '13800000001'
const MANAGER_PASSWORD = 'yaohai@123'

function assertLocalOnly() {
  const problems: string[] = []
  if (process.env.NODE_ENV === 'production') problems.push('NODE_ENV=production')
  if (process.env.PREVIEW_MODE !== 'true') problems.push("PREVIEW_MODE 未设为 'true'")
  const url = process.env.DATABASE_URL || ''
  if (!url.includes('dianjie_v4_local')) {
    problems.push('DATABASE_URL 不含 dianjie_v4_local（疑似非本地库）')
  }
  if (problems.length) {
    console.error('✋ 安全护栏拦截，拒绝写库：')
    for (const p of problems) console.error('   - ' + p)
    console.error('本脚本仅允许在本地隔离环境运行。')
    process.exit(1)
  }
}

async function main() {
  assertLocalOnly()

  const tenant = await prisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    update: { name: TENANT_NAME, status: 'ACTIVE' },
    create: { slug: TENANT_SLUG, name: TENANT_NAME, status: 'ACTIVE' },
  })

  const store = await prisma.store.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: STORE_NO } },
    update: { name: STORE_NAME, status: 'ENABLED' },
    create: { tenantId: tenant.id, no: STORE_NO, name: STORE_NAME, status: 'ENABLED' },
  })

  const passwordHash = await bcrypt.hash(MANAGER_PASSWORD, 10)
  const manager = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: MANAGER_EMAIL } },
    update: {
      name: MANAGER_NAME,
      phone: MANAGER_PHONE,
      password: passwordHash,
      role: 'MANAGER',
      status: 'ACTIVE',
      storeId: store.id,
      storeIds: [store.id],
    },
    create: {
      tenantId: tenant.id,
      name: MANAGER_NAME,
      email: MANAGER_EMAIL,
      phone: MANAGER_PHONE,
      password: passwordHash,
      role: 'MANAGER',
      status: 'ACTIVE',
      storeId: store.id,
      storeIds: [store.id],
    },
  })

  console.log('✅ 本地瑶海测试数据就绪：')
  console.log('   租户: %s  (slug=%s, id=%s)', tenant.name, tenant.slug, tenant.id)
  console.log('   门店: %s  (no=%s, id=%s)', store.name, store.no, store.id)
  console.log('   店长: %s  (id=%s)', manager.name, manager.id)
  console.log('')
  console.log('🔑 登录（/v2/login）：')
  console.log('   租户 slug : %s', TENANT_SLUG)
  console.log('   账号      : %s  或  %s', MANAGER_PHONE, MANAGER_EMAIL)
  console.log('   密码      : %s', MANAGER_PASSWORD)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
