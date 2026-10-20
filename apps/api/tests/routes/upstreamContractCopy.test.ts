import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(()=>({ replay:vi.fn(), supplier:vi.fn(), sources:vi.fn(), txSources:vi.fn(), contract:vi.fn(), create:vi.fn(), log:vi.fn(), transaction:vi.fn() }))
vi.mock('@dianjie/db',async importOriginal=>{
 const actual=await importOriginal<typeof import('@dianjie/db')>()
 return {...actual,prisma:{upstreamSupplierContract:{findUnique:mocks.replay},supplier:{findFirst:mocks.supplier},productUpstreamSource:{findMany:mocks.sources},$transaction:mocks.transaction}}
})
import { Prisma } from '@dianjie/db'
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'
const dec=(v:number)=>new Prisma.Decimal(v)
const line={id:'line-old',tenantId:'tenant-a',productId:'product-a',upstreamSourceId:'source-a',productCodeSnapshot:'OLD-CODE',productNameSnapshot:'原名',productSpecSnapshot:'原规格',supplierSkuSnapshot:'OLD-SKU',purchaseUnit:'箱',inventoryUnit:'袋',inventoryUnitsPerPurchaseUnit:dec(16),minOrderQty:dec(2),leadTimeDays:4,unitPrice:dec(100),taxRate:dec(.09),packageMultiple:dec(2),shortTolerancePct:dec(.01),overTolerancePct:dec(.02),startsAt:new Date('2026-01-02T00:00:00Z'),endsAt:new Date('2026-09-29T00:00:00Z'),isActive:true}
const original={id:'contract-old',supplierId:'supplier-a',tenantId:'tenant-a',contractNo:'KJ1',title:'原合同',status:'ACTIVE',version:3,startsAt:new Date('2026-01-01T00:00:00Z'),endsAt:new Date('2026-09-30T00:00:00Z'),settlementCycle:'FIXED_DAYS',settlementDays:45,taxInclusive:false,defaultTaxRate:dec(.13),currency:'USD',paymentMethod:'原付款条款',discrepancyRule:{old:true},attachments:[{name:'原附件'}],lines:[line]}
const source={id:'source-a',supplierId:'supplier-a',tenantId:'tenant-a',productId:'product-a',purchaseUnit:'箱',inventoryUnitsPerPurchaseUnit:dec(16),minOrderQty:dec(2),leadTimeDays:4,product:{id:'product-a',code:'NEW-CODE',name:'当前商品名',spec:'当前规格',inventoryUnit:'袋',unit:'袋'}}
const payload={copyFromContractId:'contract-old',supplierId:'supplier-a',contractNo:'KJ1',title:'不能覆盖的名称',startsAt:'2026-10-18',settlementCycle:'MONTHLY',settlementDays:0,taxInclusive:true,currency:'CNY',idempotencyKey:'copy-request-0001',lines:[{upstreamSourceId:'source-a',unitPrice:1200,packageMultiple:1,shortTolerancePct:0,overTolerancePct:0}]}
describe('contract copy authoritative original terms',()=>{
 let app:ReturnType<typeof Fastify>
 beforeAll(async()=>{
  app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId:'tenant-a',role:'SUPPLY_CHAIN',userId:'user-a'}})
  await app.register(upstreamProcurementRoutes,{prefix:'/api/upstream'});await app.ready()
 })
 beforeEach(()=>{
  vi.clearAllMocks();mocks.replay.mockResolvedValue(null);mocks.supplier.mockResolvedValue({id:'supplier-a'});mocks.sources.mockResolvedValue([source]);mocks.txSources.mockResolvedValue([source])
  mocks.contract.mockImplementation(async(args:any)=>args.where.id?original:{version:3})
  mocks.create.mockImplementation(async(args:any)=>({id:'new-contract',...args.data}));mocks.log.mockResolvedValue({})
  mocks.transaction.mockImplementation(async(callback:any)=>callback({upstreamSupplierContract:{findFirst:mocks.contract,create:mocks.create},productUpstreamSource:{findMany:mocks.txSources},opLog:{create:mocks.log}}))
 })
 it('copies original terms and snapshots, changes only prices and version, never touches old orders',async()=>{
  const response=await app.inject({method:'POST',url:'/api/upstream/contracts',payload})
  expect(response.statusCode).toBe(201)
  const data=mocks.create.mock.calls[0][0].data
  expect(data).toMatchObject({version:4,title:original.title,startsAt:original.startsAt,endsAt:original.endsAt,settlementCycle:'FIXED_DAYS',settlementDays:45,taxInclusive:false,currency:'USD',paymentMethod:original.paymentMethod,attachments:original.attachments,discrepancyRule:original.discrepancyRule})
  expect(data.lines.create).toEqual([{productId:line.productId,upstreamSourceId:line.upstreamSourceId,productCodeSnapshot:line.productCodeSnapshot,productNameSnapshot:line.productNameSnapshot,productSpecSnapshot:line.productSpecSnapshot,supplierSkuSnapshot:line.supplierSkuSnapshot,purchaseUnit:line.purchaseUnit,inventoryUnit:line.inventoryUnit,inventoryUnitsPerPurchaseUnit:line.inventoryUnitsPerPurchaseUnit,unitPrice:1200,taxRate:line.taxRate,minOrderQty:line.minOrderQty,packageMultiple:line.packageMultiple,leadTimeDays:line.leadTimeDays,shortTolerancePct:line.shortTolerancePct,overTolerancePct:line.overTolerancePct,startsAt:line.startsAt,endsAt:line.endsAt,isActive:true}])
  expect(mocks.contract.mock.calls[0][0].where).toMatchObject({id:'contract-old',tenantId:'tenant-a',supplierId:'supplier-a',contractNo:'KJ1',status:'ACTIVE'})
 })
 it('rechecks source conversion inside the transaction rather than trusting preflight',async()=>{
  mocks.txSources.mockResolvedValue([{...source,inventoryUnitsPerPurchaseUnit:dec(1)}])
  const response=await app.inject({method:'POST',url:'/api/upstream/contracts',payload})
  expect(response.statusCode).toBe(409);expect(mocks.create).not.toHaveBeenCalled()
 })
 it('blocks a missing original contract without creating a partial version',async()=>{
  mocks.contract.mockResolvedValue(null)
  const response=await app.inject({method:'POST',url:'/api/upstream/contracts',payload})
  expect(response.statusCode).toBe(409);expect(mocks.create).not.toHaveBeenCalled()
 })
 it('blocks a missing original line or detached source',async()=>{
  mocks.contract.mockResolvedValue({...original,lines:[line,{...line,id:'another',upstreamSourceId:null}]})
  const response=await app.inject({method:'POST',url:'/api/upstream/contracts',payload})
  expect(response.statusCode).toBe(409);expect(mocks.create).not.toHaveBeenCalled()
 })
 it.each([true,false])('rejects overprecision before DB access for copy=%s', async copying=>{
  const body:any={...payload,lines:[{...payload.lines[0],unitPrice:41.2345678}]}
  if(!copying)delete body.copyFromContractId
  const response=await app.inject({method:'POST',url:'/api/upstream/contracts',payload:body})
  expect(response.statusCode).toBe(400);expect(response.json().error).toContain('最多六位小数')
  expect(mocks.replay).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled()
 })
 it('retains six-place prices without rounding during contract copy',async()=>{
  const response=await app.inject({method:'POST',url:'/api/upstream/contracts',payload:{...payload,lines:[{...payload.lines[0],unitPrice:41.234567}]}})
  expect(response.statusCode).toBe(201);expect(mocks.create.mock.calls[0][0].data.lines.create[0].unitPrice).toBe(41.234567)
 })

})
