import {createHash} from 'node:crypto'
import {Prisma, prisma} from '@dianjie/db'
import {z} from 'zod'
import {serializableWithRetry} from './warehouseLedger'
import {normalizeWarehouseDocAttachments} from './warehouseDocs'
import {assertWarehouseDocumentObjects, signOssKey, canReadWarehouseDocument, canUploadWarehouseDocument} from '../routes/upload'
export type QualityImageSource = 'WAREHOUSE' | 'RECEIPT' | 'RETURN'
const fail = (message:string,statusCode=409) => Object.assign(new Error(message),{statusCode})
const attachmentSchema=z.object({key:z.string().min(1).max(1024),name:z.string().min(1).max(160),mime:z.enum(['image/jpeg','image/png','image/webp','image/gif']),size:z.number().int().positive().max(10*1024*1024)}).strict()
export const qualityImageBodySchema = z.union([
  z.object({version:z.number().int().min(0),requestId:z.string().min(8).max(100),image:attachmentSchema}).strict(),
  z.object({version:z.number().int().min(0),requestId:z.string().min(8).max(100),images:z.array(z.union([attachmentSchema,z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict()])).max(50)}).strict(),
])
type Attachment=z.infer<typeof attachmentSchema>
const normalizeImage=(tenantId:string,image:Attachment)=>attachmentSchema.parse(normalizeWarehouseDocAttachments(tenantId,[image])[0])
const imageId=(image:Attachment)=>createHash('sha256').update(image.key).digest('hex')
function storedImages(record:any):Attachment[]{
  if(!record)return []
  return Array.isArray(record.image?.images)?record.image.images:record.image?.key?[record.image]:[]
}
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
function safeImages(record:any){
  return storedImages(record).map(image=>({id:imageId(image),name:image.name,mime:image.mime,size:image.size,url:signOssKey(image.key),version:record.version,createdAt:record.createdAt,actorName:record.actorName}))
}
function safeImage(record:any){return safeImages(record).at(-1)||null}
function result(record:any,replayed:boolean){return {version:record.version,image:safeImage(record),images:safeImages(record),replayed}}
export async function getDocumentQualityImage(input:{tenantId:string;userId:string;kind:QualityImageSource;sourceId:string}){
  return prisma.$transaction(async tx=>{
    const actor=await actorAccess(tx,input.tenantId,input.userId,input.kind)
    await source(tx,input.tenantId,input.kind,input.sourceId)
    const field=input.kind==='WAREHOUSE'?Prisma.sql`"warehouseDocId"`:input.kind==='RECEIPT'?Prisma.sql`"receiptId"`:Prisma.sql`"returnId"`
    const records=await tx.$queryRaw<any[]>(Prisma.sql`SELECT * FROM document_quality_images WHERE "tenantId"=${input.tenantId} AND ${field}=${input.sourceId} AND NOT (image ? 'batchImages') ORDER BY version DESC LIMIT 20`)
    return {version:records[0]?.version||0,image:safeImage(records[0]),images:safeImages(records[0]),history:records.map(record=>({version:record.version,createdAt:record.createdAt,actorName:record.actorName,images:safeImages(record)})),canWrite:input.kind==='WAREHOUSE'?canUploadWarehouseDocument(actor.role):['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(actor.role)}
  })
}
export async function saveDocumentQualityImage(input:{tenantId:string;userId:string;kind:QualityImageSource;sourceId:string;body:z.infer<typeof qualityImageBodySchema>},checkObjects=assertWarehouseDocumentObjects){
  const parsed=qualityImageBodySchema.safeParse(input.body)
  if(!parsed.success)throw fail('图片保存参数不正确，每组最多50张、单张最大10MB',400)
  const data=parsed.data
  const legacy='image' in data
  // Keep the legacy fingerprint byte-for-byte compatible with successful old requests.
  const image=legacy?normalizeImage(input.tenantId,data.image):undefined
  const entries=legacy?[]:data.images.map(entry=>'id' in entry?entry:normalizeImage(input.tenantId,entry))
  const fingerprint=createHash('sha256').update(JSON.stringify({userId:input.userId,kind:input.kind,sourceId:input.sourceId,version:data.version,...(legacy?{image}:{images:entries})})).digest('hex')
  // Check network objects before taking source locks; recheck actor/source and replay
  // in the write transaction. Successful retries do not need another OSS HEAD.
  const existing=await prisma.$transaction(async tx=>{
    await actorAccess(tx,input.tenantId,input.userId,input.kind,true)
    await source(tx,input.tenantId,input.kind,input.sourceId)
    return tx.documentQualityImage.findUnique({where:{tenantId_requestId:{tenantId:input.tenantId,requestId:parsed.data.requestId}}})
  })
  if(existing){if(existing.fingerprint!==fingerprint)throw fail('请求编号已用于其他图片保存');return result(existing,true)}
  await checkObjects(input.tenantId,legacy?[image!]:entries.filter((entry):entry is Attachment=>'key' in entry))
  return serializableWithRetry(async tx=>{
    const actor=await actorAccess(tx,input.tenantId,input.userId,input.kind,true)
    await source(tx,input.tenantId,input.kind,input.sourceId,true)
    const replay=await tx.documentQualityImage.findUnique({where:{tenantId_requestId:{tenantId:input.tenantId,requestId:parsed.data.requestId}}})
    if(replay){if(replay.fingerprint!==fingerprint)throw fail('请求编号已用于其他图片保存');return result(replay,true)}
    const previous=await tx.documentQualityImage.findFirst({where:{tenantId:input.tenantId,...sourceWhere(input.kind,input.sourceId)},orderBy:{version:'desc'}})
    if((previous?.image as any)?.batchImages)throw fail('质检已按商品本次进货管理，请使用新的质检入口')
    if((previous?.version||0)!==parsed.data.version)throw fail('图片已被其他人员更新，请查看最新图片后重新保存')
    const previousImages=storedImages(previous)
    const images:Attachment[]=legacy?[...previousImages.filter(item=>item.key!==image!.key),image!]:entries.map(entry=>{
      if('key' in entry)return entry
      const retained=previousImages.find(item=>imageId(item)===entry.id)
      if(!retained)throw fail('保留的图片不属于当前单据版本，请重新加载',400)
      return retained
    })
    if(images.length>50)throw fail('每张单据最多保存50张质检图片',400)
    if(new Set(images.map(item=>item.key)).size!==images.length)throw fail('同一图片不能重复添加',400)
    const record=await tx.documentQualityImage.create({data:{tenantId:input.tenantId,...sourceWhere(input.kind,input.sourceId),version:parsed.data.version+1,requestId:parsed.data.requestId,fingerprint,image:{images},actorId:actor.id,actorName:actor.name,actorRole:actor.role}})
    await tx.opLog.create({data:{tenantId:input.tenantId,userId:actor.id,role:actor.role,action:'保存单据质检图片',entityType:input.kind,targetId:input.sourceId,metadata:{requestId:parsed.data.requestId,previousImageId:previous?.id||null,imageId:record.id,version:record.version}}})
    return result(record,false)
  })
}
