import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { lossClaimRoutes } from '../../src/routes/lossClaims'

const suffix = `manual-loss-cost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let storeId = ''
let userId = ''
let productId = ''
let app: ReturnType<typeof Fastify>

describe('store manual loss moving-average cost (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `报损成本测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const [store, supplier] = await Promise.all([
      prisma.store.create({ data: { tenantId, no: `STORE-${suffix}`, name: '报损成本门店' } }),
      prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '报损成本供应商' } }),
    ])
    storeId = store.id
    const user = await prisma.user.create({
      data: {
        tenantId, storeId, storeIds: [storeId], name: '报损厨师长',
        email: `${suffix}@local.test`, password: 'integration-test-only', role: 'KITCHEN_LEAD',
      },
    })
    userId = user.id
    const product = await prisma.product.create({
      data: {
        tenantId, supplierId: supplier.id, code: `${suffix}-P`, name: '低单位成本原料',
        category: '测试', unit: 'kg', inventoryUnit: 'g', inventoryUnitsPerPurchaseUnit: 1000,
        unitConversionStatus: 'VERIFIED', price: 5, stock: 0,
      },
    })
    productId = product.id
    await prisma.inventorySnapshot.create({
      data: {
        tenantId, storeId, snapshotDate: new Date('2026-07-18T00:00:00.000Z'),
        sourceFilename: '报损精度测试盘点', totalValue: 5, itemCount: 1, nonzeroCount: 1, zeroCount: 0, matchedCount: 1,
        items: {
          create: {
            productId, section: '测试', rawName: product.name, rawSpec: product.spec,
            unit: 'g', quantity: 1000, unitPrice: 0.005, amount: 5,
            normalizedQuantity: 1000, normalizedUnit: 'g', normalizationFactor: 1,
            normalizationStatus: 'EXACT', sortOrder: 0,
          },
        },
      },
    })

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId, storeId, storeIds: [storeId], userId, role: 'KITCHEN_LEAD' }
    })
    await app.register(lossClaimRoutes, { prefix: '/api/loss-claims' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.lossClaimItem.deleteMany({ where: { lossClaim: { tenantId } } })
    await prisma.lossClaim.deleteMany({ where: { tenantId } })
    await prisma.inventorySnapshotItem.deleteMany({ where: { snapshot: { tenantId } } })
    await prisma.inventorySnapshot.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('keeps sub-cent base-unit cost precise until the line amount is rounded', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/loss-claims/manual',
      payload: { items: [{ productId, quantity: 100 }], reason: '测试损耗' },
    })
    expect(response.statusCode).toBe(201)
    const claim = await prisma.lossClaim.findFirstOrThrow({
      where: { tenantId, storeId, isManual: true }, include: { items: true },
    })
    expect(claim.status).toBe('AUTO_APPROVED')
    expect(Number(claim.totalLossAmount)).toBe(0.5)
    expect(Number(claim.items[0].lossAmount)).toBe(0.5)
    expect(Number(claim.items[0].inventoryUnitCostSnapshot)).toBe(0.005)
    expect(Number(claim.items[0].inventoryQuantity)).toBe(100)
  })
})
