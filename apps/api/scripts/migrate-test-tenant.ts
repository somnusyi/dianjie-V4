/**
 * 一次性迁移脚本: 把 8 个测试账号从 dianjie tenant 挪到独立的 test tenant
 *
 * 做了什么:
 *   1. 新建 tenant slug='test', name='滇界测试'
 *   2. 复制 dianjie tenant 的 Store / Supplier / Product 到 test tenant (新 ID)
 *   3. 8 个测试 user 的 tenantId 改为 test, email 改为短名 (boss/fin/mgr/...)
 *      并把 storeId / supplierId 指向新复制的资源
 *
 * 没做什么:
 *   - PurchaseOrder / Receipt / PaymentSchedule / Invoice / RevenueRecord 不复制
 *     (test tenant 业务流水从 0 开始, 测试者自己造)
 *   - dianjie tenant 数据完全不动 (17 个真实 user + 原 Store/Supplier/Product/PO/Receipt 全保留)
 *
 * 怎么跑:
 *   PROD_DATABASE_URL='postgresql://dianjie_v4:weiyi9216%21@pgm-bp14m7g69y66165r.pg.rds.aliyuncs.com:5432/dianjie_v4?connection_limit=3' \
 *     pnpm --filter @dianjie/api exec tsx scripts/migrate-test-tenant.ts
 *
 * 备份: pg_dump 已经在 /app/backups/before-tenant-split-20260514-145953.dump
 */
import { PrismaClient } from '@dianjie/db'

const SHORT_EMAILS: Record<string, string> = {
  '13900000001': 'sup1',
  '13900000002': 'cd',
  '13900000003': 'boss',
  '13900000004': 'mgr',
  '13900000005': 'chef',
  '13900000006': 'fin',
  '13900000007': 'eng',
  '13900000008': 'sup2',
}

async function main() {
  const url = process.env.PROD_DATABASE_URL
  if (!url) {
    console.error('❌ PROD_DATABASE_URL 未设置, 跑这种生产迁移必须显式传')
    process.exit(1)
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } } as any)

  try {
    await prisma.$transaction(async (tx) => {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('  生产 tenant 隔离迁移')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

      // 1. 找 dianjie tenant
      const dianjie = await tx.tenant.findUnique({ where: { slug: 'dianjie' } })
      if (!dianjie) throw new Error('找不到 slug=dianjie 的 tenant')
      console.log(`✓ 原 tenant: ${dianjie.id} (slug=${dianjie.slug}, name=${dianjie.name})`)

      // 1.5 防止重复跑: 如果已有 slug=test 直接退出
      const existsTest = await tx.tenant.findUnique({ where: { slug: 'test' } })
      if (existsTest) {
        throw new Error(`tenant slug=test 已存在 (id=${existsTest.id}), 不能重复跑迁移`)
      }

      // 2. 创建 test tenant
      const test = await tx.tenant.create({
        data: { slug: 'test', name: '滇界测试', status: 'ACTIVE' },
      })
      console.log(`✓ 新 tenant: ${test.id} (slug=test, name=滇界测试)\n`)

      // 3. 复制 Stores
      const origStores = await tx.store.findMany({ where: { tenantId: dianjie.id } })
      const storeMap: Record<string, string> = {}
      for (const s of origStores) {
        const { id, tenantId, createdAt, updatedAt, ...rest } = s as any
        const ns = await tx.store.create({ data: { ...rest, tenantId: test.id } })
        storeMap[id] = ns.id
        console.log(`  ✓ Store ${s.name} (${s.no}) → ${ns.id.slice(0, 8)}…`)
      }
      console.log(`✓ 复制 ${origStores.length} 个 Store\n`)

      // 4. 复制 Suppliers
      const origSuppliers = await tx.supplier.findMany({ where: { tenantId: dianjie.id } })
      const supMap: Record<string, string> = {}
      for (const s of origSuppliers) {
        const { id, tenantId, createdAt, updatedAt, ...rest } = s as any
        const ns = await tx.supplier.create({ data: { ...rest, tenantId: test.id } })
        supMap[id] = ns.id
        console.log(`  ✓ Supplier ${s.name} (${s.no}) → ${ns.id.slice(0, 8)}…`)
      }
      console.log(`✓ 复制 ${origSuppliers.length} 个 Supplier\n`)

      // 5. 复制 Products (映射 supplierId, batchId 设 null 避免跨 tenant 引用)
      const origProducts = await tx.product.findMany({ where: { tenantId: dianjie.id } })
      let pn = 0
      for (const p of origProducts) {
        const { id, tenantId, createdAt, updatedAt, supplierId, batchId, ...rest } = p as any
        await tx.product.create({
          data: {
            ...rest,
            tenantId: test.id,
            supplierId: supplierId ? (supMap[supplierId] || null) : null,
            batchId: null,
          },
        })
        pn++
      }
      console.log(`✓ 复制 ${pn} 个 Product\n`)

      // 6. 迁移 8 个测试 user
      console.log('迁移 8 个测试账号:')
      for (const [phone, shortEmail] of Object.entries(SHORT_EMAILS)) {
        const u = await tx.user.findUnique({
          where: { tenantId_phone: { tenantId: dianjie.id, phone } },
        })
        if (!u) {
          console.warn(`  ⚠ 跳过 ${phone}: 不存在`)
          continue
        }
        const newStoreId = u.storeId ? storeMap[u.storeId] || null : null
        const newSupplierId = u.supplierId ? supMap[u.supplierId] || null : null
        await tx.user.update({
          where: { id: u.id },
          data: {
            tenantId: test.id,
            email: shortEmail,
            storeId: newStoreId,
            supplierId: newSupplierId,
          },
        })
        console.log(`  ✓ ${phone} ${u.name.padEnd(8, ' ')} → email=${shortEmail}`
          + (newStoreId ? ` storeId=${newStoreId.slice(0, 8)}…` : '')
          + (newSupplierId ? ` supplierId=${newSupplierId.slice(0, 8)}…` : ''))
      }

      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('✅ 迁移完成 (事务即将 COMMIT)')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    }, { timeout: 120000, maxWait: 30000 }) // 318 个 Product 复制可能要 30s+
  } catch (e: any) {
    console.error('\n❌ 迁移失败, 事务已回滚:', e.message)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
