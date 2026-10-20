import {supplierVisiblePurchaseOrder} from '../lib/upstream-order-visibility'
import {createHash} from 'node:crypto'
import {Prisma,prisma} from '@dianjie/db'
import {z} from 'zod'
import {serializableWithRetry} from './warehouseLedger'
import {signOssKey,canReadWarehouseDocument,canUploadWarehouseDocument,assertQualityBatchObjects} from '../routes/upload'
import {requireSupplierCapability} from '../lib/supplier-access'

const fail=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode})
const internal=new Set(['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'])
export type QualityContext='SHIPMENT'|'ORDER'|'RECEIPT'|'RETURN'|'WAREHOUSE'
type Identity={tenantId:string;userId:string}
const imageSchema=z.object({key:z.string().min(1).max(1024),name:z.string().trim().min(1).max(160),mime:z.enum(['image/jpeg','image/png','image/webp','image/gif']),size:z.number().int().positive().max(10*1024*1024)}).strict()
export const goodsBatchQualityBody=z.object({version:z.number().int().min(0),requestId:z.string().min(8).max(100),images:z.array(z.union([imageSchema,z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict()])).max(50)}).strict()
type Image=z.infer<typeof imageSchema>
const imageId=(image:Image)=>createHash('sha256').update(image.key).digest('hex')
async function actor(tx:Prisma.TransactionClient,input:Identity){
 const user=await tx.user.findFirst({where:{tenantId:input.tenantId,id:input.userId,status:'ACTIVE'},select:{id:true,name:true,role:true,supplierId:true}})
 if(!user)throw fail('账号不可用',403)
 return user
}
type Actor=Awaited<ReturnType<typeof actor>>
function access(user:Actor,supplierId:string|null,warehouse=false,write=false){
 if(internal.has(user.role))return
 if(warehouse&&(write?canUploadWarehouseDocument(user.role):canReadWarehouseDocument(user.role)))return
 if(!warehouse&&supplierId&&requireSupplierCapability(user.role,user.supplierId,write?'upstream.order.ship':'upstream.order.read')===supplierId)return
 throw fail('无权访问这次进货的质检图片',403)
}
function parts(key:string){const match=/^([SRW]):([a-zA-Z0-9_-]{1,64})$/.exec(key);if(!match)throw fail('进货明细标识不正确',400);return {kind:match[1],id:match[2]}}
type Batch={key:string;purchaseOrderLineId?:string;where:{shipmentId?:string;receiptId?:string;warehouseDocId?:string};ownerId:string;ownerType:'SHIPMENT'|'RECEIPT'|'WAREHOUSE';productId:string;productName:string;productCode:string|null;batchNo:string|null;quantity:string;unit:string;sourceNo:string;orderNo:string|null}
async function resolve(tx:Prisma.TransactionClient,input:Identity,key:string,user:Actor,write=false):Promise<Batch>{
 const {kind,id}=parts(key),where={tenantId:input.tenantId,id}
 if(kind==='S'){
  const line=await tx.upstreamShipmentLine.findFirst({where,include:{shipment:{select:{id:true,no:true,supplierId:true,purchaseOrder:{select:{no:true}}}},purchaseOrderLine:{select:{productNameSnapshot:true,productCodeSnapshot:true}},receiptLines:{select:{batchNo:true}}}})
  if(!line)throw fail('这次进货明细不存在',404)
  access(user,line.shipment.supplierId,false,write)
  return {purchaseOrderLineId:line.purchaseOrderLineId,key:`S:${line.id}`,where:{shipmentId:line.shipmentId},ownerId:line.shipmentId,ownerType:'SHIPMENT' as const,productId:line.productId,productName:line.purchaseOrderLine.productNameSnapshot,productCode:line.purchaseOrderLine.productCodeSnapshot,batchNo:line.batchNo||[...new Set(line.receiptLines.map(row=>row.batchNo).filter(Boolean))].join('、')||null,quantity:String(line.shippedQty),unit:line.purchaseUnit,sourceNo:line.shipment.no,orderNo:line.shipment.purchaseOrder.no}
 }
 if(kind==='R'){
  const line=await tx.upstreamReceiptLine.findFirst({where,include:{receipt:{select:{id:true,no:true,supplierId:true,purchaseOrder:{select:{no:true}}}},purchaseOrderLine:{select:{productNameSnapshot:true,productCodeSnapshot:true}}}})
  if(!line)throw fail('这次进货明细不存在',404)
  access(user,line.receipt.supplierId,false,write)
  if(line.shipmentLineId)return resolve(tx,input,`S:${line.shipmentLineId}`,user,write)
  return {key:`R:${line.id}`,where:{receiptId:line.receiptId},ownerId:line.receiptId,ownerType:'RECEIPT' as const,productId:line.productId,productName:line.purchaseOrderLine.productNameSnapshot,productCode:line.purchaseOrderLine.productCodeSnapshot,batchNo:line.batchNo,quantity:String(line.arrivedQty),unit:line.purchaseUnit,sourceNo:line.receipt.no,orderNo:line.receipt.purchaseOrder.no}
 }
 const line=await tx.warehouseDocLine.findFirst({where,include:{doc:{select:{id:true,docNo:true,type:true,supplierId:true}},movement:{select:{upstreamReceiptLine:{select:{id:true}}}}}})
 if(!line||line.doc.type!=='MANUAL_INBOUND')throw fail('本入口仅支持进货明细',404)
 access(user,line.doc.supplierId,true,write)
 if(line.movement?.upstreamReceiptLine)return resolve(tx,input,`R:${line.movement.upstreamReceiptLine.id}`,user,write)
 const product=await tx.product.findFirst({where:{tenantId:input.tenantId,id:line.productId},select:{code:true}})
 return {key:`W:${line.id}`,where:{warehouseDocId:line.docId},ownerId:line.docId,ownerType:'WAREHOUSE' as const,productId:line.productId,productName:line.productName,productCode:product?.code||null,batchNo:line.batchNo,quantity:String(line.quantity),unit:line.unit,sourceNo:line.doc.docNo,orderNo:null}
}
async function lock(tx:Prisma.TransactionClient,input:Identity,batch:Batch){
 if(batch.ownerType==='SHIPMENT')await tx.$queryRaw`SELECT id FROM upstream_shipments WHERE id=${batch.ownerId} AND "tenantId"=${input.tenantId} FOR UPDATE`
 else if(batch.ownerType==='RECEIPT')await tx.$queryRaw`SELECT id FROM upstream_receipts WHERE id=${batch.ownerId} AND "tenantId"=${input.tenantId} FOR UPDATE`
 else await tx.$queryRaw`SELECT id FROM warehouse_docs WHERE id=${batch.ownerId} AND "tenantId"=${input.tenantId} FOR UPDATE`
}
export function qualityBatchObjectPrefix(tenantId:string,key:string){parts(key);return `upstream-goods-quality/${tenantId}/${key.replace(':','/')}/`}
function stored(record:any,key:string):Image[]{return record?.image?.batchImages?.[key]||[]}
function safe(record:any,key:string){return stored(record,key).map(image=>({id:imageId(image),name:image.name,mime:image.mime,size:image.size,url:signOssKey(image.key),version:record.version,createdAt:record.createdAt,actorName:record.actorName}))}
export async function qualityBatchUploadScope(input:Identity,key:string){
 return prisma.$transaction(async tx=>{const user=await actor(tx,input),batch=await resolve(tx,input,key,user,true);return {key:batch.key,prefix:qualityBatchObjectPrefix(input.tenantId,batch.key)}})
}
export async function getGoodsBatchQuality(input:Identity,key:string){
 return prisma.$transaction(async tx=>{
  const user=await actor(tx,input),batch=await resolve(tx,input,key,user)
  const records=await tx.documentQualityImage.findMany({where:{tenantId:input.tenantId,...batch.where},orderBy:{version:'desc'}})
  // Shared snapshots include unchanged neighbouring goods. Attribute each run to
  // its oldest snapshot: that is the save which actually changed this gallery.
  const history=records.filter((record,index)=>index===records.length-1||JSON.stringify(stored(record,batch.key))!==JSON.stringify(stored(records[index+1],batch.key))).filter(record=>record.version!==1||stored(record,batch.key).length>0).slice(0,50)
  const current=history[0]
  let canWrite=false;try{await resolve(tx,input,key,user,true);canWrite=true}catch{}
  return {version:records[0]?.version||0,images:safe(current,batch.key),image:safe(current,batch.key).at(-1)||null,history:history.map(record=>({version:record.version,createdAt:record.createdAt,actorName:record.actorName,images:safe(record,batch.key)})),canWrite,batch}
 })
}
export async function saveGoodsBatchQuality(input:Identity,key:string,body:z.infer<typeof goodsBatchQualityBody>,checkObjects=assertQualityBatchObjects){
 const parsed=goodsBatchQualityBody.safeParse(body);if(!parsed.success)throw fail('每次进货最多50张图片，单张最大10MB',400)
 const data=parsed.data
 const preliminary=await prisma.$transaction(async tx=>{const user=await actor(tx,input);return resolve(tx,input,key,user,true)})
 const prefix=qualityBatchObjectPrefix(input.tenantId,preliminary.key)
 const uploads=data.images.filter((image):image is Image=>'key' in image)
 if(uploads.some(image=>!image.key.startsWith(prefix)||image.key.includes('..')||!image.key.slice(prefix.length)))throw fail('图片不属于这个商品的这次进货',403)
 const fingerprint=createHash('sha256').update(JSON.stringify({userId:input.userId,batch:preliminary.key,...data,requestId:undefined})).digest('hex')
 const replayResult=(record:any)=>{if(record.fingerprint!==fingerprint)throw fail('请求编号已用于其他图片保存');return {version:record.version,images:safe(record,preliminary.key),replayed:true}}
 const existing=await prisma.documentQualityImage.findUnique({where:{tenantId_requestId:{tenantId:input.tenantId,requestId:data.requestId}}})
 if(existing)return replayResult(existing)
 await checkObjects(prefix,uploads)
 return serializableWithRetry(async tx=>{
  const user=await actor(tx,input);await lock(tx,input,preliminary)
  const batch=await resolve(tx,input,key,user,true)
  if(batch.key!==preliminary.key||batch.ownerId!==preliminary.ownerId)throw fail('进货来源已变化，请重新打开图片')
  const replay=await tx.documentQualityImage.findUnique({where:{tenantId_requestId:{tenantId:input.tenantId,requestId:data.requestId}}});if(replay)return replayResult(replay)
  const previous=await tx.documentQualityImage.findFirst({where:{tenantId:input.tenantId,...batch.where},orderBy:{version:'desc'}})
  if((previous?.version||0)!==data.version)throw fail('图片已被其他人员更新，请查看最新图片后重新保存')
  const current=stored(previous,batch.key)
  const images=data.images.map(image=>{
   if('key' in image)return image
   const retained=current.find(item=>imageId(item)===image.id)
   if(!retained)throw fail('保留图片不属于这个商品的本次进货',400)
   return retained
  })
  if(new Set(images.map(image=>image.key)).size!==images.length)throw fail('同一图片不能重复添加',400)
  const previousMap=(previous?.image as any)?.batchImages||{}
  const record=await tx.documentQualityImage.create({data:{tenantId:input.tenantId,...batch.where,version:data.version+1,requestId:data.requestId,fingerprint,image:{batchImages:{...previousMap,[batch.key]:images}},actorId:user.id,actorName:user.name,actorRole:user.role}})
  await tx.opLog.create({data:{tenantId:input.tenantId,userId:user.id,role:user.role,action:'保存进货商品质检图片',entityType:'GOODS_BATCH_QUALITY',targetId:batch.key,metadata:{requestId:data.requestId,version:record.version,productId:batch.productId,sourceType:batch.ownerType,sourceId:batch.ownerId}}})
  return {version:record.version,images:safe(record,batch.key),replayed:false}
 })
}
export async function listGoodsQualityBatches(input:Identity,context:QualityContext,id:string){
 return prisma.$transaction(async tx=>{
  const user=await actor(tx,input),where={tenantId:input.tenantId,id};let keys:string[]=[],legacyOwner:Record<string,string>|null=null
  if(context==='SHIPMENT'||context==='ORDER'){
   const row=context==='SHIPMENT'?await tx.upstreamShipment.findFirst({where,select:{id:true,supplierId:true}}):await tx.upstreamPurchaseOrder.findFirst({where:{...where,...(!internal.has(user.role)?{AND:[supplierVisiblePurchaseOrder]}:{})},select:{id:true,supplierId:true}})
   if(!row)throw fail('采购来源不存在',404);access(user,row.supplierId)
   const lines=await tx.upstreamShipmentLine.findMany({where:{tenantId:input.tenantId,...(context==='SHIPMENT'?{shipmentId:id}:{shipment:{purchaseOrderId:id}})},orderBy:{createdAt:'asc'}})
   keys=lines.map(line=>`S:${line.id}`)
  }else if(context==='RECEIPT'){
   const row=await tx.upstreamReceipt.findFirst({where,select:{supplierId:true,lines:{select:{id:true,shipmentLineId:true}}}})
   if(!row)throw fail('收货单不存在',404);access(user,row.supplierId)
   keys=row.lines.map(line=>line.shipmentLineId?`S:${line.shipmentLineId}`:`R:${line.id}`);legacyOwner={receiptId:id}
  }else if(context==='RETURN'){
   const row=await tx.upstreamPurchaseReturn.findFirst({where,select:{supplierId:true,lines:{select:{receiptLineId:true}}}})
   if(!row)throw fail('退货单不存在',404);access(user,row.supplierId)
   keys=row.lines.map(line=>`R:${line.receiptLineId}`);legacyOwner={returnId:id}
  }else{
   const row=await tx.warehouseDoc.findFirst({where,select:{type:true,supplierId:true,lines:{select:{id:true}}}})
   if(!row)throw fail('入库单不存在',404);access(user,row.supplierId,true)
   if(row.type!=='MANUAL_INBOUND')return {legacyOnly:true,groups:[],legacyAvailable:true}
   keys=row.lines.map(line=>`W:${line.id}`);legacyOwner={warehouseDocId:id}
  }
  const batches=await Promise.all(keys.map(key=>resolve(tx,input,key,user)))
  const unique=[...new Map(batches.map(batch=>[batch.key,batch])).values()]
  const groups=await Promise.all(unique.map(async batch=>{
   const record=await tx.documentQualityImage.findFirst({where:{tenantId:input.tenantId,...batch.where},orderBy:{version:'desc'}})
   return {...batch,imageCount:stored(record,batch.key).length}
  }))
  // Old whole-document records remain unassigned history; never copy them to a product.
  const legacyAvailable=legacyOwner?Boolean(await tx.documentQualityImage.findFirst({where:{tenantId:input.tenantId,...legacyOwner,NOT:{image:{path:['batchImages'],not:Prisma.AnyNull}}},select:{id:true}})):false
  return {groups,legacyAvailable,legacyOnly:false}
 })
}
