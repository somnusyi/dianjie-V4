import Fastify from 'fastify'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {prisma} from '@dianjie/db'
import {financeReportRoutes} from '../../src/routes/financeReports'
vi.mock('@dianjie/db',()=>({prisma:{store:{findMany:vi.fn()},revenueRecord:{aggregate:vi.fn(),findMany:vi.fn()},receipt:{aggregate:vi.fn()},lossClaim:{aggregate:vi.fn()},voucherEntry:{findMany:vi.fn()}}}))
let app:ReturnType<typeof Fastify>
const samples=[['DRAFT',711],['CONFIRMED',1122],['ACCOUNTED',1333],['REJECTED',1744],['VOID',1955],['ACCOUNTED',789]] as const
beforeEach(async()=>{
 vi.resetAllMocks()
 vi.mocked(prisma.store.findMany).mockResolvedValue([{id:'s',no:'M001',name:'清源一店',lifecyclePhase:'OPERATING'}] as any)
 vi.mocked(prisma.revenueRecord.aggregate).mockResolvedValue({_sum:{amount:'100.25'}} as any)
 vi.mocked(prisma.revenueRecord.findMany).mockResolvedValue([{amount:'100.25',rawData:null}] as any)
 vi.mocked(prisma.lossClaim.aggregate).mockResolvedValue({_sum:{totalLossAmount:'0'}} as any)
 vi.mocked(prisma.voucherEntry.findMany).mockResolvedValue([])
 vi.mocked(prisma.receipt.aggregate).mockImplementation(async(args:any)=>{
 const allowed=args.where.status?.in
 return {_sum:{totalAmount:(samples.filter(([status])=>!allowed||allowed.includes(status)).reduce((sum,[,cents])=>sum+cents,0)/100).toFixed(2)}} as any
 })
 app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId:'tenant',role:req.headers['x-role']||'FINANCE'}})
 await app.register(financeReportRoutes,{prefix:'/api/finance/reports'});await app.ready()
})
afterEach(async()=>{await app.close()})
const read=(path:string,role='FINANCE')=>app.inject({url:'/api/finance/reports/'+path+'?month=2026-10',headers:{'x-role':role}})
it('profit totals, every store and comparative monthly costs use only accepted receipt states',async()=>{
 const response=await read('profit');expect(response.statusCode).toBe(200);const data=response.json()
 expect(data.summary.cost.food).toBe(32.44);expect(data.summary.netProfit).toBeCloseTo(67.81,10);expect(data.stores[0].foodCost).toBe(32.44)
 expect(prisma.receipt.aggregate).toHaveBeenCalledTimes(4)
 for(const [query] of vi.mocked(prisma.receipt.aggregate).mock.calls)expect(query.where).toMatchObject({tenantId:'tenant',status:{in:['CONFIRMED','ACCOUNTED']}})
})
it('food-cost totals, stores and all trend buckets use the same accepted receipt states',async()=>{
 const response=await read('food-cost');expect(response.statusCode).toBe(200);const data=response.json()
 expect(data.total.foodCost).toBe(32.44);expect(data.stores[0].foodCost).toBe(32.44)
 expect(data.trend).toHaveLength(6);for(const row of data.trend)expect(row.foodCost).toBe(32.44)
 for(const [query] of vi.mocked(prisma.receipt.aggregate).mock.calls)expect(query.where).toMatchObject({tenantId:'tenant',status:{in:['CONFIRMED','ACCOUNTED']}})
})
it.each(['profit','food-cost'])('%s successful empty receipts stay zero',async path=>{
 vi.mocked(prisma.receipt.aggregate).mockResolvedValue({_sum:{totalAmount:null}} as any)
 const response=await read(path);expect(response.statusCode).toBe(200);const d=response.json();expect(path==='profit'?d.summary.cost.food:d.total.foodCost).toBe(0)
})
it.each(['profit','food-cost'])('%s does not turn a failed cost source into zero',async path=>{
 vi.mocked(prisma.receipt.aggregate).mockRejectedValue(new Error('reference unavailable'));expect((await read(path)).statusCode).toBe(500)
})
it.each(['SUPPLY_CHAIN','SUPPLIER_OWNER','MANAGER'])('does not widen monthly report access for %s',async role=>{
 expect((await read('profit',role)).statusCode).toBe(403);expect((await read('food-cost',role)).statusCode).toBe(403);expect(prisma.receipt.aggregate).not.toHaveBeenCalled()
})
it('an empty profit report still identifies the requested month',async()=>{
 vi.mocked(prisma.store.findMany).mockResolvedValue([])
 const response=await read('profit');expect(response.statusCode).toBe(200);expect(response.json()).toEqual({month:'2026-10',stores:[],summary:null})
 expect(prisma.receipt.aggregate).not.toHaveBeenCalled()
})
