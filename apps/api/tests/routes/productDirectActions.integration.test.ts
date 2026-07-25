import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'

const notificationMocks = vi.hoisted(() => ({
  productChange: vi.fn(),
  legacy: vi.fn(),
}))

vi.mock('../../src/services/notify/productChange', () => ({
  fireAndForgetNotifyProductChange: (...args: any[]) => notificationMocks.productChange(...args),
}))

vi.mock('../../src/services/notify', () => ({
  fireAndForget: (...args: any[]) => notificationMocks.legacy(...args),
}))

import { productRoutes } from '../../src/routes/products'

const suffix = `product-direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const codeSuffix = suffix.slice(-16)
let tenantAId = ''
let tenantBId = ''
let supplierAId = ''
let supplierBId = ''
let foreignSupplierId = ''
let supplyChainUserId = ''
let supplierUserId = ''
let chefUserId = ''
let app: ReturnType<typeof Fastify>

describe('internal supply-chain product actions (integration)', () => {
  beforeAll(async () => {
    const [tenantA, tenantB] = await Promise.all([
      prisma.tenant.create({ data: { name: `商品直生效 A ${suffix}`, slug: `${suffix}-a` } }),
      prisma.tenant.create({ data: { name: `商品直生效 B ${suffix}`, slug: `${suffix}-b` } }),
    ])
    tenantAId = tenantA.id
    tenantBId = tenantB.id

    const [supplierA, supplierB, foreignSupplier] = await Promise.all([
      prisma.supplier.create({ data: { tenantId: tenantAId, no: `A-${suffix}`, name: '直生效供应商 A' } }),
      prisma.supplier.create({ data: { tenantId: tenantAId, no: `B-${suffix}`, name: '直生效供应商 B' } }),
      prisma.supplier.create({ data: { tenantId: tenantBId, no: `F-${suffix}`, name: '外租户供应商' } }),
    ])
    supplierAId = supplierA.id
    supplierBId = supplierB.id
    foreignSupplierId = foreignSupplier.id

    await Promise.all([
      prisma.supplierProductCategory.create({
        data: { tenantId: tenantAId, supplierId: supplierAId, name: '蔬菜', sortOrder: 0 },
      }),
      prisma.supplierProductCategory.create({
        data: { tenantId: tenantAId, supplierId: supplierBId, name: '冻品', sortOrder: 0 },
      }),
    ])

    const [supplyChainUser, supplierUser, chefUser] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId: tenantAId,
          name: '内部供应链',
          email: `supply-chain-${suffix}@local.test`,
          password: 'integration-test-only',
          role: 'SUPPLY_CHAIN',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenantAId,
          supplierId: supplierAId,
          name: '外部供应商',
          email: `supplier-${suffix}@local.test`,
          password: 'integration-test-only',
          role: 'SUPPLIER_OWNER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenantAId,
          name: '总厨',
          email: `chef-${suffix}@local.test`,
          password: 'integration-test-only',
          role: 'CHEF_DIRECTOR',
        },
      }),
    ])
    supplyChainUserId = supplyChainUser.id
    supplierUserId = supplierUser.id
    chefUserId = chefUser.id

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || 'supply-chain')
      if (actor === 'supplier') {
        request.user = {
          tenantId: tenantAId,
          supplierId: supplierAId,
          userId: supplierUserId,
          role: 'SUPPLIER_OWNER',
        }
      } else if (actor === 'chef') {
        request.user = { tenantId: tenantAId, userId: chefUserId, role: 'CHEF_DIRECTOR' }
      } else {
        request.user = { tenantId: tenantAId, userId: supplyChainUserId, role: 'SUPPLY_CHAIN' }
      }
    })
    await app.register(productRoutes, { prefix: '/api/products' })
    await app.ready()
  })

  beforeEach(() => {
    notificationMocks.productChange.mockClear()
    notificationMocks.legacy.mockClear()
  })

  afterAll(async () => {
    if (app) await app.close()
    for (const tenantId of [tenantAId, tenantBId]) {
      if (!tenantId) continue
      await prisma.documentDecision.deleteMany({ where: { document: { tenantId } } })
      await prisma.documentStep.deleteMany({ where: { document: { tenantId } } })
      await prisma.document.deleteMany({ where: { tenantId } })
      await prisma.supplierStockBatchAllocation.deleteMany({ where: { tenantId } })
      await prisma.supplierStockBatch.deleteMany({ where: { tenantId } })
      await prisma.supplierStockMovement.deleteMany({ where: { tenantId } })
      await prisma.opLog.deleteMany({ where: { tenantId } })
      await prisma.businessSequence.deleteMany({ where: { tenantId } })
      await prisma.product.deleteMany({ where: { tenantId } })
      await prisma.productBatch.deleteMany({ where: { tenantId } })
      await prisma.supplierProductCategory.deleteMany({ where: { tenantId } })
      await prisma.user.deleteMany({ where: { tenantId } })
      await prisma.supplier.deleteMany({ where: { tenantId } })
      await prisma.tenant.delete({ where: { id: tenantId } })
    }
  })

  it('creates a final product, filters by supplier and rejects cross-tenant associations', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { 'x-test-actor': 'supply-chain' },
      payload: {
        code: `SC-C-${codeSuffix}`,
        name: '直生效白菜',
        category: '蔬菜',
        unit: '斤',
        price: 10,
        supplierId: supplierAId,
        status: 'PENDING_APPROVAL',
      },
    })
    expect(create.statusCode).toBe(201)
    expect(create.json()).toMatchObject({ status: 'ENABLED', supplierId: supplierAId })
    expect(await prisma.document.count({ where: { tenantId: tenantAId } })).toBe(0)
    expect(notificationMocks.productChange).toHaveBeenCalledTimes(1)

    const ownSupplier = await app.inject({
      method: 'GET',
      url: `/api/products?supplierId=${supplierAId}&page=1&pageSize=100`,
    })
    expect(ownSupplier.statusCode).toBe(200)
    expect(ownSupplier.json().items.map((item: any) => item.id)).toContain(create.json().id)

    const otherSupplier = await app.inject({
      method: 'GET',
      url: `/api/products?supplierId=${supplierBId}&page=1&pageSize=100`,
    })
    expect(otherSupplier.statusCode).toBe(200)
    expect(otherSupplier.json().items.map((item: any) => item.id)).not.toContain(create.json().id)

    const crossTenant = await app.inject({
      method: 'POST',
      url: '/api/products',
      payload: {
        code: `SC-F-${codeSuffix}`,
        name: '越权商品',
        unit: '斤',
        supplierId: foreignSupplierId,
      },
    })
    expect(crossTenant.statusCode).toBe(400)
    expect(await prisma.product.count({
      where: { tenantId: tenantAId, code: `SC-F-${codeSuffix}` },
    })).toBe(0)

    const chefCreate = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { 'x-test-actor': 'chef' },
      payload: { code: `CHEF-${codeSuffix}`, name: '总厨越权商品', unit: '斤' },
    })
    expect(chefCreate.statusCode).toBe(403)
  })

  it('applies price and status directly, makes immediate retries no-op and locks category scope', async () => {
    const product = await prisma.product.create({
      data: {
        tenantId: tenantAId,
        supplierId: supplierAId,
        code: `SC-P-${codeSuffix}`,
        name: '直生效土豆',
        category: '蔬菜',
        unit: '斤',
        price: 10,
        status: 'ENABLED',
      },
    })

    const price = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      payload: { price: 12 },
    })
    expect(price.statusCode).toBe(200)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).price)).toBe(12)
    expect(await prisma.document.count({ where: { tenantId: tenantAId } })).toBe(0)
    expect(notificationMocks.productChange).toHaveBeenCalledTimes(1)

    const replay = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      payload: { price: 12 },
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual({ count: 0, message: '商品已是目标状态' })
    expect(notificationMocks.productChange).toHaveBeenCalledTimes(1)
    expect(await prisma.opLog.count({ where: { tenantId: tenantAId, targetId: product.id } })).toBe(1)

    const pending = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      payload: { status: 'PENDING_DISABLE' },
    })
    expect(pending.statusCode).toBe(400)

    const wrongCategory = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      payload: { category: '冻品' },
    })
    expect(wrongCategory.statusCode).toBe(409)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).category).toBe('蔬菜')

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      payload: { status: 'DISABLED' },
    })
    expect(disable.statusCode).toBe(200)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe('DISABLED')
    expect(notificationMocks.productChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'DISABLE', tenantId: tenantAId, productId: product.id }),
    )
  })

  it('keeps external supplier create and disable approval semantics unchanged', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { 'x-test-actor': 'supplier' },
      payload: {
        code: `EXT-C-${codeSuffix}`,
        name: '外部供应商商品',
        category: '蔬菜',
        unit: '斤',
        price: 8,
      },
    })
    expect(create.statusCode).toBe(201)
    expect(create.json().status).toBe('PENDING_APPROVAL')
    expect(notificationMocks.productChange).not.toHaveBeenCalled()
    expect(await prisma.document.count({
      where: { tenantId: tenantAId, type: 'SUPPLIER_OFFER_CREATE' },
    })).toBe(1)

    const enabled = await prisma.product.create({
      data: {
        tenantId: tenantAId,
        supplierId: supplierAId,
        code: `EXT-D-${codeSuffix}`,
        name: '外部停售商品',
        category: '蔬菜',
        unit: '斤',
        price: 9,
        status: 'ENABLED',
      },
    })
    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/products/${enabled.id}`,
      headers: { 'x-test-actor': 'supplier' },
      payload: { status: 'DISABLED' },
    })
    expect(disable.statusCode).toBe(200)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: enabled.id } })).status).toBe('PENDING_DISABLE')
    expect(await prisma.document.count({
      where: { tenantId: tenantAId, type: 'SUPPLIER_OFFER_DISABLE' },
    })).toBe(1)
    expect(notificationMocks.productChange).not.toHaveBeenCalled()
  })
})
