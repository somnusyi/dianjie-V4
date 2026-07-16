/**
 * 本地 dev DB 测试账号补全（按 ~/Desktop/dianjie-V4/测试账号清单.xlsx）
 *
 * - 手机号统一 13900000001-13900000008
 * - 密码必须通过 TEST_ACCOUNT_PASSWORD 显式提供（bcrypt）
 * - 已有 email 账号（admin@dianjie.com 等）→ 补 phone 字段
 * - 新角色（ENGINEERING / SUPPLIER_OWNER 等）→ 直接创建
 *
 * 跑法:
 *   PREVIEW_MODE=true ALLOW_TEST_ACCOUNT_SEED=true \
 *   DATABASE_URL=postgresql://.../dianjie_v4_local \
 *   TARGET_TENANT_SLUG=yaohai-test TEST_ACCOUNT_PASSWORD='<至少12位本地口令>' \
 *     pnpm --filter @dianjie/db exec tsx src/seed-v2-test-accounts.ts
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

function requiredTestPassword() {
  const databaseUrl = process.env.DATABASE_URL || ''
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.PREVIEW_MODE !== 'true' ||
    process.env.ALLOW_TEST_ACCOUNT_SEED !== 'true' ||
    !databaseUrl.includes('dianjie_v4_local')
  ) {
    throw new Error('安全护栏: 测试账号脚本仅允许显式授权的本地 PREVIEW_MODE 隔离库')
  }
  const password = process.env.TEST_ACCOUNT_PASSWORD || ''
  if (password.length < 12) throw new Error('安全护栏: TEST_ACCOUNT_PASSWORD 必须至少 12 位')
  return password
}

interface Account {
  phone: string
  name: string
  role: string
  storeNo?: string         // 店长/厨师长 绑店
  supplierNo?: string      // 供应商绑公司
  upgradeFromEmail?: string // 已有 email 账号补 phone 用
}

const ACCOUNTS: Account[] = [
  { phone: '13900000001', name: 'API测试账号',     role: 'SUPPLIER_OWNER',  supplierNo: 'SUP001' },
  { phone: '13900000002', name: '测试总厨',         role: 'CHEF_DIRECTOR' },
  { phone: '13900000003', name: '测试老板',         role: 'ADMIN',           upgradeFromEmail: 'admin@dianjie.com' },
  { phone: '13900000004', name: '测试店长',         role: 'MANAGER',         storeNo: 'DJ001' },
  { phone: '13900000005', name: '测试厨师长',       role: 'KITCHEN_LEAD',    storeNo: 'DJ001' },
  { phone: '13900000006', name: '测试财务',         role: 'FINANCE',         upgradeFromEmail: 'finance@dianjie.com' },
  { phone: '13900000007', name: '测试工程部',       role: 'ENGINEERING' },
  { phone: '13900000008', name: '测试供应商员工',   role: 'SUPPLIER_STAFF',  supplierNo: 'SUP001' },
]

async function main() {
  const password = requiredTestPassword()
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('补全 v2 UI 手机号登录测试账号 (xlsx 同步)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const targetSlug = process.env.TARGET_TENANT_SLUG?.trim()
  if (!targetSlug || !targetSlug.includes('test')) {
    console.error('❌ TARGET_TENANT_SLUG 必须显式指定测试租户（slug 必须包含 test）')
    process.exit(1)
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug: targetSlug } })
  if (!tenant) {
    console.error(`❌ 找不到测试租户 slug=${targetSlug}`)
    process.exit(1)
  }
  console.log(`目标测试租户: ${tenant.slug} (${tenant.id})`)

  // 保证至少一家门店（按 schema, store.no = 'DJ001'）
  let store = await prisma.store.findFirst({ where: { tenantId: tenant.id, no: 'DJ001' } })
  if (!store) {
    store = await prisma.store.create({
      data: {
        tenantId: tenant.id, no: 'DJ001', name: '合肥瑶海店',
        meituanShopId: 'DJ001_MT',
      },
    })
    console.log(`✓ 新建门店 ${store.name} (${store.no})`)
  }

  // 保证至少一家供应商
  let supplier = await prisma.supplier.findFirst({ where: { tenantId: tenant.id, no: 'SUP001' } })
  if (!supplier) {
    supplier = await prisma.supplier.create({
      data: { tenantId: tenant.id, no: 'SUP001', name: '南京捌拾捌号' },
    })
    console.log(`✓ 新建供应商 ${supplier.name} (${supplier.no})`)
  }

  const passwordHash = await bcrypt.hash(password, 10)

  for (const acc of ACCOUNTS) {
    const storeId = acc.storeNo === 'DJ001' ? store.id : null
    const supplierId = acc.supplierNo === 'SUP001' ? supplier.id : null

    // 1) 升级已有 email 账号 (补 phone + 密码统一)
    if (acc.upgradeFromEmail) {
      const found = await prisma.user.findFirst({
        where: { tenantId: tenant.id, email: acc.upgradeFromEmail },
      })
      if (found) {
        await prisma.user.update({
          where: { id: found.id },
          data: {
            phone: acc.phone,
            password: passwordHash,   // 改成统一密码
            name: acc.name,
          },
        })
        console.log(`✓ 升级 ${acc.upgradeFromEmail} → phone=${acc.phone}`)
        continue
      }
    }

    // 2) 用 phone 找现有的 (避免唯一约束冲突)
    const existing = await prisma.user.findFirst({
      where: { tenantId: tenant.id, phone: acc.phone },
    })
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          password: passwordHash,
          name: acc.name,
          role: acc.role as any,
          storeId, supplierId,
        },
      })
      console.log(`✓ 更新 ${acc.phone} ${acc.name} (${acc.role})`)
    } else {
      await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `${acc.phone}.${tenant.slug}@local.dev`, // 跨租户也保持全局唯一
          phone: acc.phone,
          name: acc.name,
          role: acc.role as any,
          password: passwordHash,
          storeId, supplierId,
        },
      })
      console.log(`✓ 创建 ${acc.phone} ${acc.name} (${acc.role})`)
    }
  }

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('登录方式: http://localhost:3200/v2/login')
  console.log('账号: 13900000001-13900000008')
  console.log('密码: 使用 TEST_ACCOUNT_PASSWORD 环境变量中提供的本地测试口令')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  await prisma.$disconnect()
}

main().catch(e => {
  console.error('FAILED:', e)
  prisma.$disconnect()
  process.exit(1)
})
