import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/services/warehouseLedger', () => ({
  recordBatchManualWarehouseInbound: vi.fn(),
  recordManualWarehouseInbound: vi.fn(),
  recordWarehousePhysicalCount: vi.fn(),
  reverseManualWarehouseInbound: vi.fn(),
}))
vi.mock('../../src/services/warehouseLedgerAudit', () => ({
  auditWarehouseLedger: vi.fn(),
}))
vi.mock('../../src/services/warehouseLedgerReconciliation', () => ({
  reconcileWarehouseShadowLedger: vi.fn(),
}))
vi.mock('../../src/services/warehouseDocs', () => ({
  ensureWarehouseDoc: vi.fn(),
}))

const mocks = vi.hoisted(() => ({
  supplierFindFirst: vi.fn(),
  sourceFindMany: vi.fn(),
  productFindMany: vi.fn(),
  productFindFirst: vi.fn(),
  opLogCreate: vi.fn(),
  movementCount: vi.fn(),
  movementFindMany: vi.fn(),
  movementAggregate: vi.fn(),
  docLineFindMany: vi.fn(),
  resolveWarehouseId: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const prismaMock: any = {
    supplier: { findFirst: (...args: any[]) => mocks.supplierFindFirst(...args) },
    product: {
      findMany: (...args: any[]) => mocks.productFindMany(...args),
      findFirst: (...args: any[]) => mocks.productFindFirst(...args),
    },
    productUpstreamSource: { findMany: (...args: any[]) => mocks.sourceFindMany(...args) },
    opLog: { create: (...args: any[]) => mocks.opLogCreate(...args) },
    warehouseLedgerMovement: {
      count: (...args: any[]) => mocks.movementCount(...args),
      findMany: (...args: any[]) => mocks.movementFindMany(...args),
      aggregate: (...args: any[]) => mocks.movementAggregate(...args),
    },
    warehouseDocLine: { findMany: (...args: any[]) => mocks.docLineFindMany(...args) },
  }
  return { ...actual, prisma: prismaMock }
})

vi.mock('../../src/services/defaultWarehouse', () => ({
  resolveTenantWarehouseId: (...args: any[]) => mocks.resolveWarehouseId(...args),
}))

import {
  recordBatchManualWarehouseInbound,
  recordManualWarehouseInbound,
  recordWarehousePhysicalCount,
  reverseManualWarehouseInbound,
} from '../../src/services/warehouseLedger'
import { auditWarehouseLedger } from '../../src/services/warehouseLedgerAudit'
import { reconcileWarehouseShadowLedger } from '../../src/services/warehouseLedgerReconciliation'
import { ensureWarehouseDoc } from '../../src/services/warehouseDocs'
import {
  buildWarehouseInventoryScopeWhere,
  currentInventoryShipmentAmount,
  warehouseInventoryRoutes,
} from '../../src/routes/warehouseInventory'

const recordInbound = vi.mocked(recordManualWarehouseInbound)
const recordBatchInbound = vi.mocked(recordBatchManualWarehouseInbound)
const reverseInbound = vi.mocked(reverseManualWarehouseInbound)
const recordCount = vi.mocked(recordWarehousePhysicalCount)
const auditLedger = vi.mocked(auditWarehouseLedger)
const reconcileLedger = vi.mocked(reconcileWarehouseShadowLedger)

function buildApp(actor: Record<string, unknown>) {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = actor })
  app.register(warehouseInventoryRoutes)
  return app
}

const upstreamSupplier = {
  id: 'sup-1',
  name: '井育苗菇',
  status: 'ENABLED',
  businessScopes: ['WAREHOUSE_UPSTREAM'],
}

const body = {
  productId: 'product-1',
  purchaseQuantity: 2,
  totalAmount: 160,
  effectiveAt: '2026-08-02T09:00:00+08:00',
  idempotencyKey: 'manual-request-0001',
  supplierId: 'sup-1',
  note: '采购到货手工入库',
}

describe('warehouse inventory routes', () => {
  beforeEach(() => {
    recordInbound.mockReset()
    recordInbound.mockResolvedValue({
      replayed: false,
      warehouseId: 'warehouse-1',
      movement: {
        id: 'movement-1',
        productId: 'product-1',
        physicalDelta: 16,
        physicalAfter: 16,
        inventoryUnit: '袋',
        valueDelta: 160,
        valueAfter: 160,
        averageUnitCostAfter: 10,
        effectiveAt: new Date('2026-08-02T01:00:00Z'),
      },
    } as any)
    recordBatchInbound.mockReset()
    recordBatchInbound.mockResolvedValue({
      replayed: false,
      warehouseId: 'warehouse-1',
      movements: [
        { id: 'movement-1', productId: 'product-1', physicalDelta: 16, inventoryUnit: '袋', valueDelta: 160 },
        { id: 'movement-2', productId: 'product-2', physicalDelta: 5, inventoryUnit: '瓶', valueDelta: 50 },
      ],
    } as any)
    auditLedger.mockResolvedValue({ readyForStrict: false, blockerCount: 2, issues: [] } as any)
    reverseInbound.mockReset()
    reverseInbound.mockResolvedValue({ replayed: false, warehouseId: 'warehouse-1', movement: { id: 'reversal-1' } } as any)
    recordCount.mockReset()
    recordCount.mockResolvedValue({
      replayed: false,
      warehouseId: 'warehouse-1',
      movement: { id: 'count-1', type: 'OPENING_BALANCE', physicalDelta: 10, physicalAfter: 10, valueAfter: 100, inventoryUnit: '袋' },
    } as any)
    reconcileLedger.mockReset()
    reconcileLedger.mockResolvedValue({ scanned: 2, reserved: 1, released: 0, shipped: 1, failures: [], nextCursor: null })
    mocks.supplierFindFirst.mockReset()
    mocks.supplierFindFirst.mockResolvedValue(upstreamSupplier)
    mocks.sourceFindMany.mockReset()
    mocks.sourceFindMany.mockResolvedValue([{ productId: 'product-1' }, { productId: 'product-2' }])
    mocks.productFindMany.mockReset()
    mocks.productFindMany.mockResolvedValue([])
    mocks.opLogCreate.mockReset()
    mocks.opLogCreate.mockResolvedValue({})
    mocks.movementCount.mockReset()
    mocks.movementCount.mockResolvedValue(1)
    mocks.movementAggregate.mockReset()
    mocks.movementAggregate.mockResolvedValue({ _sum: { valueDelta: 160 } })
    mocks.docLineFindMany.mockReset()
    mocks.docLineFindMany.mockResolvedValue([])
    mocks.productFindFirst.mockReset()
    mocks.productFindFirst.mockResolvedValue({ id: 'product-1', name: '水牛毛肚', purchaseUnit: '件', inventoryUnit: '袋' })
    vi.mocked(ensureWarehouseDoc).mockReset()
    vi.mocked(ensureWarehouseDoc).mockResolvedValue({ doc: { id: 'doc-1', docNo: 'RK20260802-001', status: 'CONFIRMED' }, created: true } as any)
    mocks.movementFindMany.mockReset()
    mocks.movementFindMany.mockResolvedValue([
      {
        id: 'movement-1', type: 'MANUAL_INBOUND', sourceType: 'WarehouseManualInbound', sourceId: 'req-1',
        effectiveAt: new Date('2026-08-02T01:00:00Z'), recordedAt: new Date('2026-08-02T01:01:00Z'),
        product: { id: 'product-1', code: 'MR001', name: '水牛毛肚', category: '荤菜' },
        supplier: { id: 'sup-1', no: 'SUP001', name: '井育苗菇' },
        sourceName: '井育苗菇', note: '采购到货',
        originalQuantity: 2, originalUnit: '件', inventoryQuantity: 16, inventoryUnit: '袋',
        inventoryUnitCost: 10, valueDelta: 160,
        createdLot: { batchNo: 'MI-20260802-abcd1234', expiryDate: null },
        reversal: null,
      },
    ] as any)
    mocks.resolveWarehouseId.mockReset()
    mocks.resolveWarehouseId.mockResolvedValue('warehouse-1')
  })

  it('separates real warehouse stock from BOM placeholders and unit-governance queues', () => {
    expect(buildWarehouseInventoryScopeWhere({ tenantId: 'tenant-1', warehouseId: 'warehouse-1', scope: 'stock' }))
      .toMatchObject({
        tenantId: 'tenant-1', status: 'ENABLED',
        warehouseLedgerBalances: { some: { tenantId: 'tenant-1', warehouseId: 'warehouse-1' } },
      })
    expect(buildWarehouseInventoryScopeWhere({ tenantId: 'tenant-1', warehouseId: 'warehouse-1', scope: 'bom-mapping' }))
      .toMatchObject({ tenantId: 'tenant-1', status: 'ENABLED', category: 'BOM待采购映射' })
    expect(buildWarehouseInventoryScopeWhere({ tenantId: 'tenant-1', warehouseId: 'warehouse-1', scope: 'unit-review' }))
      .toMatchObject({
        tenantId: 'tenant-1', status: 'ENABLED', unitConversionStatus: { not: 'VERIFIED' },
        NOT: { category: 'BOM待采购映射' },
      })
  })

  it('values current physical stock at the product cost-unit price for inventory export', () => {
    expect(currentInventoryShipmentAmount({
      physicalQty: 24,
      price: 30,
      inventoryUnitsPerCostUnit: 12,
    })).toBe(60)
    expect(currentInventoryShipmentAmount({
      physicalQty: 24,
      price: 30,
      inventoryUnitsPerCostUnit: null,
    })).toBeNull()
  })

  it('records a manual inbound bound to an upstream supplier', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const response = await app.inject({ method: 'POST', url: '/manual-inbound', payload: body })

    expect(response.statusCode).toBe(200)
    expect(recordInbound).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      userId: 'user-1',
      productId: 'product-1',
      purchaseQuantity: 2,
      totalAmount: 160,
      supplierId: 'sup-1',
      sourceName: '井育苗菇',
    }))
    expect(response.json()).toMatchObject({ ok: true, replayed: false, gateWarnings: [], movement: { physicalDelta: 16, inventoryUnit: '袋' } })
    await app.close()
  })

  it('rejects manual inbound without a supplier', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const { supplierId, ...noSupplier } = body
    const response = await app.inject({ method: 'POST', url: '/manual-inbound', payload: noSupplier })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('供应商')
    expect(recordInbound).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects suppliers that are not enabled upstream partners', async () => {
    mocks.supplierFindFirst.mockResolvedValue({ ...upstreamSupplier, businessScopes: ['STORE_FULFILLER'] })
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const response = await app.inject({ method: 'POST', url: '/manual-inbound', payload: body })

    expect(response.statusCode).toBe(409)
    expect(recordInbound).not.toHaveBeenCalled()
    await app.close()
  })

  it('warns but allows inbound when the product has no active supply relation', async () => {
    mocks.sourceFindMany.mockResolvedValue([])
    mocks.productFindMany.mockResolvedValue([{ code: 'MR001', name: '水牛毛肚' }])
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const response = await app.inject({ method: 'POST', url: '/manual-inbound', payload: body })

    expect(response.statusCode).toBe(200)
    expect(recordInbound).toHaveBeenCalled()
    expect(response.json().gateWarnings).toEqual(['水牛毛肚（MR001）未绑定该供应商的供货关系'])
    expect(mocks.opLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ entityType: 'WarehouseLedgerMovement' }),
    }))
    await app.close()
  })

  it('posts multiple inbound lines as one batch command', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const response = await app.inject({
      method: 'POST',
      url: '/batch-manual-inbound',
      payload: {
        items: [
          { productId: 'product-1', purchaseQuantity: 2, unitPrice: 80 },
          { productId: 'product-2', purchaseQuantity: 5, unitPrice: 10 },
        ],
        effectiveAt: '2026-08-08T17:00:00+08:00',
        idempotencyKey: 'batch-inbound-0001',
        supplierId: 'sup-1',
        note: '一张单多商品入库',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(recordBatchInbound).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', userId: 'user-1',
      supplierId: 'sup-1',
      sourceName: '井育苗菇',
      items: [
        expect.objectContaining({ productId: 'product-1', purchaseQuantity: 2, unitPrice: 80 }),
        expect.objectContaining({ productId: 'product-2', purchaseQuantity: 5, unitPrice: 10 }),
      ],
    }))
    expect(response.json()).toMatchObject({ ok: true, count: 2, totalAmount: 210, gateWarnings: [] })
    await app.close()
  })

  it('rejects duplicate products before a batch can be posted', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const response = await app.inject({
      method: 'POST',
      url: '/batch-manual-inbound',
      payload: {
        items: [
          { productId: 'product-1', purchaseQuantity: 2, unitPrice: 80 },
          { productId: 'product-1', purchaseQuantity: 1, unitPrice: 82 },
        ],
        effectiveAt: '2026-08-08T17:00:00+08:00',
        idempotencyKey: 'batch-inbound-0002',
        supplierId: 'sup-1',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(recordBatchInbound).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects supplier accounts from the tenant-wide warehouse ledger', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'supplier-user', role: 'SUPPLIER_OWNER' })
    const response = await app.inject({ method: 'POST', url: '/manual-inbound', payload: body })

    expect(response.statusCode).toBe(403)
    expect(recordInbound).not.toHaveBeenCalled()
    await app.close()
  })

  it('requires positive quantity and inventory value before posting', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const response = await app.inject({ method: 'POST', url: '/manual-inbound', payload: { ...body, totalAmount: 0 } })

    expect(response.statusCode).toBe(400)
    expect(recordInbound).not.toHaveBeenCalled()
    await app.close()
  })

  it('lists inbound records with supplier and batch snapshot', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'FINANCE' })
    const response = await app.inject({
      method: 'GET',
      url: '/inbound-records?from=2026-08-01&to=2026-08-31&supplierId=sup-1&source=manual&q=毛肚',
    })

    expect(response.statusCode).toBe(200)
    expect(mocks.movementFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: 'tenant-1',
        warehouseId: 'warehouse-1',
        type: 'MANUAL_INBOUND',
        sourceType: 'WarehouseManualInbound',
        supplierId: 'sup-1',
      }),
    }))
    const payload = response.json()
    expect(payload.total).toBe(1)
    expect(payload.items[0]).toMatchObject({
      id: 'movement-1',
      amount: 160,
      batchNo: 'MI-20260802-abcd1234',
      supplier: { no: 'SUP001', name: '井育苗菇' },
      product: { code: 'MR001', name: '水牛毛肚' },
      reversed: false,
    })
    await app.close()
  })

  it('defaults inbound records to all inbound types without a supplier filter', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'FINANCE' })
    const response = await app.inject({ method: 'GET', url: '/inbound-records' })

    expect(response.statusCode).toBe(200)
    expect(mocks.movementFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ type: { in: ['MANUAL_INBOUND', 'OPENING_BALANCE'] } }),
    }))
    await app.close()
  })

  it('exposes the four-book audit to internal read roles', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'finance-1', role: 'FINANCE' })
    const response = await app.inject({ method: 'GET', url: '/audit' })

    expect(response.statusCode).toBe(200)
    expect(auditLedger).toHaveBeenCalledWith('tenant-1')
    expect(response.json()).toMatchObject({ readyForStrict: false, blockerCount: 2 })
    await app.close()
  })

  it('requires a reason and appends a manual-inbound reversal', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const response = await app.inject({
      method: 'POST',
      url: '/movements/movement-1/reverse',
      payload: { reason: '录错数量', idempotencyKey: 'reverse-request-0001' },
    })

    expect(response.statusCode).toBe(200)
    expect(reverseInbound).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', movementId: 'movement-1', reason: '录错数量',
    }))
    expect(response.json()).toMatchObject({ ok: true, movementId: 'reversal-1' })
    await app.close()
  })

  it('records zero-stock SKUs explicitly during a physical count', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const response = await app.inject({
      method: 'POST',
      url: '/physical-count',
      payload: {
        productId: 'product-1', countedInventoryQuantity: 0, countedInventoryValue: 0,
        effectiveAt: '2026-08-10T22:00:00+08:00', idempotencyKey: 'count-request-0001', note: '总仓月度实盘',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(recordCount).toHaveBeenCalledWith(expect.objectContaining({
      productId: 'product-1', countedInventoryQuantity: 0, countedInventoryValue: 0,
    }))
    await app.close()
  })

  it('replays durable order facts into the shadow ledger on demand', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const response = await app.inject({ method: 'POST', url: '/reconcile-shadow', payload: { limit: 100 } })

    expect(response.statusCode).toBe(200)
    expect(reconcileLedger).toHaveBeenCalledWith({ tenantId: 'tenant-1', userId: 'user-1', limit: 100, cursor: undefined })
    expect(response.json()).toMatchObject({ scanned: 2, shipped: 1, failures: [] })
    await app.close()
  })
})
