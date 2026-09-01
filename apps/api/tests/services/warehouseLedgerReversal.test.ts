import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '@dianjie/db'

/**
 * 差异/拒收冲回（履约准确性方案 1.1）：
 * 出库按发货数记账、门店实收更少时，结案/拒收必须把差额加回仓库账，
 * 否则错误沉淀到下次实盘。这里锁住冲回的幂等、超量拒绝与批次恢复。
 */
const { reverseDeliveryOutboundInTransaction } = await import('../../src/services/warehouseLedger')

const ORIGINAL_ID = 'mv-out-1'
const IDEMPOTENCY_KEY = 'reversal:lossclaim:lc-1:mv-out-1'

function originalMovement(overrides: Record<string, unknown> = {}) {
  return {
    id: ORIGINAL_ID,
    tenantId: 'tenant-1',
    warehouseId: 'wh-1',
    productId: 'prod-1',
    type: 'ORDER_OUTBOUND',
    sourceType: 'DeliveryOrder',
    sourceId: 'do-1',
    physicalDelta: new Prisma.Decimal(-1000),
    inventoryQuantity: new Prisma.Decimal(1000),
    originalQuantity: new Prisma.Decimal(100),
    originalUnit: '箱',
    conversionFactor: new Prisma.Decimal(10),
    inventoryUnit: 'kg',
    inventoryUnitCost: new Prisma.Decimal('2.5'),
    ...overrides,
  }
}

function balanceRow() {
  return {
    id: 'bal-1',
    productId: 'prod-1',
    inventoryUnit: 'kg',
    physicalQty: new Prisma.Decimal(50),
    reservedQty: new Prisma.Decimal(0),
    inventoryValue: new Prisma.Decimal(125),
    averageUnitCost: new Prisma.Decimal('2.5'),
  }
}

function buildTx(options: {
  replayMovement?: unknown
  original?: unknown
  priorReversedQty?: string
  allocations?: Array<{ lotId: string; quantity: Prisma.Decimal }>
}) {
  const movementCreate = vi.fn().mockResolvedValue({ id: 'mv-rev-1' })
  const lotUpdate = vi.fn().mockResolvedValue({})
  const balanceUpdate = vi.fn().mockResolvedValue({})
  const tx = {
    warehouseLedgerMovement: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.idempotencyKey) return options.replayMovement ?? null
        if (where.id === ORIGINAL_ID) {
          const original = options.original ?? originalMovement()
          return where.type === original.type ? original : null
        }
        return null
      }),
      aggregate: vi.fn().mockResolvedValue({
        _sum: { inventoryQuantity: options.priorReversedQty ? new Prisma.Decimal(options.priorReversedQty) : null },
      }),
      create: movementCreate,
    },
    warehouseLedgerBalance: {
      upsert: vi.fn().mockResolvedValue({}),
      update: balanceUpdate,
    },
    $queryRaw: vi.fn().mockResolvedValue([balanceRow()]),
    warehouseLedgerLotAllocation: {
      findMany: vi.fn().mockResolvedValue(options.allocations ?? [
        { lotId: 'lot-1', quantity: new Prisma.Decimal(600) },
        { lotId: 'lot-2', quantity: new Prisma.Decimal(400) },
      ]),
    },
    warehouseLedgerLot: {
      findUnique: vi.fn().mockResolvedValue({
        initialQty: new Prisma.Decimal(1000),
        remainingQty: new Prisma.Decimal(0),
      }),
      update: lotUpdate,
    },
    // 比例加价钩子：FIXED 商品直接安静跳过，不写价格与日志
    product: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'prod-1', tenantId: 'tenant-1', name: '测试商品', status: 'ENABLED',
        price: new Prisma.Decimal(25), pricingMode: 'FIXED', markupPercent: null,
        supplierId: null, category: null, costUnit: 'kg', inventoryUnit: 'kg',
        inventoryUnitsPerCostUnit: new Prisma.Decimal(1),
      }),
    },
  } as any
  return { tx, movementCreate, lotUpdate, balanceUpdate }
}

const INPUT = {
  tenantId: 'tenant-1',
  userId: null,
  source: 'LossClaim' as const,
  sourceId: 'lc-1',
  originalMovementId: ORIGINAL_ID,
  quantity: new Prisma.Decimal(30),
  reason: '差异单 LC-1 结案冲回',
}

describe('reverseDeliveryOutboundInTransaction', () => {
  it('冲回差额：按原流水冻结因子换算、写 REVERSAL、余额与批次同步加回', async () => {
    const { tx, movementCreate, lotUpdate, balanceUpdate } = buildTx({})
    const result = await reverseDeliveryOutboundInTransaction(tx as any, INPUT)
    expect(result).toEqual({ reversed: true, movementId: 'mv-rev-1', replayed: false })

    const data = movementCreate.mock.calls[0][0].data
    expect(data.type).toBe('REVERSAL')
    expect(data.idempotencyKey).toBe(IDEMPOTENCY_KEY)
    expect(data.sourceType).toBe('LossClaimReversal')
    expect(data.sourceLineId).toBe(ORIGINAL_ID)
    // 30 箱 × 10 kg/箱 = 300kg
    expect(data.physicalDelta.toNumber()).toBe(300)
    expect(data.physicalAfter.toNumber()).toBe(350)
    // 300kg × 2.5 = 750
    expect(data.valueDelta.toNumber()).toBe(750)
    expect(data.conversionFactor.toNumber()).toBe(10)
    expect(data.inventoryUnit).toBe('kg')

    expect(balanceUpdate).toHaveBeenCalled()
    // 批次按 FEFO 消耗顺序加回：第一笔 lot-1 +300
    expect(lotUpdate).toHaveBeenCalledWith({
      where: { id: 'lot-1' },
      data: { remainingQty: { increment: expect.any(Prisma.Decimal) }, depletedAt: null },
    })
    expect(lotUpdate).toHaveBeenCalledTimes(1)
  })

  it('幂等：同一差异单同一原流水重复冲回直接 replay，不再写流水', async () => {
    const { tx, movementCreate } = buildTx({ replayMovement: { id: 'mv-rev-existing' } })
    const result = await reverseDeliveryOutboundInTransaction(tx as any, INPUT)
    expect(result).toEqual({ reversed: false, movementId: 'mv-rev-existing', replayed: true })
    expect(movementCreate).not.toHaveBeenCalled()
  })

  it('单次冲回不得超过原出库量', async () => {
    const { tx } = buildTx({})
    await expect(reverseDeliveryOutboundInTransaction(tx as any, {
      ...INPUT, quantity: new Prisma.Decimal(101),
    })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('累计冲回不得超过原出库量（多张差异单叠加场景）', async () => {
    const { tx } = buildTx({ priorReversedQty: '800' })
    // 已冲 800kg + 本次 300kg > 原出库 1000kg
    await expect(reverseDeliveryOutboundInTransaction(tx as any, INPUT))
      .rejects.toMatchObject({ statusCode: 409 })
  })

  it('批次恢复跨多笔 allocation 时按顺序补足', async () => {
    const { tx, lotUpdate } = buildTx({
      allocations: [
        { lotId: 'lot-1', quantity: new Prisma.Decimal(100) },
        { lotId: 'lot-2', quantity: new Prisma.Decimal(900) },
      ],
    })
    await reverseDeliveryOutboundInTransaction(tx as any, INPUT)
    // 300kg：lot-1 补 100，lot-2 补 200
    const first = lotUpdate.mock.calls[0][0].data.remainingQty.increment.toNumber()
    const second = lotUpdate.mock.calls[1][0].data.remainingQty.increment.toNumber()
    expect(first).toBe(100)
    expect(second).toBe(200)
  })

  it('拒收来源使用独立的幂等键前缀', async () => {
    const { tx, movementCreate } = buildTx({})
    await reverseDeliveryOutboundInTransaction(tx as any, {
      ...INPUT, source: 'ReceiptRejection', sourceId: 'rk-1',
      quantity: new Prisma.Decimal(100),
    })
    const data = movementCreate.mock.calls[0][0].data
    expect(data.idempotencyKey).toBe('reversal:receiptrejection:rk-1:mv-out-1')
    expect(data.sourceType).toBe('ReceiptRejectionReversal')
  })

  it('原流水不存在或非订单出库类型时 404', async () => {
    const { tx } = buildTx({ original: { ...originalMovement(), type: 'MANUAL_INBOUND' } })
    await expect(reverseDeliveryOutboundInTransaction(tx as any, INPUT))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})
