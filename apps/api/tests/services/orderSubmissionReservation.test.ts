import { describe, expect, it, vi } from 'vitest'
vi.mock('@dianjie/db', async () => {
  const actual: any = await vi.importActual('@dianjie/db')
  return { ...actual, prisma: new Proxy({}, { get() { throw new Error('Live database access is forbidden in this unit test') } }) }
})
import { Prisma } from '@dianjie/db'
import { syncSubmissionWarehouseReservation } from '../../src/services/warehouseLedger'
import { syncSubmissionSupplierReservation, supplierStockQuantity, supplierStockUnitsPerOrderUnit } from '../../src/services/supplierStockReservation'
import { hasSubmissionStockPolicy, withSubmissionStockPolicy } from '../../src/services/orderSubmissionReservation'
const dec = (n: number | string) => new Prisma.Decimal(n)
function memory(physical = 10, otherReserved = 0) {
  const balance = { id: 'balance', productId: 'product', inventoryUnit: '袋', physicalQty: dec(physical), reservedQty: dec(otherReserved), inventoryValue: dec(50), averageUnitCost: dec(5), rowVersion: 0 }
  const reservations: any[] = []; const movements: any[] = []
  const tx: any = {
    warehouse: { findFirst: vi.fn(async () => ({ id: 'warehouse' })) },
    $queryRaw: vi.fn(async () => [balance]),
    warehouseLedgerBalance: { upsert: vi.fn(async () => balance), update: vi.fn(async ({ data }: any) => { Object.assign(balance, data) }) },
    warehouseLedgerReservation: {
      findMany: vi.fn(async () => reservations),
      create: vi.fn(async ({ data }: any) => { const row = { id: 'r-' + reservations.length, ...data }; reservations.push(row); return row }),
      update: vi.fn(async ({ where, data }: any) => { Object.assign(reservations.find(row => row.id === where.id), data) }),
    },
    warehouseLedgerMovement: { create: vi.fn(async ({ data }: any) => {
      if (movements.some(row => row.idempotencyKey === data.idempotencyKey)) throw new Error('Duplicate movement')
      movements.push(data); return data
    }) },
  }
  return { balance, reservations, movements, tx }
}
function line(quantity: number, id = 'item') { return { purchaseOrderItemId: id, productId: 'product', quantity, orderUnitSnapshot: '箱', inventoryUnitSnapshot: '袋', inventoryUnitsPerOrderUnitSnapshot: 3, productName: '调味品' } }
const scope = { tenantId: 'tenant', purchaseOrderId: 'order', userId: 'actor' }
describe('submitted warehouse reservations', () => {
  it('uses frozen conversion, changes only reserved balance and replays without duplicate movements', async () => {
    const m = memory()
    const input = { ...scope, revision: 0, lines: [line(2)] }
    await syncSubmissionWarehouseReservation(m.tx, input)
    expect(m.balance.reservedQty.toString()).toBe('6')
    expect(m.balance.physicalQty.toString()).toBe('10')
    expect(m.balance.inventoryValue.toString()).toBe('50')
    await syncSubmissionWarehouseReservation(m.tx, input)
    expect(m.movements).toHaveLength(1)
  })
  it('reconciles increase, remove and restore by revision without deleting audit facts', async () => {
    const m = memory()
    await syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 0, lines: [line(2)] })
    await syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 1, lines: [line(3)] })
    await syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 2, lines: [] })
    expect(m.balance.reservedQty.toString()).toBe('0')
    expect(m.reservations[0].status).toBe('RELEASED')
    await syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 3, lines: [line(1)] })
    expect(m.balance.reservedQty.toString()).toBe('3')
    expect(m.movements.map(row => row.reservedDelta.toString())).toEqual(['6', '3', '-9', '3'])
    expect(m.reservations).toHaveLength(1)
  })
  it('protects other orders and rejects aggregate overstock before any movement', async () => {
    const m = memory(10, 4)
    await expect(syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 0, lines: [line(2, 'a'), line(1, 'b')] })).rejects.toMatchObject({ statusCode: 409 })
    expect(m.movements).toHaveLength(0)
    expect(m.balance.reservedQty.toString()).toBe('4')
  })
  it('blocks missing/zero baseline rather than making phantom inventory', async () => {
    const m = memory(0)
    await expect(syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 0, lines: [line(1)] })).rejects.toThrow('库存基线')
    expect(m.movements).toHaveLength(0)
  })
  it('will not resurrect consumed reservations', async () => {
    const m = memory(); m.reservations.push({ purchaseOrderItemId: 'item', status: 'CONSUMED' })
    await expect(syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 1, lines: [line(1)] })).rejects.toThrow('已发货')
  })
  it('distinguishes new durable submission policy from historical snapshots', () => {
    expect(hasSubmissionStockPolicy({ items: [] })).toBe(false)
    expect(hasSubmissionStockPolicy(withSubmissionStockPolicy({ items: [] }))).toBe(true)
  })
})

describe('reservation item identity and frozen units', () => {
  it('refuses changing warehouse product identity even when the numeric reserved amount matches', async () => {
    const m = memory(); await syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 0, lines: [line(2)] })
    await expect(syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 1, lines: [{ ...line(2), productUnit: '箱', productId: 'another' }] })).rejects.toThrow('不能更换商品')
    expect(m.movements).toHaveLength(1)
  })
  it('refuses changing warehouse inventory unit when delta is zero', async () => {
    const m = memory(); await syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 0, lines: [line(2)] })
    await expect(syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 1, lines: [{ ...line(2), productUnit: '箱', inventoryUnitSnapshot: '克' }] })).rejects.toThrow('冻结库存单位')
    expect(m.movements).toHaveLength(1)
  })
  function supplierMemory() {
    const row: any = { id: 'supplier-reservation', purchaseOrderItemId: 'item', productId: 'product', status: 'ACTIVE', quantity: dec(6), purchaseOrderItem: { productId: 'product', orderUnitSnapshot: '箱', inventoryUnitSnapshot: '袋', inventoryUnitsPerOrderUnitSnapshot: dec(3) } }
    return { supplierStockReservation: { findMany: vi.fn(async () => [row]), update: vi.fn(), create: vi.fn() }, $queryRaw: vi.fn(), row }
  }
  it('refuses changing an existing supplier reservation product identity before stock mutation', async () => {
    const m = supplierMemory()
    await expect(syncSubmissionSupplierReservation(m as any, { tenantId: 'tenant', supplierId: 'supplier', purchaseOrderId: 'order', lines: [{ ...line(2), productUnit: '箱', productId: 'another' }] })).rejects.toThrow('不能更换商品')
    expect(m.supplierStockReservation.update).not.toHaveBeenCalled()
    expect(m.$queryRaw).not.toHaveBeenCalled()
  })
  it('refuses changing supplier inventory units against the persisted PO item snapshot', async () => {
    const m = supplierMemory()
    await expect(syncSubmissionSupplierReservation(m as any, { tenantId: 'tenant', supplierId: 'supplier', purchaseOrderId: 'order', lines: [{ ...line(2), productUnit: '箱', inventoryUnitSnapshot: '克' }] })).rejects.toThrow('冻结库存单位')
    expect(m.supplierStockReservation.update).not.toHaveBeenCalled()
  })
})

describe('legacy supplier stock unit is preserved', () => {
  it('reserves 2 boxes out of stock 10 boxes, not 6 bags', () => {
    expect(supplierStockUnitsPerOrderUnit({ ...line(2), productUnit: '箱' }, '箱').toString()).toBe('1')
    expect(supplierStockQuantity({ ...line(2), productUnit: '箱' }, '箱', 2).toString()).toBe('2')
  })
  it('uses provable frozen ratios when order and legacy stock units differ', () => {
    const frozen = { ...line(2), orderUnitSnapshot: '大箱', inventoryUnitSnapshot: '袋', inventoryUnitsPerOrderUnitSnapshot: 12, purchaseUnitSnapshot: '箱', inventoryUnitsPerPurchaseUnitSnapshot: 3, productUnit: '箱' }
    expect(supplierStockQuantity(frozen, '箱', 2).toString()).toBe('8')
  })
  it('refuses unknown stock unit instead of using inventory units as an implicit substitute', () => {
    expect(() => supplierStockQuantity(line(2), '桶', 2)).toThrow('无法可靠换算')
  })
  it('refuses implicit rounding beyond the legacy stock precision', () => {
    expect(() => supplierStockQuantity({ ...line(2), inventoryUnitsPerOrderUnitSnapshot: 0.0001 }, '袋', 1)).toThrow('超出供应商库存账精度')
  })
})

describe('warehouse choice remains frozen', () => {
  it('revises in the original warehouse after the tenant changes its default', async () => {
    const m = memory()
    await syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 0, lines: [line(1)] })
    m.tx.warehouse.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id || 'new-default' }))
    await syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 1, lines: [line(2)] })
    expect(m.tx.warehouse.findFirst.mock.calls.at(-1)?.[0].where.id).toBe('warehouse')
    expect(m.movements.at(-1).warehouseId).toBe('warehouse')
  })
  it('rejects mixed-warehouse reservation rows before any reconciliation', async () => {
    const m = memory()
    m.reservations.push({ purchaseOrderItemId: 'old-a', productId: 'product', warehouseId: 'first', status: 'RELEASED' }, { purchaseOrderItemId: 'old-b', productId: 'product', warehouseId: 'second', status: 'RELEASED' })
    await expect(syncSubmissionWarehouseReservation(m.tx, { ...scope, revision: 1, lines: [line(1)] })).rejects.toThrow('多个仓库')
    expect(m.movements).toHaveLength(0)
  })
})

describe('supplier reservation transaction uses one legacy stock ledger', () => {
  function memorySupplier() {
    const records: any[] = []
    const product = { id: 'product', unit: '箱', stock: dec(10) }
    const tx: any = {
      product: { findMany: vi.fn(async () => [product]) },
      $queryRaw: vi.fn(async () => [product]),
      supplierStockReservation: {
        findMany: vi.fn(async () => records), groupBy: vi.fn(async () => []),
        create: vi.fn(async ({ data }: any) => { const row = { id: 'reservation', status: 'ACTIVE', ...data, purchaseOrderItem: { productId: 'product', orderUnitSnapshot: '箱', inventoryUnitSnapshot: '袋', inventoryUnitsPerOrderUnitSnapshot: dec(3) } }; records.push(row); return row }),
        update: vi.fn(async ({ data }: any) => { Object.assign(records[0], data); return records[0] }),
      },
    }
    return { records, product, tx }
  }
  const input = { tenantId: 'tenant', supplierId: 'supplier', purchaseOrderId: 'order', lines: [{ ...line(2), productUnit: '箱' }] }
  it('persists 2 boxes and freezes the box basis while retaining stock 10 boxes', async () => {
    const m = memorySupplier(); await syncSubmissionSupplierReservation(m.tx, input)
    expect(m.records[0].quantity.toString()).toBe('2')
    expect(m.records[0].stockUnitSnapshot).toBe('箱')
    expect(m.records[0].stockUnitsPerOrderUnitSnapshot.toString()).toBe('1')
    expect(m.product.stock.toString()).toBe('10')
    await syncSubmissionSupplierReservation(m.tx, input)
    expect(m.records).toHaveLength(1)
    expect(m.records[0].quantity.toString()).toBe('2')
  })
  it('refuses a later physical stock unit change instead of mixing the reserved box count with bags', async () => {
    const m = memorySupplier(); await syncSubmissionSupplierReservation(m.tx, input)
    m.product.unit = '袋'
    await expect(syncSubmissionSupplierReservation(m.tx, { ...input, lines: [{ ...line(2), productUnit: '袋' }] })).rejects.toThrow('库存账单位已改变')
    expect(m.records[0].quantity.toString()).toBe('2')
  })
})
