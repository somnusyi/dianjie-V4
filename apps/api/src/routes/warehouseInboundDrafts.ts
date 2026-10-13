import { FastifyInstance } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { upstreamFeatureEnabled } from '../lib/upstream-feature-flags'
import { assertSupportedDraftFormat, draftPayloadSchema, saveInboundDraft, submitInboundDraft } from '../services/warehouseInboundDrafts'
import { serializableWithRetry } from '../services/warehouseLedger'
import { normalizeWarehouseDocAttachments } from '../services/warehouseDocs'
import { assertWarehouseDocumentObjects, signOssKey } from './upload'
const versionSchema=z.object({version:z.number().int().min(1)}).strict()
const submitSchema=versionSchema.extend({auditOnSubmit:z.boolean().optional()}).strict()
export function registerWarehouseInboundDraftRoutes(app:FastifyInstance,auth:any){
 const handle=(work:any)=>async(req:any,reply:any)=>{try{return await work(req,reply)}catch(e:any){if(e instanceof z.ZodError)return reply.code(400).send({error:e.issues[0].message});if(e.statusCode)return reply.code(e.statusCode).send({error:e.message});throw e}}
 app.get('/inbound-drafts',auth,handle(async(req:any)=>{
  const {mode}=z.object({mode:z.enum(['SINGLE','BATCH','OUTBOUND'])}).parse(req.query)
  const draft=await prisma.warehouseInboundDraft.findFirst({where:{tenantId:req.user.tenantId,createdById:req.user.userId,mode,status:'EDITING'},orderBy:{updatedAt:'desc'}})
  if(!draft)return {draft:null}
  assertSupportedDraftFormat(draft)
  const attachments=normalizeWarehouseDocAttachments(req.user.tenantId,draftPayloadSchema.parse(draft.payload).attachments)
  return {draft:{...draft,attachmentUrls:Object.fromEntries(attachments.map(a=>[a.key,signOssKey(a.key)]))}}
 }))
 // Resolve an uncertain submit after reload without creating a replacement receipt.
 app.get('/inbound-drafts/:id',auth,handle(async(req:any)=>{
  const draft=await prisma.warehouseInboundDraft.findFirst({where:{id:String(req.params.id),tenantId:req.user.tenantId,createdById:req.user.userId}})
  if(!draft)return {draft:null}
  assertSupportedDraftFormat(draft)
  const attachments=normalizeWarehouseDocAttachments(req.user.tenantId,draftPayloadSchema.parse(draft.payload).attachments)
  return {draft:{...draft,attachmentUrls:Object.fromEntries(attachments.map(a=>[a.key,signOssKey(a.key)]))}}
 }))
 app.put('/inbound-drafts/:id',auth,handle(async(req:any)=>{
  const id=z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/).parse(req.params.id)
  const body=z.object({baseVersion:z.number().int().min(0),payload:draftPayloadSchema,reconfirmSnapshot:z.boolean().optional(),reconfirmRequestId:z.string().trim().min(8).max(100).optional()}).strict().parse(req.body)
  return {draft:await saveInboundDraft({tenantId:req.user.tenantId,userId:req.user.userId,id,...body})}
 }))
 app.post('/inbound-drafts/:id/submit',auth,handle(async(req:any,reply:any)=>{
  const {version,auditOnSubmit}=submitSchema.parse(req.body)
  const draft=await prisma.warehouseInboundDraft.findFirst({where:{id:String(req.params.id),tenantId:req.user.tenantId,createdById:req.user.userId}})
  if(!draft)return reply.code(404).send({error:'草稿不存在'})
  assertSupportedDraftFormat(draft)
  if(draft.mode!=='OUTBOUND' && upstreamFeatureEnabled('UPSTREAM_MANUAL_INBOUND_RESTRICTED'))return reply.code(409).send({error:'手工入库已收口，请从上游采购验收入库'})
  if(draft.status==='EDITING')await assertWarehouseDocumentObjects(req.user.tenantId,normalizeWarehouseDocAttachments(req.user.tenantId,draftPayloadSchema.parse(draft.payload).attachments))
  const result=await submitInboundDraft({tenantId:req.user.tenantId,userId:req.user.userId,id:draft.id,version,auditOnSubmit})
  return {replayed:result.replayed,gateWarnings:result.gateWarnings,count:result.doc.lineCount,totalAmount:Number(result.doc.totalAmount),doc:{id:result.doc.id,docNo:result.doc.docNo,status:result.doc.status,reviewStatus:result.doc.reviewStatus}}
 }))
 app.post('/inbound-drafts/:id/discard',auth,handle(async(req:any,reply:any)=>{
  const {version}=versionSchema.parse(req.body)
  return serializableWithRetry(async tx=>{
   const draft=await tx.warehouseInboundDraft.findFirst({where:{id:String(req.params.id),tenantId:req.user.tenantId,createdById:req.user.userId}})
   if(!draft)return reply.code(404).send({error:'草稿不存在'})
   assertSupportedDraftFormat(draft)
   if(draft.status==='DISCARDED')return {ok:true}
   if(draft.status!=='EDITING'||draft.version!==version)return reply.code(409).send({error:'草稿状态或版本已变化，未丢弃，请重新加载'})
   await tx.warehouseInboundDraft.update({where:{id:draft.id},data:{status:'DISCARDED',version:{increment:1}}});return {ok:true}
  })
 }))
}
