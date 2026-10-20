import type {FastifyInstance} from 'fastify'
import {goodsBatchQualityBody,getGoodsBatchQuality,saveGoodsBatchQuality,listGoodsQualityBatches,qualityBatchUploadScope,type QualityContext} from '../services/goodsBatchQuality'
export function registerGoodsBatchQualityRoutes(app:FastifyInstance,auth:any){
 const handle=(fn:(req:any)=>Promise<unknown>)=>async(req:any,reply:any)=>{try{return await fn(req)}catch(error:any){if(error.statusCode)return reply.code(error.statusCode).send({error:error.message});throw error}}
 const identity=(req:any)=>({tenantId:req.user.tenantId,userId:req.user.userId})
 for(const [path,context] of [['shipments','SHIPMENT'],['purchase-orders','ORDER'],['receipts','RECEIPT'],['purchase-returns','RETURN']] as const){
  app.get(`/${path}/:id/quality-batches`,auth,handle(req=>listGoodsQualityBatches(identity(req),context as QualityContext,String(req.params.id))))
 }
 app.get('/quality-batches/:id',auth,handle(req=>getGoodsBatchQuality(identity(req),String(req.params.id))))
 app.post('/quality-batches/:id',auth,handle(req=>{
  const parsed=goodsBatchQualityBody.safeParse(req.body)
  if(!parsed.success)throw Object.assign(new Error('每次进货最多50张图片，单张最大10MB'),{statusCode:400})
  return saveGoodsBatchQuality(identity(req),String(req.params.id),parsed.data)
 }))
}
