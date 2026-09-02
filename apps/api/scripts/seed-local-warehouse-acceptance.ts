/**
 * 本机沙盒专用：为总仓入库/出库/盘点验收准备可重复执行的主数据。
 * 不写流水；业务流水必须通过 API 生成，以便验证真实逻辑。
 */
import { prisma } from '@dianjie/db'

const DATABASE_URL = process.env.DATABASE_URL || ''
const TENANT_SLUG = process.env.LOCAL_TENANT_SLUG || 'dianjie'
const ACCOUNT_PHONE = process.env.LOCAL_SUPPLY_CHAIN_PHONE || ''

function assertLocalSandbox() {
  let url: URL
  try { url = new URL(DATABASE_URL) } catch { throw new Error('DATABASE_URL 格式不正确') }
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.PREVIEW_MODE !== 'true' ||
    !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
    !database.includes('dianjie_v4_local')
  ) throw new Error('安全护栏：仅允许在 localhost/dianjie_v4_local 预览库执行')
  if (!/^1[3-9]\d{9}$/.test(ACCOUNT_PHONE)) throw new Error('请显式提供 LOCAL_SUPPLY_CHAIN_PHONE')
}

const PRODUCTS = [
  { code: 'TEST-WH-RICE', name: '【测试】东北大米', spec: '25kg/袋', category: '米面粮油', unit: '袋', purchaseUnit: '袋', inventoryUnit: 'kg', orderUnit: '袋', costUnit: 'kg', purchaseFactor: 25, orderFactor: 25, costFactor: 1, price: 150 },
  { code: 'TEST-WH-OIL', name: '【测试】菜籽油', spec: '12瓶×1L/箱', category: '米面粮油', unit: '箱', purchaseUnit: '箱', inventoryUnit: '瓶', orderUnit: '瓶', costUnit: '瓶', purchaseFactor: 12, orderFactor: 1, costFactor: 1, price: 168 },
  { code: 'TEST-WH-BEEF', name: '【测试】冷鲜牛肉', spec: '1kg/包', category: '肉禽', unit: 'kg', purchaseUnit: 'kg', inventoryUnit: 'g', orderUnit: '斤', costUnit: 'kg', purchaseFactor: 1000, orderFactor: 500, costFactor: 1000, price: 68 },
  { code: 'TEST-WH-EGGS', name: '【测试】鸡蛋', spec: '20盒/箱', category: '肉禽', unit: '箱', purchaseUnit: '箱', inventoryUnit: '盒', orderUnit: '盒', costUnit: '盒', purchaseFactor: 20, orderFactor: 1, costFactor: 1, price: 120 },
  { code: 'TEST-WH-SODA', name: '【测试】苏打水', spec: '24瓶×330ml/件', category: '酒水', unit: '件', purchaseUnit: '件', inventoryUnit: '瓶', orderUnit: '瓶', costUnit: '瓶', purchaseFactor: 24, orderFactor: 1, costFactor: 1, price: 72 },
  { code: 'TEST-WH-MUSHROOM', name: '【测试】鲜菌拼盘', spec: '500g/盒', category: '菌菇', unit: '件', purchaseUnit: '件', inventoryUnit: '盒', orderUnit: '盒', costUnit: '盒', purchaseFactor: 8, orderFactor: 1, costFactor: 1, price: 96 },
] as const

async function main() {
  assertLocalSandbox()
  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } })
  if (!tenant) throw new Error(`本地租户不存在: ${TENANT_SLUG}`)
  const user = await prisma.user.findUnique({ where: { tenantId_phone: { tenantId: tenant.id, phone: ACCOUNT_PHONE } } })
  if (!user || user.role !== 'SUPPLY_CHAIN') throw new Error('找不到本地 SUPPLY_CHAIN 测试账号')
  const warehouse = await prisma.warehouse.findFirst({ where: { tenantId: tenant.id, isDefault: true, isActive: true } })
  if (!warehouse) throw new Error('本地租户没有启用的默认总仓')

  const supplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'TEST-UP-001' } },
    update: { name: '【测试】总仓上游供应商', status: 'ENABLED', businessScopes: ['WAREHOUSE_UPSTREAM'] },
    create: {
      tenantId: tenant.id, no: 'TEST-UP-001', name: '【测试】总仓上游供应商',
      contactName: '测试联系人', contactPhone: '13900009991', category: '总仓测试',
      status: 'ENABLED', businessScopes: ['WAREHOUSE_UPSTREAM'],
    },
  })

  const productIds: string[] = []
  for (const input of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: input.code } },
      update: {
        name: input.name, spec: input.spec, category: input.category, unit: input.unit,
        purchaseUnit: input.purchaseUnit, inventoryUnit: input.inventoryUnit,
        orderUnit: input.orderUnit, costUnit: input.costUnit,
        inventoryUnitsPerPurchaseUnit: input.purchaseFactor,
        inventoryUnitsPerOrderUnit: input.orderFactor,
        inventoryUnitsPerCostUnit: input.costFactor,
        unitConversionStatus: 'VERIFIED', unitConversionNote: '本机验收夹具',
        unitConversionVerifiedAt: new Date(), price: input.price, status: 'ENABLED', shelfDays: 30,
      },
      create: {
        tenantId: tenant.id, code: input.code, name: input.name, spec: input.spec,
        category: input.category, unit: input.unit, purchaseUnit: input.purchaseUnit,
        inventoryUnit: input.inventoryUnit, orderUnit: input.orderUnit, costUnit: input.costUnit,
        inventoryUnitsPerPurchaseUnit: input.purchaseFactor,
        inventoryUnitsPerOrderUnit: input.orderFactor,
        inventoryUnitsPerCostUnit: input.costFactor,
        unitConversionStatus: 'VERIFIED', unitConversionNote: '本机验收夹具',
        unitConversionVerifiedAt: new Date(), price: input.price, status: 'ENABLED', shelfDays: 30,
      },
    })
    productIds.push(product.id)
    await prisma.productUpstreamSource.upsert({
      where: { tenantId_productId_supplierId: { tenantId: tenant.id, productId: product.id, supplierId: supplier.id } },
      update: {
        isPrimary: true, isActive: true, purchaseUnit: input.purchaseUnit,
        inventoryUnitsPerPurchaseUnit: input.purchaseFactor, quotedUnitPrice: input.price,
      },
      create: {
        tenantId: tenant.id, productId: product.id, supplierId: supplier.id,
        isPrimary: true, isActive: true, supplierSku: `UP-${input.code}`,
        purchaseUnit: input.purchaseUnit, inventoryUnitsPerPurchaseUnit: input.purchaseFactor,
        quotedUnitPrice: input.price,
      },
    })
  }

  // 负例：必须被候选商品接口排除，用来验证整单原子回滚。
  const pending = await prisma.product.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: 'TEST-WH-PENDING' } },
    update: { name: '【测试】单位待核验商品', status: 'ENABLED', unitConversionStatus: 'PENDING' },
    create: {
      tenantId: tenant.id, code: 'TEST-WH-PENDING', name: '【测试】单位待核验商品',
      category: '测试负例', unit: '件', purchaseUnit: '件', inventoryUnit: '件', orderUnit: '件', costUnit: '件',
      inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1,
      unitConversionStatus: 'PENDING', price: 10, status: 'ENABLED',
    },
  })

  console.log(JSON.stringify({
    ok: true, tenantSlug: tenant.slug, userId: user.id, warehouseId: warehouse.id,
    supplier: { id: supplier.id, no: supplier.no }, productIds, pendingProductId: pending.id,
  }))
}

main()
  .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
