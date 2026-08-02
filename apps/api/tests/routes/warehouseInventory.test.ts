import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/services/warehouseLedger', () => ({
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

import {
  recordManualWarehouseInbound,
  recordWarehousePhysicalCount,
  reverseManualWarehouseInbound,
} from '../../src/services/warehouseLedger'
import { auditWarehouseLedger } from '../../src/services/warehouseLedgerAudit'
import { reconcileWarehouseShadowLedger } from '../../src/services/warehouseLedgerReconciliation'
import { warehouseInventoryRoutes } from '../../src/routes/warehouseInventory'

const recordInbound = vi.mocked(recordManualWarehouseInbound)
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

const body = {
  productId: 'product-1',
  purchaseQuantity: 2,
  totalAmount: 160,
  effectiveAt: '2026-08-02T09:00:00+08:00',
  idempotencyKey: 'manual-request-0001',
  sourceName: '线下采购',
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
  })

  it('allows internal supply chain to record a supplier-independent manual inbound', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' })
    const response = await app.inject({ method: 'POST', url: '/manual-inbound', payload: body })

    expect(response.statusCode).toBe(200)
    expect(recordInbound).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      userId: 'user-1',
      productId: 'product-1',
      purchaseQuantity: 2,
      totalAmount: 160,
      sourceName: '线下采购',
    }))
    expect(response.json()).toMatchObject({ ok: true, replayed: false, movement: { physicalDelta: 16, inventoryUnit: '袋' } })
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
