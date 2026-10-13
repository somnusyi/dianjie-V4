import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ reviewStatus: 'REVIEWED', failLog: true, committedLogs: 0 }))
vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return { ...actual, prisma: { $transaction: async (work: any) => {
    let flag = state.reviewStatus
    let logs = 0
    const result = await work({
      $queryRaw: async () => [],
      warehouseDoc: {
        findFirst: async () => ({ id: 'doc', status: 'CONFIRMED', reviewStatus: flag }),
        update: async ({ data }: any) => { flag = data.reviewStatus; return { id: 'doc', status: 'CONFIRMED', reviewStatus: flag } },
      },
      user: { findFirst: async () => ({ name: '供应链' }) },
      warehouseDocLog: { create: async () => { if (state.failLog) throw Error('injected log failure'); logs++; return {} } },
    })
    state.reviewStatus = flag; state.committedLogs += logs
    return result
  } } }
})
import { reviewWarehouseDoc, unreviewWarehouseDoc } from '../../src/services/warehouseDocs'
beforeEach(() => { state.reviewStatus = 'REVIEWED'; state.failLog = true; state.committedLogs = 0 })
it('review flag and log roll back together on log failure',async()=>{
 state.reviewStatus='UNREVIEWED'
 await expect(reviewWarehouseDoc({tenantId:'fixture',userId:'actor',docId:'doc'})).rejects.toThrow('injected log failure')
 expect(state.reviewStatus).toBe('UNREVIEWED');expect(state.committedLogs).toBe(0)
})
it('legacy cancellation calls are rejected without writing flags or logs',async()=>{
 state.failLog=false
 await expect(unreviewWarehouseDoc({tenantId:'fixture',userId:'actor',docId:'doc'})).rejects.toMatchObject({statusCode:409})
 expect(state.reviewStatus).toBe('REVIEWED');expect(state.committedLogs).toBe(0)
})
