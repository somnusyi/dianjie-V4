import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { financeReconcileRoutes } from '../../src/routes/financeReconcile'
vi.mock('@dianjie/db', () => ({ prisma: {
  store: { findMany: vi.fn() }, supplier: { findMany: vi.fn() },
  revenueRecord: { aggregate: vi.fn() }, receipt: { aggregate: vi.fn() },
  lossClaim: { aggregate: vi.fn() }, paymentSchedule: { aggregate: vi.fn() },
} }))
let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(prisma.store.findMany).mockResolvedValue([{ id: 'store', no: 'M001', name: '清源门店' }] as any)
  vi.mocked(prisma.supplier.findMany).mockResolvedValue([{ id: 'supplier', name: '青禾食材' }] as any)
  vi.mocked(prisma.revenueRecord.aggregate).mockResolvedValue({ _sum: { amount: '100.25' } } as any)
  vi.mocked(prisma.receipt.aggregate).mockResolvedValue({ _sum: { totalAmount: '40.12' } } as any)
  vi.mocked(prisma.lossClaim.aggregate).mockResolvedValue({ _sum: { totalLossAmount: '5.03' } } as any)
  vi.mocked(prisma.paymentSchedule.aggregate).mockImplementation(async (args: any) => ({ _sum: { amount: args.where.status === 'PAID' ? '12.01' : '28.11' } }) as any)
  app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId: 'tenant', role: req.headers['x-role'] || 'FINANCE' } })
  await app.register(financeReconcileRoutes, { prefix: '/api/finance' })
  await app.ready()
})
afterEach(async () => { await app.close() })
const read = (view = 'store', role = 'FINANCE') => app.inject({ url: `/api/finance/reconcile?month=2026-10&view=${view}`, headers: { 'x-role': role } })
describe('monthly financial reconciliation source completeness', () => {
  it('keeps successful store and supplier amount projections', async () => {
    const store = await read()
    expect(store.statusCode).toBe(200)
    expect(store.json()).toHaveLength(1)
    expect(store.json()[0]).toMatchObject({ storeId: 'store', no: 'M001', name: '清源门店', revenue: 100.25, foodCost: 40.12, loss: 5.03 })
    expect(store.json()[0].net).toBeCloseTo(55.10, 10)
    const supplier = await read('supplier')
    expect(supplier.statusCode).toBe(200)
    expect(supplier.json()).toEqual([{ supplierId: 'supplier', name: '青禾食材', delivered: 40.12, paid: 12.01, unpaid: 28.11, loss: 5.03 }])
  })
  it('successful empty aggregates stay genuine zero-valued reports', async () => {
    vi.mocked(prisma.revenueRecord.aggregate).mockResolvedValue({ _sum: { amount: null } } as any)
    vi.mocked(prisma.receipt.aggregate).mockResolvedValue({ _sum: { totalAmount: null } } as any)
    vi.mocked(prisma.lossClaim.aggregate).mockResolvedValue({ _sum: { totalLossAmount: null } } as any)
    vi.mocked(prisma.paymentSchedule.aggregate).mockResolvedValue({ _sum: { amount: null } } as any)
    const store = await read()
    expect(store.statusCode).toBe(200)
    expect(store.json()[0]).toMatchObject({ revenue: 0, foodCost: 0, loss: 0, net: 0 })
    const supplier = await read('supplier')
    expect(supplier.statusCode).toBe(200)
    expect(supplier.json()).toEqual([])
  })
  it.each(['revenue', 'cost', 'loss'])('store %s query failure cannot become a successful zero-valued report', async source => {
    const aggregate = source === 'revenue' ? prisma.revenueRecord.aggregate : source === 'cost' ? prisma.receipt.aggregate : prisma.lossClaim.aggregate
    vi.mocked(aggregate).mockRejectedValue(new Error('Local synthetic source query failed'))
    const response = await read()
    expect(response.statusCode).toBe(500)
    expect(response.json()).not.toBeInstanceOf(Array)
  })
  it.each(['delivery', 'paid', 'unpaid', 'loss'])('supplier %s query failure cannot become a successful zero-valued report', async source => {
    if (source === 'delivery') vi.mocked(prisma.receipt.aggregate).mockRejectedValue(new Error('Local synthetic source query failed'))
    else if (source === 'loss') vi.mocked(prisma.lossClaim.aggregate).mockRejectedValue(new Error('Local synthetic source query failed'))
    else vi.mocked(prisma.paymentSchedule.aggregate).mockImplementation(async (args: any) => {
      if ((source === 'paid') === (args.where.status === 'PAID')) throw new Error('Local synthetic source query failed')
      return { _sum: { amount: '12.01' } } as any
    })
    const response = await read('supplier')
    expect(response.statusCode).toBe(500)
    expect(response.json()).not.toBeInstanceOf(Array)
  })
  it.each(['SUPPLY_CHAIN', 'SUPPLIER_OWNER', 'MANAGER'])('%s cannot query group monthly finance', async role => {
    expect((await read('store', role)).statusCode).toBe(403)
    expect(prisma.store.findMany).not.toHaveBeenCalled()
    expect(prisma.receipt.aggregate).not.toHaveBeenCalled()
  })
})

it.each(['store','supplier'])('monthly %s costs include only confirmed or accounted receipts',async view=>{
 const receipts=[{status:'DRAFT',cents:711},{status:'CONFIRMED',cents:1122},{status:'ACCOUNTED',cents:1333},{status:'REJECTED',cents:1744},{status:'VOID',cents:1955}]
 vi.mocked(prisma.receipt.aggregate).mockImplementation(async(args:any)=>{
 const allowed=args.where.status?.in
 return{_sum:{totalAmount:(receipts.filter(r=>!allowed||allowed.includes(r.status)).reduce((sum,r)=>sum+r.cents,0)/100).toFixed(2)}} as any
 })
 const response=await read(view);expect(response.statusCode).toBe(200)
 const data=response.json()[0];expect(view==='store'?data.foodCost:data.delivered).toBe(24.55)
 expect(prisma.receipt.aggregate).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({status:{in:['CONFIRMED','ACCOUNTED']}})}))
 if(view==='store')expect(data.net).toBeCloseTo(70.67,10)
})
