import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({
  receiptFindMany: vi.fn(),
  receiptItemFindMany: vi.fn(),
  productFindMany: vi.fn(),
  auditSupplyChain: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      receipt: { findMany: (...args: any[]) => mocks.receiptFindMany(...args) },
      receiptItem: { findMany: (...args: any[]) => mocks.receiptItemFindMany(...args) },
      product: { findMany: (...args: any[]) => mocks.productFindMany(...args) },
    },
  }
})

vi.mock('../../src/services/supplyChainAudit', () => ({
  auditSupplierSupplyChain: (...args: any[]) => mocks.auditSupplyChain(...args),
}))

import { supplierInsightRoutes } from '../../src/routes/supplierInsights'

const TENANT = 'tenant-insights'
const SUPPLIER = 'sup-insights'

function buildApp(user: Record<string, any>) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = user
  })
  return app.register(supplierInsightRoutes, { prefix: '/api/insights' })
}

const supplierUser = { tenantId: TENANT, supplierId: SUPPLIER, userId: 'u-sup', role: 'SUPPLIER_OWNER' }
const adminUser = { tenantId: TENANT, userId: 'u-admin', role: 'ADMIN' }

function verifiedProduct(overrides: Record<string, any> = {}) {
  return {
    id: 'prod-verified',
    name: '鲜松茸',
    unit: '斤',
    price: 0.02,
    purchaseUnit: '箱',
    inventoryUnit: 'g',
    orderUnit: '斤',
    costUnit: 'g',
    inventoryUnitsPerPurchaseUnit: 10000,
    inventoryUnitsPerOrderUnit: 500,
    inventoryUnitsPerCostUnit: 1,
    unitConversionStatus: 'VERIFIED',
    status: 'ENABLED',
    ...overrides,
  }
}

function pendingProduct(overrides: Record<string, any> = {}) {
  return verifiedProduct({
    id: 'prod-pending',
    name: '待核验松茸',
    unitConversionStatus: 'PENDING',
    ...overrides,
  })
}

describe('supplierInsights routes (unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.receiptFindMany.mockResolvedValue([])
    mocks.receiptItemFindMany.mockResolvedValue([])
    mocks.productFindMany.mockResolvedValue([])
    mocks.auditSupplyChain.mockResolvedValue({})
  })

  describe('auth scope', () => {
    it('ADMIN without supplierId → 400', async () => {
      const app = buildApp(adminUser)
      await app.ready()
      const res = await app.inject({ method: 'GET', url: '/api/insights/sku-rank' })
      await app.close()
      expect(res.statusCode).toBe(400)
    })

    it('ADMIN with supplierId → 200 and queries the requested supplier', async () => {
      const app = buildApp(adminUser)
      await app.ready()
      const res = await app.inject({
        method: 'GET',
        url: '/api/insights/sku-rank?supplierId=sup-target',
      })
      await app.close()
      expect(res.statusCode).toBe(200)

      const args = mocks.receiptItemFindMany.mock.calls[0][0]
      expect(args.where.receipt.supplierId).toBe('sup-target')
    })

    it('unknown role → 403', async () => {
      const app = buildApp({ tenantId: TENANT, userId: 'u-chef', role: 'CHEF_DIRECTOR' })
      await app.ready()
      const res = await app.inject({ method: 'GET', url: '/api/insights/sku-rank' })
      await app.close()
      expect(res.statusCode).toBe(403)
    })

    it('SUPPLIER_OWNER ignores query supplierId and uses bound supplierId', async () => {
      const app = buildApp(supplierUser)
      await app.ready()
      const res = await app.inject({
        method: 'GET',
        url: '/api/insights/sku-rank?supplierId=sup-other',
      })
      await app.close()
      expect(res.statusCode).toBe(200)

      const receiptItemArgs = mocks.receiptItemFindMany.mock.calls[0][0]
      expect(receiptItemArgs.where.receipt.supplierId).toBe(SUPPLIER)

      const productArgs = mocks.productFindMany.mock.calls[0][0]
      expect(productArgs.where.supplierId).toBe(SUPPLIER)
    })
  })

  describe('sku-rank: stale SKU pricing', () => {
    it('VERIFIED g→斤: 0.02 元/g × 500 g/斤 = 10 元/斤', async () => {
      const app = buildApp(supplierUser)
      mocks.productFindMany.mockResolvedValue([verifiedProduct()])
      await app.ready()
      const res = await app.inject({ method: 'GET', url: '/api/insights/sku-rank' })
      await app.close()

      expect(res.statusCode).toBe(200)
      const { bottom } = res.json()
      const hit = bottom.find((item: any) => item.productId === 'prod-verified')
      expect(hit).toBeDefined()
      expect(hit.orderUnitPrice).toBe(10)
      expect(hit.valuationStatus).toBe('VALUED')
      expect(hit.orderUnit).toBe('斤')
      expect(hit.costUnit).toBe('g')
    })

    it('PENDING conversion → orderUnitPrice null, valuationStatus PENDING', async () => {
      const app = buildApp(supplierUser)
      mocks.productFindMany.mockResolvedValue([pendingProduct()])
      await app.ready()
      const res = await app.inject({ method: 'GET', url: '/api/insights/sku-rank' })
      await app.close()

      const { bottom } = res.json()
      const hit = bottom.find((item: any) => item.productId === 'prod-pending')
      expect(hit).toBeDefined()
      expect(hit.orderUnitPrice).toBeNull()
      expect(hit.valuationStatus).toBe('PENDING')
    })

    it('bottom entries carry no legacy price field', async () => {
      const app = buildApp(supplierUser)
      mocks.productFindMany.mockResolvedValue([verifiedProduct(), pendingProduct()])
      await app.ready()
      const res = await app.inject({ method: 'GET', url: '/api/insights/sku-rank' })
      await app.close()

      const { bottom } = res.json()
      expect(bottom.length).toBeGreaterThanOrEqual(2)
      for (const item of bottom) {
        expect(item).not.toHaveProperty('price')
      }
    })
  })

  describe('sku-rank: hot-selling uses frozen snapshots', () => {
    it('uses snapshot name/unit and historical amount, not current Product fields', async () => {
      const app = buildApp(supplierUser)
      mocks.receiptItemFindMany.mockResolvedValue([
        {
          productId: 'prod-a',
          quantity: 10,
          amount: 100,
          productNameSnapshot: '入库时鲜菌',
          productUnitSnapshot: '斤',
          productCodeSnapshot: 'P001',
          productSpecSnapshot: null,
          productCategorySnapshot: '菌类',
          product: { name: '后来改名', unit: '箱', spec: null },
        },
      ])
      await app.ready()
      const res = await app.inject({ method: 'GET', url: '/api/insights/sku-rank' })
      await app.close()

      expect(res.statusCode).toBe(200)
      const { top } = res.json()
      expect(top).toHaveLength(1)
      expect(top[0].name).toBe('入库时鲜菌')
      expect(top[0].unit).toBe('斤')
      expect(top[0].qty).toBe(10)
      expect(top[0].amount).toBe(100)
      expect(top[0]).not.toHaveProperty('orderUnitPrice')
      expect(top[0]).not.toHaveProperty('valuationStatus')
    })

    it('Prisma where fixes CONFIRMED/ACCOUNTED status and deliveryDate', async () => {
      const app = buildApp(supplierUser)
      await app.ready()
      await app.inject({ method: 'GET', url: '/api/insights/sku-rank?days=30' })
      await app.close()

      const args = mocks.receiptItemFindMany.mock.calls[0][0]
      expect(args.where.receipt.status.in).toEqual(['CONFIRMED', 'ACCOUNTED'])
      expect(args.where.receipt.deliveryDate.gte).toBeInstanceOf(Date)
      expect(args.include.product.select).toEqual({
        name: true,
        unit: true,
        spec: true,
      })
      expect(args.include.product.select).not.toHaveProperty('price')
    })
  })

  describe('sku-rank: tenant/supplier isolation', () => {
    it('Prisma receiptItem.where fixes authenticated tenantId and supplierId', async () => {
      const app = buildApp(supplierUser)
      await app.ready()
      await app.inject({ method: 'GET', url: '/api/insights/sku-rank' })
      await app.close()

      const args = mocks.receiptItemFindMany.mock.calls[0][0]
      expect(args.where.receipt.tenantId).toBe(TENANT)
      expect(args.where.receipt.supplierId).toBe(SUPPLIER)
    })

    it('Prisma product.where fixes authenticated tenantId and supplierId', async () => {
      const app = buildApp(supplierUser)
      await app.ready()
      await app.inject({ method: 'GET', url: '/api/insights/sku-rank' })
      await app.close()

      const args = mocks.productFindMany.mock.calls[0][0]
      expect(args.where.tenantId).toBe(TENANT)
      expect(args.where.supplierId).toBe(SUPPLIER)
      expect(args.where.status).toBe('ENABLED')
    })

    it('query tenantId/supplierId cannot override the authenticated scope', async () => {
      const app = buildApp(supplierUser)
      await app.ready()
      const res = await app.inject({
        method: 'GET',
        url: '/api/insights/sku-rank?tenantId=tenant-other&supplierId=sup-other',
      })
      await app.close()

      expect(res.statusCode).toBe(200)

      const productArgs = mocks.productFindMany.mock.calls[0][0]
      expect(productArgs.where.tenantId).toBe(TENANT)
      expect(productArgs.where.supplierId).toBe(SUPPLIER)

      const receiptItemArgs = mocks.receiptItemFindMany.mock.calls[0][0]
      expect(receiptItemArgs.where.receipt.tenantId).toBe(TENANT)
      expect(receiptItemArgs.where.receipt.supplierId).toBe(SUPPLIER)
    })
  })
})
