import { describe, expect, it, vi } from 'vitest'
vi.mock('@dianjie/db', async () => {
  const actual: any = await vi.importActual('@dianjie/db')
  return { ...actual, prisma: new Proxy({}, { get() { throw new Error('Live database forbidden') } }) }
})
import { Prisma } from '@dianjie/db'
import { reserveReplenishmentStock, releaseReplenishmentStock, transferReplenishmentStock } from '../../src/services/replenishmentStockReservation'
const d = (n: number) => new Prisma.Decimal(n)
const scope = { tenantId: 'tenant', replenishmentOrderId: 'ro', userId: 'actor' }
const line = (quantity = 2, productId = 'p1', id = 'ri1') => ({ purchaseOrderItemId: id, productId, quantity, productName: '食材', orderUnitSnapshot: '箱', inventoryUnitSnapshot: '袋', inventoryUnitsPerOrderUnitSnapshot: 3 })
function memory(physical = 12, reserved = 0) {
  const balance = { id: 'balance', productId: 'p1', inventoryUnit: '袋', physicalQty: d(physical), reservedQty: d(reserved), inventoryValue: d(120), averageUnitCost: d(10), rowVersion: 0 }
  const holds: any[] = [], movements: any[] = [], reservations: any[] = []
  const ro: any = { storeId: 'store', supplierId: 'supplier', items: [{ ...line(), id: 'ri1' }], status: 'SUBMITTED', stockReservationPolicy: 'SUBMISSION_V1', supplier: { sourceType: 'HEADQ_WAREHOUSE', status: 'ENABLED' } }
  const po: any = { id: 'po', storeId: 'store', supplierId: 'supplier', items: [{ ...line(), id: 'pi1', quantity: d(2) }] }
  const tx: any = {
    replenishmentOrder: { findFirst: vi.fn(async () => ro) },
    purchaseOrder: { findFirst: vi.fn(async () => po) },
    warehouse: { findFirst: vi.fn(async () => ({ id: 'original-warehouse' })) },
    $queryRaw: vi.fn(async () => [balance]),
    warehouseLedgerBalance: { upsert: vi.fn(), update: vi.fn(async ({ data }: any) => Object.assign(balance, data, { rowVersion: balance.rowVersion + 1 })) },
    replenishmentStockHold: {
      findMany: vi.fn(async () => holds),
      create: vi.fn(async ({ data }: any) => { const row = { id: 'h' + holds.length, status: 'ACTIVE', ...data }; holds.push(row); return row }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(holds.find(h => h.id === where.id), data)),
    },
    warehouseLedgerMovement: { create: vi.fn(async ({ data }: any) => { if (movements.some(m => m.idempotencyKey === data.idempotencyKey)) throw Error('duplicate'); movements.push(data); return data }) },
    warehouseLedgerReservation: { findMany: vi.fn(async () => reservations), create: vi.fn(async ({ data }: any) => { reservations.push(data); return data }) },
  }
  return { tx, balance, holds, movements, reservations, ro, po }
}
describe('independent replenishment frozen stock holds', () => {
  it('reserves at submission without a PO and leaves quantity/value unchanged', async () => {
    const m = memory(); await reserveReplenishmentStock(m.tx, { ...scope, lines: [line()] })
    expect(m.balance.reservedQty.toString()).toBe('6'); expect(m.balance.physicalQty.toString()).toBe('12'); expect(m.balance.inventoryValue.toString()).toBe('120')
    expect(m.holds[0]).toMatchObject({ warehouseId: 'original-warehouse', replenishmentOrderItemId: 'ri1', status: 'ACTIVE' })
    expect(m.movements[0]).toMatchObject({ sourceType: 'ReplenishmentOrder', sourceId: 'ro', sourceLineId: 'ri1', type: 'ORDER_RESERVED' })
    expect(m.tx.purchaseOrder.findFirst).not.toHaveBeenCalled(); expect(m.reservations).toHaveLength(0)
  })
  it('rejects overstock before writing any hold or movement, protecting another order', async () => {
    const m = memory(8, 4)
    await expect(reserveReplenishmentStock(m.tx, { ...scope, lines: [line()] })).rejects.toMatchObject({ statusCode: 409 })
    expect(m.holds).toHaveLength(0); expect(m.movements).toHaveLength(0); expect(m.balance.reservedQty.toString()).toBe('4')
  })
  it('does not silently recreate an existing hold', async () => {
    const m = memory(); await reserveReplenishmentStock(m.tx, { ...scope, lines: [line()] })
    await expect(reserveReplenishmentStock(m.tx, { ...scope, lines: [line()] })).rejects.toThrow('已经存在')
    expect(m.holds).toHaveLength(1); expect(m.movements).toHaveLength(1)
  })
  it.each(['DRAFT', 'CANCELLED'])('only submitted stock policy requests hold stock, not %s', async status => {
    const m = memory(); m.ro.status = status
    await expect(reserveReplenishmentStock(m.tx, { ...scope, lines: [line()] })).rejects.toMatchObject({ statusCode: 409 })
    expect(m.tx.$queryRaw).not.toHaveBeenCalled()
  })
  it('does not permit an external supplier or missing frozen conversion', async () => {
    const m = memory(); m.ro.supplier.sourceType = 'MAIN_SUPPLIER'
    await expect(reserveReplenishmentStock(m.tx, { ...scope, lines: [line()] })).rejects.toThrow('内部总仓')
    m.ro.supplier.sourceType = 'HEADQ_WAREHOUSE'
    await expect(reserveReplenishmentStock(m.tx, { ...scope, lines: [{ ...line(), inventoryUnitsPerOrderUnitSnapshot: null }] })).rejects.toThrow()
    expect(m.holds).toHaveLength(0)
  })
  it('cancellation releases only this RO quantity and replays without a second release', async () => {
    const m = memory(12, 3); await reserveReplenishmentStock(m.tx, { ...scope, lines: [line()] })
    m.ro.status = 'CANCELLED'
    await releaseReplenishmentStock(m.tx, scope); await releaseReplenishmentStock(m.tx, scope)
    expect(m.balance.reservedQty.toString()).toBe('3'); expect(m.balance.physicalQty.toString()).toBe('12'); expect(m.balance.inventoryValue.toString()).toBe('120')
    expect(m.holds[0].status).toBe('RELEASED'); expect(m.movements.map(x => x.reservedDelta.toString())).toEqual(['6', '-6'])
  })
  it('transfers a full available hold to PO without release/re-reserve or default warehouse lookup', async () => {
    const m = memory(6); await reserveReplenishmentStock(m.tx, { ...scope, lines: [line()] }); m.ro.status = 'ACCEPTED'
    m.tx.warehouse.findFirst.mockClear(); m.tx.warehouse.findFirst.mockResolvedValue({ id: 'new-default' })
    await transferReplenishmentStock(m.tx, { ...scope, purchaseOrderId: 'po' })
    expect(m.tx.warehouse.findFirst).not.toHaveBeenCalled(); expect(m.balance.reservedQty.toString()).toBe('6')
    expect(m.reservations[0]).toMatchObject({ warehouseId: 'original-warehouse', purchaseOrderId: 'po', purchaseOrderItemId: 'pi1', status: 'ACTIVE', originalUnit: '箱', inventoryUnit: '袋' })
    expect(m.reservations[0].conversionFactor.toString()).toBe('3'); expect(m.holds[0].status).toBe('TRANSFERRED'); expect(m.movements).toHaveLength(1)
    m.ro.status = 'CANCELLED'
    await expect(releaseReplenishmentStock(m.tx, scope)).rejects.toThrow('已经转交')
    m.ro.status = 'ACCEPTED'
    await expect(transferReplenishmentStock(m.tx, { ...scope, purchaseOrderId: 'po' })).rejects.toThrow('不完整')
  })
  it('rejects new policy missing holdings rather than falling back to acceptance reservation', async () => {
    const m = memory(); m.ro.status = 'ACCEPTED'
    await expect(transferReplenishmentStock(m.tx, { ...scope, purchaseOrderId: 'po' })).rejects.toThrow('不完整')
    expect(m.reservations).toHaveLength(0)
  })
  it('does not silently cancel a new-policy request whose hold is missing', async () => {
    const m = memory(); m.ro.status = 'CANCELLED'
    await expect(releaseReplenishmentStock(m.tx, scope)).rejects.toThrow('不完整')
    expect(m.tx.warehouseLedgerBalance.update).not.toHaveBeenCalled()
  })
  it('refuses a PO with another store or supplier and mismatching original RO lines', async () => {
    const m = memory(); await reserveReplenishmentStock(m.tx, { ...scope, lines: [line()] }); m.ro.status = 'ACCEPTED'
    m.po.storeId = 'another-store'
    await expect(transferReplenishmentStock(m.tx, { ...scope, purchaseOrderId: 'po' })).rejects.toThrow('门店或供应商')
    m.po.storeId = 'store'; m.ro.items[0].quantity = 3
    await expect(transferReplenishmentStock(m.tx, { ...scope, purchaseOrderId: 'po' })).rejects.toThrow('原单与冻结预占')
    expect(m.reservations).toHaveLength(0)
  })
  it('keeps legacy requests on their original acceptance path', async () => {
    const m = memory(); m.ro.status = 'ACCEPTED'; m.ro.stockReservationPolicy = 'LEGACY'
    expect(await transferReplenishmentStock(m.tx, { ...scope, purchaseOrderId: 'po' })).toBe(false)
    expect(m.tx.replenishmentStockHold.findMany).not.toHaveBeenCalled(); expect(m.tx.$queryRaw).not.toHaveBeenCalled()
  })
  it.each(['quantity', 'inventoryUnitSnapshot', 'inventoryUnitsPerOrderUnitSnapshot'])('refuses frozen %s mismatch before any PO reservation', async key => {
    const m = memory(); await reserveReplenishmentStock(m.tx, { ...scope, lines: [line()] }); m.ro.status = 'ACCEPTED'
    m.po.items[0][key] = key === 'inventoryUnitSnapshot' ? 'kg' : 4
    await expect(transferReplenishmentStock(m.tx, { ...scope, purchaseOrderId: 'po' })).rejects.toThrow('冻结预占')
    expect(m.reservations).toHaveLength(0); expect(m.holds[0].status).toBe('ACTIVE')
  })
})
