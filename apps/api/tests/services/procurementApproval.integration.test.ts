import {prisma} from '@dianjie/db'
import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,it,expect} from 'vitest'
import {changeProcurementApproval,ProcurementSourceKind} from '../../src/services/procurementApproval'
import {createUpstreamPurchaseReturn,submitUpstreamPurchaseReturnInTransaction,postUpstreamPurchaseReturnBusinessInTransaction,rejectUpstreamPurchaseReturn,cancelUpstreamPurchaseReturn} from '../../src/services/upstreamPurchaseReturns'
import {postReceiptBusinessInTransaction} from '../../src/routes/upstreamProcurement'
import {saveProcurementDocument} from '../../src/services/procurementDocumentEdit'
import {saveProcurementDocumentNote} from '../../src/services/procurementDocumentNote'
import {postUpstreamReceiptInTransaction} from '../../src/services/warehouseLedger'
let tenantId:string,warehouseId:string,supplierId:string,productId:string,actorA:string,actorB:string,financeId:string,postedLineId:string
let seq=0
async function receipt(posted=false){
 const order=await prisma.upstreamPurchaseOrder.create({data:{tenantId,no:`PO-${randomUUID()}`,supplierId,warehouseId,createdById:actorA,status:posted?'RECEIVED':'SUPPLIER_ACCEPTED',lines:{create:{lineNo:1,productId,productCodeSnapshot:'APPROVAL-FIXTURE',productNameSnapshot:'采购审批合成物料',purchaseUnit:'袋',inventoryUnit:'kg',inventoryUnitsPerPurchaseUnit:5,orderedQty:10,confirmedQty:10,receivedQty:posted?10:0,unitPrice:25,amountWithoutTax:250,taxAmount:0,totalAmount:250}}},include:{lines:true}})
 return prisma.upstreamReceipt.create({data:{tenantId,no:`RC-${randomUUID()}`,purchaseOrderId:order.id,supplierId,warehouseId,createdById:actorA,status:posted?'POSTED':'DRAFT',postedAt:posted?new Date():null,payableAmount:250,lines:{create:{purchaseOrderLineId:order.lines[0].id,productId,orderedQty:10,arrivedQty:10,acceptedQty:10,purchaseUnit:'袋',inventoryUnit:'kg',inventoryUnitsPerPurchaseUnit:5,inventoryAcceptedQty:50,unitPrice:25,payableAmount:250}}},include:{lines:true}})
}
async function source(kind:ProcurementSourceKind,id:string){return kind==='RECEIPT'?prisma.upstreamReceipt.findUniqueOrThrow({where:{id}}):prisma.upstreamPurchaseReturn.findUniqueOrThrow({where:{id}})}
async function stock(){return JSON.stringify({balances:await prisma.warehouseLedgerBalance.findMany({where:{tenantId},orderBy:{id:'asc'}}),lots:await prisma.warehouseLedgerLot.findMany({where:{tenantId},orderBy:{id:'asc'}}),movements:await prisma.warehouseLedgerMovement.findMany({where:{tenantId},orderBy:{id:'asc'}}),allocations:await prisma.warehouseLedgerLotAllocation.findMany({where:{tenantId},orderBy:{id:'asc'}}),poLines:await prisma.upstreamPurchaseOrderLine.findMany({where:{tenantId},orderBy:{id:'asc'}}),claims:await prisma.upstreamArrivalClaim.findMany({where:{tenantId},orderBy:{id:'asc'}})})}
async function change(kind:ProcurementSourceKind,id:string,action:any,userId=actorA,hooks:any={},requestId=randomUUID()){
 const row=await source(kind,id)
 return changeProcurementApproval({tenantId,userId,kind,sourceId:id,action,approvalVersion:row.approvalVersion,sourceVersion:row.rowVersion,requestId},hooks)
}
async function newReturn(){return (await createUpstreamPurchaseReturn({tenantId,userId:actorA,supplierId,warehouseId,reason:'合成质量退货',idempotencyKey:`approval-return-${++seq}-${randomUUID()}`,lines:[{receiptLineId:postedLineId,purchaseQuantity:1}]})).purchaseReturn}
const hooks={submit:(tx:any,row:any)=>submitUpstreamPurchaseReturnInTransaction(tx,tenantId,row.id,actorA),reviewGuard:async()=>{},review:(tx:any,row:any)=>postUpstreamPurchaseReturnBusinessInTransaction(tx,tenantId,row.id,actorB)}
beforeAll(async()=>{
 tenantId=(await prisma.tenant.create({data:{slug:`procurement-approval-${randomUUID()}`,name:'采购独立审批合成测试'}})).id
 warehouseId=(await prisma.warehouse.findFirst({where:{tenantId,isDefault:true}})??await prisma.warehouse.create({data:{tenantId,code:'MAIN',name:'审批隔离仓',isDefault:true,inventoryMode:'SHADOW'}})).id
 supplierId=(await prisma.supplier.create({data:{tenantId,no:'APPROVAL-SUP',name:'审批合成供应商',businessScopes:['WAREHOUSE_UPSTREAM']}})).id
 for(const [role,key] of [['SUPPLY_CHAIN','A'],['SUPPLY_CHAIN','B'],['FINANCE','F']] as const){const user=await prisma.user.create({data:{tenantId,role,name:`合成${key}`,email:`${key}-${randomUUID()}@local.invalid`,password:'unusable'}});if(key==='A')actorA=user.id;else if(key==='B')actorB=user.id;else financeId=user.id}
 productId=(await prisma.product.create({data:{tenantId,code:'APPROVAL-FIXTURE',name:'采购审批合成物料',price:1,unit:'kg',purchaseUnit:'袋',inventoryUnit:'kg',orderUnit:'kg',costUnit:'kg',inventoryUnitsPerPurchaseUnit:5,inventoryUnitsPerOrderUnit:1,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED'}})).id
 const opening=await receipt(true);postedLineId=opening.lines[0].id
 await prisma.$transaction(tx=>postUpstreamReceiptInTransaction(tx,{tenantId,warehouseId,supplierId,supplierName:'审批合成供应商',receiptId:opening.id,receiptNo:opening.no,userId:actorA,effectiveAt:new Date(),lines:[{receiptLineId:postedLineId,productId,productName:'采购审批合成物料',purchaseQuantity:10,purchaseUnit:'袋',conversionFactor:5,inventoryQuantity:50,inventoryUnit:'kg',totalAmount:250}]}))
})
afterAll(()=>prisma.$disconnect())
it('posted receipts allow independent note saving without changing business or approval',async()=>{
 const origin=await prisma.upstreamReceiptLine.findUniqueOrThrow({where:{id:postedLineId}})
 const row=await source('RECEIPT',origin.receiptId),before=await stock(),original=row
 const request={tenantId,userId:actorA,kind:'RECEIPT' as const,sourceId:row.id,body:{note:'复审后补充备注',sourceVersion:original.rowVersion,requestId:randomUUID()}}
 await saveProcurementDocumentNote(request)
 const after=await source('RECEIPT',row.id)
 expect(after).toMatchObject({note:'复审后补充备注',status:original.status,approvalStatus:original.approvalStatus,approvalVersion:original.approvalVersion,rowVersion:original.rowVersion+1,payableAmount:original.payableAmount})
 expect(await stock()).toBe(before)
 expect(await prisma.upstreamReceiptLine.findUniqueOrThrow({where:{id:postedLineId}})).toEqual(origin)
 const strip=(value:any)=>{const {note,rowVersion,updatedAt,...rest}=value;return rest}
 expect(strip(after)).toEqual(strip(original))
 expect((await saveProcurementDocumentNote(request)).replayed).toBe(true)
 await expect(saveProcurementDocumentNote({...request,body:{...request.body,quantity:99}})).rejects.toMatchObject({statusCode:400})
 await expect(saveProcurementDocumentNote({...request,userId:financeId})).rejects.toMatchObject({statusCode:403})
 await expect(saveProcurementDocumentNote({...request,body:{...request.body,requestId:randomUUID()}})).rejects.toMatchObject({statusCode:409})
})
it('receipt business save is atomic, recalculates quantities and costs, and returns pending approval to draft',async()=>{
 const row=await receipt();await change('RECEIPT',row.id,'submit')
 const current=await source('RECEIPT',row.id),before=await stock()
 const request={tenantId,userId:actorA,kind:'RECEIPT' as const,sourceId:row.id,body:{approvalVersion:current.approvalVersion,sourceVersion:current.rowVersion,requestId:randomUUID(),note:'编辑备注',lines:[{id:row.lines[0].id,quantity:8,arrivedQty:10,damagedQty:2,rejectedQty:0,unitPrice:20,batchNo:'KEEP-001',manufactureDate:'2026-10-10',expiryDate:'2026-11-10'}]}}
 const saved=await saveProcurementDocument(request)
 expect(saved).toMatchObject({approvalStatus:'DRAFT',sourceVersion:1})
 const edited=await prisma.upstreamReceipt.findUniqueOrThrow({where:{id:row.id},include:{lines:true}})
 expect(edited.payableAmount.toString()).toBe('160');expect(edited.lines[0].inventoryAcceptedQty.toString()).toBe('40')
 expect(edited.lines[0].manufactureDate?.toISOString().slice(0,10)).toBe('2026-10-10');expect(edited.lines[0].batchNo).toBe('KEEP-001')
 expect(await stock()).toBe(before)
 expect((await saveProcurementDocument(request)).replayed).toBe(true)
 const event=await prisma.procurementApprovalEvent.findUniqueOrThrow({where:{tenantId_requestId:{tenantId,requestId:request.body.requestId}}})
 expect((event.beforeValue as any).business.lines[0].acceptedQty).toBe('10')
 expect((event.afterValue as any).business.lines[0].acceptedQty).toBe('8')
 await expect(saveProcurementDocument({...request,body:{...request.body,note:'同请求不同修改'}})).rejects.toMatchObject({statusCode:409})
})
it('invalid receipt quantities and stale edits do not change any source or stock',async()=>{
 const row=await receipt(),before=await stock(),current=await source('RECEIPT',row.id)
 const request={tenantId,userId:actorA,kind:'RECEIPT' as const,sourceId:row.id,body:{approvalVersion:current.approvalVersion,sourceVersion:current.rowVersion,requestId:randomUUID(),lines:[{id:row.lines[0].id,quantity:11,arrivedQty:11}]}}
 await expect(saveProcurementDocument(request)).rejects.toMatchObject({statusCode:400})
 expect(await source('RECEIPT',row.id)).toEqual(current);expect(await stock()).toBe(before)
 await expect(saveProcurementDocument({...request,body:{...request.body,sourceVersion:99}})).rejects.toMatchObject({statusCode:409})
 expect(await prisma.procurementApprovalEvent.count({where:{receiptId:row.id}})).toBe(0)
})
it('return business save uses original settlement price and rechecks cumulative return allowance',async()=>{
 const row=await newReturn(),current=await source('RETURN',row.id),before=await stock()
 const body={approvalVersion:current.approvalVersion,sourceVersion:current.rowVersion,requestId:randomUUID(),lines:[{id:row.lines[0].id,quantity:2}]}
 await saveProcurementDocument({tenantId,userId:actorA,kind:'RETURN',sourceId:row.id,body})
 const saved=await prisma.upstreamPurchaseReturn.findUniqueOrThrow({where:{id:row.id},include:{lines:true}})
 expect(saved.lines[0].inventoryQuantity.toString()).toBe('10');expect(saved.settlementAmount.toString()).toBe('50');expect(await stock()).toBe(before)
 const next={...body,approvalVersion:saved.approvalVersion,sourceVersion:saved.rowVersion,requestId:randomUUID(),lines:[{id:row.lines[0].id,quantity:99}]}
 await expect(saveProcurementDocument({tenantId,userId:actorA,kind:'RETURN',sourceId:row.id,body:next})).rejects.toMatchObject({statusCode:409})
 expect(await prisma.upstreamPurchaseReturn.findUniqueOrThrow({where:{id:row.id},include:{lines:true}})).toEqual(saved)
})
it('a real business editor cannot review after a later unchanged save by another actor',async()=>{
 const row=await receipt()
 async function saveAs(userId:string){const current=await source('RECEIPT',row.id);return saveProcurementDocument({tenantId,userId,kind:'RECEIPT',sourceId:row.id,body:{approvalVersion:current.approvalVersion,sourceVersion:current.rowVersion,requestId:randomUUID(),note:'',lines:[{id:row.lines[0].id,quantity:9,arrivedQty:10,unitPrice:25,note:''}]}})}
 await saveAs(actorB);await saveAs(actorA)
 const saves=await prisma.procurementApprovalEvent.findMany({where:{receiptId:row.id,action:'SAVE'},orderBy:{createdAt:'asc'}})
 expect((saves[0].afterValue as any).businessChanged).toBe(true)
 expect((saves[1].afterValue as any).businessChanged).toBe(false)
 await change('RECEIPT',row.id,'submit');await change('RECEIPT',row.id,'audit')
 await expect(change('RECEIPT',row.id,'review',actorB,{review:async()=>{throw Error('must not reach posting')}})).rejects.toMatchObject({statusCode:403})
 expect((await source('RECEIPT',row.id)).approvalStatus).toBe('AUDITED')
})
it('positive return quantity below storage precision is rejected instead of saved as zero',async()=>{
 const row=await newReturn(),current=await source('RETURN',row.id)
 await expect(saveProcurementDocument({tenantId,userId:actorA,kind:'RETURN',sourceId:row.id,body:{approvalVersion:current.approvalVersion,sourceVersion:current.rowVersion,requestId:randomUUID(),lines:[{id:row.lines[0].id,quantity:0.00000001}]}})).rejects.toMatchObject({statusCode:400})
 expect(await source('RETURN',row.id)).toEqual(current)
 expect(await prisma.procurementApprovalEvent.count({where:{returnId:row.id,action:'SAVE'}})).toBe(0)
})
it('above-standard-price receipts cannot post even through an administrator exception',async()=>{
 const row=await receipt()
 await prisma.upstreamReceiptLine.update({where:{id:row.lines[0].id},data:{standardUnitPriceSnapshot:20}})
 for(const action of ['submit','audit'])await change('RECEIPT',row.id,action)
 const before=await stock(),current=await source('RECEIPT',row.id)
 await expect(change('RECEIPT',row.id,'review',actorB,{review:(tx:any,source:any)=>postReceiptBusinessInTransaction(tx,tenantId,'ADMIN',actorB,source.id,true,{priceExceptionReason:'不能以例外绕过标准价'},true)})).rejects.toThrow('禁止验收入库')
 expect(await stock()).toBe(before);expect(await source('RECEIPT',row.id)).toEqual(current)
 expect(await prisma.procurementApprovalEvent.count({where:{receiptId:row.id,action:'REVIEW'}})).toBe(0)
})
it('legacy reject and cancel cannot bypass audited return approval',async()=>{
 const row=await newReturn()
 for(const action of ['submit','audit'])await change('RETURN',row.id,action,actorA,hooks)
 const before=await stock(),current=await source('RETURN',row.id)
 await expect(rejectUpstreamPurchaseReturn(tenantId,row.id,actorA,'不能绕过审核')).rejects.toMatchObject({statusCode:409})
 await expect(cancelUpstreamPurchaseReturn(tenantId,row.id,actorA,'不能绕过审核')).rejects.toMatchObject({statusCode:409})
 expect(await source('RETURN',row.id)).toEqual(current);expect(await stock()).toBe(before)
})
it('receipt save, submit, audit and pre-review reverse never change inventory or cumulative receipt',async()=>{
 const row=await receipt(),before=await stock()
 for(const action of ['save','submit','audit','unconfirm']){await change('RECEIPT',row.id,action);expect(await stock()).toBe(before)}
 expect((await source('RECEIPT',row.id)).approvalStatus).toBe('PENDING')
 expect(await prisma.procurementApprovalEvent.count({where:{receiptId:row.id}})).toBe(4)
 await change('RECEIPT',row.id,'audit')
 await expect(change('RECEIPT',row.id,'review',actorB)).rejects.toMatchObject({statusCode:503})
 expect((await source('RECEIPT',row.id)).approvalStatus).toBe('AUDITED');expect(await stock()).toBe(before)
})
it('return review posts once in the same transaction; final review cannot reverse',async()=>{
 const row=await newReturn(),before=await stock()
 for(const action of ['save','submit','audit']){await change('RETURN',row.id,action,actorA,hooks);expect(await stock()).toBe(before)}
 const current=await source('RETURN',row.id),request={tenantId,userId:actorB,kind:'RETURN' as const,sourceId:row.id,action:'review' as const,approvalVersion:current.approvalVersion,sourceVersion:current.rowVersion,requestId:randomUUID()}
 const results=await Promise.all([changeProcurementApproval(request,hooks),changeProcurementApproval(request,hooks)])
 expect(results.filter(result=>!result.replayed)).toHaveLength(1)
 expect((await source('RETURN',row.id))).toMatchObject({status:'APPROVED',approvalStatus:'REVIEWED'})
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,sourceType:'UpstreamPurchaseReturn',sourceId:row.id}})).toBe(1)
 expect(await prisma.procurementApprovalEvent.count({where:{returnId:row.id,action:'REVIEW'}})).toBe(1)
 const after=await stock();await expect(change('RETURN',row.id,'unconfirm')).rejects.toMatchObject({statusCode:409});expect(await stock()).toBe(after)
})
it('a failure after complete return posting rolls back stock, source, and approval event',async()=>{
 const row=await newReturn();for(const action of ['save','submit','audit'])await change('RETURN',row.id,action,actorA,hooks)
 const before=await stock(),current=await source('RETURN',row.id)
 await expect(change('RETURN',row.id,'review',actorB,{...hooks,review:async(tx:any,source:any)=>{await hooks.review(tx,source);throw Error('injected after physical posting')}})).rejects.toThrow('injected')
 expect(await stock()).toBe(before);expect(await source('RETURN',row.id)).toEqual(current)
 expect(await prisma.procurementApprovalEvent.count({where:{returnId:row.id,action:'REVIEW'}})).toBe(0)
})
it('detects source content mutation even if its rowVersion was not incremented',async()=>{
 const row=await receipt();await change('RECEIPT',row.id,'submit')
 await prisma.upstreamReceiptLine.update({where:{id:row.lines[0].id},data:{inventoryAcceptedQty:51}})
 await expect(change('RECEIPT',row.id,'audit')).rejects.toThrow('业务内容已变化')
 expect((await source('RECEIPT',row.id)).approvalStatus).toBe('PENDING')
})
it('rejects finance and stale dual versions, and never enrolls legacy posted receipts',async()=>{
 const row=await receipt();await expect(change('RECEIPT',row.id,'submit',financeId)).rejects.toMatchObject({statusCode:403})
 await expect(changeProcurementApproval({tenantId,userId:actorA,kind:'RECEIPT',sourceId:row.id,action:'submit',approvalVersion:99,sourceVersion:row.rowVersion,requestId:randomUUID()})).rejects.toMatchObject({statusCode:409})
 const legacy=await prisma.upstreamReceiptLine.findUniqueOrThrow({where:{id:postedLineId}}),before=await stock()
 await expect(change('RECEIPT',legacy.receiptId,'submit')).rejects.toMatchObject({statusCode:409})
 expect((await source('RECEIPT',legacy.receiptId)).approvalStatus).toBeNull();expect(await stock()).toBe(before)
})

it('rejects a distinct receipt inspector from reviewing without writing approval or stock',async()=>{
 const row=await receipt()
 await prisma.upstreamReceipt.update({where:{id:row.id},data:{inspectorId:actorB}})
 await change('RECEIPT',row.id,'submit',actorA)
 await change('RECEIPT',row.id,'audit',actorA)
 const before=await source('RECEIPT',row.id),beforeStock=await stock(),events=await prisma.procurementApprovalEvent.findMany({where:{receiptId:row.id},orderBy:{id:'asc'}})
 expect(before.createdById).not.toBe(actorB)
 await expect(change('RECEIPT',row.id,'review',actorB,{review:async()=>{throw Error('must not reach posting hook')}})).rejects.toMatchObject({statusCode:403})
 expect(await source('RECEIPT',row.id)).toEqual(before)
 expect(await stock()).toBe(beforeStock)
 expect(await prisma.procurementApprovalEvent.findMany({where:{receiptId:row.id},orderBy:{id:'asc'}})).toEqual(events)
})

it('rejects finance audit and review individually without changing source, events or stock',async()=>{
 const row=await receipt();await change('RECEIPT',row.id,'submit',actorA)
 for(const action of ['audit','review'] as const){
  if(action==='review')await change('RECEIPT',row.id,'audit',actorA)
  const before=await source('RECEIPT',row.id),beforeStock=await stock(),events=await prisma.procurementApprovalEvent.findMany({where:{receiptId:row.id},orderBy:{id:'asc'}})
  await expect(change('RECEIPT',row.id,action,financeId,{review:async()=>{throw Error('must not reach posting hook')}})).rejects.toMatchObject({statusCode:403})
  expect(await source('RECEIPT',row.id)).toEqual(before)
  expect(await stock()).toBe(beforeStock)
  expect(await prisma.procurementApprovalEvent.findMany({where:{receiptId:row.id},orderBy:{id:'asc'}})).toEqual(events)
 }
})

it('a review hook cannot substitute an approval flag for physical posting',async()=>{
 const row=await newReturn();for(const action of ['save','submit','audit'])await change('RETURN',row.id,action,actorA,hooks)
 const before=await stock()
 await expect(change('RETURN',row.id,'review',actorB,{...hooks,review:async(tx:any,source:any)=>tx.upstreamPurchaseReturn.update({where:{id:source.id},data:{approvalStatus:'REVIEWED'}})})).rejects.toThrow('未形成完整过账事实')
 expect(await stock()).toBe(before);expect((await source('RETURN',row.id)).approvalStatus).toBe('AUDITED')
})
it('reversed legacy receipts cannot be enrolled into fresh approval',async()=>{
 const row=await receipt();await prisma.upstreamReceipt.update({where:{id:row.id},data:{status:'REVERSED',reversedAt:new Date()}})
 for(const action of ['save','submit','audit'])await expect(change('RECEIPT',row.id,action)).rejects.toThrow('已冲销')
 expect((await source('RECEIPT',row.id)).approvalStatus).toBeNull()
})
it('resubmitting a saved pending return rechecks the original receipt validity',async()=>{
 const row=await newReturn();await change('RETURN',row.id,'submit',actorA,hooks);await change('RETURN',row.id,'save')
 const original=await prisma.upstreamReceiptLine.findUniqueOrThrow({where:{id:postedLineId}})
 await prisma.upstreamReceipt.update({where:{id:original.receiptId},data:{status:'REVERSED',reversedAt:new Date()}})
 try{
  await expect(change('RETURN',row.id,'submit',actorA,hooks)).rejects.toThrow()
  expect((await source('RETURN',row.id)).approvalStatus).toBe('DRAFT')
 }finally{await prisma.upstreamReceipt.update({where:{id:original.receiptId},data:{status:'POSTED',reversedAt:null}})}
})

it('all purchase returns require a reviewer different from both creator and current auditor',async()=>{
 const row=await newReturn();await change('RETURN',row.id,'submit',actorA,hooks);await change('RETURN',row.id,'audit',actorA,hooks)
 await expect(change('RETURN',row.id,'review',actorA,hooks)).rejects.toMatchObject({statusCode:403})
 await change('RETURN',row.id,'unconfirm');await change('RETURN',row.id,'audit',actorB,hooks)
 await expect(change('RETURN',row.id,'review',actorB,hooks)).rejects.toMatchObject({statusCode:403})
 expect((await source('RETURN',row.id)).approvalStatus).toBe('AUDITED')
})
it('receipt review runs the entire source transaction once and updates cumulative quantities only then',async()=>{
 const row=await receipt(),before=await stock()
 for(const action of ['save','submit','audit']){await change('RECEIPT',row.id,action);expect(await stock()).toBe(before)}
 const receiptHooks={review:(tx:any,source:any)=>postReceiptBusinessInTransaction(tx,tenantId,'SUPPLY_CHAIN',actorB,source.id,true,{},true)}
 const requestSource=await source('RECEIPT',row.id),request={tenantId,userId:actorB,kind:'RECEIPT' as const,sourceId:row.id,action:'review' as const,approvalVersion:requestSource.approvalVersion,sourceVersion:requestSource.rowVersion,requestId:randomUUID()}
 const reviews=await Promise.all([changeProcurementApproval(request,receiptHooks),changeProcurementApproval(request,receiptHooks)])
 expect(reviews.filter(result=>!result.replayed)).toHaveLength(1)
 const posted=await prisma.upstreamReceipt.findUniqueOrThrow({where:{id:row.id},include:{lines:true}})
 expect(posted).toMatchObject({status:'POSTED',approvalStatus:'REVIEWED'})
 expect(posted.lines[0].ledgerMovementId).toBeTruthy()
 expect((await prisma.upstreamPurchaseOrderLine.findUniqueOrThrow({where:{id:row.lines[0].purchaseOrderLineId}})).receivedQty.toString()).toBe('10')
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,sourceType:'UpstreamReceipt',sourceId:row.id}})).toBe(1)
 expect(await prisma.upstreamArrivalClaim.count({where:{tenantId,receiptId:row.id}})).toBe(0)
 expect(await prisma.procurementApprovalEvent.count({where:{tenantId,receiptId:row.id,action:'REVIEW'}})).toBe(1)
})

it('100/3 three pre-created drafts conserve the last return remainder and freeze its submitted amount before audit',async()=>{
 // A new synthetic source isolates this test from other return quota fixtures.
 const opening=await receipt(true)
 const sourceLineId=opening.lines[0].id
 await prisma.$transaction(async tx=>{
  await tx.upstreamPurchaseOrderLine.update({where:{id:opening.lines[0].purchaseOrderLineId},data:{orderedQty:3,confirmedQty:3,receivedQty:3,unitPrice:33.333333,amountWithoutTax:100,totalAmount:100}})
  await tx.upstreamReceipt.update({where:{id:opening.id},data:{payableAmount:100}})
  await tx.upstreamReceiptLine.update({where:{id:sourceLineId},data:{orderedQty:3,arrivedQty:3,acceptedQty:3,inventoryAcceptedQty:15,unitPrice:33.333333,payableAmount:100}})
  await postUpstreamReceiptInTransaction(tx,{tenantId,warehouseId,supplierId,supplierName:'审批合成供应商',receiptId:opening.id,receiptNo:opening.no,userId:actorA,effectiveAt:new Date(),lines:[{receiptLineId:sourceLineId,productId,productName:'采购审批合成物料',purchaseQuantity:3,purchaseUnit:'袋',conversionFactor:5,inventoryQuantity:15,inventoryUnit:'kg',totalAmount:100}]})
 })
 const baseline=await stock()
 const beforeBalance=await prisma.warehouseLedgerBalance.findFirstOrThrow({where:{tenantId,warehouseId,productId}})
 const drafts=[]
 for(let i=0;i<3;i++)drafts.push((await createUpstreamPurchaseReturn({tenantId,userId:actorA,supplierId,warehouseId,reason:'三次部分退货尾差',idempotencyKey:`tail-${randomUUID()}`,lines:[{receiptLineId:sourceLineId,purchaseQuantity:1}]})).purchaseReturn)
 expect(drafts.map(row=>row.settlementAmount.toString())).toEqual(['33.3333','33.3333','33.3333'])
 expect(await stock()).toBe(baseline)
 for(const row of drafts){await change('RETURN',row.id,'submit',actorA,hooks);expect(await stock()).toBe(baseline)}
 const submitted=await prisma.upstreamPurchaseReturn.findMany({where:{tenantId,id:{in:drafts.map(row=>row.id)}},include:{lines:true}})
 const byId=new Map(submitted.map(row=>[row.id,row]))
 expect(drafts.map(row=>byId.get(row.id)!.settlementAmount.toString())).toEqual(['33.3333','33.3333','33.3334'])
 expect(drafts.map(row=>byId.get(row.id)!.lines[0].settlementAmount.toString())).toEqual(['33.3333','33.3333','33.3334'])
 for(const row of drafts){
  await change('RETURN',row.id,'audit',actorA,hooks)
  expect((await source('RETURN',row.id)).approvalStatus).toBe('AUDITED')
  expect(await stock()).toBe(baseline)
 }
 await expect(change('RETURN',drafts[0].id,'review',actorA,hooks)).rejects.toMatchObject({statusCode:403})
 expect(await stock()).toBe(baseline)
 for(const row of drafts){
  const current=await source('RETURN',row.id)
  const request={tenantId,userId:actorB,kind:'RETURN' as const,sourceId:row.id,action:'review' as const,approvalVersion:current.approvalVersion,sourceVersion:current.rowVersion,requestId:randomUUID()}
  await changeProcurementApproval(request,hooks)
  const after=await stock()
  expect((await changeProcurementApproval(request,hooks)).replayed).toBe(true)
  expect(await stock()).toBe(after)
  expect((await source('RETURN',row.id))).toMatchObject({status:'APPROVED',approvalStatus:'REVIEWED'})
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,sourceType:'UpstreamPurchaseReturn',sourceId:row.id}})).toBe(1)
 }
 const final=await prisma.upstreamPurchaseReturn.findMany({where:{tenantId,id:{in:drafts.map(row=>row.id)}}})
 expect(final[0].settlementAmount.plus(final[1].settlementAmount).plus(final[2].settlementAmount).eq(100)).toBe(true)
 const afterBalance=await prisma.warehouseLedgerBalance.findFirstOrThrow({where:{tenantId,warehouseId,productId}})
 expect(afterBalance.physicalQty.eq(beforeBalance.physicalQty.minus(15))).toBe(true)
})
