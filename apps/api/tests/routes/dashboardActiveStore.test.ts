import Fastify from 'fastify'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {prisma} from '@dianjie/db'
import {v2DashboardRoutes} from '../../src/routes/v2Dashboard'
import {estimatedStoreInventory} from '../../src/services/storeInventory'
vi.mock('@dianjie/db',()=>({prisma:{user:{findUnique:vi.fn()},store:{findFirst:vi.fn()},revenueRecord:{aggregate:vi.fn(),findMany:vi.fn(),count:vi.fn()},purchaseOrder:{count:vi.fn()},receipt:{aggregate:vi.fn()},stockConsumption:{aggregate:vi.fn()},lossClaim:{aggregate:vi.fn()}}}))
vi.mock('../../src/services/storeInventory',()=>({estimatedStoreInventory:vi.fn()}))
let actor:any;let app:ReturnType<typeof Fastify>
beforeEach(async()=>{
 vi.resetAllMocks();actor={userId:'u',tenantId:'t',role:'MANAGER',storeId:'a',storeIds:['a','b']}
 vi.mocked(prisma.user.findUnique).mockResolvedValue({id:'u',name:'店长',role:'MANAGER',store:{id:'a',name:'一号'},supplier:null} as any)
 vi.mocked(prisma.store.findFirst).mockImplementation(async(q:any)=>({id:q.where.id,name:q.where.id==='b'?'东城':'一号',no:q.where.id}) as any)
 vi.mocked(prisma.revenueRecord.aggregate).mockResolvedValue({_sum:{amount:0}} as any);vi.mocked(prisma.revenueRecord.findMany).mockResolvedValue([]);vi.mocked(prisma.revenueRecord.count).mockResolvedValue(0)
 vi.mocked(prisma.purchaseOrder.count).mockResolvedValue(0);vi.mocked(prisma.receipt.aggregate).mockResolvedValue({_sum:{totalAmount:0}} as any);vi.mocked(prisma.stockConsumption.aggregate).mockResolvedValue({_sum:{costAmountSnapshot:0}} as any);vi.mocked(prisma.lossClaim.aggregate).mockResolvedValue({_sum:{totalLossAmount:0}} as any)
 vi.mocked(estimatedStoreInventory).mockResolvedValue({summary:{itemCount:0}} as any)
 app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user=actor});await app.register(v2DashboardRoutes,{prefix:'/api/v2/dashboard'});await app.ready()
})
afterEach(async()=>{await app.close()})
const read=(store?:string)=>app.inject({url:'/api/v2/dashboard/me',headers:store?{'x-active-store':store}:{}})
it.each(['MANAGER','REGIONAL_MANAGER','SUPERVISOR','KITCHEN_LEAD'])('%s scopes all aggregates and response to the selected permitted store',async role=>{
 actor.role=role;const r=await read('b');expect(r.statusCode).toBe(200);expect(r.json().store).toMatchObject({id:'b',name:'东城'});expect(r.json().user.store.id).toBe('b')
 for(const fn of [prisma.revenueRecord.aggregate,prisma.revenueRecord.findMany,prisma.revenueRecord.count,prisma.purchaseOrder.count,prisma.receipt.aggregate,prisma.stockConsumption.aggregate,prisma.lossClaim.aggregate])for(const [q] of vi.mocked(fn).mock.calls as any)expect(q.where.storeId).toBe('b')
 if(role!=='KITCHEN_LEAD')expect(estimatedStoreInventory).toHaveBeenCalledWith('t','b')
 expect(prisma.store.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:'b',tenantId:'t',status:'ENABLED'}}))
})
it('defaults to the first permitted store',async()=>{actor.storeId='b';expect((await read()).json().store.id).toBe('a')})
it('refuses unassigned stores before data queries',async()=>{expect((await read('foreign')).statusCode).toBe(403);expect(prisma.store.findFirst).not.toHaveBeenCalled();expect(prisma.revenueRecord.aggregate).not.toHaveBeenCalled()})
it('refuses an unbound store-scoped account',async()=>{actor.storeId=null;actor.storeIds=[];expect((await read()).statusCode).toBe(403);expect(prisma.revenueRecord.aggregate).not.toHaveBeenCalled()})
it('refuses a missing or other-tenant store before aggregation',async()=>{vi.mocked(prisma.store.findFirst).mockResolvedValue(null);expect((await read('b')).statusCode).toBe(403);expect(prisma.revenueRecord.aggregate).not.toHaveBeenCalled()})
