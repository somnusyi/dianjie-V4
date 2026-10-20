import {prisma} from '@dianjie/db'
import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,it,expect,vi} from 'vitest'
vi.mock('../../src/routes/upload',async()=>({...await vi.importActual<any>('../../src/routes/upload'),signOssKey:(key:string)=>`http://local.invalid/${key}`}))
import {getGoodsBatchQuality as get,saveGoodsBatchQuality as put,listGoodsQualityBatches as list,qualityBatchUploadScope as upload,qualityBatchObjectPrefix as prefix} from '../../src/services/goodsBatchQuality'
import {saveDocumentQualityImage,getDocumentQualityImage} from '../../src/services/documentQualityImage'
let tenantId:string,userId:string,vendor:string,other:string,finance:string,ship:any,next:any,rc:any,ret:any,wh:any,po:any
const check=vi.fn(async()=>{}),ident=()=>({tenantId,userId}),key=(i=0)=>`S:${ship.lines[i].id}`
const image=(batch=key(),name='随货凭证.png')=>({key:`${prefix(tenantId,batch)}${randomUUID()}.png`,name,mime:'image/png' as const,size:100})
async function save(batch=key(),images=[image(batch)],user=userId){const view=await get({tenantId,userId:user},batch);return put({tenantId,userId:user},batch,{version:view.version,requestId:randomUUID(),images},check)}
async function business(){return JSON.stringify({po:await prisma.upstreamPurchaseOrder.findMany({where:{tenantId}}),lines:await prisma.upstreamPurchaseOrderLine.findMany({where:{tenantId},orderBy:{id:'asc'}}),shipments:await prisma.upstreamShipment.findMany({where:{tenantId},orderBy:{id:'asc'}}),receipts:await prisma.upstreamReceipt.findMany({where:{tenantId}}),returns:await prisma.upstreamPurchaseReturn.findMany({where:{tenantId}}),ledger:await prisma.warehouseLedgerMovement.findMany({where:{tenantId}})})}
beforeAll(async()=>{
 tenantId=(await prisma.tenant.create({data:{slug:`goods-quality-${randomUUID()}`,name:'进货质检隔离合成'}})).id
 const warehouse=await prisma.warehouse.create({data:{tenantId,code:'MAIN',name:'收货仓',inventoryMode:'SHADOW'}})
 const a=await prisma.supplier.create({data:{tenantId,no:'A',name:'上游甲公司'}}),b=await prisma.supplier.create({data:{tenantId,no:'B',name:'上游乙公司'}})
 const user=async(role:any,name:string,supplierId?:string)=>(await prisma.user.create({data:{tenantId,name,email:`${randomUUID()}@local.invalid`,password:'unusable',role,supplierId}})).id
 userId=await user('SUPPLY_CHAIN','供应链甲');vendor=await user('SUPPLIER_OWNER','供应商甲',a.id);other=await user('SUPPLIER_STAFF','供应商乙',b.id);finance=await user('FINANCE','财务')
 const products=await Promise.all(['土豆','菌菇'].map((name,index)=>prisma.product.create({data:{tenantId,code:`P${index}`,name,price:10,unit:'kg'}})))
 po=await prisma.upstreamPurchaseOrder.create({data:{tenantId,no:'PO1',supplierId:a.id,warehouseId:warehouse.id,createdById:userId,status:'SUPPLIER_ACCEPTED',lines:{create:products.map((p,i)=>({lineNo:i+1,productId:p.id,productCodeSnapshot:p.code,productNameSnapshot:p.name,purchaseUnit:'kg',inventoryUnit:'kg',inventoryUnitsPerPurchaseUnit:1,orderedQty:10,unitPrice:10,amountWithoutTax:100,taxAmount:0,totalAmount:100}))}},include:{lines:true}})
 const draft=(no:string,indices:number[])=>prisma.upstreamShipment.create({data:{tenantId,no,purchaseOrderId:po.id,supplierId:a.id,warehouseId:warehouse.id,createdById:vendor,lines:{create:indices.map(i=>({purchaseOrderLineId:po.lines[i].id,productId:products[i].id,shippedQty:2,purchaseUnit:'kg',batchNo:`LOT-${no}-${i}`}))}},include:{lines:true}})
 ship=await draft('SHIP1',[0,1]);next=await draft('SHIP2',[0])
 rc=await prisma.upstreamReceipt.create({data:{tenantId,no:'RC1',purchaseOrderId:po.id,shipmentId:ship.id,supplierId:a.id,warehouseId:warehouse.id,createdById:userId,status:'POSTED',approvalStatus:'REVIEWED',payableAmount:40,lines:{create:ship.lines.map((line:any)=>({purchaseOrderLineId:line.purchaseOrderLineId,shipmentLineId:line.id,productId:line.productId,orderedQty:10,arrivedQty:2,acceptedQty:2,purchaseUnit:'kg',inventoryUnit:'kg',inventoryUnitsPerPurchaseUnit:1,inventoryAcceptedQty:2,unitPrice:10,payableAmount:20}))}},include:{lines:true}})
 ret=await prisma.upstreamPurchaseReturn.create({data:{tenantId,no:'RET1',supplierId:a.id,warehouseId:warehouse.id,createdById:userId,reason:'本地核对',lines:{create:{receiptLineId:rc.lines[0].id,productId:rc.lines[0].productId,purchaseQuantity:1,purchaseUnit:'kg',inventoryUnitsPerPurchaseUnit:1,inventoryQuantity:1,inventoryUnit:'kg',settlementUnitPrice:10,settlementAmount:10}}}})
 wh=await prisma.warehouseDoc.create({data:{tenantId,docNo:'WH1',type:'MANUAL_INBOUND',supplierId:a.id,warehouseId:warehouse.id,effectiveAt:new Date(),idempotencyKey:randomUUID(),lines:{create:{tenantId,lineNo:1,productId:products[0].id,productName:'土豆',quantity:2,unit:'kg',amount:20,inventoryQuantity:2,inventoryUnit:'kg'}}},include:{lines:true}})
})
afterAll(()=>prisma.$disconnect())
it('supplier multi-image gallery is isolated by product occurrence, not product or whole shipment',async()=>{
 const before=await business();await save(key(),Array.from({length:12},(_,i)=>image(key(),`凭证${i}.png`)),vendor)
 expect((await get(ident(),key())).images).toHaveLength(12);expect((await get(ident(),key(1))).images).toEqual([]);expect((await get(ident(),`S:${next.lines[0].id}`)).images).toEqual([]);expect(await business()).toBe(before)
})
it('receipt and return trace the exact shared gallery; same product on two arrivals remains separate',async()=>{
 expect((await get(ident(),`R:${rc.lines[0].id}`)).images).toEqual((await get(ident(),key())).images)
 expect((await list(ident(),'RETURN',ret.id)).groups[0].key).toBe(key())
 expect((await list(ident(),'RECEIPT',rc.id)).groups.map(g=>g.key)).toEqual(ship.lines.map((line:any)=>`S:${line.id}`))
 const groups=(await list(ident(),'ORDER',po.id)).groups;expect(groups).toHaveLength(3);expect(groups.filter(g=>g.productId===ship.lines[0].productId)).toHaveLength(2)
})
it('saving one product preserves its neighbours; foreign object keys and retained image refs are rejected',async()=>{
 const a=await get(ident(),key());await save(key(1),[image(key(1),'菌菇凭证.png')],vendor)
 expect((await get(ident(),key())).images.map(i=>i.id)).toEqual(a.images.map(i=>i.id))
 const b=await get(ident(),key(1))
 await expect(put(ident(),key(1),{version:b.version,requestId:randomUUID(),images:[{id:a.images[0].id}]},check)).rejects.toMatchObject({statusCode:400})
 await expect(put(ident(),key(1),{version:b.version,requestId:randomUUID(),images:[image(key())]},check)).rejects.toMatchObject({statusCode:403})
})
it('supplier company, active role and tenant scope apply to reads, lists and uploads',async()=>{
 for(const id of [other,finance]){const input={tenantId,userId:id};await expect(get(input,key())).rejects.toMatchObject({statusCode:403});await expect(upload(input,key())).rejects.toMatchObject({statusCode:403});await expect(list(input,'SHIPMENT',ship.id)).rejects.toMatchObject({statusCode:403})}
 await expect(get({tenantId:'another',userId},key())).rejects.toMatchObject({statusCode:403})
 expect((await upload({tenantId,userId:vendor},key())).prefix).toBe(prefix(tenantId,key()))
 await prisma.user.update({where:{id:other},data:{status:'INACTIVE'}});await expect(upload({tenantId,userId:other},key())).rejects.toMatchObject({statusCode:403})
})
it('double saves are idempotent and stale windows cannot overwrite another goods gallery',async()=>{
 const v=await get(ident(),key()),body={version:v.version,requestId:randomUUID(),images:[...v.images.map(i=>({id:i.id})),image()]},count=await prisma.documentQualityImage.count({where:{tenantId}})
 const both=await Promise.all([put(ident(),key(),body,check),put(ident(),key(),body,check)]);expect(both.filter(r=>!r.replayed)).toHaveLength(1);expect(await prisma.documentQualityImage.count({where:{tenantId}})).toBe(count+1)
 const stale=await get(ident(),key(1));await save(key(),[image(key(),'甲新凭证.png')]);await expect(put(ident(),key(1),{version:stale.version,requestId:randomUUID(),images:[image(key(1))]},check)).rejects.toMatchObject({statusCode:409});expect((await get(ident(),key(1))).images[0].name).toBe('菌菇凭证.png')
})
it('failed object checks are atomic; removals keep history and do not remove a neighbour gallery',async()=>{
 const v=await get(ident(),key()),count=await prisma.documentQualityImage.count({where:{tenantId}})
 await expect(put(ident(),key(),{version:v.version,requestId:randomUUID(),images:[image()]},async()=>{throw Object.assign(Error('HEAD失败'),{statusCode:503})})).rejects.toMatchObject({statusCode:503});expect(await prisma.documentQualityImage.count({where:{tenantId}})).toBe(count)
 await put(ident(),key(),{version:v.version,requestId:randomUUID(),images:[]},check);const after=await get(ident(),key());expect(after.images).toEqual([]);expect(after.history.some(v=>v.images.length>0)).toBe(true);expect((await get(ident(),key(1))).images).toHaveLength(1)
})
it('legacy whole-document pictures remain unassigned rather than being copied to products',async()=>{
 await saveDocumentQualityImage({...ident(),kind:'RECEIPT',sourceId:rc.id,body:{version:0,requestId:randomUUID(),image:{key:`warehouse-docs/${tenantId}/legacy.png`,name:'原整单凭证.png',mime:'image/png',size:100}}},check)
 expect((await list(ident(),'RECEIPT',rc.id)).legacyAvailable).toBe(true);expect((await getDocumentQualityImage({...ident(),kind:'RECEIPT',sourceId:rc.id})).images[0].name).toBe('原整单凭证.png');expect((await get(ident(),key())).images).toEqual([])
})
it('manual inbound identifies its own occurrence; no inventory or approval is changed',async()=>{
 const groups=(await list(ident(),'WAREHOUSE',wh.id)).groups;expect(groups[0].key).toBe(`W:${wh.lines[0].id}`);expect(groups[0].productCode).toBe('P0');expect((await get(ident(),groups[0].key)).batch.productCode).toBe('P0')
 const before=await business();await save(groups[0].key,[image(groups[0].key,'本次进货.png')]);expect(await business()).toBe(before);expect((await get(ident(),key())).images).toEqual([])
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId}})).toBe(0);expect(await prisma.procurementApprovalEvent.count({where:{tenantId}})).toBe(0)
})

it('public upload routes do not widen warehouse or generic object access for suppliers',async()=>{
 const {default:Fastify}=await import('fastify');const {uploadRoutes}=await import('../../src/routes/upload');const {registerGoodsBatchQualityRoutes}=await import('../../src/routes/goodsBatchQuality')
 const app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId,userId:vendor,role:'SUPPLIER_OWNER'}})
 const {default:multipart}=await import('@fastify/multipart');await app.register(multipart,{limits:{fileSize:10*1024*1024}})
 await app.register(uploadRoutes,{prefix:'/api'})
 await app.register(async scope=>registerGoodsBatchQualityRoutes(scope,{preHandler:[(app as any).authenticate]}),{prefix:'/api/upstream'})
 try{
  expect((await app.inject({method:'POST',url:'/api/upload?category=warehouse-docs'})).statusCode).toBe(403)
  expect((await app.inject({method:'POST',url:'/api/upload?category=upstream-goods-quality'})).statusCode).toBe(403)
  expect((await app.inject({method:'GET',url:`/api/upload/signed-url?key=${encodeURIComponent(image().key)}`})).statusCode).toBe(403)
  expect((await app.inject({method:'GET',url:`/api/upstream/quality-batches/${encodeURIComponent(key())}`})).statusCode).toBe(200)
  expect((await app.inject({method:'POST',url:'/api/upstream/quality-batches/S:missing/images'})).statusCode).toBe(404)
  const boundary='goods-quality-test',payload=`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="proof.pdf"\r\nContent-Type: application/pdf\r\n\r\npdf\r\n--${boundary}--\r\n`
  const unsupported=await app.inject({method:'POST',url:`/api/upstream/quality-batches/${encodeURIComponent(key())}/images`,headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload})
  expect(unsupported.statusCode).toBe(400);expect(unsupported.json().error).toContain('不支持的文件类型')
 }finally{await app.close()}
})

it('displays the goods code and actual receipt batch when the upstream draft had no batch number',async()=>{
 await prisma.upstreamShipmentLine.update({where:{id:ship.lines[0].id},data:{batchNo:null}})
 await prisma.upstreamReceiptLine.update({where:{id:rc.lines[0].id},data:{batchNo:'STOCK-LOT-001'}})
 const view=await get(ident(),key());expect(view.batch.productCode).toBe('P0');expect(view.batch.batchNo).toBe('STOCK-LOT-001')
})

it('neighbour saves retain the actual gallery modifier beyond fifty shared snapshots',async()=>{
 const ownImage=image(key(),'独立历史凭证.png')
 const saved=await save(key(),[ownImage],userId)
 for(let i=0;i<51;i++)await save(key(1),[image(key(1),`另一商品${i}.png`)],vendor)
 const current=await get(ident(),key())
 expect(current.version).toBe(saved.version+51)
 expect(current.images[0]).toMatchObject({name:ownImage.name,actorName:'供应链甲',version:saved.version})
 expect(current.history[0]).toMatchObject({actorName:'供应链甲',version:saved.version})
 const removed=await save(key(),[],vendor)
 await save(key(1),[image(key(1))],userId)
 const empty=await get(ident(),key())
 expect(empty.images).toEqual([])
 expect(empty.history[0]).toMatchObject({actorName:'供应商甲',version:removed.version,images:[]})
 expect(empty.history[1].images[0].name).toBe(ownImage.name)
})
