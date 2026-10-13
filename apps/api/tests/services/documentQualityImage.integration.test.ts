import {prisma} from '@dianjie/db'
import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,it,expect,vi} from 'vitest'
vi.mock('../../src/routes/upload',async()=>({...await vi.importActual<any>('../../src/routes/upload'),signOssKey:(key:string)=>`http://local.invalid/${key}`}))
import {getDocumentQualityImage,saveDocumentQualityImage,type QualityImageSource} from '../../src/services/documentQualityImage'
let tenantId:string,userId:string,financeId:string,warehouseId:string,supplierId:string
const ids={} as Record<QualityImageSource,string>
const check=vi.fn(async()=>{})
const body=(version=0,name='质检.png')=>({version,requestId:randomUUID(),image:{key:`warehouse-docs/${tenantId}/${randomUUID()}.png`,name,mime:'image/png' as const,size:100}})
const input=(kind:QualityImageSource)=>({tenantId,userId,kind,sourceId:ids[kind]})
const raw=(kind:QualityImageSource)=>kind==='WAREHOUSE'?prisma.warehouseDoc.findUniqueOrThrow({where:{id:ids[kind]}}):kind==='RECEIPT'?prisma.upstreamReceipt.findUniqueOrThrow({where:{id:ids[kind]}}):prisma.upstreamPurchaseReturn.findUniqueOrThrow({where:{id:ids[kind]}})
beforeAll(async()=>{
 tenantId=(await prisma.tenant.create({data:{slug:`quality-${randomUUID()}`,name:'质检图片隔离合成'}})).id
 warehouseId=(await prisma.warehouse.create({data:{tenantId,code:'QC',name:'质检合成仓',inventoryMode:'SHADOW'}})).id
 userId=(await prisma.user.create({data:{tenantId,email:`sc-${randomUUID()}@local.invalid`,name:'合成供应链',role:'SUPPLY_CHAIN',password:'unusable'}})).id
 financeId=(await prisma.user.create({data:{tenantId,email:`finance-${randomUUID()}@local.invalid`,name:'合成财务',role:'FINANCE',password:'unusable'}})).id
 supplierId=(await prisma.supplier.create({data:{tenantId,no:'QC-SUP',name:'合成质检供应商'}})).id
 ids.WAREHOUSE=(await prisma.warehouseDoc.create({data:{tenantId,docNo:'QC-WH',type:'MANUAL_INBOUND',warehouseId,status:'CONFIRMED',reviewStatus:'REVIEWED',effectiveAt:new Date(),idempotencyKey:randomUUID(),createdById:userId,totalAmount:10}})).id
 const order=await prisma.upstreamPurchaseOrder.create({data:{tenantId,no:'QC-PO',warehouseId,supplierId,createdById:userId}})
 ids.RECEIPT=(await prisma.upstreamReceipt.create({data:{tenantId,no:'QC-RC',purchaseOrderId:order.id,warehouseId,supplierId,createdById:userId,status:'POSTED',approvalStatus:'REVIEWED',payableAmount:10}})).id
 ids.RETURN=(await prisma.upstreamPurchaseReturn.create({data:{tenantId,no:'QC-RET',warehouseId,supplierId,createdById:userId,status:'APPROVED',approvalStatus:'REVIEWED',reason:'合成',settlementAmount:10}})).id
})
afterAll(()=>prisma.$disconnect())
it('all three reviewed sources accept pictures without changing business fields or approval',async()=>{
 for(const kind of ['WAREHOUSE','RECEIPT','RETURN'] as const){
   const before=await raw(kind),b=body()
   const result=await saveDocumentQualityImage({...input(kind),body:b},check)
   expect(result.version).toBe(1);expect(await raw(kind)).toEqual(before)
   const view=await getDocumentQualityImage(input(kind));expect(view.image?.name).toBe('质检.png');expect(JSON.stringify(view)).not.toContain('"key"')
   expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(0)
   expect(await prisma.procurementApprovalEvent.count({where:{tenantId}})).toBe(0)
 }
})
it('same request concurrently saves exactly one image record and log',async()=>{
 const request={...input('WAREHOUSE'),body:body(1)}
 const results=await Promise.all([saveDocumentQualityImage(request,check),saveDocumentQualityImage(request,check)])
 expect(results.filter(result=>!result.replayed)).toHaveLength(1)
 expect(await prisma.documentQualityImage.count({where:{tenantId,requestId:request.body.requestId}})).toBe(1)
 expect(await prisma.opLog.count({where:{tenantId,action:'保存单据质检图片',metadata:{path:['requestId'],equals:request.body.requestId}}})).toBe(1)
 await expect(saveDocumentQualityImage({...request,body:{...request.body,image:{...request.body.image,name:'不同.png'}}},check)).rejects.toMatchObject({statusCode:409})
})
it('different concurrent pictures cannot overwrite the same version and keep previous history',async()=>{
 const old=await prisma.documentQualityImage.count({where:{tenantId,receiptId:ids.RECEIPT}})
 const results=await Promise.allSettled([saveDocumentQualityImage({...input('RECEIPT'),body:body(1,'一.png')},check),saveDocumentQualityImage({...input('RECEIPT'),body:body(1,'二.png')},check)])
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
 expect((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason.statusCode).toBe(409)
 expect(await prisma.documentQualityImage.count({where:{tenantId,receiptId:ids.RECEIPT}})).toBe(old+1)
 expect((await getDocumentQualityImage(input('RECEIPT'))).history).toHaveLength(2)
})
it('object verification failure rolls back and retains prior current image',async()=>{
 const before=await getDocumentQualityImage(input('RETURN')),count=await prisma.opLog.count({where:{tenantId}})
 await expect(saveDocumentQualityImage({...input('RETURN'),body:body(1)},async()=>{throw Object.assign(Error('OSS不可用'),{statusCode:503})})).rejects.toMatchObject({statusCode:503})
 expect(await getDocumentQualityImage(input('RETURN'))).toEqual(before);expect(await prisma.opLog.count({where:{tenantId}})).toBe(count)
})
it('enforces source tenant, read-only roles, image MIME and strict body',async()=>{
 const request={...input('WAREHOUSE'),body:body(2)}
 await expect(saveDocumentQualityImage({...request,userId:financeId},check)).rejects.toMatchObject({statusCode:403})
 expect((await getDocumentQualityImage({...input('WAREHOUSE'),userId:financeId})).canWrite).toBe(false)
 await expect(getDocumentQualityImage({...input('RECEIPT'),userId:financeId})).rejects.toMatchObject({statusCode:403})
 await expect(saveDocumentQualityImage({...request,body:{...request.body,image:{...request.body.image,key:`warehouse-docs/other-tenant/x.png`}}},check)).rejects.toMatchObject({statusCode:403})
 await expect(saveDocumentQualityImage({...request,sourceId:'other-tenant-source'},check)).rejects.toMatchObject({statusCode:404})
 await expect(saveDocumentQualityImage({...request,body:{...request.body,image:{...request.body.image,mime:'application/pdf'}} as any},check)).rejects.toMatchObject({statusCode:400})
 await expect(saveDocumentQualityImage({...request,body:{...request.body,quantity:999} as any},check)).rejects.toMatchObject({statusCode:400})
})
it('a failure writing the audit log rolls back the newly appended image',async()=>{
 const before=await prisma.documentQualityImage.count({where:{tenantId}})
 const original=prisma.$transaction.bind(prisma)
 const spy=vi.spyOn(prisma,'$transaction').mockImplementation(((callback:any,options:any)=>original(async(tx:any)=>callback(new Proxy(tx,{get(target,key){return key==='opLog'?{...target.opLog,create:async()=>{throw Error('injected log failure')}}:Reflect.get(target,key)}})),options)) as any)
 try{await expect(saveDocumentQualityImage({...input('RETURN'),body:body(1)},check)).rejects.toThrow('injected log failure')}
 finally{spy.mockRestore()}
 expect(await prisma.documentQualityImage.count({where:{tenantId}})).toBe(before)
 expect((await getDocumentQualityImage(input('RETURN'))).version).toBe(1)
})
it('database constraints refuse zero or multiple sources, invalid versions and cross-tenant sources',async()=>{
 const base={tenantId,version:99,requestId:randomUUID(),fingerprint:'a'.repeat(64),image:body().image,actorId:userId,actorName:'测试',actorRole:'SUPPLY_CHAIN'}
 await expect(prisma.documentQualityImage.create({data:base})).rejects.toThrow()
 await expect(prisma.documentQualityImage.create({data:{...base,requestId:randomUUID(),warehouseDocId:ids.WAREHOUSE,receiptId:ids.RECEIPT}})).rejects.toThrow()
 await expect(prisma.documentQualityImage.create({data:{...base,requestId:randomUUID(),warehouseDocId:ids.WAREHOUSE,version:0}})).rejects.toThrow()
 const other=await prisma.tenant.create({data:{slug:`quality-other-${randomUUID()}`,name:'其他合成租户'}})
 await expect(prisma.documentQualityImage.create({data:{...base,tenantId:other.id,requestId:randomUUID(),warehouseDocId:ids.WAREHOUSE}})).rejects.toThrow()
})
