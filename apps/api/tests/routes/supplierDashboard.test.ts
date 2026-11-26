import Fastify from 'fastify'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {prisma} from '@dianjie/db'
import {v2DashboardRoutes} from '../../src/routes/v2Dashboard'
vi.mock('@dianjie/db',()=>({prisma:{user:{findUnique:vi.fn()},revenueRecord:{aggregate:vi.fn(),findMany:vi.fn()},purchaseOrder:{count:vi.fn(),aggregate:vi.fn()},paymentSchedule:{aggregate:vi.fn()},supplierStockMovement:{count:vi.fn()},$queryRawUnsafe:vi.fn()}}))
vi.mock('../../src/services/storeInventory',()=>({estimatedStoreInventory:vi.fn()}))
let app:ReturnType<typeof Fastify>;let failed='',zero=false,overdue=false,unbound=false
function source(q:any){if(q.where.status==='PAID')return'paid';if(!q.where.status)return'due';if(q.where.status.in.includes('ON_HOLD'))return'all';if(q.where.dueAt.lt)return'overdue';if(q.where.dueAt.gt)return'thirty';return'seven'}
beforeEach(async()=>{
 vi.resetAllMocks();failed='';zero=false;overdue=false;unbound=false
 vi.mocked(prisma.user.findUnique).mockResolvedValue({id:'u',name:'供货经办',role:'SUPPLIER_OWNER',store:null,supplier:{id:'p',name:'青禾',businessScopes:[]}} as any)
 vi.mocked(prisma.revenueRecord.aggregate).mockResolvedValue({_sum:{amount:0}} as any);vi.mocked(prisma.revenueRecord.findMany).mockResolvedValue([])
 vi.mocked(prisma.purchaseOrder.count).mockResolvedValue(0);vi.mocked(prisma.purchaseOrder.aggregate).mockImplementation(async()=>{if(failed==='delivered')throw new Error('reference failure');return{_sum:{totalAmount:zero?0:543.21}} as any})
 vi.mocked(prisma.supplierStockMovement.count).mockResolvedValue(0);vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([{c:0}])
 vi.mocked(prisma.paymentSchedule.aggregate).mockImplementation(async(q:any)=>{const key=source(q);if(failed===key)throw new Error('reference failure');const values:any={all:1277.43,overdue:overdue&&q.where.status?.in?.includes('OVERDUE')?7.89:0,seven:0,thirty:1277.43,paid:22.22,due:22.22};return{_sum:{amount:zero?0:values[key]}} as any})
 app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={userId:'u',tenantId:'tenant',role:'SUPPLIER_OWNER',supplierId:unbound?undefined:'p'}});await app.register(v2DashboardRoutes,{prefix:'/api/v2/dashboard'});await app.ready()
})
afterEach(async()=>{await app.close()})
const read=()=>app.inject({url:'/api/v2/dashboard/me'})
it('a future receivable stays exact and never claims no receivables',async()=>{
 const r=await read();expect(r.statusCode).toBe(200);const h=r.json().hero
 expect(h.value).toBe('¥1,277.43');expect(h.meta).toBe('暂无近期到期账款');expect(h.stats[1].value).toBe('¥543.21');expect(h.supplierExt.arTotal).toBe(1277.43)
})
it('genuine successful zero remains no receivables',async()=>{zero=true;const r=await read();expect(r.statusCode).toBe(200);expect(r.json().hero).toMatchObject({value:'¥0.00',meta:'✓ 暂无应收'})})
it('explicit OVERDUE remains in the overdue amount bucket',async()=>{overdue=true;const r=await read();expect(r.statusCode).toBe(200);expect(r.json().hero.supplierExt.arOverdue).toBe(7.89);expect(r.json().hero.meta).toContain('¥7.89')})
it.each(['all','overdue','seven','thirty','paid','due','delivered'])('failed %s source cannot become a successful zero supplier dashboard',async key=>{failed=key;expect((await read()).statusCode).toBe(500)})
it('unbound supplier keeps the original unavailable-account state',async()=>{unbound=true;const r=await read();expect(r.statusCode).toBe(200);expect(r.json().hero.label).toBe('账号未绑供应商');expect(prisma.paymentSchedule.aggregate).not.toHaveBeenCalled()})
