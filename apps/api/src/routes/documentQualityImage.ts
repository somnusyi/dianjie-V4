import type {FastifyInstance} from 'fastify'
import {getDocumentQualityImage,saveDocumentQualityImage,qualityImageBodySchema,type QualityImageSource} from '../services/documentQualityImage'
export function registerDocumentQualityImageRoutes(app:FastifyInstance,prefix:string,kind:QualityImageSource,auth:any){
  const handle=(write:boolean)=>async(req:any,reply:any)=>{
    const sourceId=String(req.params.id||'')
    if(!sourceId||sourceId.length>64)return reply.code(400).send({error:'单据标识不正确'})
    const input={tenantId:req.user.tenantId,userId:req.user.userId,kind,sourceId}
    try{
      if(!write)return await getDocumentQualityImage(input)
      const parsed=qualityImageBodySchema.safeParse(req.body)
      if(!parsed.success)return reply.code(400).send({error:'仅支持保存单张质检图片，请检查文件与图片版本'})
      return await saveDocumentQualityImage({...input,body:parsed.data})
    }catch(error:any){if(error.statusCode)return reply.code(error.statusCode).send({error:error.message});throw error}
  }
  app.get(`${prefix}/:id/quality-image`,auth,handle(false))
  app.post(`${prefix}/:id/quality-image`,auth,handle(true))
}
