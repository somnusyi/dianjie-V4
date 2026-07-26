import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@dianjie/db'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    supplierStockReservation: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
  },
}))

vi.mock('@dianjie/db', async () => {
  const actual = await vi.importActual<typeof import('@dianjie/db')>('@dianjie/db')
  return { ...actual, prisma: mockPrisma }
})

vi.mock('../../src/services/supplierStockBatch', () => ({
  consumeSupplierStockBatches: vi.fn().mockResolvedValue([]),
}))

import {
  resolveWarehouseForReservation,
  reserveSupplierStockForOrder,
  releaseSupplierStockForOrder,
  consumeSupplierStockForShipment,
  getSupplierReservedStock,
} from '../../src/services/supplierStockReservation'
import { consumeSupplierStockBatches } from '../../src/services/supplierStockBatch'

const TENANT = 'tenant-1'
const SUPPLIER = 'supplier-1'
const WH_REAL = 'wh-real-id'
const PRODUCT_A = 'product-a'
const PRODUCT_B = 'product-b'
const ORDER_1 = 'order-1'
const ORDER_2 = 'order-2'
const ITEM_1 = 'item-1'
const ITEM_2 = 'item-2'
const USER = 'user-1'

type InMemoryReservation = {
  tenantId: string
  supplierId: string
  warehouseId: string | null
  productId: string
  purchaseOrderId: string
  purchaseOrderItemId: string
  quantity: Prisma.Decimal
  status: 'ACTIVE' | 'CONSUMED' | 'RELEASED'
  fulfilledQty: Prisma.Decimal
  consumedAt: Date | null
  releasedAt: Date | null
}

function dec(n: number | string) { return new Prisma.Decimal(n) }

function createMockTx(overrides: {
  warehouses?: Array<{ id: string; tenantId: string; isDefault: boolean; isActive: boolean }>
  products?: Array<{ id: string; tenantId: string; supplierId: string; stock: Prisma.Decimal }>
  warehouseStocks?: Array<{ tenantId: string; warehouseId: string; productId: string; physicalQty: Prisma.Decimal }>
  reservations?: InMemoryReservation[]
}) {
  const warehouses = overrides.warehouses || []
  const products = overrides.products || []
  const warehouseStocks = overrides.warehouseStocks || []
  const reservations: InMemoryReservation[] = (overrides.reservations || []).map(r => ({ ...r }))

  const calls: Record<string, unknown[]> = {
    createMany: [],
    wsUpdate: [],
    pUpdate: [],
    movementCreate: [],
    reservationUpdateMany: [],
  }

  const tx = {
    warehouse: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return warehouses.find(w => {
          if (where.tenantId !== w.tenantId) return false
          if ('isDefault' in where && where.isDefault === true) return w.isDefault && w.isActive
          if ('id' in where) return w.id === where.id && w.isActive
          return false
        }) || null
      }),
    },
    $queryRaw: vi.fn(async (sql: { sql: string; values: unknown[] }) => {
      const text = sql.sql
      const values = sql.values || []
      if (text.includes('"products"')) {
        const idValues = values.flat() as string[]
        return products
          .filter(p => idValues.includes(p.id))
          .sort((a, b) => a.id.localeCompare(b.id))
      }
      if (text.includes('"warehouse_stocks"')) {
        const idValues = values.flat() as string[]
        return warehouseStocks
          .filter(ws => idValues.includes(ws.productId))
          .sort((a, b) => a.productId.localeCompare(b.productId))
      }
      if (text.includes('"supplier_stock_batches"')) {
        return []
      }
      return []
    }),
    supplierStockReservation: {
      groupBy: vi.fn(async ({ where }: { by: string[]; where: Record<string, unknown> }) => {
        let filtered = reservations.filter(r => {
          if (where.tenantId && r.tenantId !== where.tenantId) return false
          if (where.supplierId && r.supplierId !== where.supplierId) return false
          if (where.warehouseId && r.warehouseId !== where.warehouseId) return false
          if (where.status && r.status !== where.status) return false
          if (where.productId) {
            const cond = where.productId as { in?: string[] }
            if (cond.in && !cond.in.includes(r.productId)) return false
          }
          if (where.purchaseOrderId) {
            const cond = where.purchaseOrderId as { not?: string }
            if (cond.not && r.purchaseOrderId === cond.not) return false
          }
          return true
        })
        const groups = new Map<string, Prisma.Decimal>()
        for (const r of filtered) {
          groups.set(r.productId, (groups.get(r.productId) || dec(0)).plus(r.quantity))
        }
        return [...groups.entries()].map(([productId, sum]) => ({
          productId,
          _sum: { quantity: sum },
        }))
      }),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
        calls.createMany.push(data)
        for (const d of data as Array<Record<string, unknown>>) {
          reservations.push({
            tenantId: d.tenantId as string,
            supplierId: d.supplierId as string,
            warehouseId: (d.warehouseId as string) || null,
            productId: d.productId as string,
            purchaseOrderId: d.purchaseOrderId as string,
            purchaseOrderItemId: d.purchaseOrderItemId as string,
            quantity: d.quantity as Prisma.Decimal,
            status: 'ACTIVE',
            fulfilledQty: dec(0),
            consumedAt: null,
            releasedAt: null,
          })
        }
        return { count: data.length }
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.reservationUpdateMany.push({ where, data })
        let count = 0
        for (const r of reservations) {
          if (where.purchaseOrderId && r.purchaseOrderId !== where.purchaseOrderId) continue
          if (where.purchaseOrderItemId && r.purchaseOrderItemId !== where.purchaseOrderItemId) continue
          if (where.warehouseId && r.warehouseId !== where.warehouseId) continue
          if (where.status && r.status !== where.status) continue
          if (data.status) r.status = data.status as InMemoryReservation['status']
          if (data.fulfilledQty !== undefined) r.fulfilledQty = data.fulfilledQty as Prisma.Decimal
          if (data.consumedAt !== undefined) r.consumedAt = data.consumedAt as Date | null
          if (data.releasedAt !== undefined) r.releasedAt = data.releasedAt as Date | null
          count++
        }
        return { count }
      }),
    },
    warehouseStock: {
      update: vi.fn(async ({ where, data, select }: {
        where: { tenantId_warehouseId_productId: { tenantId: string; warehouseId: string; productId: string } }
        data: { physicalQty: { decrement: Prisma.Decimal } }
        select: Record<string, boolean>
      }) => {
        const key = where.tenantId_warehouseId_productId
        calls.wsUpdate.push({ where: key, data })
        const ws = warehouseStocks.find(
          w => w.tenantId === key.tenantId && w.warehouseId === key.warehouseId && w.productId === key.productId,
        )
        if (!ws) throw new Error('WarehouseStock not found')
        ws.physicalQty = ws.physicalQty.minus(data.physicalQty.decrement)
        return select.physicalQty ? { physicalQty: ws.physicalQty } : ws
      }),
    },
    product: {
      update: vi.fn(async ({ where, data }: {
        where: { id: string }
        data: { stock: { decrement: Prisma.Decimal } }
      }) => {
        calls.pUpdate.push({ where, data })
        const p = products.find(pp => pp.id === where.id)
        if (!p) throw new Error('Product not found')
        p.stock = p.stock.minus(data.stock.decrement)
        return { stock: p.stock }
      }),
    },
    supplierStockMovement: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.movementCreate.push(data)
        return { id: `movement-${calls.movementCreate.length}`, ...data }
      }),
    },
    supplierStockBatch: {
      update: vi.fn(async () => ({ remainingQty: dec(0), depletedAt: null })),
    },
    supplierStockBatchAllocation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'alloc-1', ...data })),
    },
    _calls: calls,
    _reservations: reservations,
    _warehouseStocks: warehouseStocks,
    _products: products,
  }
  return tx as unknown as Prisma.TransactionClient & {
    _calls: typeof calls
    _reservations: InMemoryReservation[]
    _warehouseStocks: typeof warehouseStocks
    _products: typeof products
  }
}

describe('resolveWarehouseForReservation', () => {
  it('resolves default warehouse when warehouseId is omitted', async () => {
    const db = { warehouse: { findFirst: vi.fn().mockResolvedValue({ id: WH_REAL }) } }
    const result = await resolveWarehouseForReservation(db as any, TENANT)
    expect(result).toBe(WH_REAL)
    expect(db.warehouse.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, isDefault: true, isActive: true },
      select: { id: true },
    })
  })

  it('resolves default warehouse when warehouseId is "default"', async () => {
    const db = { warehouse: { findFirst: vi.fn().mockResolvedValue({ id: WH_REAL }) } }
    const result = await resolveWarehouseForReservation(db as any, TENANT, 'default')
    expect(result).toBe(WH_REAL)
  })

  it('normalizes blank and whitespace-padded default aliases', async () => {
    const db = { warehouse: { findFirst: vi.fn().mockResolvedValue({ id: WH_REAL }) } }
    await expect(resolveWarehouseForReservation(db as any, TENANT, '   ')).resolves.toBe(WH_REAL)
    await expect(resolveWarehouseForReservation(db as any, TENANT, ' default ')).resolves.toBe(WH_REAL)
    expect(db.warehouse.findFirst).toHaveBeenLastCalledWith({
      where: { tenantId: TENANT, isDefault: true, isActive: true },
      select: { id: true },
    })
  })

  it('resolves explicit warehouseId', async () => {
    const db = { warehouse: { findFirst: vi.fn().mockResolvedValue({ id: 'explicit-wh' }) } }
    const result = await resolveWarehouseForReservation(db as any, TENANT, 'explicit-wh')
    expect(result).toBe('explicit-wh')
    expect(db.warehouse.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, id: 'explicit-wh', isActive: true },
      select: { id: true },
    })
  })

  it('fails when no default warehouse exists for tenant', async () => {
    const db = { warehouse: { findFirst: vi.fn().mockResolvedValue(null) } }
    await expect(resolveWarehouseForReservation(db as any, TENANT))
      .rejects.toMatchObject({ statusCode: 404, message: '当前租户不存在启用的默认仓' })
  })

  it('fails for unknown warehouseId', async () => {
    const db = { warehouse: { findFirst: vi.fn().mockResolvedValue(null) } }
    await expect(resolveWarehouseForReservation(db as any, TENANT, 'unknown-wh'))
      .rejects.toMatchObject({ statusCode: 404, message: '仓库不存在、已停用或不属于当前租户' })
  })

  it('fails for empty tenantId', async () => {
    const db = { warehouse: { findFirst: vi.fn() } }
    await expect(resolveWarehouseForReservation(db as any, ''))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('reserveSupplierStockForOrder', () => {
  beforeEach(() => {
    vi.mocked(consumeSupplierStockBatches).mockClear()
  })

  it('locks both Product and WarehouseStock, checks drift, creates reservation with warehouseId', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(100) }],
    })

    await reserveSupplierStockForOrder(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 10, productName: 'A' }],
    })

    const queryRawCalls = (tx.$queryRaw as any).mock.calls
    const tables = queryRawCalls.map((c: any) => c[0].sql.includes('"warehouse_stocks"') ? 'ws' : 'products')
    expect(tables).toEqual(['products', 'ws'])
    expect(queryRawCalls[1][0].sql).toContain('"isActive" = true')

    expect(tx._calls.createMany).toHaveLength(1)
    const created = (tx._calls.createMany[0] as any[])[0]
    expect(created.warehouseId).toBe(WH_REAL)
    expect(created.productId).toBe(PRODUCT_A)
    expect(Number(created.quantity)).toBe(10)
  })

  it('returns 409 when Product.stock and WarehouseStock.physicalQty diverge', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(90) }],
    })

    await expect(reserveSupplierStockForOrder(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 5 }],
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('不一致') })

    expect(tx._calls.createMany).toHaveLength(0)
  })

  it('calculates available from WarehouseStock.physicalQty minus same-warehouse ACTIVE reservations', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(100) }],
      reservations: [{
        tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
        productId: PRODUCT_A, purchaseOrderId: 'other-order', purchaseOrderItemId: 'other-item',
        quantity: dec(80), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
      }],
    })

    await expect(reserveSupplierStockForOrder(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 30 }],
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('可用库存不足') })
  })

  it('succeeds when available covers the request after same-warehouse reservations', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(100) }],
      reservations: [{
        tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
        productId: PRODUCT_A, purchaseOrderId: 'other-order', purchaseOrderItemId: 'other-item',
        quantity: dec(80), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
      }],
    })

    await reserveSupplierStockForOrder(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 15 }],
    })

    expect(tx._calls.createMany).toHaveLength(1)
  })

  it('handles two product lines with independent locks and availability', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [
        { id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(50) },
        { id: PRODUCT_B, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(30) },
      ],
      warehouseStocks: [
        { tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(50) },
        { tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_B, physicalQty: dec(30) },
      ],
    })

    await reserveSupplierStockForOrder(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      lines: [
        { purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 10 },
        { purchaseOrderItemId: ITEM_2, productId: PRODUCT_B, quantity: 5 },
      ],
    })

    const created = tx._calls.createMany[0] as any[]
    expect(created).toHaveLength(2)
    expect(created[0].warehouseId).toBe(WH_REAL)
    expect(created[1].warehouseId).toBe(WH_REAL)
  })
})

describe('cross-warehouse reservation isolation', () => {
  it('reservations in a different warehouse do not reduce this warehouse availability', async () => {
    const OTHER_WH = 'wh-other'
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(100) }],
      reservations: [{
        tenantId: TENANT, supplierId: SUPPLIER, warehouseId: OTHER_WH,
        productId: PRODUCT_A, purchaseOrderId: 'other-wh-order', purchaseOrderItemId: 'other-wh-item',
        quantity: dec(95), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
      }],
    })

    await reserveSupplierStockForOrder(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 50 }],
    })

    expect(tx._calls.createMany).toHaveLength(1)
    const created = (tx._calls.createMany[0] as any[])[0]
    expect(created.warehouseId).toBe(WH_REAL)
  })
})

describe('consumeSupplierStockForShipment', () => {
  beforeEach(() => {
    vi.mocked(consumeSupplierStockBatches).mockClear()
    vi.mocked(consumeSupplierStockBatches).mockResolvedValue([])
  })

  it('updates WarehouseStock first, then Product.stock mirror, with movement and batch', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(100) }],
      reservations: [{
        tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
        productId: PRODUCT_A, purchaseOrderId: ORDER_1, purchaseOrderItemId: ITEM_1,
        quantity: dec(10), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
      }],
    })

    await consumeSupplierStockForShipment(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      deliveryOrderId: 'delivery-1',
      orderNo: 'PO-001',
      userId: USER,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 10, shippedQty: 10 }],
    })

    expect(tx._calls.wsUpdate).toHaveLength(1)
    expect(tx._calls.pUpdate).toHaveLength(1)
    expect(tx._calls.movementCreate).toHaveLength(1)

    const movement = tx._calls.movementCreate[0] as any
    expect(movement.warehouseId).toBe(WH_REAL)
    expect(movement.type).toBe('OUTBOUND_PO')
    expect(Number(movement.balanceAfter)).toBe(90)

    expect(vi.mocked(consumeSupplierStockBatches)).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ warehouseId: WH_REAL, productId: PRODUCT_A }),
    )

    const ws = tx._warehouseStocks[0]
    expect(Number(ws.physicalQty)).toBe(90)
    const p = tx._products[0]
    expect(Number(p.stock)).toBe(90)
  })

  it('protects other orders same-warehouse reservations during shipment', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(20) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(20) }],
      reservations: [
        {
          tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
          productId: PRODUCT_A, purchaseOrderId: ORDER_1, purchaseOrderItemId: ITEM_1,
          quantity: dec(10), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
        },
        {
          tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
          productId: PRODUCT_A, purchaseOrderId: ORDER_2, purchaseOrderItemId: ITEM_2,
          quantity: dec(15), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
        },
      ],
    })

    await expect(consumeSupplierStockForShipment(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      deliveryOrderId: 'delivery-fail',
      orderNo: 'PO-001',
      userId: USER,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 10, shippedQty: 10 }],
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('可发库存不足') })
  })

  it('partial shipment closes unshipped remainder and marks CONSUMED for shipped portion', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(100) }],
      reservations: [{
        tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
        productId: PRODUCT_A, purchaseOrderId: ORDER_1, purchaseOrderItemId: ITEM_1,
        quantity: dec(10), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
      }],
    })

    await consumeSupplierStockForShipment(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      deliveryOrderId: 'delivery-partial',
      orderNo: 'PO-001',
      userId: USER,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 10, shippedQty: 6 }],
    })

    const r = tx._reservations.find(rr => rr.purchaseOrderItemId === ITEM_1)!
    expect(r.status).toBe('CONSUMED')
    expect(Number(r.fulfilledQty)).toBe(6)
    expect(r.consumedAt).toBeTruthy()
    expect(r.releasedAt).toBeTruthy()
  })

  it('zero-shipped line is RELEASED not CONSUMED', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(100) }],
      reservations: [{
        tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
        productId: PRODUCT_A, purchaseOrderId: ORDER_1, purchaseOrderItemId: ITEM_1,
        quantity: dec(10), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
      }],
    })

    await consumeSupplierStockForShipment(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      deliveryOrderId: 'delivery-zero',
      orderNo: 'PO-001',
      userId: USER,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 10, shippedQty: 0 }],
    })

    const r = tx._reservations.find(rr => rr.purchaseOrderItemId === ITEM_1)!
    expect(r.status).toBe('RELEASED')
    expect(Number(r.fulfilledQty)).toBe(0)
    expect(r.releasedAt).toBeTruthy()
    expect(tx._calls.movementCreate).toHaveLength(0)
  })

  it('scopes close to current order, current line, same warehouse only', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(100) }],
      reservations: [
        {
          tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
          productId: PRODUCT_A, purchaseOrderId: ORDER_1, purchaseOrderItemId: ITEM_1,
          quantity: dec(10), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
        },
        {
          tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
          productId: PRODUCT_A, purchaseOrderId: ORDER_2, purchaseOrderItemId: ITEM_2,
          quantity: dec(5), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
        },
      ],
    })

    await consumeSupplierStockForShipment(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      deliveryOrderId: 'delivery-scope',
      orderNo: 'PO-001',
      userId: USER,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 10, shippedQty: 10 }],
    })

    const r1 = tx._reservations.find(rr => rr.purchaseOrderId === ORDER_1)!
    expect(r1.status).toBe('CONSUMED')
    const r2 = tx._reservations.find(rr => rr.purchaseOrderId === ORDER_2)!
    expect(r2.status).toBe('ACTIVE')
  })

  it('returns 409 on Product/WarehouseStock drift during shipment', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [{ tenantId: TENANT, warehouseId: WH_REAL, productId: PRODUCT_A, physicalQty: dec(80) }],
    })

    await expect(consumeSupplierStockForShipment(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      deliveryOrderId: 'delivery-drift',
      orderNo: 'PO-001',
      userId: USER,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 5, shippedQty: 5 }],
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('不一致') })
  })
})

describe('releaseSupplierStockForOrder', () => {
  it('releases only same-warehouse ACTIVE reservations when warehouseId is provided', async () => {
    const tx = createMockTx({
      reservations: [
        {
          tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
          productId: PRODUCT_A, purchaseOrderId: ORDER_1, purchaseOrderItemId: ITEM_1,
          quantity: dec(10), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
        },
        {
          tenantId: TENANT, supplierId: SUPPLIER, warehouseId: 'wh-other',
          productId: PRODUCT_A, purchaseOrderId: ORDER_1, purchaseOrderItemId: 'item-other-wh',
          quantity: dec(5), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
        },
      ],
    })

    await releaseSupplierStockForOrder(tx as any, ORDER_1, new Date(), WH_REAL)

    const r1 = tx._reservations.find(r => r.purchaseOrderItemId === ITEM_1)!
    expect(r1.status).toBe('RELEASED')
    const r2 = tx._reservations.find(r => r.purchaseOrderItemId === 'item-other-wh')!
    expect(r2.status).toBe('ACTIVE')
  })

  it('releases all ACTIVE reservations when warehouseId is omitted', async () => {
    const tx = createMockTx({
      reservations: [
        {
          tenantId: TENANT, supplierId: SUPPLIER, warehouseId: WH_REAL,
          productId: PRODUCT_A, purchaseOrderId: ORDER_1, purchaseOrderItemId: ITEM_1,
          quantity: dec(10), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
        },
        {
          tenantId: TENANT, supplierId: SUPPLIER, warehouseId: 'wh-other',
          productId: PRODUCT_A, purchaseOrderId: ORDER_1, purchaseOrderItemId: 'item-other-wh',
          quantity: dec(5), status: 'ACTIVE', fulfilledQty: dec(0), consumedAt: null, releasedAt: null,
        },
      ],
    })

    await releaseSupplierStockForOrder(tx as any, ORDER_1)

    expect(tx._reservations.every(r => r.status === 'RELEASED')).toBe(true)
  })
})

describe('getSupplierReservedStock', () => {
  beforeEach(() => {
    mockPrisma.supplierStockReservation.groupBy.mockClear()
    mockPrisma.supplierStockReservation.groupBy.mockResolvedValue([])
  })

  it('filters by warehouseId when provided', async () => {
    mockPrisma.supplierStockReservation.groupBy.mockResolvedValueOnce([
      { productId: PRODUCT_A, _sum: { quantity: dec(10) } },
    ])

    const result = await getSupplierReservedStock({
      tenantId: TENANT,
      supplierId: SUPPLIER,
      productIds: [PRODUCT_A],
      warehouseId: WH_REAL,
    })

    expect(result.get(PRODUCT_A)).toBe(10)
    expect(mockPrisma.supplierStockReservation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ warehouseId: WH_REAL }),
      }),
    )
  })

  it('omits warehouseId filter when not provided', async () => {
    mockPrisma.supplierStockReservation.groupBy.mockResolvedValueOnce([])

    await getSupplierReservedStock({ tenantId: TENANT })

    const where = mockPrisma.supplierStockReservation.groupBy.mock.calls[0][0].where
    expect(where.warehouseId).toBeUndefined()
  })
})

describe('missing warehouse and cross-tenant', () => {
  it('returns 409 when WarehouseStock row does not exist for product in warehouse', async () => {
    const tx = createMockTx({
      warehouses: [{ id: WH_REAL, tenantId: TENANT, isDefault: true, isActive: true }],
      products: [{ id: PRODUCT_A, tenantId: TENANT, supplierId: SUPPLIER, stock: dec(100) }],
      warehouseStocks: [],
    })

    await expect(reserveSupplierStockForOrder(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 5 }],
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('不存在库存记录') })
  })

  it('fails when warehouse belongs to a different tenant', async () => {
    const tx = createMockTx({
      warehouses: [{ id: 'other-tenant-wh', tenantId: 'other-tenant', isDefault: true, isActive: true }],
    })

    await expect(reserveSupplierStockForOrder(tx as any, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      purchaseOrderId: ORDER_1,
      warehouseId: 'other-tenant-wh',
      lines: [{ purchaseOrderItemId: ITEM_1, productId: PRODUCT_A, quantity: 5 }],
    })).rejects.toMatchObject({ statusCode: 404 })
  })
})
