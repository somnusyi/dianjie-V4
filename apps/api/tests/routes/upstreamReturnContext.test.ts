import Fastify from 'fastify'
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest'
const mocks=vi.hoisted(()=>({supplier:vi.fn(),warehouse:vi.fn(),tenant:vi.fn(),existing:vi.fn(),returnable:vi.fn()}))
vi.mock('@dianjie/db',async original=>({...await original<typeof import('@dianjie/db')>(),prisma:{supplier:{findFirst:mocks.supplier},warehouse:{findFirst:mocks.warehouse},tenant:{findUnique:mocks.tenant},upstreamPurchaseReturn:{findFirst:mocks.existing}}}))
vi.mock('../../src/services/upstreamPurchaseReturns',async original=>({...await original<typeof import('../../src/services/upstreamPurchaseReturns')>(),listReturnableUpstreamReceiptLines:mocks.returnable}))
import {upstreamProcurementRoutes} from '../../src/routes/upstreamProcurement'
const app=Fastify()
beforeAll(async()=>{app.decorate('authenticate',async(req:any)=>{req.user={tenantId:'tenant-a',userId:'actor-a',role:req.headers['x-test-role']||'SUPPLY_CHAIN'}});await app.register(upstreamProcurementRoutes,{prefix:'/api/upstream'});await app.ready()})
afterAll(()=>app.close())
beforeEach(()=>{vi.clearAllMocks();mocks.supplier.mockResolvedValue({id:'supplier-a',no:'SUP-A',name:'来源供应商'});mocks.warehouse.mockResolvedValue({id:'warehouse-a',name:'来源仓库'});mocks.tenant.mockResolvedValue({name:'本租户机构'});mocks.existing.mockResolvedValue(null);mocks.returnable.mockResolvedValue([{id:'source-line',purchaseUnit:'袋',inventoryUnit:'kg',inventoryUnitsPerPurchaseUnit:5,returnableQuantity:{gt:()=>true,toJSON:()=>3},unitPrice:'12.25',product:{code:'SKU-A',name:'原商品'},receipt:{no:'RC-SOURCE'},purchaseReturnLines:[{purchaseQuantity:1}]}])})
const get=(suffix='',headers={})=>app.inject({method:'GET',url:`/api/upstream/purchase-returns/create-context?supplierId=supplier-a&warehouseId=warehouse-a${suffix}`,headers})
it('maps original price and frozen units into a zero quantity return draft without internal relations',async()=>{
 const result=await get();expect(result.statusCode).toBe(200)
 expect(result.json()).toMatchObject({organizationName:'本租户机构',lines:[{id:'source-line',settlementUnitPrice:'12.25',purchaseQuantity:0,returnableQuantity:3,inventoryUnitsPerPurchaseUnit:5,receiptLine:{receipt:{no:'RC-SOURCE'}}}]})
 expect(result.json().lines[0]).not.toHaveProperty('purchaseReturnLines')
 expect(mocks.returnable).toHaveBeenCalledWith({tenantId:'tenant-a',supplierId:'supplier-a',warehouseId:'warehouse-a',take:200,cursor:undefined,includeUnavailable:true})
})
it('restores only the same actor and request in the same supplier and warehouse context',async()=>{
 mocks.existing.mockResolvedValue({id:'return-original',no:'RT-ORIGINAL'})
 expect((await get('&requestKey=return-key-original')).json()).toEqual({existingSourceId:'return-original',existingNo:'RT-ORIGINAL'})
 expect(mocks.existing.mock.calls[0][0].where).toMatchObject({tenantId:'tenant-a',createdById:'actor-a',supplierId:'supplier-a',warehouseId:'warehouse-a',idempotencyKey:'return-key-original'})
 expect(mocks.returnable).not.toHaveBeenCalled()
})
it('rejects missing or inactive scoped source without returning candidates',async()=>{
 mocks.supplier.mockResolvedValue(null);expect((await get()).statusCode).toBe(404);expect(mocks.returnable).not.toHaveBeenCalled()
 expect(mocks.supplier.mock.calls[0][0].where.tenantId).toBe('tenant-a')
})
it('blocks a financial role before source queries',async()=>{
 expect((await get('',{'x-test-role':'FINANCE'})).statusCode).toBe(403);expect(mocks.supplier).not.toHaveBeenCalled()
})
it('rejects malformed recovery keys rather than fetching a different draft',async()=>{
 expect((await get('&requestKey=x')).statusCode).toBe(400);expect(mocks.existing).not.toHaveBeenCalled()
})
it('returns a continuation cursor even if the first raw page has no remaining quota',async()=>{
 mocks.returnable.mockResolvedValue(Array.from({length:200},(_,i)=>({id:`source-${i}`,returnableQuantity:{gt:()=>false}})))
 const result=await get();expect(result.statusCode).toBe(200)
 expect(result.json()).toMatchObject({lines:[],nextCursor:'source-199'})
})
it('restores an original requested row even after its quota becomes unavailable',async()=>{
 mocks.returnable.mockResolvedValueOnce([]).mockResolvedValueOnce([{id:'source-original',purchaseUnit:'袋',inventoryUnit:'kg',inventoryUnitsPerPurchaseUnit:5,returnableQuantity:0,unavailableReason:'当前可退额度已用完',unitPrice:12,receipt:{no:'RC-ORIGINAL'},product:{code:'ORIGINAL',name:'原请求物料'}}])
 const result=await get('&sourceIds=source-original')
 expect(result.statusCode).toBe(200)
 expect(result.json().lines[0]).toMatchObject({id:'source-original',returnableQuantity:0,unavailableReason:'当前可退额度已用完'})
 expect(mocks.returnable.mock.calls[1][0]).toMatchObject({tenantId:'tenant-a',supplierId:'supplier-a',warehouseId:'warehouse-a',sourceIds:['source-original'],includeUnavailable:true})
})
