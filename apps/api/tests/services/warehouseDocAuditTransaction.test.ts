import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ status: 'POSTED', failLog: true, transactions: 0, globalWrites: 0 }))
vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return { ...actual, prisma: {
    warehouseDoc: {
      findFirst: async () => ({ id: 'doc-test', status: state.status, reviewStatus: 'PENDING' }),
      update: async ({ data }: any) => { state.globalWrites++; state.status = data.status; return { status: state.status } },
    },
    user: { findFirst: async () => ({ name: '隔离测试操作员' }) },
    warehouseDocLog: { create: async () => { if (state.failLog) throw Error('injected audit log failure'); return {} } },
    $transaction: async (work: any) => {
      state.transactions++
      let staged = state.status
      const result = await work({
        $queryRaw: async () => [],
        warehouseDoc: {
          findFirst: async () => ({ id: 'doc-test', status: staged, reviewStatus: 'PENDING' }),
          update: async ({ data }: any) => { staged = data.status; return { status: staged } },
        },
        user: { findFirst: async () => ({ name: '隔离测试操作员' }) },
        warehouseDocLog: { create: async () => { if (state.failLog) throw Error('injected audit log failure'); return {} } },
      })
      state.status = staged
      return result
    },
  } }
})
import { confirmWarehouseDoc, unconfirmWarehouseDoc } from '../../src/services/warehouseDocs'
beforeEach(() => { state.status = 'POSTED'; state.failLog = true; state.transactions = 0; state.globalWrites = 0 })
it.each(['confirm', 'unconfirm'])('does not commit %s when its audit log fails', async kind => {
  state.status = kind === 'confirm' ? 'POSTED' : 'CONFIRMED'
  const before = state.status
  const input = { tenantId: 'isolated', userId: 'actor', docId: 'doc-test', reason: '回退测试理由' }
  await expect(kind === 'confirm' ? confirmWarehouseDoc(input) : unconfirmWarehouseDoc(input)).rejects.toThrow('injected audit log failure')
  expect(state.status).toBe(before)
  expect(state.transactions).toBe(1)
  expect(state.globalWrites).toBe(0)
})
it('retains duplicate confirmation and rejected duplicate unconfirmation behavior', async () => {
  state.status = 'CONFIRMED'; state.failLog = false
  expect((await confirmWarehouseDoc({ tenantId: 'isolated', userId: 'actor', docId: 'doc-test' })).changed).toBe(false)
  await unconfirmWarehouseDoc({ tenantId: 'isolated', userId: 'actor', docId: 'doc-test', reason: '允许回退理由' })
  await expect(unconfirmWarehouseDoc({ tenantId: 'isolated', userId: 'actor', docId: 'doc-test', reason: '重复回退理由' })).rejects.toThrow('只有已审核')
  expect(state.status).toBe('POSTED')
  expect(state.globalWrites).toBe(0)
})
