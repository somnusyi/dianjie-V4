import { prisma,Prisma } from '@dianjie/db'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { draftPayloadSchema, saveInboundDraft, submitInboundDraft } from '../../src/services/warehouseInboundDrafts'
import * as docs from '../../src/services/warehouseDocs'
import { recordManualWarehouseInbound, reverseManualWarehouseInbound } from '../../src/services/warehouseLedger'
import { registerWarehouseInboundDraftRoutes } from '../../src/routes/warehouseInboundDrafts'
import { warehouseDocsRoutes } from '../../src/routes/warehouseDocs'
import {warehouseInventoryRoutes} from '../../src/routes/warehouseInventory'
vi.mock('../../src/routes/upload',()=>({signOssKey:(key:string)=>`https://fixture.invalid/${key}`,assertWarehouseDocumentObjects:vi.fn().mockResolvedValue(undefined)}))
let tenantId:string, userId:string, otherId:string, financeId:string, supplierId:string, productId:string
let seq=0
const app=Fastify()
const payload=(extra:any={})=>draftPayloadSchema.parse({mode:'SINGLE',supplierId,productId,purchaseQuantity:'1',totalAmount:'2',singleUnitPrice:'2',effectiveAt:'2026-10-11T10:00',effectiveAtIso:'2026-10-11T17:00:00Z',...extra})
const save=async(extra:any={})=>saveWithDisplayedUnits({tenantId,userId,id:`draft-test-${Date.now()}-${++seq}`,baseVersion:0,payload:payload(extra)})
async function saveWithDisplayedUnits(input:Parameters<typeof saveInboundDraft>[0]){
 if(!input.payload.displayUnits){
  const ids=input.payload.mode==='SINGLE'?[input.payload.productId]:input.payload.rows.map(row=>row.productId)
  const products=await prisma.product.findMany({where:{tenantId:input.tenantId,id:{in:ids}}})
  input={...input,payload:{...input.payload,displayUnits:products.map(product=>({productId:product.id,unit:(input.payload.mode==='OUTBOUND'?product.inventoryUnit:product.purchaseUnit)||'',inventoryUnit:product.inventoryUnit||'',conversionFactor:input.payload.mode==='OUTBOUND'?1:Number(product.inventoryUnitsPerPurchaseUnit)}))}}
 }
 return saveInboundDraft(input)
}
const discard=async(id:string)=>prisma.warehouseInboundDraft.update({where:{id},data:{status:'DISCARDED'}})
beforeAll(async()=>{
 tenantId=(await prisma.tenant.create({data:{slug:`dj010-drafts-${Date.now()}`,name:'DJ010独立合成测试'}})).id
 await prisma.warehouse.create({data:{tenantId,code:'DRAFT',name:'草稿事务仓',isDefault:true,inventoryMode:'SHADOW'}})
 userId=(await prisma.user.create({data:{tenantId,email:'draft@local.invalid',name:'草稿录入夹具',role:'SUPPLY_CHAIN',password:'unusable'}})).id
 otherId=(await prisma.user.create({data:{tenantId,email:'other@local.invalid',name:'隔离夹具',role:'SUPPLY_CHAIN',password:'unusable'}})).id
 financeId=(await prisma.user.create({data:{tenantId,email:'finance@local.invalid',name:'复审夹具',role:'FINANCE',password:'unusable'}})).id
 supplierId=(await prisma.supplier.create({data:{tenantId,no:'SUP001',name:'合成上游',status:'ENABLED',businessScopes:['WAREHOUSE_UPSTREAM']}})).id
 productId=(await prisma.product.create({data:{tenantId,code:'DRAFT001',name:'草稿合成商品',price:2,unit:'kg',purchaseUnit:'kg',inventoryUnit:'kg',orderUnit:'kg',costUnit:'kg',inventoryUnitsPerPurchaseUnit:1,inventoryUnitsPerOrderUnit:1,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED'}})).id
 app.decorate('authenticate',async(req:any)=>{req.user={tenantId,userId:req.headers['x-actor']||userId,role:req.headers['x-role']||'SUPPLY_CHAIN'}})
 registerWarehouseInboundDraftRoutes(app,{preHandler:[(app as any).authenticate]})
 await app.register(warehouseDocsRoutes,{prefix:'/docs'});await app.register(warehouseInventoryRoutes,{prefix:'/inventory'});await app.ready()
})
afterAll(async()=>{await app.close();await prisma.$disconnect()})
describe('DJ010 draft audit atomic contract',()=>{
 it('saves incomplete strings without creating stock or documents; server retrieval is owner-only',async()=>{
  const draft=await save({purchaseQuantity:'',totalAmount:'',note:'未完成输入'})
  expect(await prisma.warehouseDoc.count({where:{tenantId}})).toBe(0)
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(0)
  expect((await app.inject({url:'/inbound-drafts?mode=SINGLE'})).json().draft.id).toBe(draft.id)
  expect((await app.inject({url:'/inbound-drafts?mode=SINGLE',headers:{'x-actor':otherId}})).json().draft).toBeNull()
  await expect(saveWithDisplayedUnits({tenantId,userId:otherId,id:draft.id,baseVersion:draft.version,payload:payload()})).rejects.toThrow('不存在')
  expect((await app.inject({method:'POST',url:`/inbound-drafts/${draft.id}/submit`,headers:{'x-actor':otherId},payload:{version:draft.version}})).statusCode).toBe(404)
  await discard(draft.id)
 })
 it('CAS rejects stale differing input and retries identical input without incrementing',async()=>{
  const first=await save()
  const second=await saveWithDisplayedUnits({tenantId,userId,id:first.id,baseVersion:first.version,payload:payload({note:'另一设备修改'})})
  await expect(saveWithDisplayedUnits({tenantId,userId,id:first.id,baseVersion:first.version,payload:payload({note:'过时输入'})})).rejects.toThrow('其他页面')
  expect((await saveWithDisplayedUnits({tenantId,userId,id:first.id,baseVersion:first.version,payload:payload({note:'另一设备修改'})})).version).toBe(second.version)
  await discard(first.id)
 })
 it('rolls back ledger writes if document creation fails, and preserves the editable draft',async()=>{
  const draft=await save();const spy=vi.spyOn(docs,'ensureWarehouseDocInTransaction').mockRejectedValueOnce(Error('injected document failure'))
  await expect(submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version})).rejects.toThrow('injected');spy.mockRestore()
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(0)
  expect(await prisma.warehouseLedgerLot.count({where:{tenantId}})).toBe(0)
  expect((await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}})).status).toBe('EDITING')
  await discard(draft.id)
 })
 it('rejects invalid dates and a bad later batch line without partial posting',async()=>{
  const draft=await save({manufactureDate:'2026-99-99'})
  await expect(submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version})).rejects.toThrow('日期无效');await discard(draft.id)
  const batch=await saveWithDisplayedUnits({tenantId,userId,id:`draft-batch-${Date.now()}-${++seq}`,baseVersion:0,payload:draftPayloadSchema.parse({mode:'BATCH',supplierId,effectiveAtIso:'2026-10-11T17:00:00Z',rows:[{productId,purchaseQuantity:'1',amount:'2'},{productId:'absent-product',purchaseQuantity:'1',amount:'2'}]})})
  await expect(submitInboundDraft({tenantId,userId,id:batch.id,version:batch.version})).rejects.toThrow()
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(0);await discard(batch.id)
 })
 it('simultaneous submit and response-loss retry produce one confirmed receipt, movement and audit',async()=>{
  const draft=await save();const input={tenantId,userId,id:draft.id,version:draft.version}
  const results=await Promise.all([submitInboundDraft(input),submitInboundDraft(input)])
  expect(results.filter(r=>!r.replayed)).toHaveLength(1)
  const doc=results[0].doc;expect(doc.status).toBe('CONFIRMED')
  expect((await submitInboundDraft(input)).doc.id).toBe(doc.id)
  expect((await app.inject({url:`/inbound-drafts/${draft.id}`})).json().draft).toMatchObject({status:'SUBMITTED',docId:doc.id})
  expect((await app.inject({url:`/inbound-drafts/${draft.id}`,headers:{'x-actor':otherId}})).json().draft).toBeNull()
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,type:'MANUAL_INBOUND'}})).toBe(1)
  expect(await prisma.warehouseDocLog.count({where:{docId:doc.id,action:'CONFIRM'}})).toBe(1)
  expect(Number((await prisma.warehouseLedgerBalance.findFirstOrThrow({where:{tenantId,productId}})).inventoryValue)).toBe(2)
  await expect(saveWithDisplayedUnits({tenantId,userId,id:draft.id,baseVersion:draft.version,payload:payload({note:'迟到保存'})})).rejects.toThrow('已提交')
  const line=await prisma.warehouseDocLine.findFirstOrThrow({where:{docId:doc.id}})
  await expect(reverseManualWarehouseInbound({tenantId,userId,movementId:line.movementId!,reason:'绕过审核冲销',idempotencyKey:'blocked-confirmed'})).rejects.toThrow('先对入库单反审核')
  const financeHeaders={'x-role':'FINANCE','x-actor':financeId}
  for(const action of ['review','confirm','unconfirm']){const denied=await app.inject({method:'POST',url:`/docs/${doc.id}/${action}`,headers:financeHeaders,payload:{reason:'财务不得审核入库'}});expect(denied.statusCode).toBe(403)}
  const reviewed=await app.inject({method:'POST',url:`/docs/${doc.id}/review`,headers:{'x-role':'SUPPLY_CHAIN','x-actor':userId}});expect(reviewed.statusCode).toBe(200)
  expect((await docs.reviewWarehouseDoc({tenantId,userId,docId:doc.id})).changed).toBe(false)
  expect(await prisma.warehouseDocLog.count({where:{docId:doc.id,action:'REVIEW'}})).toBe(1)
  await expect(docs.unconfirmWarehouseDoc({tenantId,userId,docId:doc.id,reason:'已复审退回'})).rejects.toThrow('复审')
  await expect(reverseManualWarehouseInbound({tenantId,userId,movementId:line.movementId!,reason:'绕过复审冲销',idempotencyKey:'blocked-reviewed'})).rejects.toThrow('已复审')
  expect(Number((await prisma.warehouseLedgerBalance.findFirstOrThrow({where:{tenantId,productId}})).inventoryValue)).toBe(2)
 })
 it('soft discard is repeatable and never creates stock',async()=>{
  const draft=await save();const req={method:'POST' as const,url:`/inbound-drafts/${draft.id}/discard`,payload:{version:draft.version}}
  expect((await app.inject(req)).statusCode).toBe(200);expect((await app.inject(req)).statusCode).toBe(200)
  expect((await app.inject({url:'/inbound-drafts?mode=SINGLE'})).json().draft).toBeNull()
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,type:'MANUAL_INBOUND'}})).toBe(1)
 })
})

it('separate Submit stays pending, replay does not audit, Audit changes status without another posting', async () => {
 const draft=await save({note:'DEC038 独立提交'})
 const before=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
 const request={method:'POST' as const,url:`/inbound-drafts/${draft.id}/submit`,payload:{version:draft.version,auditOnSubmit:false}}
 const response=await app.inject(request)
 expect(response.statusCode,response.body).toBe(200)
 const doc=response.json().doc
 expect(doc.status).toBe('POSTED')
 expect(await prisma.warehouseDocLog.count({where:{docId:doc.id,action:'CONFIRM'}})).toBe(0)
 const after=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
 expect(after).toBe(before+1)
 const replay=await app.inject({...request,payload:{version:draft.version,auditOnSubmit:true}})
 expect(replay.statusCode).toBe(200)
 expect(replay.json().replayed).toBe(true)
 expect(replay.json().doc.status).toBe('POSTED')
 const stockBeforeAudit=JSON.stringify(await prisma.warehouseLedgerBalance.findMany({where:{tenantId,productId}}))
 const audited=await app.inject({method:'POST',url:`/docs/${doc.id}/confirm`,payload:{}})
 expect(audited.statusCode).toBe(200)
 expect(audited.json().status).toBe('CONFIRMED')
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(after)
 expect(JSON.stringify(await prisma.warehouseLedgerBalance.findMany({where:{tenantId,productId}}))).toBe(stockBeforeAudit)
 expect(await prisma.warehouseDocLog.count({where:{docId:doc.id,action:'CONFIRM'}})).toBe(1)
})

it('explicit gift keeps quantity/conversion but records zero amount/cost; ordinary zero and positive gifts are rejected',async()=>{
 const product=await prisma.product.create({data:{tenantId,code:'GIFT001',name:'独立赠品物料',price:3,unit:'箱',purchaseUnit:'箱',inventoryUnit:'瓶',orderUnit:'箱',costUnit:'瓶',inventoryUnitsPerPurchaseUnit:12,inventoryUnitsPerOrderUnit:12,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED'}})
 for(const values of [{isGift:false,totalAmount:'0'},{isGift:true,totalAmount:'3'}]){
  const invalid=await save({productId:product.id,purchaseQuantity:'2',...values})
  await expect(submitInboundDraft({tenantId,userId,id:invalid.id,version:invalid.version,auditOnSubmit:false})).rejects.toThrow('明确赠品')
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,productId:product.id}})).toBe(0)
  await discard(invalid.id)
 }
 const draft=await save({productId:product.id,purchaseQuantity:'2',totalAmount:'0',singleUnitPrice:'0',isGift:true})
 const created=await submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})
 const line=await prisma.warehouseDocLine.findFirstOrThrow({where:{docId:created.doc.id}})
 expect(line.isGift).toBe(true);expect(Number(line.quantity)).toBe(2);expect(Number(line.inventoryQuantity)).toBe(24)
 expect(Number(line.amount)).toBe(0);expect(Number(line.unitPrice)).toBe(0)
 const lot=await prisma.warehouseLedgerLot.findFirstOrThrow({where:{tenantId,productId:product.id}})
 expect(Number(lot.initialQty)).toBe(24);expect(Number(lot.inventoryUnitCost)).toBe(0)
 await expect(docs.editWarehouseDoc({tenantId,userId,docId:created.doc.id,editReason:'不可把赠品改成正价',lines:[{lineId:line.id,amount:1}]})).rejects.toThrow('金额无效')
 const edited=await docs.editWarehouseDoc({tenantId,userId,docId:created.doc.id,editReason:'核对赠品数量',lines:[{lineId:line.id,quantity:3}]})
 expect(edited.changed).toBe(true)
 const revised=await prisma.warehouseDocLine.findUniqueOrThrow({where:{id:line.id}})
 expect(revised.isGift).toBe(true);expect(Number(revised.inventoryQuantity)).toBe(36);expect(Number(revised.amount)).toBe(0)
 const balance=await prisma.warehouseLedgerBalance.findFirstOrThrow({where:{tenantId,productId:product.id}})
 expect(Number(balance.physicalQty)).toBe(36);expect(Number(balance.inventoryValue)).toBe(0)
})
it('batch gift has explicit zero semantics and does not turn ordinary zero rows into gifts',async()=>{
 const product=await prisma.product.create({data:{tenantId,code:'GIFT002',name:'批量赠品物料',price:3,unit:'kg',purchaseUnit:'kg',inventoryUnit:'kg',orderUnit:'kg',costUnit:'kg',inventoryUnitsPerPurchaseUnit:1,inventoryUnitsPerOrderUnit:1,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED'}})
 const draft=await saveWithDisplayedUnits({tenantId,userId,id:`batch-gift-${Date.now()}`,baseVersion:0,payload:draftPayloadSchema.parse({mode:'BATCH',supplierId,effectiveAtIso:'2026-10-11T17:00:00Z',rows:[{productId:product.id,purchaseQuantity:'1',unitPrice:'0',amount:'0',isGift:true,note:'供应商赠送'}]})})
 const result=await submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})
 const line=await prisma.warehouseDocLine.findFirstOrThrow({where:{docId:result.doc.id}})
 expect(line.isGift).toBe(true);expect(line.note).toBe('供应商赠送');expect(Number(line.amount)).toBe(0)
 const before=await prisma.warehouseLedgerMovement.count({where:{tenantId,productId:product.id}})
 expect((await submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})).replayed).toBe(true)
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,productId:product.id}})).toBe(before)
})

it('date-only manufacture/expiry input survives database storage on the same calendar day',async()=>{
 const draft=await save({manufactureDate:'2026-10-10',expiryDate:'2026-11-10'})
 const result=await submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})
 const line=await prisma.warehouseDocLine.findFirstOrThrow({where:{docId:result.doc.id}})
 expect(line.manufactureDate?.toISOString().slice(0,10)).toBe('2026-10-10')
 expect(line.expiryDate?.toISOString().slice(0,10)).toBe('2026-11-10')
 const lot=await prisma.warehouseLedgerLot.findFirstOrThrow({where:{sourceMovementId:line.movementId!}})
 expect(lot.manufactureDate?.toISOString().slice(0,10)).toBe('2026-10-10')
 expect(lot.expiryDate?.toISOString().slice(0,10)).toBe('2026-11-10')
})

it('batch draft restores batch/date fields; invalid range cannot partially post; valid dates match doc and lot',async()=>{
 const product=await prisma.product.create({data:{tenantId,code:'DATE-BATCH',name:'批次日期合成物料',price:3,unit:'kg',purchaseUnit:'kg',inventoryUnit:'kg',orderUnit:'kg',costUnit:'kg',inventoryUnitsPerPurchaseUnit:1,inventoryUnitsPerOrderUnit:1,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED'}})
 const row={productId:product.id,purchaseQuantity:'2',unitPrice:'3',amount:'6',batchNo:'QA-DATE-20261010',manufactureDate:'2026-10-10',expiryDate:'2026-10-09'}
 const draft=await saveWithDisplayedUnits({tenantId,userId,id:`batch-dates-${Date.now()}`,baseVersion:0,payload:draftPayloadSchema.parse({mode:'BATCH',supplierId,effectiveAtIso:'2026-10-11T17:00:00Z',rows:[row]})})
 expect((await app.inject({url:'/inbound-drafts?mode=BATCH'})).json().draft.payload.rows[0]).toMatchObject(row)
 await expect(submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})).rejects.toThrow('早于')
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,productId:product.id}})).toBe(0)
 const corrected=await saveWithDisplayedUnits({tenantId,userId,id:draft.id,baseVersion:draft.version,payload:draftPayloadSchema.parse({mode:'BATCH',supplierId,effectiveAtIso:'2026-10-11T17:00:00Z',rows:[{...row,expiryDate:'2026-11-10'}]})})
 const result=await submitInboundDraft({tenantId,userId,id:draft.id,version:corrected.version,auditOnSubmit:false})
 const line=await prisma.warehouseDocLine.findFirstOrThrow({where:{docId:result.doc.id}})
 const lot=await prisma.warehouseLedgerLot.findFirstOrThrow({where:{sourceMovementId:line.movementId!}})
 for(const record of [line,lot]){expect(record.batchNo).toBe(row.batchNo);expect(record.manufactureDate?.toISOString().slice(0,10)).toBe('2026-10-10');expect(record.expiryDate?.toISOString().slice(0,10)).toBe('2026-11-10')}
 expect((await submitInboundDraft({tenantId,userId,id:draft.id,version:corrected.version,auditOnSubmit:false})).replayed).toBe(true)
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,productId:product.id}})).toBe(1)
})

it('outbound draft is server-restorable without stock writes; submit posts once and audit never posts again',async()=>{
 const p=await prisma.product.create({data:{tenantId,code:'OUT-DRAFT',name:'出库草稿合成物料',price:2,unit:'kg',purchaseUnit:'kg',inventoryUnit:'kg',orderUnit:'kg',costUnit:'kg',inventoryUnitsPerPurchaseUnit:1,inventoryUnitsPerOrderUnit:1,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED'}})
 await recordManualWarehouseInbound({tenantId,userId,productId:p.id,purchaseQuantity:10,totalAmount:20,effectiveAt:new Date('2026-10-10T01:00:00Z'),idempotencyKey:`out-opening-${Date.now()}`})
 const where={tenantId,productId:p.id}
 const before=JSON.stringify(await prisma.warehouseLedgerBalance.findMany({where}))
 const draft=await saveWithDisplayedUnits({tenantId,userId,id:`out-draft-${Date.now()}`,baseVersion:0,payload:draftPayloadSchema.parse({mode:'OUTBOUND',effectiveAtIso:'2026-10-12T00:00:00Z',purpose:'SAMPLE_ISSUE',reason:'合成样品领用',responsibility:'供应链甲',sourceName:'测试样品室',rows:[{productId:p.id,inventoryQuantity:'2',totalAmount:'',note:'按台账自动成本'}]})})
 expect((await app.inject({url:'/inbound-drafts?mode=OUTBOUND'})).json().draft.payload.rows[0]).toMatchObject({inventoryQuantity:'2',totalAmount:''})
 expect(JSON.stringify(await prisma.warehouseLedgerBalance.findMany({where}))).toBe(before)
 expect(await prisma.warehouseDocLine.count({where})).toBe(0)
 const result=await submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})
 expect(result.doc.type).toBe('MANUAL_OUTBOUND');expect(result.doc.status).toBe('POSTED')
 expect(result.doc.note).toContain('责任归属：供应链甲');expect(result.doc.note).toContain('去向：测试样品室')
 const line=await prisma.warehouseDocLine.findFirstOrThrow({where})
 expect(Number(line.quantity)).toBe(2);expect(Number(line.amount)).toBe(4);expect(line.unit).toBe('kg');expect(line.note).toBe('按台账自动成本')
 const after=JSON.stringify(await prisma.warehouseLedgerBalance.findMany({where}))
 expect((await submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:true})).doc.status).toBe('POSTED')
 expect((await app.inject({method:'POST',url:`/docs/${result.doc.id}/confirm`,payload:{}})).statusCode).toBe(200)
 expect(JSON.stringify(await prisma.warehouseLedgerBalance.findMany({where}))).toBe(after)
 expect(await prisma.warehouseLedgerMovement.count({where})).toBe(2)
})
it('outbound document failure rolls back every stock write and preserves its draft',async()=>{
 const payload=draftPayloadSchema.parse({mode:'OUTBOUND',effectiveAtIso:'2026-10-12T00:00:00Z',purpose:'HISTORICAL_CORRECTION',reason:'原子事务回归',rows:[{productId,inventoryQuantity:'0.1',totalAmount:'',note:''}]})
 const draft=await saveWithDisplayedUnits({tenantId,userId,id:`out-fail-${Date.now()}`,baseVersion:0,payload})
 const beforeBalance=JSON.stringify(await prisma.warehouseLedgerBalance.findMany({where:{tenantId}})),beforeMovements=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
 const spy=vi.spyOn(docs,'ensureWarehouseDocInTransaction').mockRejectedValueOnce(Error('injected outbound document failure'))
 await expect(submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})).rejects.toThrow('injected outbound');spy.mockRestore()
 expect(JSON.stringify(await prisma.warehouseLedgerBalance.findMany({where:{tenantId}}))).toBe(beforeBalance)
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(beforeMovements)
 expect((await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}})).status).toBe('EDITING')
 await discard(draft.id)
})
it('rejects combined audit for a purchaser before any stock write, but permits separate submit and immutable replay',async()=>{
  const buyer=await prisma.user.create({data:{tenantId,email:`buyer-${Date.now()}@local.invalid`,name:'采购草稿夹具',role:'PURCHASER',password:'unusable'}})
  const draft=await saveWithDisplayedUnits({tenantId,userId:buyer.id,id:`buyer-draft-${Date.now()}`,baseVersion:0,payload:payload()})
  const before=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
  for(const auditOnSubmit of [undefined,true])await expect(submitInboundDraft({tenantId,userId:buyer.id,id:draft.id,version:draft.version,auditOnSubmit})).rejects.toMatchObject({statusCode:403})
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(before)
  expect((await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}})).status).toBe('EDITING')
  const result=await submitInboundDraft({tenantId,userId:buyer.id,id:draft.id,version:draft.version,auditOnSubmit:false})
  expect(result.doc.status).toBe('POSTED')
  const replay=await submitInboundDraft({tenantId,userId:buyer.id,id:draft.id,version:draft.version,auditOnSubmit:true})
  expect(replay.replayed).toBe(true);expect(replay.doc.status).toBe('POSTED')
 })

it('rejects a prefixed outbound reason over the storage limit before stock posting',async()=>{
 const draft=await saveWithDisplayedUnits({tenantId,userId,id:`out-long-${Date.now()}`,baseVersion:0,payload:draftPayloadSchema.parse({mode:'OUTBOUND',effectiveAtIso:'2026-10-12T00:00:00Z',purpose:'SAMPLE_ISSUE',reason:'因'.repeat(120),rows:[{productId,inventoryQuantity:'1',totalAmount:''}]})})
 const before=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
 await expect(submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})).rejects.toMatchObject({statusCode:400})
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(before)
 expect((await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}})).status).toBe('EDITING');await discard(draft.id)
})

it('keeps saved units during autosave, blocks drift, and posts only after explicit recheck',async()=>{
 const draft=await save()
 const before=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
 await prisma.product.update({where:{id:productId},data:{inventoryUnitsPerPurchaseUnit:2}})
 try{
  const edited=await saveInboundDraft({tenantId,userId,id:draft.id,baseVersion:draft.version,payload:payload({note:'单位变更后继续填写',displayUnits:[{productId,unit:'kg',inventoryUnit:'kg',conversionFactor:1}]})})
  const frozen=draftPayloadSchema.parse(edited.payload).executionSnapshot!
  expect(frozen.products[0].units!.inventoryUnitsPerPurchaseUnit).toBe(1)
  await expect(submitInboundDraft({tenantId,userId,id:edited.id,version:edited.version,auditOnSubmit:false})).rejects.toThrow('单位或换算已变化')
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(before)
  const checked=await saveInboundDraft({tenantId,userId,id:edited.id,baseVersion:edited.version,payload:payload({note:'单位变更后继续填写',displayUnits:[{productId,unit:'kg',inventoryUnit:'kg',conversionFactor:1}]}),reconfirmSnapshot:true,reconfirmRequestId:`check-${Date.now()}-${++seq}`})
  expect(draftPayloadSchema.parse(checked.payload).executionSnapshot!.products[0].units!.inventoryUnitsPerPurchaseUnit).toBe(2)
  const result=await submitInboundDraft({tenantId,userId,id:checked.id,version:checked.version,auditOnSubmit:false})
  const line=await prisma.warehouseDocLine.findFirstOrThrow({where:{docId:result.doc.id}})
  expect(Number(line.inventoryQuantity)).toBe(2)
 }finally{await prisma.product.update({where:{id:productId},data:{inventoryUnitsPerPurchaseUnit:1}});const state=await prisma.warehouseInboundDraft.findUnique({where:{id:draft.id}});if(state?.status==='EDITING')await discard(draft.id)}
})
it('freezes the original warehouse even after the default warehouse changes',async()=>{
 const original=await prisma.warehouse.findFirstOrThrow({where:{tenantId,isDefault:true}})
 const draft=await save()
 await prisma.warehouse.update({where:{id:original.id},data:{isDefault:false}})
 const replacement=await prisma.warehouse.create({data:{tenantId,code:`NEXT-${Date.now()}`,name:'另一个默认仓',isDefault:true,inventoryMode:'SHADOW'}})
 try{
  const result=await submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})
  expect(result.doc.warehouseId).toBe(original.id)
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,warehouseId:replacement.id}})).toBe(0)
 }finally{await prisma.warehouse.update({where:{id:replacement.id},data:{isDefault:false}});await prisma.warehouse.update({where:{id:original.id},data:{isDefault:true}})}
})
it('does not silently add a verified snapshot to an old draft when saving normally',async()=>{
 const old=await prisma.warehouseInboundDraft.create({data:{id:`legacy-draft-${Date.now()}`,tenantId,createdById:userId,mode:'SINGLE',payload:payload() as Prisma.InputJsonValue}})
 const normal=await saveInboundDraft({tenantId,userId,id:old.id,baseVersion:old.version,payload:payload({note:'旧草稿继续保存'})})
 expect(draftPayloadSchema.parse(normal.payload).executionSnapshot).toBeUndefined()
 const before=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
 await expect(submitInboundDraft({tenantId,userId,id:normal.id,version:normal.version,auditOnSubmit:false})).rejects.toThrow('旧草稿尚未核对')
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(before)
 const checked=await saveInboundDraft({tenantId,userId,id:normal.id,baseVersion:normal.version,payload:payload({note:'旧草稿继续保存'}),reconfirmSnapshot:true,reconfirmRequestId:`check-${Date.now()}-${++seq}`})
 expect(draftPayloadSchema.parse(checked.payload).executionSnapshot?.version).toBe(1)
 await discard(old.id)
})
it('requires explicit recheck when the first save displays a stale conversion factor',async()=>{
 const draft=await save({displayUnits:[{productId,unit:'kg',inventoryUnit:'kg',conversionFactor:2}]})
 expect(draftPayloadSchema.parse(draft.payload).executionSnapshot!.products[0].displayMatched).toBe(false)
 const before=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
 await expect(submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})).rejects.toThrow('重新核对')
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(before)
 await discard(draft.id)
})

it('pages candidate sources and recovers disabled IDs without exposing another tenant',async()=>{
 const data={tenantId,price:2,unit:'kg',purchaseUnit:'kg',inventoryUnit:'kg',orderUnit:'kg',costUnit:'kg',inventoryUnitsPerPurchaseUnit:1,inventoryUnitsPerOrderUnit:1,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED' as const}
 const first=await prisma.product.create({data:{...data,code:'QA-CAND-1',name:'候选第一页'}})
 const second=await prisma.product.create({data:{...data,code:'QA-CAND-2',name:'候选第二页'}})
 const disabled=await prisma.product.create({data:{...data,code:'QA-CAND-3',name:'停用的草稿来源',status:'DISABLED'}})
 const other=await prisma.tenant.create({data:{slug:`snapshot-other-${Date.now()}`,name:'快照跨租户夹具'}})
 const foreign=await prisma.product.create({data:{...data,tenantId:other.id,code:'QA-CAND-X',name:'不能跨租户补读'}})
 const page=await app.inject({url:'/inventory/inbound-candidates?paged=1&limit=1&q=QA-CAND'})
 expect(page.statusCode).toBe(200)
 const body=page.json();expect(body.items).toHaveLength(1);expect(body.nextCursor).toBeTruthy()
 const next=await app.inject({url:`/inventory/inbound-candidates?paged=1&limit=1&q=QA-CAND&cursor=${body.nextCursor}`})
 expect(next.statusCode).toBe(200);expect(next.json().items[0].id).not.toBe(body.items[0].id)
 expect(new Set([body.items[0].id,next.json().items[0].id])).toEqual(new Set([first.id,second.id]))
 const restore=await app.inject({url:`/inventory/inbound-candidates?productIds=${disabled.id},${foreign.id}`})
 expect(restore.statusCode).toBe(200);expect(restore.json().items).toHaveLength(1)
 expect(restore.json().items[0]).toMatchObject({id:disabled.id,eligible:false,purchaseToInventoryFactor:0})
})

it('keeps warehouse mode frozen during autosave and refuses a changed execution policy',async()=>{
 const warehouse=await prisma.warehouse.findFirstOrThrow({where:{tenantId,isDefault:true}})
 const draft=await save()
 await prisma.warehouse.update({where:{id:warehouse.id},data:{inventoryMode:'STRICT'}})
 try{
  const edited=await saveInboundDraft({tenantId,userId,id:draft.id,baseVersion:draft.version,payload:payload({note:'模式变化后自动保存'})})
  expect(draftPayloadSchema.parse(edited.payload).executionSnapshot!.warehouse.inventoryMode).toBe('SHADOW')
  const before=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
  await expect(submitInboundDraft({tenantId,userId,id:edited.id,version:edited.version,auditOnSubmit:false})).rejects.toThrow('库存模式已变化')
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(before)
 }finally{await prisma.warehouse.update({where:{id:warehouse.id},data:{inventoryMode:'SHADOW'}});await discard(draft.id)}
})

it('does not confirm the first save from a client that omitted displayed units',async()=>{
 const draft=await saveInboundDraft({tenantId,userId,id:`no-display-${Date.now()}`,baseVersion:0,payload:payload()})
 expect(draftPayloadSchema.parse(draft.payload).executionSnapshot!.products[0].displayMatched).toBe(false)
 const before=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
 await expect(submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version,auditOnSubmit:false})).rejects.toThrow('重新核对')
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(before)
 await discard(draft.id)
})

it('replays a confirmed request without recapturing later units, and retains proof after later saves and rechecks',async()=>{
 const draft=await save(),request={tenantId,userId,id:draft.id,baseVersion:draft.version,payload:payload(),reconfirmSnapshot:true,reconfirmRequestId:`proof-${Date.now()}-${++seq}`}
 const original=await saveInboundDraft(request)
 expect(original.version).toBe(draft.version+1)
 await prisma.product.update({where:{id:productId},data:{inventoryUnitsPerPurchaseUnit:2}})
 try{
  const replay=await saveInboundDraft(request)
  expect(replay.version).toBe(original.version)
  expect(draftPayloadSchema.parse(replay.payload).executionSnapshot!.products[0].units!.inventoryUnitsPerPurchaseUnit).toBe(1)
  expect((replay as any).reconfirmationReceipt.requiresReload).toBe(false)
  expect(await prisma.warehouseDraftReconfirmation.count({where:{draftId:draft.id}})).toBe(1)
  const edited=await saveInboundDraft({tenantId,userId,id:draft.id,baseVersion:original.version,payload:payload({note:'后续备注'})})
  const before=JSON.stringify(await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}}))
  const replayLater=await saveInboundDraft(request)
  expect((replayLater as any).reconfirmationReceipt).toMatchObject({requiresReload:true,resultVersion:original.version,currentVersion:edited.version})
  expect((replayLater.payload as any).note).toBe('后续备注')
  expect(JSON.stringify(await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}}))).toBe(before)
  const second=await saveInboundDraft({...request,baseVersion:edited.version,payload:payload({note:'后续备注'}),reconfirmRequestId:`second-${Date.now()}-${++seq}`})
  const oldest=await saveInboundDraft(request)
  expect((oldest as any).reconfirmationReceipt.confirmedSnapshot.products[0].units.inventoryUnitsPerPurchaseUnit).toBe(1)
  expect(draftPayloadSchema.parse(oldest.payload).executionSnapshot!.products[0].units!.inventoryUnitsPerPurchaseUnit).toBe(2)
  expect(oldest.version).toBe(second.version)
  expect(await prisma.warehouseDraftReconfirmation.count({where:{draftId:draft.id}})).toBe(2)
  await discard(draft.id)
  expect((await saveInboundDraft(request)).status).toBe('DISCARDED')
  expect(await prisma.warehouseDraftReconfirmation.count({where:{draftId:draft.id}})).toBe(2)
 }finally{await prisma.product.update({where:{id:productId},data:{inventoryUnitsPerPurchaseUnit:1}});await discard(draft.id)}
})
it('concurrent reconfirmation applies once and rejects changed content, base version and actor',async()=>{
 const draft=await save(),request={tenantId,userId,id:draft.id,baseVersion:draft.version,payload:payload(),reconfirmSnapshot:true,reconfirmRequestId:`parallel-check-${Date.now()}-${++seq}`}
 const results=await Promise.all([saveInboundDraft(request),saveInboundDraft(request)])
 expect(results.map(result=>result.version)).toEqual([draft.version+1,draft.version+1])
 expect(await prisma.warehouseDraftReconfirmation.count({where:{draftId:draft.id}})).toBe(1)
 await expect(saveInboundDraft({...request,payload:payload({note:'改变原内容'})})).rejects.toThrow('原核对请求不能')
 await expect(saveInboundDraft({...request,baseVersion:draft.version+1})).rejects.toThrow('原核对请求不能')
 await expect(saveInboundDraft({...request,userId:otherId})).rejects.toThrow('不存在')
 const another=await saveWithDisplayedUnits({tenantId,userId,id:`other-check-${Date.now()}`,baseVersion:0,payload:draftPayloadSchema.parse({mode:'BATCH',rows:[]})})
 await expect(saveInboundDraft({...request,id:another.id,baseVersion:another.version,payload:draftPayloadSchema.parse(another.payload)})).rejects.toThrow('原核对请求不能')
 await discard(another.id);await discard(draft.id)
})
it('receipt insertion failure rolls back the new snapshot and draft version',async()=>{
 const draft=await save(),before=JSON.stringify(draft),transaction=prisma.$transaction.bind(prisma)
 const spy=vi.spyOn(prisma,'$transaction').mockImplementation(((work:any,options:any)=>transaction(async tx=>{
  const proxy=new Proxy(tx,{get(target,key){if(key==='warehouseDraftReconfirmation')return new Proxy(target.warehouseDraftReconfirmation,{get(delegate,property){if(property==='create')return()=>{throw Error('injected confirmation receipt failure')};return Reflect.get(delegate,property)}});return Reflect.get(target,key)}})
  return work(proxy)
 },options)) as any)
 try{await expect(saveInboundDraft({tenantId,userId,id:draft.id,baseVersion:draft.version,payload:payload(),reconfirmSnapshot:true,reconfirmRequestId:`rollback-proof-${Date.now()}`})).rejects.toThrow('injected confirmation receipt failure')}finally{spy.mockRestore()}
 expect(JSON.stringify(await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}}))).toBe(before)
 expect(await prisma.warehouseDraftReconfirmation.count({where:{draftId:draft.id}})).toBe(0)
 await discard(draft.id)
})

it('requires a stable reconfirmation key and rejects a cross-tenant receipt relation',async()=>{
 const draft=await save()
 const missing=await app.inject({method:'PUT',url:`/inbound-drafts/${draft.id}`,payload:{baseVersion:draft.version,payload:payload(),reconfirmSnapshot:true}})
 expect(missing.statusCode).toBe(400)
 expect((await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}})).version).toBe(draft.version)
 const foreign=await prisma.tenant.create({data:{slug:`receipt-fk-${Date.now()}`,name:'核对FK隔离夹具'}})
 await expect(prisma.warehouseDraftReconfirmation.create({data:{tenantId:foreign.id,draftId:draft.id,actorId:userId,requestId:`invalid-tenant-key-${Date.now()}`,baseVersion:1,resultVersion:2,payloadFingerprint:'a'.repeat(64),resultPayload:{}}})).rejects.toThrow()
 expect(await prisma.warehouseDraftReconfirmation.count({where:{tenantId:foreign.id}})).toBe(0)
 await discard(draft.id)
})

it('refuses an unsupported stored format without overwriting payload, discarding or posting',async()=>{
 const draft=await save()
 // A future snapshot keeps the row edit version but is not safe for this reader.
 const futurePayload={...(draft.payload as any),executionSnapshot:{...(draft.payload as any).executionSnapshot,version:2}}
 await prisma.warehouseInboundDraft.update({where:{id:draft.id},data:{payload:futurePayload}})
 const before=JSON.stringify(await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}}))
 const movements=await prisma.warehouseLedgerMovement.count({where:{tenantId}})
 const docsCount=await prisma.warehouseDoc.count({where:{tenantId}})
 try{
  for(const request of [
   {url:'/inbound-drafts?mode=SINGLE'},
   {url:`/inbound-drafts/${draft.id}`},
   {method:'PUT' as const,url:`/inbound-drafts/${draft.id}`,payload:{baseVersion:draft.version,payload:payload({note:'旧端尝试改写'})}},
   {method:'PUT' as const,url:`/inbound-drafts/${draft.id}`,payload:{baseVersion:draft.version,payload:payload(),reconfirmSnapshot:true,reconfirmRequestId:`future-${Date.now()}`}},
   {method:'POST' as const,url:`/inbound-drafts/${draft.id}/submit`,payload:{version:draft.version}},
   {method:'POST' as const,url:`/inbound-drafts/${draft.id}/discard`,payload:{version:draft.version}},
  ]){
   const result=await app.inject(request)
   expect(result.statusCode,result.body).toBe(409)
   expect(result.json().error).toContain('格式当前版本不支持')
   expect(JSON.stringify(await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}}))).toBe(before)
  }
  await expect(saveInboundDraft({tenantId,userId,id:draft.id,baseVersion:draft.version,payload:payload()})).rejects.toThrow('格式当前版本不支持')
  await expect(submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version})).rejects.toThrow('格式当前版本不支持')
  expect(await prisma.warehouseDraftReconfirmation.count({where:{draftId:draft.id}})).toBe(0)
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(movements)
  expect(await prisma.warehouseDoc.count({where:{tenantId}})).toBe(docsCount)
  expect((await app.inject({url:`/inbound-drafts/${draft.id}`,headers:{'x-actor':otherId}})).json().draft).toBeNull()
  // Idempotent terminal replies must not bypass format refusal either.
  for(const status of ['SUBMITTED','DISCARDED']){
   await prisma.warehouseInboundDraft.update({where:{id:draft.id},data:{status}})
   const terminal=JSON.stringify(await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}}))
   await expect(submitInboundDraft({tenantId,userId,id:draft.id,version:draft.version})).rejects.toThrow('格式当前版本不支持')
   const refused=await app.inject({method:'POST',url:`/inbound-drafts/${draft.id}/discard`,payload:{version:draft.version}})
   expect(refused.statusCode,refused.body).toBe(409)
   expect(JSON.stringify(await prisma.warehouseInboundDraft.findUniqueOrThrow({where:{id:draft.id}}))).toBe(terminal)
  }
 }finally{await discard(draft.id)}
})
