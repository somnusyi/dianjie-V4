import { Prisma } from '@dianjie/db'
import { describe, expect, it, vi } from 'vitest'
import {
  applyReceiptCorrection,
  planReceiptCorrection,
  ReceiptCorrectionError,
} from '../../src/services/receiptCorrection'

const dec = (value: string | number) => new Prisma.Decimal(value)

/** 还原 2026-08-10 RK202608000013 的真实形态。 */
function receipt(overrides: Record<string, any> = {}) {
  return {
    id: 'receipt-1',
    no: 'RK202608000013',
    status: 'ACCOUNTED',
    totalAmount: dec('623187.14'),
    items: [
      {
        id: 'item-baole',
        productId: 'p-baole',
        productNameSnapshot: '保乐肩',
        productUnitSnapshot: '件',
        quantity: dec('5'),
        unitPrice: dec('122000'),
        amount: dec('610000'),
        inventoryQuantity: dec('5000'),
        inventoryUnitCostSnapshot: dec('122'),
      },
      {
        id: 'item-mian',
        productId: 'p-mian',
        productNameSnapshot: '东川三色面·滇界定制',
        productUnitSnapshot: '箱',
        quantity: dec('1'),
        unitPrice: dec('7400'),
        amount: dec('7400'),
        inventoryQuantity: dec('40'),
        inventoryUnitCostSnapshot: dec('185'),
      },
      {
        id: 'item-ok',
        productId: 'p-ok',
        productNameSnapshot: '清远鸡（真空包装）',
        productUnitSnapshot: '箱',
        quantity: dec('3'),
        unitPrice: dec('405'),
        amount: dec('1215'),
        inventoryQuantity: dec('3'),
        inventoryUnitCostSnapshot: dec('405'),
      },
    ],
    ...overrides,
  }
}

describe('planReceiptCorrection', () => {
  it('按真实事故算出更正后的行与单据总额', () => {
    const plan = planReceiptCorrection({
      receipt: receipt() as any,
      corrections: [
        { receiptItemId: 'item-baole', newUnitPrice: 122 },
        { receiptItemId: 'item-mian', newUnitPrice: 185 },
      ],
    })

    const baole = plan.lines.find(line => line.receiptItemId === 'item-baole')!
    expect(baole.after.amount).toBe('610.00')
    // 每库存单位成本由「金额 ÷ 记入库存量」推出，不再依赖任何快照换算率
    expect(baole.after.inventoryUnitCost).toBe('0.122')
    expect(baole.amountDelta).toBe('-609390.00')

    const mian = plan.lines.find(line => line.receiptItemId === 'item-mian')!
    expect(mian.after.amount).toBe('185.00')
    expect(mian.after.inventoryUnitCost).toBe('4.625')

    expect(plan.totalAfter).toBe('6582.14')
    expect(plan.totalDelta).toBe('-616605.00')
  })

  it('不动没有被更正的行', () => {
    const plan = planReceiptCorrection({
      receipt: receipt() as any,
      corrections: [{ receiptItemId: 'item-baole', newUnitPrice: 122 }],
    })
    expect(plan.lines).toHaveLength(1)
    expect(plan.totalAfter).toBe('13797.14')
  })

  it('拒绝非本单的行、重复行、负价和无变化的更正', () => {
    const base = receipt() as any
    expect(() => planReceiptCorrection({
      receipt: base, corrections: [{ receiptItemId: '别的单的行', newUnitPrice: 1 }],
    })).toThrow(ReceiptCorrectionError)
    expect(() => planReceiptCorrection({
      receipt: base,
      corrections: [
        { receiptItemId: 'item-baole', newUnitPrice: 122 },
        { receiptItemId: 'item-baole', newUnitPrice: 123 },
      ],
    })).toThrow('同一行不能重复更正')
    expect(() => planReceiptCorrection({
      receipt: base, corrections: [{ receiptItemId: 'item-baole', newUnitPrice: -1 }],
    })).toThrow('不能为负')
    expect(() => planReceiptCorrection({
      receipt: base, corrections: [{ receiptItemId: 'item-ok', newUnitPrice: 405 }],
    })).toThrow('无需更正')
  })

  it('只对已确认/已入账的单据出更正单，其余状态走既有流程', () => {
    expect(() => planReceiptCorrection({
      receipt: receipt({ status: 'RECEIVED' }) as any,
      corrections: [{ receiptItemId: 'item-baole', newUnitPrice: 122 }],
    })).toThrow('不需要走更正单')
  })
})

function tx(overrides: Record<string, any> = {}) {
  return {
    receipt: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'receipt-1', no: 'RK202608000013', status: 'ACCOUNTED', totalAmount: dec('623187.14'),
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    receiptItem: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    paymentSchedule: {
      findMany: vi.fn().mockResolvedValue([{ id: 'sched-1', amount: dec('623187.14'), status: 'PENDING' }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    opLog: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  }
}

describe('applyReceiptCorrection', () => {
  const plan = planReceiptCorrection({
    receipt: receipt() as any,
    corrections: [
      { receiptItemId: 'item-baole', newUnitPrice: 122 },
      { receiptItemId: 'item-mian', newUnitPrice: 185 },
    ],
  })

  it('改行、重算总额、把未付款的排期一起拉平并留痕', async () => {
    const client = tx()
    const result = await applyReceiptCorrection(client as any, { tenantId: 't1', plan, userId: 'u1', role: 'CHEF_DIRECTOR', documentNo: 'DOC1' })

    expect(client.receiptItem.updateMany).toHaveBeenCalledTimes(2)
    expect(client.receipt.updateMany.mock.calls[0][0].data.totalAmount.toFixed(2)).toBe('6582.14')
    // 应付排期必须跟着走，否则错误金额仍会按原计划付出去
    expect(client.paymentSchedule.updateMany.mock.calls[0][0].data.amount.toFixed(2)).toBe('6582.14')
    expect(result.adjustedSchedules).toHaveLength(1)
    expect(client.opLog.create).toHaveBeenCalledTimes(1)
  })

  it('审批期间单据金额被改过就拒绝落地', async () => {
    const client = tx({
      receipt: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'receipt-1', no: 'RK202608000013', status: 'ACCOUNTED', totalAmount: dec('999'),
        }),
        updateMany: vi.fn(),
      },
    })
    await expect(applyReceiptCorrection(client as any, { tenantId: 't1', plan }))
      .rejects.toThrow('金额在审批期间已变化')
  })

  it('明细行已被别人改动就整体失败，不留半套', async () => {
    const client = tx({ receiptItem: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    await expect(applyReceiptCorrection(client as any, { tenantId: 't1', plan }))
      .rejects.toThrow('已被改动')
  })

  it('已付款的排期不碰', async () => {
    const client = tx({
      paymentSchedule: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
    })
    const result = await applyReceiptCorrection(client as any, { tenantId: 't1', plan })
    expect(client.paymentSchedule.updateMany).not.toHaveBeenCalled()
    expect(result.adjustedSchedules).toHaveLength(0)
  })

  it('拆成多笔的排期按比例缩放，不并单', async () => {
    const client = tx({
      paymentSchedule: {
        findMany: vi.fn().mockResolvedValue([
          { id: 's1', amount: dec('311593.57'), status: 'PENDING' },
          { id: 's2', amount: dec('311593.57'), status: 'NOTIFIED' },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    })
    const result = await applyReceiptCorrection(client as any, { tenantId: 't1', plan })
    expect(result.adjustedSchedules).toHaveLength(2)
    const total = result.adjustedSchedules.reduce((sum, item) => sum + Number(item.after), 0)
    expect(total).toBeCloseTo(6582.14, 1)
  })
})
