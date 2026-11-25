import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  doc: null as any,
  failMovementId: '' as string,
  updates: [] as any[],
  logs: [] as any[],
  reversed: [] as string[],
  transaction: null as any,
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      $transaction: async (work: any) => work({
        $queryRaw: vi.fn().mockResolvedValue([]),
        warehouseDoc: {
          findFirst: vi.fn().mockImplementation(async () => state.doc),
          update: vi.fn().mockImplementation(async ({ data }: any) => {
            state.updates.push(data)
            return { ...state.doc, ...data }
          }),
        },
        warehouseDocLog: { create: vi.fn().mockImplementation(async ({ data }: any) => { state.logs.push(data); return data }) },
        user: { findFirst: vi.fn().mockResolvedValue({ name: '供应链测试员' }) },
      }),
    },
  }
})

vi.mock('../../src/services/warehouseLedger', () => ({
  serializableWithRetry: async (work: any) => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      warehouseDoc: {
        findFirst: vi.fn().mockImplementation(async () => state.doc),
        update: vi.fn().mockImplementation(async ({ data }: any) => { state.updates.push(data); return { ...state.doc, ...data } }),
      },
      warehouseDocLog: { create: vi.fn().mockImplementation(async ({ data }: any) => { state.logs.push(data); return data }) },
      user: { findFirst: vi.fn().mockResolvedValue({ name: '供应链测试员' }) },
    }
    state.transaction = tx
    return work(tx)
  },
  adjustWarehouseMovementValue: vi.fn(),
  prepareBatchManualWarehouseInbound: vi.fn(),
  prepareBatchManualWarehouseOutbound: vi.fn(),
  recordBatchManualWarehouseInbound: vi.fn(),
  recordBatchManualWarehouseOutbound: vi.fn(),
  reverseManualWarehouseInbound: vi.fn().mockImplementation(async ({ movementId }: any, tx: any) => {
    if (tx !== state.transaction) throw new Error('reversal escaped document transaction')
    if (movementId === state.failMovementId) throw Object.assign(new Error('该入库批次已有出库消耗，不能整笔冲销；请通过实盘调整处理差错'), { statusCode: 409 })
    state.reversed.push(movementId)
    return { replayed: false, movement: { id: `reversal-${movementId}` } }
  }),
}))

import { confirmWarehouseDocInTransaction, voidWarehouseInboundDoc } from '../../src/services/warehouseDocs'

function postedDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-void-1', tenantId: 'tenant-1', warehouseId: 'warehouse-1', docNo: 'RK-VOID-1',
    type: 'MANUAL_INBOUND', status: 'POSTED', reviewStatus: 'UNREVIEWED',
    lines: [{ id: 'line-1', lineNo: 1, movementId: 'movement-1' }, { id: 'line-2', lineNo: 2, movementId: 'movement-2' }],
    ...overrides,
  }
}

describe('warehouse document whole-void transaction', () => {
  beforeEach(() => {
    state.doc = postedDoc(); state.failMovementId = ''; state.updates = []; state.logs = []; state.reversed = []; state.transaction = null
  })

  it('reverses every line before marking the original document void and writing one audit log', async () => {
    const result = await voidWarehouseInboundDoc({ tenantId: 'tenant-1', userId: 'actor-1', docId: 'doc-void-1', reason: '数量录入错误' })
    expect(result.changed).toBe(true)
    expect(state.reversed).toEqual(['movement-1', 'movement-2'])
    expect(state.updates).toEqual([{ status: 'VOIDED' }])
    expect(state.logs).toEqual([expect.objectContaining({ action: 'VOID', reason: '数量录入错误', detail: { reversedLineCount: 2 } })])
  })

  it('does not change the document or write a void log when a later line cannot be reversed', async () => {
    state.failMovementId = 'movement-2'
    await expect(voidWarehouseInboundDoc({ tenantId: 'tenant-1', userId: 'actor-1', docId: 'doc-void-1', reason: '数量录入错误' })).rejects.toThrow('已有出库消耗')
    expect(state.updates).toEqual([])
    expect(state.logs).toEqual([])
  })

  it('is idempotent after void and refuses reviewed, audited, outbound, or incomplete documents', async () => {
    state.doc = postedDoc({ status: 'VOIDED' })
    expect((await voidWarehouseInboundDoc({ tenantId: 'tenant-1', userId: 'actor-1', docId: 'doc-void-1', reason: '重复请求' })).changed).toBe(false)
    for (const [overrides, message] of [
      [{ reviewStatus: 'REVIEWED' }, '取消复审'],
      [{ status: 'CONFIRMED' }, '反审核'],
      [{ type: 'MANUAL_OUTBOUND' }, '只有手工入库单'],
      [{ lines: [{ id: 'line-1', lineNo: 1, movementId: null }] }, '缺少完整过账流水'],
    ] as const) {
      state.doc = postedDoc(overrides)
      await expect(voidWarehouseInboundDoc({ tenantId: 'tenant-1', userId: 'actor-1', docId: 'doc-void-1', reason: '状态边界' })).rejects.toThrow(message)
    }
  })

  it('never lets a void document become audited again', async () => {
    const tx: any = { $queryRaw: vi.fn(), warehouseDoc: { findFirst: vi.fn().mockResolvedValue(postedDoc({ status: 'VOIDED' })), update: vi.fn() } }
    await expect(confirmWarehouseDocInTransaction(tx, { tenantId: 'tenant-1', userId: 'actor-1', docId: 'doc-void-1' })).rejects.toThrow('只有待审核单据')
    expect(tx.warehouseDoc.update).not.toHaveBeenCalled()
  })
})
