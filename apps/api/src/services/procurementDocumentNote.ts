import {createHash} from 'node:crypto'
import {prisma} from '@dianjie/db'
import {z} from 'zod'
import {serializableWithRetry} from './warehouseLedger'
import {procurementApprovalView,type ProcurementSourceKind} from './procurementApproval'
const schema=z.object({note:z.string().trim().max(500).nullable(),sourceVersion:z.number().int().min(0),requestId:z.string().min(8).max(100)}).strict()
const fail=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode})
/** Metadata-only path: terminal business/approval remains locked, even after posting. */
export async function saveProcurementDocumentNote(input:{tenantId:string;userId:string;kind:ProcurementSourceKind;sourceId:string;body:unknown}){
 const parsed=schema.safeParse(input.body);if(!parsed.success)throw fail('备注保存仅接受备注、单据版本和请求编号',400)
 const body={...parsed.data,note:parsed.data.note||null}
 const fingerprint=createHash('sha256').update(JSON.stringify({kind:input.kind,sourceId:input.sourceId,userId:input.userId,operation:'NOTE_ONLY',...body})).digest('hex')
 return serializableWithRetry(async tx=>{
   const actor=await tx.user.findFirst({where:{tenantId:input.tenantId,id:input.userId,status:'ACTIVE'},select:{id:true,name:true,role:true}})
   if(!actor||!['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(actor.role))throw fail('仅供应链内部人员可补充采购单据备注',403)
   const old=await tx.procurementApprovalEvent.findUnique({where:{tenantId_requestId:{tenantId:input.tenantId,requestId:body.requestId}}})
   if(old){if(old.fingerprint!==fingerprint)throw fail('请求编号已用于其他修改');return {...old.afterValue as any,replayed:true}}
   if(input.kind==='RECEIPT')await tx.$queryRaw`SELECT id FROM upstream_receipts WHERE id=${input.sourceId} AND "tenantId"=${input.tenantId} FOR UPDATE`
   else await tx.$queryRaw`SELECT id FROM upstream_purchase_returns WHERE id=${input.sourceId} AND "tenantId"=${input.tenantId} FOR UPDATE`
   const where={tenantId:input.tenantId,id:input.sourceId}
   const current=input.kind==='RECEIPT'?await tx.upstreamReceipt.findFirst({where}):await tx.upstreamPurchaseReturn.findFirst({where})
   if(!current)throw fail('采购单据不存在',404)
   if(current.rowVersion!==body.sourceVersion)throw fail('备注或单据已被其他人员更新，请刷新核对',409)
   const data={note:body.note,rowVersion:{increment:1}}
   const updated=input.kind==='RECEIPT'?await tx.upstreamReceipt.update({where:{id:current.id},data}):await tx.upstreamPurchaseReturn.update({where:{id:current.id},data})
   const result={sourceId:current.id,kind:input.kind,...procurementApprovalView(input.kind,updated),note:updated.note}
   await tx.procurementApprovalEvent.create({data:{tenantId:input.tenantId,...(input.kind==='RECEIPT'?{receiptId:current.id}:{returnId:current.id}),action:'SAVE',requestId:body.requestId,fingerprint,actorId:actor.id,actorName:actor.name,actorRole:actor.role,beforeValue:{...procurementApprovalView(input.kind,current),note:current.note},afterValue:{...result,metadataOnly:true,businessChanged:false}}})
   return {...result,replayed:false}
 })
}
