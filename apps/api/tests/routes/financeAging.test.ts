import Fastify from 'fastify'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {prisma} from '@dianjie/db'
import {financeReportRoutes} from '../../src/routes/financeReports'
vi.mock('@dianjie/db',()=>({prisma:{paymentSchedule:{findMany:vi.fn()},supplier:{findMany:vi.fn()},store:{findMany:vi.fn()}}}))
let app:ReturnType<typeof Fastify>
const rows=[['PENDING','23.46',3],['OVERDUE','7.89',-2],['NOTIFIED','8.12',-35],['PENDING_APPROVAL','4.21',5],['APPROVED','5.32',8],['ON_HOLD','6.43',10],['PAID','99.99',-10],['CANCELLED','88.88',-10]]
beforeEach(async()=>{
 vi.resetAllMocks();vi.mocked(prisma.paymentSchedule.findMany).mockImplementation(async(q:any)=>rows.filter(([status])=>q.where.status.in.includes(status)).map(([status,amount,days],i)=>({id:'p'+i,tenantId:'tenant',supplierId:'sup',storeId:'store',status,amount,dueAt:new Date(Date.now()+Number(days)*86400000)})) as any)
 vi.mocked(prisma.supplier.findMany).mockResolvedValue([{id:'sup',name:'青禾食材'}] as any);vi.mocked(prisma.store.findMany).mockResolvedValue([{id:'store',name:'清源一店'}] as any)
 app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId:'tenant',role:req.headers['x-role']||'FINANCE'}});await app.register(financeReportRoutes,{prefix:'/api/finance/reports'});await app.ready()
})
afterEach(async()=>{await app.close()})
const read=(role='FINANCE',query='')=>app.inject({url:'/api/finance/reports/aging'+query,headers:{'x-role':role}})
it('includes OVERDUE and NOTIFIED while retaining earlier unpaid states and excluding paid/cancelled',async()=>{
 const r=await read();expect(r.statusCode).toBe(200);const d=r.json();expect(d.items.map((x:any)=>x.status).sort()).toEqual(['PENDING','OVERDUE','NOTIFIED','PENDING_APPROVAL','APPROVED','ON_HOLD'].sort());expect(d.totalOverdue).toBeCloseTo(16.01,8);expect(d.totalNotDue).toBeCloseTo(39.42,8);expect(d.grandTotal).toBeCloseTo(55.43,8);expect(d.buckets.d0_30.total).toBe(7.89);expect(d.buckets.d30_60.total).toBe(8.12);expect(d.supplierRank[0].count).toBe(6)
})
it('preserves exact tenant and requested store query',async()=>{expect((await read('FINANCE','?storeId=store')).statusCode).toBe(200);expect(prisma.paymentSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({tenantId:'tenant',storeId:'store'})}))})
it('empty successful aging is a real zero',async()=>{vi.mocked(prisma.paymentSchedule.findMany).mockResolvedValue([]);const d=(await read()).json();expect(d.grandTotal).toBe(0);expect(d.totalOverdue).toBe(0);expect(d.items).toEqual([])})
it.each(['paymentSchedule','supplier','store'])('%s read failures do not become zero aging',async model=>{vi.mocked((prisma as any)[model].findMany).mockRejectedValue(new Error('不可读取'));expect((await read()).statusCode).toBe(500)})
it.each(['SUPPLY_CHAIN','SUPPLIER_OWNER','MANAGER'])('rejects %s before reading financial data',async role=>{expect((await read(role)).statusCode).toBe(403);expect(prisma.paymentSchedule.findMany).not.toHaveBeenCalled()})
