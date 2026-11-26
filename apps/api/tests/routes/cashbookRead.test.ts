import Fastify from 'fastify'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {prisma} from '@dianjie/db'
import {cashbookRoutes} from '../../src/routes/cashbook'
vi.mock('@dianjie/db',()=>({Prisma:{},prisma:{cashTransaction:{findMany:vi.fn(),count:vi.fn()}}}))
vi.mock('../../src/services/cmbPayment',()=>({cmbTransfer:vi.fn(),reportCmbError:vi.fn()}))
vi.mock('../../src/services/voucher',()=>({voucherForInternalTransfer:vi.fn()}))
vi.mock('../../src/services/cmbAutoSync',()=>({syncCmbAccount:vi.fn()}))
vi.mock('../../src/services/cashbook',()=>({writeCashTransaction:vi.fn()}))
let app:ReturnType<typeof Fastify>
beforeEach(async()=>{
 vi.resetAllMocks();vi.mocked(prisma.cashTransaction.findMany).mockResolvedValue([{id:'t100'}] as any);vi.mocked(prisma.cashTransaction.count).mockResolvedValue(101)
 app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId:'local-tenant',role:req.headers['x-role']||'FINANCE'}})
 await app.register(cashbookRoutes,{prefix:'/api/cashbook'});await app.ready()
})
afterEach(async()=>{await app.close()})
it('returns actual pagination metadata and a stable tenant-scoped transaction order',async()=>{
 const r=await app.inject({url:'/api/cashbook/transactions?accountId=cash-a&month=2026-10&page=2&pageSize=200'})
 expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({total:101,page:2,pageSize:100,items:[{id:'t100'}]})
 expect(prisma.cashTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({tenantId:'local-tenant',accountId:'cash-a'}),orderBy:[{txDate:'desc'},{id:'desc'}],skip:100,take:100}))
 expect(prisma.cashTransaction.count).toHaveBeenCalledWith({where:expect.objectContaining({tenantId:'local-tenant',accountId:'cash-a'})})
})
it('does not grant supplier or store users cashbook access',async()=>{
 for(const role of ['SUPPLIER_OWNER','SUPPLY_CHAIN','MANAGER']){
 const r=await app.inject({url:'/api/cashbook/transactions?accountId=cash-a',headers:{'x-role':role}});expect(r.statusCode).toBe(403)
 }
 expect(prisma.cashTransaction.findMany).not.toHaveBeenCalled()
})
it('query failure stays an error rather than a successful empty export source',async()=>{
 vi.mocked(prisma.cashTransaction.findMany).mockRejectedValue(new Error('reference unavailable'))
 const r=await app.inject({url:'/api/cashbook/transactions?accountId=cash-a'});expect(r.statusCode).toBe(500)
})
