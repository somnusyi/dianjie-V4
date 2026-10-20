import type {FastifyInstance} from 'fastify'
import {prisma} from '@dianjie/db'
import {getDocumentQualityImage,saveDocumentQualityImage,qualityImageBodySchema,type QualityImageSource} from '../services/documentQualityImage'
export function registerDocumentQualityImageRoutes(app:FastifyInstance,prefix:string,kind:QualityImageSource,auth:any){
  const handle=(write:boolean)=>async(req:any,reply:any)=>{
    const sourceId=String(req.params.id||'')
    if(!sourceId||sourceId.length>64)return reply.code(400).send({error:'单据标识不正确'})
    const input={tenantId:req.user.tenantId,userId:req.user.userId,kind,sourceId}
    try{
      const legacy=await getDocumentQualityImage(input)
      const legacyEditable=kind==='WAREHOUSE'&&(await prisma.warehouseDoc.findFirst({where:{tenantId:input.tenantId,id:sourceId},select:{type:true}}))?.type==='MANUAL_OUTBOUND'
      if(!write)return {...legacy,canWrite:legacy.canWrite&&legacyEditable}
      if(!legacyEditable)return reply.code(409).send({error:'质检已按商品本次进货管理，请从商品质检入口添加图片；原整单图片只读保留'})
      const parsed=qualityImageBodySchema.safeParse(req.body)
      if(!parsed.success)return reply.code(400).send({error:'请检查质检图片与版本，每组最多50张、单张最大10MB'})
      return await saveDocumentQualityImage({...input,body:parsed.data})
    }catch(error:any){if(error.statusCode)return reply.code(error.statusCode).send({error:error.message});throw error}
  }
  app.get(`${prefix}/:id/quality-image`,auth,handle(false))
  app.post(`${prefix}/:id/quality-image`,auth,handle(true))
}
