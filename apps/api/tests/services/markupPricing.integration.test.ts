import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { recordManualWarehouseInbound } from '../../src/services/warehouseLedger'

/**
 * 比例加价定价集成测试（2026-08-20 需求）：
 * 入库改变总仓库存移动均价 → MARKUP 商品卖价 = 均价 × 成本单位因子 × (1+比例) 自动写回，
 * 全程 opLog 留痕；FIXED 商品不动；商品未自填比例时继承分类默认。
 */
const suffix = `markup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let userId = ''
let markupProductId = ''
let fixedProductId = ''
let inheritProductId = ''

async function createProduct(name: string, pricing: {
  pricingMode?: string | null
  markupPercent?: number | null
}) {
  const product = await prisma.product.create({
    data: {
      tenantId,
      supplierId,
      code: `P-${suffix}-${name}`,
      name,
      category: '野生菌类',
      unit: '包',
      price: 999, // 初始占位价，入库后应被规则改写
      purchaseUnit: '包',
      orderUnit: '包',
      costUnit: '包',
      inventoryUnit: 'g',
      inventoryUnitsPerPurchaseUnit: 1000,
      inventoryUnitsPerOrderUnit: 1000,
      inventoryUnitsPerCostUnit: 1000,
      unitConversionStatus: 'VERIFIED',
      stock: 0,
      pricingMode: pricing.pricingMode ?? null,
      markupPercent: pricing.markupPercent ?? null,
    },
  })
  return product.id
}

describe('markup pricing (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `比例加价测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const supplier = await prisma.supplier.create({
      data: { tenantId, no: `MK-${suffix}`, name: '比例加价测试供应商', sourceType: 'HEADQ_WAREHOUSE' },
    })
    supplierId = supplier.id
    const user = await prisma.user.create({
      data: {
        tenantId,
        name: '比例加价测试员',
        email: `${suffix}@local.test`,
        password: 'integration-test-only',
        role: 'SUPPLY_CHAIN',
      },
    })
    userId = user.id
    // 分类默认比例 10%（供继承测试）
    await prisma.supplierProductCategory.create({
      data: { tenantId, supplierId, name: '野生菌类', defaultMarkupPercent: 10 },
    })
    markupProductId = await createProduct('加价菌', { pricingMode: 'MARKUP', markupPercent: 20 })
    fixedProductId = await createProduct('固定菌', { pricingMode: 'FIXED' })
    inheritProductId = await createProduct('继承菌', { pricingMode: 'MARKUP' }) // 不填比例 → 继承分类 10%
  })

  afterAll(async () => {
    if (!tenantId) return
    await prisma.warehouseLedgerLotAllocation.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerLot.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.supplierProductCategory.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.warehouse.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  it('入库后 MARKUP 商品按 均价×因子×(1+比例) 自动调价并留痕', async () => {
    // 入 10 包（10000g），总价 ¥500 → 均价 0.05/g；卖价 = 0.05×1000×1.2 = ¥60/包
    await recordManualWarehouseInbound({
      tenantId, userId, productId: markupProductId,
      purchaseQuantity: 10, totalAmount: 500,
      effectiveAt: new Date(), idempotencyKey: `mk-in-1-${suffix}`,
    })
    const product = await prisma.product.findUnique({ where: { id: markupProductId } })
    expect(Number(product!.price)).toBe(60)

    const log = await prisma.opLog.findFirst({
      where: { tenantId, entityType: 'Product', targetId: markupProductId },
      orderBy: { createdAt: 'desc' },
    })
    expect(log?.action).toContain('比例加价自动调价')
    expect(log?.action).toContain('999.00')
    expect(log?.action).toContain('60.00')
  })

  it('第二次入库价格变动 → 卖价跟随移动均价', async () => {
    // 再入 10 包总价 ¥700 → 总 20000g/¥1200 → 均价 0.06/g → 卖价 0.06×1000×1.2 = ¥72
    await recordManualWarehouseInbound({
      tenantId, userId, productId: markupProductId,
      purchaseQuantity: 10, totalAmount: 700,
      effectiveAt: new Date(), idempotencyKey: `mk-in-2-${suffix}`,
    })
    const product = await prisma.product.findUnique({ where: { id: markupProductId } })
    expect(Number(product!.price)).toBe(72)
  })

  it('FIXED 商品入库不改价', async () => {
    await recordManualWarehouseInbound({
      tenantId, userId, productId: fixedProductId,
      purchaseQuantity: 5, totalAmount: 250,
      effectiveAt: new Date(), idempotencyKey: `mk-in-3-${suffix}`,
    })
    const product = await prisma.product.findUnique({ where: { id: fixedProductId } })
    expect(Number(product!.price)).toBe(999)
  })

  it('商品未自填比例时继承分类默认 10%', async () => {
    // 入 4 包总价 ¥200 → 均价 0.05/g → 卖价 0.05×1000×1.1 = ¥55
    await recordManualWarehouseInbound({
      tenantId, userId, productId: inheritProductId,
      purchaseQuantity: 4, totalAmount: 200,
      effectiveAt: new Date(), idempotencyKey: `mk-in-4-${suffix}`,
    })
    const product = await prisma.product.findUnique({ where: { id: inheritProductId } })
    expect(Number(product!.price)).toBe(55)
  })

  it('价格与规则一致时安静跳过（幂等）', async () => {
    const before = await prisma.opLog.count({ where: { tenantId, entityType: 'Product', targetId: markupProductId } })
    // 同样的成本再入一次：均价不变 → 卖价不变 → 不产生新调价日志
    await recordManualWarehouseInbound({
      tenantId, userId, productId: markupProductId,
      purchaseQuantity: 10, totalAmount: 600, // 0.06/g，与当前均价一致
      effectiveAt: new Date(), idempotencyKey: `mk-in-5-${suffix}`,
    })
    const product = await prisma.product.findUnique({ where: { id: markupProductId } })
    expect(Number(product!.price)).toBe(72)
    const after = await prisma.opLog.count({ where: { tenantId, entityType: 'Product', targetId: markupProductId } })
    expect(after).toBe(before)
  })
})
