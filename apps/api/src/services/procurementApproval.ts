import {createHash} from 'node:crypto'
import {Prisma,prisma,ProcurementApprovalAction} from '@dianjie/db'
import {serializableWithRetry} from './warehouseLedger'
export type ProcurementSourceKind='RECEIPT'|'RETURN'
export type ProcurementProgressAction='save'|'submit'|'audit'|'unconfirm'|'review'
const fail=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode})
function normalized(value:any):any{
 if(value instanceof Prisma.Decimal)return value.toString()
 if(value instanceof Date)return value.toISOString()
 if(Array.isArray(value))return value.map(normalized)
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalized(value[key])]))
 return value
}
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(normalized(value))).digest('hex')
export function procurementContentFingerprint(kind:ProcurementSourceKind,source:any){
 const fields=kind==='RECEIPT'?['purchaseOrderId','shipmentId','supplierId','warehouseId','arrivedAt','payableAmount','finalForShipment','evidence']:['supplierId','warehouseId','reason','settlementAmount']
 const lineFields=kind==='RECEIPT'?['id','purchaseOrderLineId','shipmentLineId','productId','arrivedQty','acceptedQty','rejectedQty','damagedQty','orderedQty','shippedQty','shortageQty','overageQty','inventoryAcceptedQty','unitPrice','payableAmount','standardUnitPriceSnapshot','priceStandardCurrencySnapshot','priceStandardTaxInclusiveSnapshot','priceStandardId','priceStandardVersionSnapshot','purchaseUnit','inventoryUnit','inventoryUnitsPerPurchaseUnit','qualityStandardId','qualityStandardVersionSnapshot','qualityCriteriaSnapshot','qualityResult','qualityDisposition','qualityEvidence','evidence','batchNo','manufactureDate','expiryDate']:['id','receiptLineId','productId','purchaseQuantity','purchaseUnit','inventoryQuantity','inventoryUnit','inventoryUnitsPerPurchaseUnit','settlementUnitPrice','settlementAmount']
 return hash({kind,header:Object.fromEntries(fields.map(key=>[key,source[key]??null])),lines:[...source.lines].sort((a:any,b:any)=>a.id.localeCompare(b.id)).map(line=>Object.fromEntries(lineFields.map(key=>[key,line[key]??null])))})
}
export function procurementApprovalView(kind:ProcurementSourceKind,source:any){
 const posted=kind==='RECEIPT'?source.status==='POSTED':['APPROVED','RECEIVED'].includes(source.status)
 return {approvalStatus:source.approvalStatus??null,approvalVersion:source.approvalVersion,sourceVersion:source.rowVersion,sourceStatus:source.status,legacyPosted:posted&&!source.approvalStatus,businessFieldsLocked:posted||source.approvalStatus==='REVIEWED'||['REVERSED','CANCELLED','REJECTED'].includes(source.status)}
}
/** Caller-owned callbacks keep complete source posting in this transaction. No nested commit. */
export async function changeProcurementApproval(input:{tenantId:string;userId:string;kind:ProcurementSourceKind;sourceId:string;action:ProcurementProgressAction;approvalVersion:number;sourceVersion:number;requestId:string;reviewData?:Record<string,unknown>;editData?:unknown},hooks:{save?: (tx:Prisma.TransactionClient,source:any)=>Promise<{before:unknown;after:unknown}>;submit?: (tx:Prisma.TransactionClient,source:any)=>Promise<unknown>;review?: (tx:Prisma.TransactionClient,source:any)=>Promise<unknown>;reviewGuard?: (tx:Prisma.TransactionClient,source:any)=>Promise<void>}={}){
 if(input.editData&&input.action!=='save')throw fail('业务修改必须先保存后提交审核',400)
 const requestFingerprint=hash(input)
 return serializableWithRetry(async tx=>{
  const actor=await tx.user.findFirst({where:{tenantId:input.tenantId,id:input.userId,status:'ACTIVE'},select:{id:true,name:true,role:true}})
  if(!actor||!['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(actor.role))throw fail('仅供应链可操作采购审批',403)
  if(['audit','unconfirm','review'].includes(input.action)&&actor.role!=='SUPPLY_CHAIN')throw fail('采购审核与复审由供应链操作',403)
  const replay=await tx.procurementApprovalEvent.findUnique({where:{tenantId_requestId:{tenantId:input.tenantId,requestId:input.requestId}}})
  if(replay){if(replay.fingerprint!==requestFingerprint)throw fail('请求编号已用于其他操作');return {...replay.afterValue as any,replayed:true}}
  if(input.kind==='RECEIPT'){
   const preliminary=await tx.upstreamReceipt.findFirst({where:{tenantId:input.tenantId,id:input.sourceId},select:{purchaseOrderId:true}})
   if(!preliminary)throw fail('采购收货单不存在',404)
   await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-po:${preliminary.purchaseOrderId}`}))::text AS locked`
   await tx.$queryRaw`SELECT id FROM upstream_receipts WHERE id=${input.sourceId} AND "tenantId"=${input.tenantId} FOR UPDATE`
  }else await tx.$queryRaw`SELECT id FROM upstream_purchase_returns WHERE id=${input.sourceId} AND "tenantId"=${input.tenantId} FOR UPDATE`
  const read=()=>input.kind==='RECEIPT'?tx.upstreamReceipt.findFirst({where:{tenantId:input.tenantId,id:input.sourceId},include:{lines:true}}):tx.upstreamPurchaseReturn.findFirst({where:{tenantId:input.tenantId,id:input.sourceId},include:{lines:true}})
  const source=await read();if(!source)throw fail('采购单据不存在',404)
  const before=procurementApprovalView(input.kind,source)
  if(input.kind==='RECEIPT'&&(source.status==='REVERSED'||(source as any).reversedAt))throw fail('已冲销的收货单不可重新审批')
  if(before.businessFieldsLocked)throw fail('已过账或已复审的业务已锁定，不得重新审批或反审核')
  if(['CANCELLED','REJECTED'].includes(source.status))throw fail('已取消或已驳回的单据不可直接审批')
  if(source.approvalVersion!==input.approvalVersion||source.rowVersion!==input.sourceVersion)throw fail('采购单据版本已变化，请刷新核对；输入保留')
  const state=source.approvalStatus??'DRAFT'
  let contentFingerprint=procurementContentFingerprint(input.kind,source)
  let next:'DRAFT'|'PENDING'|'AUDITED'|'REVIEWED'
  let editSnapshot:{before:unknown;after:unknown}|undefined
  if(input.action==='save'){
   if(!['DRAFT','PENDING'].includes(state))throw fail('已审核内容不可保存，请先反审核')
   if(input.editData&&!hooks.save)throw fail('业务保存尚未接入',503)
   if(hooks.save)editSnapshot=await hooks.save(tx,source)
   next='DRAFT'
  }else{
   const transitions={submit:['DRAFT','PENDING'],audit:['PENDING','AUDITED'],unconfirm:['AUDITED','PENDING'],review:['AUDITED','REVIEWED']} as const
   const [from,to]=transitions[input.action];if(state!==from)throw fail('当前审批状态不允许此操作')
   if(['audit','review'].includes(input.action)&&source.approvalContentFingerprint!==contentFingerprint)throw fail('提交后的业务内容已变化，请重新保存提交')
   next=to
   if(input.action==='submit'&&hooks.submit){
    await hooks.submit(tx,source)
    // Submission may allocate a final return's rounding remainder. Freeze the
    // actual submitted amount, not the pre-allocation draft fingerprint.
    const submitted=await read();if(!submitted)throw fail('采购单据不存在',404)
    contentFingerprint=procurementContentFingerprint(input.kind,submitted)
   }
   if(input.action==='review'){
    if(!hooks.review)throw fail('采购复审完整业务尚未接入，不允许仅改状态',503)
    const audit=await tx.procurementApprovalEvent.findFirst({where:{tenantId:input.tenantId,...(input.kind==='RECEIPT'?{receiptId:source.id}:{returnId:source.id}),action:'AUDIT',afterValue:{path:['approvalVersion'],equals:source.approvalVersion}},orderBy:{createdAt:'desc'}})
    const editors=await tx.procurementApprovalEvent.findMany({where:{tenantId:input.tenantId,...(input.kind==='RECEIPT'?{receiptId:source.id}:{returnId:source.id}),action:'SAVE',afterValue:{path:['businessChanged'],equals:true}},select:{actorId:true}})
    if(actor.id===source.createdById||actor.id===(source as any).inspectorId||actor.id===audit?.actorId||editors.some(editor=>editor.actorId===actor.id))throw fail('复审须由填写及审核人员之外的另一名供应链人员完成',403)
    if(!audit)throw fail('缺少本轮审核记录，不能复审')
    if(hooks.reviewGuard)await hooks.reviewGuard(tx,source)
    await hooks.review(tx,source)
    const posted=await read()
    const physicallyPosted=posted&&(input.kind==='RECEIPT'?posted.status==='POSTED'&&!(posted as any).reversedAt:['APPROVED','RECEIVED'].includes(posted.status))
    const positiveLines=(posted?.lines||[]).filter((line:any)=>Number(input.kind==='RECEIPT'?line.inventoryAcceptedQty:line.inventoryQuantity)>0)
    if(!physicallyPosted||positiveLines.some((line:any)=>!line.ledgerMovementId))throw fail('复审未形成完整过账事实，事务已回滚')
   }
  }
  const data={approvalStatus:next,approvalVersion:{increment:1},approvalContentFingerprint:next==='DRAFT'?null:contentFingerprint}
  const updated=input.kind==='RECEIPT'?await tx.upstreamReceipt.update({where:{id:source.id},data}):await tx.upstreamPurchaseReturn.update({where:{id:source.id},data})
  const after={sourceId:source.id,kind:input.kind,...procurementApprovalView(input.kind,updated)}
  await tx.procurementApprovalEvent.create({data:{tenantId:input.tenantId,...(input.kind==='RECEIPT'?{receiptId:source.id}:{returnId:source.id}),action:input.action.toUpperCase() as ProcurementApprovalAction,requestId:input.requestId,fingerprint:requestFingerprint,actorId:actor.id,actorName:actor.name,actorRole:actor.role,beforeValue:{...before,...(editSnapshot?{business:normalized(editSnapshot.before)}:{})},afterValue:{...after,...(editSnapshot?{business:normalized(editSnapshot.after),businessChanged:JSON.stringify(normalized(editSnapshot.before))!==JSON.stringify(normalized(editSnapshot.after))}:{})}}})
  return {...after,replayed:false}
 })
}
