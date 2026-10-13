import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import {createHash} from 'node:crypto'
import {warehouseDraftSnapshotSchema,captureWarehouseDraftSnapshot,assertWarehouseDraftSnapshot} from './warehouseDraftSnapshot'
import { hasInternalSupplyChainCapability } from '../lib/internal-supply-chain-access'
import { recordBatchManualWarehouseOutbound, recordBatchManualWarehouseInbound, recordManualWarehouseInbound, serializableWithRetry } from './warehouseLedger'
import { ensureWarehouseDocInTransaction, normalizeWarehouseDocAttachments, confirmWarehouseDocInTransaction } from './warehouseDocs'
const text = z.string().max(240).default('')
const attachment = z.object({ key: z.string().max(1024), name: z.string().max(160), mime: z.enum(['image/jpeg','image/png','image/webp','image/gif','application/pdf']), size: z.number().int().positive().max(10*1024*1024) }).strict()
const displayUnits=z.array(z.object({productId:z.string(),unit:z.string(),inventoryUnit:z.string(),conversionFactor:z.number().nullable()}).strict()).max(200).optional()
const shared = { displayUnits,warehouseId:text,executionSnapshot:warehouseDraftSnapshotSchema.optional(),effectiveAt: text, effectiveAtIso: text, supplierId: text, note: text, attachments: z.array(attachment).max(9).default([]) }
const row = z.object({ productId: text, purchaseQuantity: text, unitPrice: text, amount: text, note: text, batchNo: text, manufactureDate: text, expiryDate: text, isGift:z.boolean().default(false), priceSource: z.enum(['none','auto','manual']).default('none'), amountSource: z.enum(['none','auto','manual']).default('none') }).strict()
export const draftPayloadSchema = z.discriminatedUnion('mode', [
 z.object({ mode:z.literal('SINGLE'), ...shared, productId:text, purchaseQuantity:text, totalAmount:text, singleUnitPrice:text, isGift:z.boolean().default(false), batchNo:text, manufactureDate:text, expiryDate:text, priceSource:z.enum(['none','auto','manual']).default('none'), amountSource:z.enum(['none','auto','manual']).default('none') }).strict(),
 z.object({ mode:z.literal('BATCH'), ...shared, rows:z.array(row).max(200).default([]) }).strict(),
 z.object({mode:z.literal('OUTBOUND'),...shared,purpose:z.enum(['','STORE_REALLOCATION','SAMPLE_ISSUE','HISTORICAL_CORRECTION']).default(''),reason:text,responsibility:text,sourceName:text,rows:z.array(z.object({productId:text,inventoryQuantity:text,totalAmount:text,note:text}).strict()).max(200).default([])}).strict(),
])
export type InboundDraftPayload = z.infer<typeof draftPayloadSchema>
function error(message:string, statusCode=409) { return Object.assign(new Error(message),{statusCode}) }
// The snapshot format version is distinct from the optimistic edit version.
// Unknown fields/formats must never be discarded or rewritten by this reader.
export function assertSupportedDraftFormat(draft:{payload:unknown}) {
 if(!draftPayloadSchema.safeParse(draft.payload).success)throw error('此草稿格式当前版本不支持或内容异常，请使用兼容版本核对；原草稿已保留')
}
export async function saveInboundDraft(input:{tenantId:string;userId:string;id:string;baseVersion:number;payload:InboundDraftPayload;reconfirmSnapshot?:boolean;reconfirmRequestId?:string}) {
 const payload=draftPayloadSchema.parse(input.payload)
 normalizeWarehouseDocAttachments(input.tenantId,payload.attachments)
 const content=(value:InboundDraftPayload)=>{const {executionSnapshot,...body}=value;return JSON.stringify(body)}
 const requestId=input.reconfirmRequestId?.trim()
 if(input.reconfirmSnapshot&&(!requestId||requestId.length<8||requestId.length>100))throw error('重新核对需要原请求编号，请从编辑页重新核对',400)
 const fingerprint=createHash('sha256').update(JSON.stringify({tenantId:input.tenantId,actorId:input.userId,draftId:input.id,baseVersion:input.baseVersion,content:content(payload)})).digest('hex')
 return serializableWithRetry(async tx=>{
  await tx.$queryRaw`SELECT id FROM warehouse_inbound_drafts WHERE id=${input.id} AND "tenantId"=${input.tenantId} AND "createdById"=${input.userId} FOR UPDATE`
  const current=await tx.warehouseInboundDraft.findUnique({where:{id:input.id}})
  if(current && (current.tenantId!==input.tenantId || current.createdById!==input.userId)) throw error('草稿不存在',404)
  if(current)assertSupportedDraftFormat(current)
  if(input.reconfirmSnapshot){
    const proof=await tx.warehouseDraftReconfirmation.findUnique({where:{tenantId_requestId:{tenantId:input.tenantId,requestId:requestId!}}})
    if(proof){
      if(!current||proof.draftId!==input.id||proof.actorId!==input.userId||proof.baseVersion!==input.baseVersion||proof.payloadFingerprint!==fingerprint)throw error('原核对请求不能用于另一草稿、演员、版本或内容')
      return {...current,reconfirmationReceipt:{requestId:proof.requestId,replayed:true,resultVersion:proof.resultVersion,confirmedSnapshot:draftPayloadSchema.parse(proof.resultPayload).executionSnapshot,currentVersion:current.version,currentStatus:current.status,requiresReload:current.version!==proof.resultVersion||current.status!=='EDITING'}}
    }
  }
  if(current && (current.status!=='EDITING' || current.mode!==payload.mode)) throw error('草稿已提交或已丢弃，请重新打开')
  const previous=current?draftPayloadSchema.parse(current.payload):null
  if(current && !input.reconfirmSnapshot && content(previous!)===content(payload)) return current
  if(current && current.version!==input.baseVersion) throw error('草稿已在其他页面或设备修改，本页输入仍保留，请重新加载或另存')
  delete payload.executionSnapshot
  const ids=payload.mode==='SINGLE'?[payload.productId]:payload.rows.map(row=>row.productId)
  if(!current||previous?.executionSnapshot||input.reconfirmSnapshot){
    const frozen=await captureWarehouseDraftSnapshot(tx,input.tenantId,payload.warehouseId||previous?.executionSnapshot?.warehouse.id,ids)
    if(!input.reconfirmSnapshot){
      frozen.products=frozen.products.map(product=>{
        const shown=payload.displayUnits?.find(row=>row.productId===product.id),units=product.units
        const matched=Boolean(shown&&units&&shown.inventoryUnit===units.inventoryUnit&&shown.unit===(payload.mode==='OUTBOUND'?units.inventoryUnit:units.purchaseUnit)&&shown.conversionFactor===(payload.mode==='OUTBOUND'?1:units.inventoryUnitsPerPurchaseUnit))
        return {...product,displayMatched:matched}
      })
    }
    if(previous?.executionSnapshot&&!input.reconfirmSnapshot){
      if(!payload.warehouseId||payload.warehouseId===previous.executionSnapshot.warehouse.id)frozen.warehouse=previous.executionSnapshot.warehouse
      const old=new Map(previous.executionSnapshot.products.map(row=>[row.id,row]))
      frozen.products=frozen.products.map(row=>{
        const saved=old.get(row.id)
        if(!saved)return row
        const shown=payload.displayUnits?.find(value=>value.productId===saved.id),units=saved.units
        const stillMatched=Boolean(shown&&units&&shown.inventoryUnit===units.inventoryUnit&&shown.unit===(payload.mode==='OUTBOUND'?units.inventoryUnit:units.purchaseUnit)&&shown.conversionFactor===(payload.mode==='OUTBOUND'?1:units.inventoryUnitsPerPurchaseUnit))
        return {...saved,displayMatched:saved.displayMatched&&stillMatched}
      })
    }
    payload.executionSnapshot=frozen
  }
  if(!current){
   if(input.baseVersion!==0) throw error('草稿不存在，请重新加载',404)
   if(await tx.warehouseInboundDraft.findFirst({where:{tenantId:input.tenantId,createdById:input.userId,mode:payload.mode,status:'EDITING'}})) throw error('已有未提交草稿，请关闭并重新打开恢复；本页输入仍保留')
   const created=await tx.warehouseInboundDraft.create({data:{id:input.id,tenantId:input.tenantId,createdById:input.userId,mode:payload.mode,payload:payload as Prisma.InputJsonValue}})
   if(input.reconfirmSnapshot)await tx.warehouseDraftReconfirmation.create({data:{tenantId:input.tenantId,draftId:created.id,actorId:input.userId,requestId:requestId!,baseVersion:input.baseVersion,resultVersion:created.version,payloadFingerprint:fingerprint,resultPayload:created.payload as Prisma.InputJsonValue}})
   return created
  }
  const updated=await tx.warehouseInboundDraft.update({where:{id:current.id},data:{version:{increment:1},payload:payload as Prisma.InputJsonValue}})
  if(input.reconfirmSnapshot)await tx.warehouseDraftReconfirmation.create({data:{tenantId:input.tenantId,draftId:updated.id,actorId:input.userId,requestId:requestId!,baseVersion:input.baseVersion,resultVersion:updated.version,payloadFingerprint:fingerprint,resultPayload:updated.payload as Prisma.InputJsonValue}})
  return updated
 })
}
export async function submitInboundDraft(input:{tenantId:string;userId:string;id:string;version:number;auditOnSubmit?:boolean}) {
 return serializableWithRetry(async tx=>{
  await tx.$queryRaw`SELECT id FROM warehouse_inbound_drafts WHERE id=${input.id} AND "tenantId"=${input.tenantId} AND "createdById"=${input.userId} FOR UPDATE`
  const draft=await tx.warehouseInboundDraft.findFirst({where:{id:input.id,tenantId:input.tenantId,createdById:input.userId}})
  if(!draft) throw error('草稿不存在',404)
  assertSupportedDraftFormat(draft)
  if(draft.status==='SUBMITTED') return {replayed:true,doc:await tx.warehouseDoc.findUniqueOrThrow({where:{id:draft.docId!}}),gateWarnings:[] as string[]}
  if(draft.status!=='EDITING' || draft.version!==input.version) throw error('草稿状态或版本已变化，本页输入保留，请重新加载')
  const payload=draftPayloadSchema.parse(draft.payload)
  const ids=payload.mode==='SINGLE'?[payload.productId]:payload.rows.map(row=>row.productId)
  await assertWarehouseDraftSnapshot(tx,input.tenantId,payload.executionSnapshot,ids,payload.mode==='OUTBOUND')
  const willAudit=payload.mode==='OUTBOUND' ? input.auditOnSubmit===true : input.auditOnSubmit!==false
  if(willAudit){
   const actor=await tx.user.findFirst({where:{id:input.userId,tenantId:input.tenantId},select:{role:true}})
   if(!hasInternalSupplyChainCapability(actor?.role,'inventory.write'))throw error('库存单据审核由供应链操作',403)
  }
  const effectiveAt=new Date(payload.effectiveAtIso)
  if(!Number.isFinite(effectiveAt.getTime())) throw error('请填写有效入库时间',400)
  if(payload.mode==='OUTBOUND')return submitOutboundInTransaction(tx,input,draft,payload,effectiveAt)
  const supplier=await tx.supplier.findFirst({where:{id:payload.supplierId,tenantId:input.tenantId,status:'ENABLED',businessScopes:{has:'WAREHOUSE_UPSTREAM'}}})
  if(!supplier) throw error('请选择启用的总仓上游供应商',400)
  const raw=payload.mode==='SINGLE' ? [{productId:payload.productId,purchaseQuantity:payload.purchaseQuantity,amount:payload.totalAmount,isGift:payload.isGift,batchNo:payload.batchNo,manufactureDate:payload.manufactureDate,expiryDate:payload.expiryDate}] : payload.rows
  if(!raw.length) throw error('请至少添加一个入库商品',400)
  const items=raw.map(r=>{
   for(const field of ['manufactureDate','expiryDate'] as const){
    const value=field in r ? String((r as Record<string,unknown>)[field] || '') : ''
    if(value && !z.string().date().safeParse(value).success)throw error('生产或到期日期无效',400)
   }
   if (r.batchNo.trim().length > 80) throw error('批次号最多80个字符',400)
   if (r.manufactureDate && r.expiryDate && r.expiryDate < r.manufactureDate) throw error('到期日期不能早于生产日期',400)
   const purchaseQuantity=Number(r.purchaseQuantity), totalAmount=Number(r.amount)
   if(!Number.isFinite(purchaseQuantity)||purchaseQuantity<=0||purchaseQuantity>99999999||!Number.isFinite(totalAmount)||(r.isGift ? totalAmount!==0 : totalAmount<=0)||totalAmount>999999999.99) throw error('商品数量须大于0；普通商品金额大于0，明确赠品金额必须为0',400)
   return {productId:r.productId,purchaseQuantity,totalAmount,isGift:r.isGift,unitPrice:totalAmount/purchaseQuantity,note:'note' in r ? r.note || null : null,batchNo:'batchNo' in r ? r.batchNo || null : null,manufactureDate:'manufactureDate' in r && r.manufactureDate ? new Date(`${r.manufactureDate}T00:00:00.000Z`):null,expiryDate:'expiryDate' in r && r.expiryDate ? new Date(`${r.expiryDate}T00:00:00.000Z`):null}
  })
  const common={warehouseId:payload.executionSnapshot!.warehouse.id,tenantId:input.tenantId,userId:input.userId,supplierId:supplier.id,sourceName:supplier.name,note:payload.note,effectiveAt,idempotencyKey:draft.id}
  const single=payload.mode==='SINGLE' ? await recordManualWarehouseInbound({...common,...items[0]},tx):null
  const batch=single ? {movements:[single.movement],warehouseId:single.warehouseId} : await recordBatchManualWarehouseInbound({...common,items},tx)
  const products=await tx.product.findMany({where:{tenantId:input.tenantId,id:{in:items.map(i=>i.productId)}}})
  const relations=await tx.productUpstreamSource.findMany({where:{tenantId:input.tenantId,supplierId:supplier.id,isActive:true,productId:{in:items.map(i=>i.productId)}},select:{productId:true}})
  const bound=new Set(relations.map(r=>r.productId))
  const gateWarnings=products.filter(p=>!bound.has(p.id)).map(p=>`${p.name}（${p.code}）未绑定该供应商的供货关系`)
  const {doc}=await ensureWarehouseDocInTransaction(tx,{...common,type:'MANUAL_INBOUND',warehouseId:batch.warehouseId,supplierName:supplier.name,attachments:normalizeWarehouseDocAttachments(input.tenantId,payload.attachments),idempotencyKey:`inbound-draft:${draft.id}`,lines:items.map((item,index)=>{
   const movement=batch.movements[index], product=products.find(p=>p.id===item.productId)!
   return {...item,productName:product.name,quantity:item.purchaseQuantity,unit:product.purchaseUnit||movement.inventoryUnit,amount:item.totalAmount,inventoryQuantity:Number(movement.physicalDelta),inventoryUnit:movement.inventoryUnit,movementId:movement.id}
  })})
  // Legacy callers submitted-and-audited in one action. The shared editor uses
  // auditOnSubmit=false for its separate Submit button, then confirm for Audit.
  // A submitted draft replay above never escalates the document's audit state.
  const submittedDoc=input.auditOnSubmit===false ? doc : (await confirmWarehouseDocInTransaction(tx,{tenantId:input.tenantId,userId:input.userId,docId:doc.id})).doc
  await tx.warehouseInboundDraft.update({where:{id:draft.id},data:{status:'SUBMITTED',docId:doc.id,version:{increment:1}}})
  if(gateWarnings.length) await tx.opLog.create({data:{tenantId:input.tenantId,userId:input.userId,action:`入库闸口警告：${gateWarnings.length}项未绑定`,target:draft.id,entityType:'WarehouseInboundDraft',targetId:draft.id,metadata:{warnings:gateWarnings}}})
  return {replayed:false,doc:submittedDoc,gateWarnings}
 },30000)
}

async function submitOutboundInTransaction(tx:Prisma.TransactionClient,input:{tenantId:string;userId:string;id:string;auditOnSubmit?:boolean},draft:{id:string},payload:Extract<InboundDraftPayload,{mode:'OUTBOUND'}>,effectiveAt:Date){
 if(!payload.purpose || payload.reason.trim().length<2)throw error('请选择出库用途并填写至少2个字的原因/去向',400)
 if(payload.reason.trim().length>120||payload.responsibility.trim().length>114||payload.sourceName.trim().length>120)throw error('出库原因最多120字，责任归属最多114字，去向最多120字',400)
 const documentNote=[payload.note,payload.responsibility?`责任归属：${payload.responsibility}`:'',payload.sourceName?`去向：${payload.sourceName}`:''].filter(Boolean).join('；')
 if(documentNote.length>240)throw error('备注、责任归属与去向合计最多240字，请减少后再提交',400)
 if(!payload.rows.length)throw error('请至少添加一个出库商品',400)
 const items=payload.rows.map(row=>{
  const inventoryQuantity=Number(row.inventoryQuantity),totalAmount=row.totalAmount.trim()===''?null:Number(row.totalAmount)
  if(!Number.isFinite(inventoryQuantity)||inventoryQuantity<=0||inventoryQuantity>99999999||totalAmount!==null&&(!Number.isFinite(totalAmount)||totalAmount<=0||totalAmount>999999999.99))throw error('出库数量必须大于0，指定成本须大于0；可留空按台账成本计算',400)
  return {productId:row.productId,inventoryQuantity,totalAmount,note:row.note||null}
 })
 const labels={STORE_REALLOCATION:'门店拨补',SAMPLE_ISSUE:'样品领用',HISTORICAL_CORRECTION:'历史补录'}
 const reason=`【${labels[payload.purpose]}】${payload.reason.trim()}`
 if(reason.length>120)throw error('出库用途与原因合计最多120字，请减少原因后再提交',400)
 const products=await tx.product.findMany({where:{tenantId:input.tenantId,id:{in:items.map(i=>i.productId)}}})
 const result=await recordBatchManualWarehouseOutbound({warehouseId:payload.executionSnapshot!.warehouse.id,tenantId:input.tenantId,userId:input.userId,items,effectiveAt,idempotencyKey:draft.id,reason,sourceName:payload.responsibility?`责任归属：${payload.responsibility}`:payload.sourceName||null,businessType:'GENERIC'},tx)
 const {doc}=await ensureWarehouseDocInTransaction(tx,{tenantId:input.tenantId,userId:input.userId,type:'MANUAL_OUTBOUND',warehouseId:result.warehouseId,effectiveAt,idempotencyKey:`outbound-draft:${draft.id}`,reason,note:documentNote||null,attachments:normalizeWarehouseDocAttachments(input.tenantId,payload.attachments),lines:items.map(item=>{
  const m=result.movements.find(row=>row.productId===item.productId)!,p=products.find(p=>p.id===item.productId)!
  const quantity=Math.abs(Number(m.physicalDelta)),amount=Math.abs(Number(m.valueDelta))
  return {productId:item.productId,productName:p.name,quantity,unit:m.inventoryUnit,unitPrice:quantity>0?amount/quantity:null,amount,inventoryQuantity:quantity,inventoryUnit:m.inventoryUnit,movementId:m.id,note:item.note}
 })})
 const submittedDoc=input.auditOnSubmit===true?(await confirmWarehouseDocInTransaction(tx,{tenantId:input.tenantId,userId:input.userId,docId:doc.id})).doc:doc
 await tx.warehouseInboundDraft.update({where:{id:draft.id},data:{status:'SUBMITTED',docId:doc.id,version:{increment:1}}})
 return {replayed:false,doc:submittedDoc,gateWarnings:[] as string[]}
}
