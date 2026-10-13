import {createHash} from 'node:crypto'
import {Prisma, prisma} from '@dianjie/db'
import {z} from 'zod'
import {serializableWithRetry} from './warehouseLedger'
import {normalizeWarehouseDocAttachments} from './warehouseDocs'
import {assertWarehouseDocumentObjects, signOssKey, canReadWarehouseDocument, canUploadWarehouseDocument} from '../routes/upload'
export type QualityImageSource = 'WAREHOUSE' | 'RECEIPT' | 'RETURN'
const fail = (message:string,statusCode=409) => Object.assign(new Error(message),{statusCode})
export const qualityImageBodySchema = z.object({
  version:z.number().int().min(0), requestId:z.string().min(8).max(100),
  image:z.object({key:z.string().min(1).max(1024),name:z.string().min(1).max(160),mime:z.enum(['image/jpeg','image/png','image/webp','image/gif']),size:z.number().int().positive().max(10*1024*1024)}).strict(),
}).strict()
const sourceWhere = (kind:QualityImageSource,id:string) => kind==='WAREHOUSE'?{warehouseDocId:id}:kind==='RECEIPT'?{receiptId:id}:{returnId:id}
async function actorAccess(tx:Prisma.TransactionClient,tenantId:string,userId:string,kind:QualityImageSource,write=false){
  const actor=await tx.user.findFirst({where:{tenantId,id:userId,status:'ACTIVE'},select:{id:true,name:true,role:true}})
  const allowed=actor&&(kind==='WAREHOUSE'?(write?canUploadWarehouseDocument(actor.role):canReadWarehouseDocument(actor.role)):['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(actor.role))
  if(!allowed)throw fail('无权访问本单据质检图片',403)
  return actor!
}
async function source(tx:Prisma.TransactionClient,tenantId:string,kind:QualityImageSource,id:string,lock=false){
  if(lock){
    if(kind==='WAREHOUSE')await tx.$queryRaw`SELECT id FROM warehouse_docs WHERE id=${id} AND "tenantId"=${tenantId} FOR UPDATE`
    else if(kind==='RECEIPT')await tx.$queryRaw`SELECT id FROM upstream_receipts WHERE id=${id} AND "tenantId"=${tenantId} FOR UPDATE`
    else await tx.$queryRaw`SELECT id FROM upstream_purchase_returns WHERE id=${id} AND "tenantId"=${tenantId} FOR UPDATE`
  }
  const where={tenantId,id}
  const row=kind==='WAREHOUSE'?await tx.warehouseDoc.findFirst({where,select:{id:true,docNo:true}}):kind==='RECEIPT'?await tx.upstreamReceipt.findFirst({where,select:{id:true,no:true}}):await tx.upstreamPurchaseReturn.findFirst({where,select:{id:true,no:true}})
  if(!row)throw fail('单据不存在',404)
  return row
}
function safeImage(record:any){
  if(!record)return null
  const image=record.image as {key:string;name:string;mime:string;size:number}
  return {name:image.name,mime:image.mime,size:image.size,url:signOssKey(image.key),version:record.version,createdAt:record.createdAt,actorName:record.actorName}
}
export async function getDocumentQualityImage(input:{tenantId:string;userId:string;kind:QualityImageSource;sourceId:string}){
  return prisma.$transaction(async tx=>{
    const actor=await actorAccess(tx,input.tenantId,input.userId,input.kind)
    await source(tx,input.tenantId,input.kind,input.sourceId)
    const records=await tx.documentQualityImage.findMany({where:{tenantId:input.tenantId,...sourceWhere(input.kind,input.sourceId)},orderBy:{version:'desc'},take:20})
    return {version:records[0]?.version||0,image:safeImage(records[0]),history:records.map(safeImage),canWrite:input.kind==='WAREHOUSE'?canUploadWarehouseDocument(actor.role):['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(actor.role)}
  })
}
export async function saveDocumentQualityImage(input:{tenantId:string;userId:string;kind:QualityImageSource;sourceId:string;body:z.infer<typeof qualityImageBodySchema>},checkObjects=assertWarehouseDocumentObjects){
  const parsed=qualityImageBodySchema.safeParse(input.body)
  if(!parsed.success)throw fail('图片保存参数不正确，仅支持单张图片、图片版本和请求编号',400)
  const image=normalizeWarehouseDocAttachments(input.tenantId,[parsed.data.image])[0]
  const fingerprint=createHash('sha256').update(JSON.stringify({userId:input.userId,kind:input.kind,sourceId:input.sourceId,version:parsed.data.version,image})).digest('hex')
  // Check network objects before taking source locks; recheck actor/source and replay
  // in the write transaction. Successful retries do not need another OSS HEAD.
  const existing=await prisma.$transaction(async tx=>{
    await actorAccess(tx,input.tenantId,input.userId,input.kind,true)
    await source(tx,input.tenantId,input.kind,input.sourceId)
    return tx.documentQualityImage.findUnique({where:{tenantId_requestId:{tenantId:input.tenantId,requestId:parsed.data.requestId}}})
  })
  if(existing){if(existing.fingerprint!==fingerprint)throw fail('请求编号已用于其他图片保存');return {version:existing.version,image:safeImage(existing),replayed:true}}
  await checkObjects(input.tenantId,[image])
  return serializableWithRetry(async tx=>{
    const actor=await actorAccess(tx,input.tenantId,input.userId,input.kind,true)
    await source(tx,input.tenantId,input.kind,input.sourceId,true)
    const replay=await tx.documentQualityImage.findUnique({where:{tenantId_requestId:{tenantId:input.tenantId,requestId:parsed.data.requestId}}})
    if(replay){if(replay.fingerprint!==fingerprint)throw fail('请求编号已用于其他图片保存');return {version:replay.version,image:safeImage(replay),replayed:true}}
    const previous=await tx.documentQualityImage.findFirst({where:{tenantId:input.tenantId,...sourceWhere(input.kind,input.sourceId)},orderBy:{version:'desc'}})
    if((previous?.version||0)!==parsed.data.version)throw fail('图片已被其他人员更新，请查看最新图片后重新保存')
    const record=await tx.documentQualityImage.create({data:{tenantId:input.tenantId,...sourceWhere(input.kind,input.sourceId),version:parsed.data.version+1,requestId:parsed.data.requestId,fingerprint,image,actorId:actor.id,actorName:actor.name,actorRole:actor.role}})
    await tx.opLog.create({data:{tenantId:input.tenantId,userId:actor.id,role:actor.role,action:'保存单据质检图片',entityType:input.kind,targetId:input.sourceId,metadata:{requestId:parsed.data.requestId,previousImageId:previous?.id||null,imageId:record.id,version:record.version}}})
    return {version:record.version,image:safeImage(record),replayed:false}
  })
}
