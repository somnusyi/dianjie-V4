import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({
  productCreate: vi.fn(),
  productUpdate: vi.fn(),
  productUpdateMany: vi.fn(),
  productFindFirst: vi.fn(),
  productFindUniqueOrThrow: vi.fn(),
  supplierFindFirst: vi.fn(),
  supplierProductCategoryFindUnique: vi.fn(),
  supplierProductCategoryAggregate: vi.fn(),
  supplierProductCategoryCreateMany: vi.fn(),
  supplierStockMovementCreate: vi.fn(),
  createSupplierStockBatchIncrease: vi.fn(),
  opLogCreate: vi.fn(),
  documentCreate: vi.fn(),
  nextDocumentNo: vi.fn(),
  notifyProductChange: vi.fn(),
  fireAndForget: vi.fn(),
  getSupplierReservedStock: vi.fn(),
  stockAvailability: vi.fn(),
  signOssKey: vi.fn(),
  invalidatePattern: vi.fn(),
  cached: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
}))

vi.mock('@dianjie/db', () => {
  const prismaMock: any = {
    $transaction: vi.fn(async (fn: any) => fn(prismaMock)),
    $executeRaw: mocks.executeRaw,
    $queryRaw: mocks.queryRaw,
    product: {
      create: (...args: any[]) => mocks.productCreate(...args),
      update: (...args: any[]) => mocks.productUpdate(...args),
      updateMany: (...args: any[]) => mocks.productUpdateMany(...args),
      findFirst: (...args: any[]) => mocks.productFindFirst(...args),
      findUniqueOrThrow: (...args: any[]) => mocks.productFindUniqueOrThrow(...args),
    },
    supplier: {
      findFirst: (...args: any[]) => mocks.supplierFindFirst(...args),
    },
    supplierProductCategory: {
      findUnique: (...args: any[]) => mocks.supplierProductCategoryFindUnique(...args),
      aggregate: (...args: any[]) => mocks.supplierProductCategoryAggregate(...args),
      createMany: (...args: any[]) => mocks.supplierProductCategoryCreateMany(...args),
    },
    supplierStockMovement: {
      create: (...args: any[]) => mocks.supplierStockMovementCreate(...args),
    },
    opLog: {
      create: (...args: any[]) => mocks.opLogCreate(...args),
    },
    document: {
      create: (...args: any[]) => mocks.documentCreate(...args),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  }
  return { prisma: prismaMock }
})

vi.mock('../../src/services/notify/productChange', () => ({
  fireAndForgetNotifyProductChange: (...args: any[]) => mocks.notifyProductChange(...args),
}))

vi.mock('../../src/services/notify', () => ({
  fireAndForget: (...args: any[]) => mocks.fireAndForget(...args),
}))

vi.mock('../../src/services/supplierStockBatch', () => ({
  createSupplierStockBatchIncrease: (...args: any[]) => mocks.createSupplierStockBatchIncrease(...args),
}))

vi.mock('../../src/services/documentNo', () => ({
  nextDocumentNo: () => mocks.nextDocumentNo(),
}))

vi.mock('../../src/lib/cache', () => ({
  cached: (key: string, _ttl: number, fn: () => any) => mocks.cached(key, _ttl, fn),
  invalidatePattern: (...args: any[]) => mocks.invalidatePattern(...args),
}))

vi.mock('../../src/services/supplierStockReservation', () => ({
  getSupplierReservedStock: (...args: any[]) => mocks.getSupplierReservedStock(...args),
  stockAvailability: (stock: number, reserved: number) => mocks.stockAvailability(stock, reserved),
}))

vi.mock('../../src/routes/upload', () => ({
  signOssKey: (key: string | null) => mocks.signOssKey(key),
}))

import { productRoutes } from '../../src/routes/products'

const tenantId = 'tenant-direct'
const otherTenantId = 'tenant-other'
const supplierId = 'supplier-direct'
const otherSupplierId = 'supplier-other'
const supplyChainUserId = 'user-sc'
const supplierUserId = 'user-supplier'
const productId = 'product-direct'

function createdProduct(overrides: Record<string, any> = {}) {
  return {
    id: productId,
    tenantId,
    supplierId: overrides.supplierId ?? null,
    code: overrides.code ?? 'SC-001',
    name: overrides.name ?? '白菜',
    spec: overrides.spec ?? null,
    category: overrides.category ?? '蔬菜',
    unit: overrides.unit ?? '斤',
    price: overrides.price ?? 10,
    stock: overrides.stock ?? 0,
    status: overrides.status ?? 'ENABLED',
    imageKey: overrides.imageKey ?? null,
    ...overrides,
  }
}

function beforeProduct(overrides: Record<string, any> = {}) {
  return {
    id: productId,
    tenantId,
    supplierId: overrides.supplierId ?? supplierId,
    code: 'SC-001',
    name: '白菜',
    spec: null,
    category: '蔬菜',
    imageKey: null,
    unit: '斤',
    inventoryUnit: null,
    inventoryUnitsPerPurchaseUnit: null,
    unitConversionStatus: 'PENDING',
    unitConversionNote: null,
    unitConversionVerifiedAt: null,
    price: 10,
    minOrderQty: 1,
    stepQty: 1,
    shelfDays: 7,
    status: 'ENABLED',
    shipUpperPct: 1.10,
    shipUpperBuffer: 5,
    ...overrides,
  }
}

describe('product direct actions (SUPPLY_CHAIN)', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || 'supply-chain')
      const map: Record<string, any> = {
        'supply-chain': { tenantId, userId: supplyChainUserId, role: 'SUPPLY_CHAIN' },
        'supplier': { tenantId, supplierId, userId: supplierUserId, role: 'SUPPLIER_OWNER' },
        'chef': { tenantId, userId: 'user-chef', role: 'CHEF_DIRECTOR' },
      }
      request.user = map[actor] || { tenantId, userId: actor, role: actor }
    })
    await app.register(productRoutes, { prefix: '/api/products' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.executeRaw.mockResolvedValue([])
    mocks.queryRaw.mockResolvedValue([])
    mocks.cached.mockImplementation((_key: string, _ttl: number, fn: () => any) => fn())
    mocks.signOssKey.mockImplementation((key: string | null) => (key ? `signed:${key}` : null))
    mocks.stockAvailability.mockImplementation((stock: number, reserved: number) => ({ available: stock - reserved }))
  })

  describe('CREATE', () => {
    it('SUPPLY_CHAIN creates product in final ENABLED status and notifies chef', async () => {
      mocks.supplierFindFirst.mockResolvedValue({ id: supplierId, name: '测试供应商' })
      mocks.supplierProductCategoryFindUnique.mockResolvedValue({ isActive: true })
      mocks.productCreate.mockResolvedValue(createdProduct({ supplierId, status: 'ENABLED' }))
      mocks.opLogCreate.mockResolvedValue({})

      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: { 'x-test-actor': 'supply-chain' },
        payload: {
          code: 'SC-001',
          name: '白菜',
          category: '蔬菜',
          unit: '斤',
          price: 10,
          supplierId,
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.status).toBe('ENABLED')
      expect(mocks.documentCreate).not.toHaveBeenCalled()
      expect(mocks.productCreate).toHaveBeenCalledTimes(1)
      const createData = mocks.productCreate.mock.calls[0][0].data
      expect(createData.tenantId).toBe(tenantId)
      expect(createData.supplierId).toBe(supplierId)
      expect(createData.status).toBe('ENABLED')

      expect(mocks.notifyProductChange).toHaveBeenCalledTimes(1)
      const notification = mocks.notifyProductChange.mock.calls[0][0]
      expect(notification).toMatchObject({
        tenantId,
        productId,
        action: 'CREATE',
        operatorId: supplyChainUserId,
        before: {},
      })
      expect(notification.eventKey).toMatch(/^PRODUCT:product-direct:CREATE:user-sc:[a-f0-9]{16}$/)
      expect(notification.after).toMatchObject({
        name: '白菜',
        code: 'SC-001',
        category: '蔬菜',
        unit: '斤',
        price: 10,
        status: 'ENABLED',
        supplierName: '测试供应商',
      })
    })

    it('SUPPLY_CHAIN cannot create product with supplier from another tenant', async () => {
      mocks.supplierFindFirst.mockResolvedValue(null)

      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: { 'x-test-actor': 'supply-chain' },
        payload: { code: 'SC-002', name: '白菜', unit: '斤', supplierId: otherSupplierId },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('供应商不存在或不属于当前租户')
      expect(mocks.productCreate).not.toHaveBeenCalled()
      expect(mocks.notifyProductChange).not.toHaveBeenCalled()
    })

    it('SUPPLY_CHAIN cannot create product with category outside supplier', async () => {
      mocks.supplierFindFirst.mockResolvedValue({ id: supplierId, name: '测试供应商' })
      mocks.supplierProductCategoryFindUnique.mockResolvedValue(null)

      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: { 'x-test-actor': 'supply-chain' },
        payload: { code: 'SC-003', name: '白菜', unit: '斤', supplierId, category: '不存在的分类' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('分类')
      expect(mocks.productCreate).not.toHaveBeenCalled()
      expect(mocks.notifyProductChange).not.toHaveBeenCalled()
    })

    it('SUPPLIER_OWNER create still goes through approval workflow', async () => {
      mocks.supplierFindFirst.mockResolvedValue({ id: supplierId, name: '测试供应商' })
      mocks.supplierProductCategoryFindUnique.mockResolvedValue({ isActive: true })
      mocks.productCreate.mockResolvedValue(createdProduct({ supplierId, status: 'PENDING_APPROVAL' }))
      mocks.nextDocumentNo.mockResolvedValue('DOC-1')
      mocks.documentCreate.mockResolvedValue({ no: 'DOC-1' })
      mocks.opLogCreate.mockResolvedValue({})

      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: { 'x-test-actor': 'supplier' },
        payload: { code: 'SUP-001', name: '白菜', unit: '斤', category: '蔬菜' },
      })

      expect(response.statusCode).toBe(201)
      expect(mocks.productCreate).toHaveBeenCalledTimes(1)
      expect(mocks.productCreate.mock.calls[0][0].data.status).toBe('PENDING_APPROVAL')
      expect(mocks.documentCreate).toHaveBeenCalledTimes(1)
      expect(mocks.notifyProductChange).not.toHaveBeenCalled()
      expect(mocks.fireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVAL_PENDING' }),
      )
    })

    it('does not send notification when transaction fails', async () => {
      mocks.supplierFindFirst.mockResolvedValue({ id: supplierId, name: '测试供应商' })
      mocks.supplierProductCategoryFindUnique.mockResolvedValue({ isActive: true })
      mocks.productCreate.mockRejectedValue(new Error('test-only db failure'))

      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: { 'x-test-actor': 'supply-chain' },
        payload: { code: 'SC-FAIL', name: '白菜', unit: '斤', supplierId, category: '蔬菜' },
      })

      expect(response.statusCode).toBe(500)
      expect(mocks.notifyProductChange).not.toHaveBeenCalled()
    })
  })

  describe('UPDATE', () => {
    it('SUPPLY_CHAIN edits product directly and sends UPDATE notification', async () => {
      mocks.productFindFirst.mockResolvedValue(beforeProduct())
      mocks.productUpdate.mockResolvedValue({ ...beforeProduct(), name: '大白菜' })
      mocks.opLogCreate.mockResolvedValue({})

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/products/${productId}`,
        headers: { 'x-test-actor': 'supply-chain' },
        payload: { name: '大白菜' },
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.productUpdate).toHaveBeenCalledTimes(1)
      expect(mocks.documentCreate).not.toHaveBeenCalled()
      expect(mocks.notifyProductChange).toHaveBeenCalledTimes(1)
      const notification = mocks.notifyProductChange.mock.calls[0][0]
      expect(notification.action).toBe('UPDATE')
      expect(notification.operatorId).toBe(supplyChainUserId)
      expect(notification.before).toMatchObject({ name: '白菜' })
      expect(notification.after).toMatchObject({ name: '大白菜' })
      expect(notification.eventKey).toMatch(/^PRODUCT:product-direct:UPDATE:user-sc:[a-f0-9]{16}$/)
    })

    it('SUPPLY_CHAIN price change is direct and sends PRICE_CHANGE notification', async () => {
      mocks.productFindFirst.mockResolvedValue(beforeProduct())
      mocks.productUpdate.mockResolvedValue({ ...beforeProduct(), price: 12 })
      mocks.opLogCreate.mockResolvedValue({})

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/products/${productId}`,
        headers: { 'x-test-actor': 'supply-chain' },
        payload: { price: 12 },
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.documentCreate).not.toHaveBeenCalled()
      const notification = mocks.notifyProductChange.mock.calls[0][0]
      expect(notification.action).toBe('PRICE_CHANGE')
      expect(notification.before.price).toBe(10)
      expect(notification.after.price).toBe(12)
    })

    it('SUPPLY_CHAIN disables product directly and sends DISABLE notification', async () => {
      mocks.productFindFirst.mockResolvedValue(beforeProduct())
      mocks.productUpdate.mockResolvedValue({ ...beforeProduct(), status: 'DISABLED' })
      mocks.opLogCreate.mockResolvedValue({})

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/products/${productId}`,
        headers: { 'x-test-actor': 'supply-chain' },
        payload: { status: 'DISABLED' },
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.documentCreate).not.toHaveBeenCalled()
      const notification = mocks.notifyProductChange.mock.calls[0][0]
      expect(notification.action).toBe('DISABLE')
      expect(notification.before.status).toBe('ENABLED')
      expect(notification.after.status).toBe('DISABLED')
    })

    it('SUPPLY_CHAIN enables product directly and sends ENABLE notification', async () => {
      mocks.productFindFirst.mockResolvedValue(beforeProduct({ status: 'DISABLED' }))
      mocks.productUpdate.mockResolvedValue({ ...beforeProduct(), status: 'ENABLED' })
      mocks.opLogCreate.mockResolvedValue({})

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/products/${productId}`,
        headers: { 'x-test-actor': 'supply-chain' },
        payload: { status: 'ENABLED' },
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.documentCreate).not.toHaveBeenCalled()
      const notification = mocks.notifyProductChange.mock.calls[0][0]
      expect(notification.action).toBe('ENABLE')
      expect(notification.before.status).toBe('DISABLED')
      expect(notification.after.status).toBe('ENABLED')
    })

    it('repeated PATCH with same body produces the same eventKey', async () => {
      mocks.productFindFirst.mockResolvedValue(beforeProduct())
      mocks.productUpdate.mockResolvedValue({ ...beforeProduct(), price: 12 })
      mocks.opLogCreate.mockResolvedValue({})

      const payload = { price: 12 }
      await app.inject({
        method: 'PATCH',
        url: `/api/products/${productId}`,
        headers: { 'x-test-actor': 'supply-chain' },
        payload,
      })
      await app.inject({
        method: 'PATCH',
        url: `/api/products/${productId}`,
        headers: { 'x-test-actor': 'supply-chain' },
        payload,
      })

      expect(mocks.notifyProductChange).toHaveBeenCalledTimes(2)
      expect(mocks.notifyProductChange.mock.calls[0][0].eventKey)
        .toBe(mocks.notifyProductChange.mock.calls[1][0].eventKey)
    })

    it('SUPPLIER_OWNER disable still creates an approval document', async () => {
      mocks.productFindFirst.mockResolvedValue(beforeProduct())
      mocks.productUpdateMany.mockResolvedValue({ count: 1 })
      mocks.nextDocumentNo.mockResolvedValue('DOC-2')
      mocks.documentCreate.mockResolvedValue({ no: 'DOC-2' })
      mocks.opLogCreate.mockResolvedValue({})

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/products/${productId}`,
        headers: { 'x-test-actor': 'supplier' },
        payload: { status: 'DISABLED' },
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.productUpdateMany).toHaveBeenCalledTimes(1)
      expect(mocks.productUpdateMany.mock.calls[0][0].data.status).toBe('PENDING_DISABLE')
      expect(mocks.documentCreate).toHaveBeenCalledTimes(1)
      expect(mocks.notifyProductChange).not.toHaveBeenCalled()
    })

    it('SUPPLY_CHAIN cannot patch product from another tenant', async () => {
      mocks.productFindFirst.mockResolvedValue(null)

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/products/${productId}`,
        headers: { 'x-test-actor': 'supply-chain' },
        payload: { name: '大白菜' },
      })

      expect(response.statusCode).toBe(404)
      expect(mocks.productUpdate).not.toHaveBeenCalled()
      expect(mocks.notifyProductChange).not.toHaveBeenCalled()
    })
  })
})
