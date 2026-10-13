import { prisma } from '@dianjie/db'
import Fastify from 'fastify'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { inventoryReportRoutes } from '../../src/routes/inventoryReports'
let tenantId: string, userId: string, warehouseId: string, productId: string
const app = Fastify()
const list = async (id = productId) => (await app.inject({url:'/policies'})).json().items.find((r:any)=>r.productId===id)
const save = (maxQty:number, rowVersion=0, draftVersion=0, id=productId) => app.inject({method:'PATCH',url:`/policies/${id}`,payload:{warehouseId,minQty:5,maxQty,stagnantDays:30,active:true,rowVersion,draftVersion,requestId:randomUUID()}})
const act = async (action:string, row:any, id=productId, requestId=randomUUID()) => app.inject({method:'POST',url:`/policies/${id}/${action}`,payload:{warehouseId,rowVersion:row.revision.rowVersion,revisionId:row.revision.id,requestId}})
beforeAll(async()=>{
 tenantId=(await prisma.tenant.create({data:{slug:`limits-flow-${randomUUID()}`,name:'上下限审批合成测试'}})).id
 userId=(await prisma.user.create({data:{tenantId,email:'limits@local.invalid',name:'供应链合成审核',role:'SUPPLY_CHAIN',password:'unusable'}})).id
 warehouseId=(await prisma.warehouse.create({data:{tenantId,code:'LIMIT',name:'审批隔离仓',isDefault:true}})).id
 productId=(await prisma.product.create({data:{tenantId,code:'LIMIT-20-30',name:'审批专用合成物料',price:3,unit:'kg',inventoryUnit:'kg',unitConversionStatus:'VERIFIED',inventoryUnitsPerOrderUnit:1}})).id
 await prisma.warehouseInventoryPolicy.create({data:{tenantId,warehouseId,productId,inventoryUnitSnapshot:'kg',minQty:5,maxQty:20,createdById:userId,createdByName:'合成',createdByRole:'SUPPLY_CHAIN',updatedById:userId,updatedByName:'合成',updatedByRole:'SUPPLY_CHAIN'}})
 app.decorate('authenticate',async(req:any)=>{req.user={tenantId:req.headers['x-tenant']||tenantId,userId,role:req.headers['x-role']||'SUPPLY_CHAIN'}})
 await app.register(inventoryReportRoutes);await app.ready()
})
afterAll(async()=>{await app.close();await prisma.$disconnect()})
it('save, submit and audit preserve 20; review applies 30; review is final and cannot be cancelled or reversed',async()=>{
 const beforeMovements=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
 const s=await save(30);expect(s.statusCode,s.body).toBe(200);let row=s.json()
 expect(row.revision.status).toBe('DRAFT');expect((await list()).maxQty).toBe(20)
 for(const action of ['submit','audit']){const r=await act(action,row);expect(r.statusCode,r.body).toBe(200);row=r.json();expect((await list()).maxQty).toBe(20)}
 const requestId=randomUUID(),pending={...row}
 const reviews=await Promise.all([act('review',pending,productId,requestId),act('review',pending,productId,requestId)])
 expect(reviews.map(r=>r.statusCode)).toEqual([200,200]);row=reviews[0].json();expect((await list()).maxQty).toBe(30)
 expect(await prisma.warehouseInventoryPolicyRevisionEvent.count({where:{tenantId,action:'review'}})).toBe(1)
 expect((await act('unconfirm',row)).statusCode).toBe(409)
 expect((await act('unreview',row)).statusCode).toBe(409);expect((await list()).maxQty).toBe(30)
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(beforeMovements)
 expect(await prisma.warehouseLedgerBalance.count({where:{tenantId}})).toBe(0)
})
it('finance/cross-tenant and stale version are rejected, without changing effective policy',async()=>{
 const current=await list(),request={method:'POST' as const,url:`/policies/${productId}/audit`,payload:{warehouseId,rowVersion:current.revision.rowVersion,revisionId:current.revision.id,requestId:randomUUID()}}
 expect((await app.inject({...request,headers:{'x-role':'FINANCE'}})).statusCode).toBe(403)
 expect((await app.inject({...request,headers:{'x-tenant':'missing-tenant'}})).statusCode).toBe(404)
 expect((await app.inject({...request,payload:{...request.payload,rowVersion:999}})).statusCode).toBe(409)
 expect((await list()).maxQty).toBe(30)
})
it('final review retains the frozen legacy basis without a cancellation path',async()=>{
 const id=(await prisma.product.create({data:{tenantId,code:'LIMIT-LEGACY',name:'旧规则兼容合成物料',price:3,unit:'kg',inventoryUnit:'kg',minStock:5,inventoryUnitsPerOrderUnit:2,unitConversionStatus:'VERIFIED'}})).id
 expect((await list(id)).minQty).toBe(10)
 let response=await save(30,0,0,id),row=response.json();expect(response.statusCode,response.body).toBe(200)
 for(const action of ['submit','audit','review']){if(action==='unreview')await prisma.product.update({where:{id},data:{minStock:99}});response=await act(action,row,id);expect(response.statusCode,response.body).toBe(200);row=response.json()}
 expect(await list(id)).toMatchObject({minQty:5,maxQty:30,source:'configured',active:true})
 expect(row.revision.previousEffective.minQty).toBe(10)
 expect((await act('unreview',row,id)).statusCode).toBe(409)
})

it('two different first saves from an absent revision cannot overwrite one another',async()=>{
 const id=(await prisma.product.create({data:{tenantId,code:'LIMIT-FIRST-CAS',name:'首次CAS合成物料',price:3,unit:'kg',inventoryUnit:'kg',inventoryUnitsPerOrderUnit:1,unitConversionStatus:'VERIFIED'}})).id
 const responses=await Promise.all([save(30,0,0,id),save(35,0,0,id)])
 expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409])
 const revision=await prisma.warehouseInventoryPolicyRevision.findFirstOrThrow({where:{tenantId,warehouseId,productId:id,isCurrent:true}})
 expect(revision.rowVersion).toBe(1)
 expect(await prisma.warehouseInventoryPolicyRevisionEvent.count({where:{tenantId,revisionId:revision.id,action:'save'}})).toBe(1)
})
it('a new revision retains current30 until final review40 and preserves both completed cycles',async()=>{
 let row={revision:(await list()).revision}
 const firstId=row.revision.id
 expect((await list()).effectiveMax).toBe(30)
 const response=await act('revise',row);expect(response.statusCode,response.body).toBe(200);row=response.json()
 expect(row.revision.id).not.toBe(firstId);expect(row.revision.cycleNumber).toBe(2)
 const current=await list()
 const saved=await app.inject({method:'PATCH',url:`/policies/${productId}`,payload:{warehouseId,minQty:5,maxQty:40,stagnantDays:30,active:true,rowVersion:current.rowVersion,draftVersion:row.revision.rowVersion,revisionId:row.revision.id,requestId:randomUUID()}})
 expect(saved.statusCode,saved.body).toBe(200);row=saved.json()
 for(const action of ['submit','audit']){const r=await act(action,row);expect(r.statusCode,r.body).toBe(200);row=r.json();expect((await list()).effectiveMax).toBe(30)}
 const reviewed=await act('review',row);expect(reviewed.statusCode,reviewed.body).toBe(200);row=reviewed.json();expect((await list()).effectiveMax).toBe(40)
 expect((await act('unreview',row)).statusCode).toBe(409);expect((await list()).effectiveMax).toBe(40)
 const old=await prisma.warehouseInventoryPolicyRevision.findUniqueOrThrow({where:{id:firstId}})
 expect(old.status).toBe('REVIEWED');expect(old.isCurrent).toBe(false)
 expect(await prisma.warehouseInventoryPolicyRevision.count({where:{tenantId,warehouseId,productId}})).toBe(2)
 const staleOld=await app.inject({method:'POST',url:`/policies/${productId}/unconfirm`,payload:{warehouseId,rowVersion:row.revision.rowVersion,revisionId:firstId,requestId:randomUUID()}})
 expect(staleOld.statusCode).toBe(409)
})
it('effective limits match alert parsing for disabled and mismatched-unit policies',async()=>{
 const actor={createdById:userId,createdByName:'合成',createdByRole:'SUPPLY_CHAIN',updatedById:userId,updatedByName:'合成',updatedByRole:'SUPPLY_CHAIN'}
 for(const [code,active,inventoryUnit] of [['LIMIT-OFF',false,'kg'],['LIMIT-UNIT',true,'箱']] as const){
  const p=await prisma.product.create({data:{tenantId,code,name:code,price:3,unit:'kg',inventoryUnit:'kg',unitConversionStatus:'VERIFIED'}})
  await prisma.warehouseInventoryPolicy.create({data:{tenantId,warehouseId,productId:p.id,inventoryUnitSnapshot:'kg',minQty:5,maxQty:20,active,...actor}})
  await prisma.warehouseLedgerBalance.create({data:{tenantId,warehouseId,productId:p.id,inventoryUnit,physicalQty:3,reservedQty:0,inventoryValue:6,averageUnitCost:2}})
  const row=await list(p.id);expect(row.effectiveMin).toBeNull();expect(row.effectiveMax).toBeNull();expect(row.storedUnit).toBe('kg');expect(row.minQty).toBe(5)
 }
})

it('requires explicit re-entry in the current unit when an older draft unit changes',async()=>{
 const id=(await prisma.product.create({data:{tenantId,code:'LIMIT-UNIT-RECHECK',name:'单位重新核对合成',price:3,unit:'kg',inventoryUnit:'kg',unitConversionStatus:'VERIFIED'}})).id
 const first=await save(30,0,0,id);expect(first.statusCode,first.body).toBe(200)
 await prisma.product.update({where:{id},data:{inventoryUnit:'箱'}})
 const current=await list(id);expect(current.unitChanged).toBe(true)
 const body={warehouseId,minQty:5,maxQty:30,stagnantDays:30,active:true,rowVersion:0,draftVersion:current.revision.rowVersion,revisionId:current.revision.id,confirmUnitChange:true}
 for(const snapshot of [undefined,'kg']){
  const failed=await app.inject({method:'PATCH',url:`/policies/${id}`,payload:{...body,inventoryUnitSnapshot:snapshot,requestId:randomUUID()}})
  expect(failed.statusCode,failed.body).toBe(409)
 }
 expect((await list(id)).revision.payload.inventoryUnitSnapshot).toBe('kg')
 const accepted=await app.inject({method:'PATCH',url:`/policies/${id}`,payload:{...body,inventoryUnitSnapshot:'箱',minQty:1,maxQty:3,requestId:randomUUID()}})
 expect(accepted.statusCode,accepted.body).toBe(200)
 expect(accepted.json().revision.payload).toMatchObject({inventoryUnitSnapshot:'箱',minQty:1,maxQty:3})
 expect(await prisma.warehouseInventoryPolicy.count({where:{tenantId,productId:id}})).toBe(0)
})

it('exact rule reader requires an explicit warehouse and preserves the list projection with tenant and role boundaries',async()=>{
 const query=`warehouseId=${warehouseId}`
 const detail=await app.inject({url:`/policies/${productId}?${query}`})
 expect(detail.statusCode,detail.body).toBe(200)
 expect(detail.json().items).toHaveLength(1)
 expect(detail.json().items[0]).toEqual(await list())
 expect(detail.json().warehouse.id).toBe(warehouseId)
 expect((await app.inject({url:`/policies/${productId}`})).statusCode).toBe(400)
 expect((await app.inject({url:`/policies/${productId}?warehouseId=missing`})).statusCode).toBe(404)
 expect((await app.inject({url:`/policies/${productId}?${query}`,headers:{'x-role':'STORE'}})).statusCode).toBe(403)
 const foreign=await prisma.tenant.create({data:{slug:`exact-policy-foreign-${randomUUID()}`,name:'精确读取隔离租户'}})
 const foreignWarehouse=await prisma.warehouse.create({data:{tenantId:foreign.id,code:'ONLY',name:'其他租户仓'}})
 expect((await app.inject({url:`/policies/${productId}?warehouseId=${foreignWarehouse.id}`})).statusCode).toBe(404)
 expect((await app.inject({url:`/policies/${productId}?warehouseId=${foreignWarehouse.id}`,headers:{'x-tenant':foreign.id}})).statusCode).toBe(404)
})

it('rule history paginates only the exact tenant warehouse and product and never changes revisions',async()=>{
 const scope={tenantId,warehouseId,productId}
 const before=JSON.stringify(await prisma.warehouseInventoryPolicyRevision.findMany({where:scope,orderBy:{id:'asc'}}))
 const where={tenantId,revision:scope}
 const revisions=await prisma.warehouseInventoryPolicyRevisionEvent.findMany({where,select:{requestId:true,action:true}})
 const policyEvents=await prisma.warehouseInventoryPolicyEvent.findMany({where:{tenantId,policy:scope},select:{requestId:true}})
 const reviewKeys=new Set(revisions.filter(r=>['review','unreview'].includes(r.action)).map(r=>r.requestId))
 const total=revisions.length+policyEvents.filter(r=>!reviewKeys.has(r.requestId)).length
 expect(total).toBeGreaterThan(1)
 const first=await app.inject({url:`/policies/${productId}/history?warehouseId=${warehouseId}&pageSize=1`})
 const second=await app.inject({url:`/policies/${productId}/history?warehouseId=${warehouseId}&pageSize=1&page=2`})
 expect(first.statusCode,first.body).toBe(200);expect(second.statusCode,second.body).toBe(200)
 expect(first.json().total).toBe(total)
 expect(first.json().items).toHaveLength(1)
 expect(second.json().items[0].id).not.toBe(first.json().items[0].id)
 expect(['REVISION','POLICY']).toContain(first.json().items[0].sourceType)
 expect(first.json().items[0]).not.toHaveProperty('requestId')
 expect((await app.inject({url:`/policies/${productId}/history`})).statusCode).toBe(400)
 expect((await app.inject({url:`/policies/absent/history?warehouseId=${warehouseId}`})).statusCode).toBe(404)
 expect((await app.inject({url:`/policies/${productId}/history?warehouseId=${warehouseId}`,headers:{'x-role':'STORE'}})).statusCode).toBe(403)
 expect(JSON.stringify(await prisma.warehouseInventoryPolicyRevision.findMany({where:scope,orderBy:{id:'asc'}}))).toBe(before)
})

it('history includes retained legacy policy events without fabricating an approval cycle',async()=>{
 const policy=await prisma.warehouseInventoryPolicy.findFirstOrThrow({where:{tenantId,warehouseId,productId}})
 const event=await prisma.warehouseInventoryPolicyEvent.create({data:{tenantId,policyId:policy.id,actorId:userId,actorName:'历史合成人员',actorRole:'SUPPLY_CHAIN',requestId:randomUUID(),requestFingerprint:'a'.repeat(64),beforeValue:{maxQty:10},afterValue:{maxQty:20}}})
 const response=await app.inject({url:`/policies/${productId}/history?warehouseId=${warehouseId}&pageSize=100`})
 expect(response.statusCode,response.body).toBe(200)
 expect(response.json().items.find((r:any)=>r.id===`policy:${event.id}`)).toMatchObject({sourceType:'POLICY',revision:null,actorName:'历史合成人员',beforeValue:{maxQty:10},afterValue:{maxQty:20}})
 expect(response.json().items.some((r:any)=>r.sourceType==='REVISION'&&r.revision.cycleNumber>0)).toBe(true)
 expect(await prisma.warehouseInventoryPolicyEvent.findUnique({where:{id:event.id}})).not.toBeNull()
})

it('history links the effective write to its real review rather than displaying the same operation twice',async()=>{
 const reviews=await prisma.warehouseInventoryPolicyRevisionEvent.findMany({where:{tenantId,revision:{tenantId,warehouseId,productId},action:'review'}})
 expect(reviews.length).toBeGreaterThan(0)
 const response=await app.inject({url:`/policies/${productId}/history?warehouseId=${warehouseId}&pageSize=100`})
 expect(response.statusCode,response.body).toBe(200)
 for(const review of reviews){
  const policy=await prisma.warehouseInventoryPolicyEvent.findUnique({where:{tenantId_requestId:{tenantId,requestId:review.requestId}}})
  expect(policy).not.toBeNull()
  const item=response.json().items.find((r:any)=>r.id===`revision:${review.id}`)
  expect(item.effectiveEvent).toMatchObject({id:policy!.id,afterValue:policy!.afterValue,beforeValue:policy!.beforeValue})
  expect(response.json().items.some((r:any)=>r.id===`policy:${policy!.id}`)).toBe(false)
  expect(item.effectiveEvent).not.toHaveProperty('requestId')
 }
})
