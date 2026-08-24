import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '@dianjie/db'

/**
 * 批量手工出库（2026-08-23）单测：
 * 锁成本语义（指定成本 / 移动均价 / 清零尾差）、STRICT 库存不足拒绝、
 * 幂等重放、FEFO 批次分摊与 opLog 留痕。
 */

const movements: any[] = []
const opLogs: any[] = []
let balanceRow: any
let lots: any[]

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const tx = {
    warehouseLedgerMovement: {
      findMany: vi.fn(async ({ where }: any) => movements.filter(m => where.idempotencyKey.in.includes(m.idempotencyKey))),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `mv-${movements.length + 1}`, ...data }
        movements.push(row)
        return row
      }),
    },
    warehouseLedgerBalance: {
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async ({ data }: any) => {
        balanceRow = { ...balanceRow, ...data }
        return balanceRow
      }),
    },
    warehouseLedgerLot: {
      findMany: vi.fn(async () => lots.filter(l => l.remainingQty.gt(0))),
      update: vi.fn(async ({ where, data }: any) => {
        lots = lots.map(l => l.id === where.id ? { ...l, ...data } : l)
        return {}
      }),
    },
    warehouseLedgerLotAllocation: { create: vi.fn(async () => ({})) },
    opLog: { create: vi.fn(async ({ data }: any) => { opLogs.push(data); return {} }) },
    $queryRaw: vi.fn(async () => [balanceRow]),
    $executeRaw: vi.fn(async () => 0),
  }
  const prismaMock = {
    $transaction: async (work: any) => work(tx),
    warehouse: { findFirst: vi.fn(async () => ({ inventoryMode: 'STRICT' })) },
    product: {
      findMany: vi.fn(async ({ where }: any) => PRODUCTS.filter(p => where.id.in.includes(p.id) && p.status === 'ENABLED')),
    },
  }
  return { ...actual, prisma: prismaMock }
})

vi.mock('../../src/services/defaultWarehouse', () => ({
  resolveTenantWarehouseId: vi.fn(async () => 'wh-1'),
}))

const PRODUCTS = [
  {
    id: 'prod-1', tenantId: 'tenant-1', name: '出库测试菌', status: 'ENABLED',
    unit: 'kg', purchaseUnit: 'kg', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
    inventoryUnitsPerPurchaseUnit: new Prisma.Decimal(1),
    inventoryUnitsPerOrderUnit: new Prisma.Decimal(1),
    inventoryUnitsPerCostUnit: new Prisma.Decimal(1),
    unitConversionStatus: 'VERIFIED',
  },
  {
    id: 'prod-pending', tenantId: 'tenant-1', name: '未核验品', status: 'ENABLED',
    unit: 'kg', purchaseUnit: 'kg', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
    inventoryUnitsPerPurchaseUnit: new Prisma.Decimal(1),
    inventoryUnitsPerOrderUnit: new Prisma.Decimal(1),
    inventoryUnitsPerCostUnit: new Prisma.Decimal(1),
    unitConversionStatus: 'PENDING',
  },
]

const { recordBatchManualWarehouseOutbound } = await import('../../src/services/warehouseLedger')

function reset() {
  movements.length = 0
  opLogs.length = 0
  balanceRow = {
    id: 'bal-1', tenantId: 'tenant-1', warehouseId: 'wh-1', productId: 'prod-1', inventoryUnit: 'kg',
    physicalQty: new Prisma.Decimal(100), reservedQty: new Prisma.Decimal(0),
    inventoryValue: new Prisma.Decimal(1000), averageUnitCost: new Prisma.Decimal(10),
  }
  lots = [{ id: 'lot-1', remainingQty: new Prisma.Decimal(100), inventoryUnitCost: new Prisma.Decimal(10), expiryDate: null, manufactureDate: null, createdAt: new Date(), }]
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1', userId: 'user-1',
    items: [{ productId: 'prod-1', inventoryQuantity: 30, totalAmount: 330 }],
    effectiveAt: new Date('2026-08-23T12:00:00+08:00'),
    idempotencyKey: 'test-out-1', reason: '门店拨补（测试）',
    ...overrides,
  }
}

describe('recordBatchManualWarehouseOutbound', () => {
  it('指定成本出库：流水/余额/批次/opLog 正确', async () => {
    reset()
    const result = await recordBatchManualWarehouseOutbound(baseInput())
    expect(result.replayed).toBe(false)
    const mv = movements[0]
    expect(mv.type).toBe('ORDER_OUTBOUND')
    expect(mv.sourceType).toBe('WarehouseManualOutbound')
    expect(mv.physicalDelta.toFixed(6)).toBe('-30.000000')
    expect(mv.valueDelta.toFixed(4)).toBe('-330.0000')
    expect(mv.note).toContain('门店拨补')
    expect(balanceRow.physicalQty.toFixed(6)).toBe('70.000000')
    expect(balanceRow.inventoryValue.toFixed(4)).toBe('670.0000')
    expect(lots[0].remainingQty.toFixed(6)).toBe('70.000000')
    expect(opLogs[0].action).toContain('总仓批量出库')
  })

  it('缺省成本按移动均价带出', async () => {
    reset()
    await recordBatchManualWarehouseOutbound(baseInput({
      idempotencyKey: 'test-out-2',
      items: [{ productId: 'prod-1', inventoryQuantity: 30 }],
    }))
    expect(movements[0].valueDelta.toFixed(4)).toBe('-300.0000')
    expect(balanceRow.inventoryValue.toFixed(4)).toBe('700.0000')
  })

  it('清零行尾差全部带出，余额归零', async () => {
    reset()
    await recordBatchManualWarehouseOutbound(baseInput({
      idempotencyKey: 'test-out-3',
      items: [{ productId: 'prod-1', inventoryQuantity: 100, totalAmount: 999 }],
    }))
    expect(balanceRow.physicalQty.toFixed(6)).toBe('0.000000')
    expect(balanceRow.inventoryValue.toFixed(4)).toBe('0.0000')
    expect(movements[0].valueDelta.toFixed(4)).toBe('-1000.0000')
  })

  it('STRICT 模式库存不足整批拒绝', async () => {
    reset()
    await expect(recordBatchManualWarehouseOutbound(baseInput({
      idempotencyKey: 'test-out-4',
      items: [{ productId: 'prod-1', inventoryQuantity: 101 }],
    }))).rejects.toThrow('可用总仓库存不足')
    expect(movements).toHaveLength(0)
  })

  it('幂等：同键重跑不重复记账', async () => {
    reset()
    await recordBatchManualWarehouseOutbound(baseInput())
    const again = await recordBatchManualWarehouseOutbound(baseInput())
    expect(again.replayed).toBe(true)
    expect(movements).toHaveLength(1)
    expect(balanceRow.physicalQty.toFixed(6)).toBe('70.000000')
  })

  it('四单位未核验拒绝出库', async () => {
    reset()
    await expect(recordBatchManualWarehouseOutbound(baseInput({
      idempotencyKey: 'test-out-5',
      items: [{ productId: 'prod-pending', inventoryQuantity: 1 }],
    }))).rejects.toThrow('四单位换算尚未核验')
  })

  it('同批商品重复拒绝', async () => {
    reset()
    await expect(recordBatchManualWarehouseOutbound(baseInput({
      idempotencyKey: 'test-out-6',
      items: [
        { productId: 'prod-1', inventoryQuantity: 1 },
        { productId: 'prod-1', inventoryQuantity: 2 },
      ],
    }))).rejects.toThrow('同一商品不能重复添加')
  })
})
