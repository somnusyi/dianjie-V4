import {beforeEach,afterEach,afterAll,it,expect,vi} from 'vitest'
import {Prisma,prisma} from '@dianjie/db'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import ExcelJS from 'exceljs'
import {randomUUID} from 'node:crypto'
import {recordManualWarehouseInbound,recordBatchManualWarehouseOutbound,adjustWarehouseMovementValue,reverseDeliveryOutboundInTransaction} from '../../src/services/warehouseLedger'
import {inventoryReportRoutes} from '../../src/routes/inventoryReports'
const url=new URL(process.env.DATABASE_URL!);if(url.hostname!=='127.0.0.1'||url.port!=='15449'||url.pathname!=='/dianjie_four_gap_test')throw new Error('Dedicated synthetic database required')
const db:any=prisma;let tenantId='',warehouseId='',productId='',actorId='',supplierId='';let app:any
// Keep implicit reversal/return dates inside the October report fixture, regardless of the day tests run.
beforeEach(async()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-28T08:00:00Z'));tenantId='';tenantId=(await db.tenant.create({data:{name:'报表核定验证',slug:'p05-api-'+randomUUID()}})).id;warehouseId=(await db.warehouse.findFirst({where:{tenantId,isDefault:true}})).id;await db.warehouse.update({where:{id:warehouseId},data:{inventoryMode:'STRICT'}});supplierId=(await db.supplier.create({data:{tenantId,no:'S',name:'供应商'}})).id;productId=(await db.product.create({data:{tenantId,supplierId,code:'P',name:'商品',unit:'kg',price:10,pricingMode:'FIXED',inventoryUnit:'kg',purchaseUnit:'kg',orderUnit:'kg',costUnit:'kg',inventoryUnitsPerOrderUnit:1,inventoryUnitsPerPurchaseUnit:1,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED'}})).id;actorId=(await db.user.create({data:{tenantId,email:'p05-api-'+randomUUID()+'@local.invalid',name:'供应链',password:'synthetic-not-login',role:'SUPPLY_CHAIN'}})).id;app=Fastify();await app.register(jwt,{secret:'p05-api-synthetic-secret-only'});app.decorate('authenticate',async(req:any)=>{await req.jwtVerify()});await app.register(inventoryReportRoutes,{prefix:'/api/inventory-reports'});await app.ready()})
afterEach(async()=>{vi.useRealTimers();await app?.close();if(!tenantId)return;for(const c of await db.warehouseNetCostBasisConfirmation.findMany({where:{tenantId},orderBy:{version:'desc'}}))await db.warehouseNetCostBasisConfirmation.delete({where:{id:c.id}});await db.warehouseLedgerLotAllocation.deleteMany({where:{tenantId}});await db.warehouseLedgerLot.deleteMany({where:{tenantId}});await db.warehouseLedgerMovement.deleteMany({where:{tenantId}});await db.warehouseLedgerBalance.deleteMany({where:{tenantId}});await db.opLog.deleteMany({where:{tenantId}});await db.deliveryOrderItem.deleteMany({where:{deliveryOrder:{tenantId}}});await db.deliveryOrder.deleteMany({where:{tenantId}});await db.purchaseOrderItem.deleteMany({where:{purchaseOrder:{tenantId}}});await db.purchaseOrder.deleteMany({where:{tenantId}});await db.store.deleteMany({where:{tenantId}});await db.product.deleteMany({where:{tenantId}});await db.user.deleteMany({where:{tenantId}});await db.supplier.deleteMany({where:{tenantId}});await db.warehouse.deleteMany({where:{tenantId}});await db.tenant.delete({where:{id:tenantId}})})
afterAll(async()=>{await db.$disconnect()})
const headers=(role='SUPPLY_CHAIN',tenant=tenantId)=>({authorization:'Bearer '+app.jwt.sign({userId:actorId,tenantId:tenant,role})})
const inbound=(amount=113,quantity=10,date='2026-10-10Z')=>recordManualWarehouseInbound({tenantId,warehouseId,userId:actorId,productId,purchaseQuantity:quantity,totalAmount:amount,effectiveAt:new Date(date),idempotencyKey:randomUUID()})
const report=(id:string,extra='')=>app.inject({url:`/api/inventory-reports/${id}?start=2026-10-01&end=2026-10-31&warehouseId=${warehouseId}${extra}`,headers:headers()})
const confirm=(id:string,net='100',patch:any={})=>app.inject({url:`/api/inventory-reports/cost-basis/${id}`,method:'POST',headers:headers(),payload:{requestKey:randomUUID(),expectedVersion:0,basisType:'NET_DOCUMENT',netValueDelta:net,evidenceRefs:['document:LOCAL-COST-MATERIAL'],...patch}})
async function excel(result:any){const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(result.fileBase64,'base64') as any);return book.worksheets[0]}

it('restores frozen gross 1.13 and net 1 across three single-unit returns without rounding inflation, with replay and over-return guards',async()=>{
 const initial=await inbound(1.13,3);expect((await confirm(initial.movement.id,'1')).statusCode).toBe(201)
 const store=await db.store.create({data:{tenantId,no:'R',name:'门店'}})
 const po=await db.purchaseOrder.create({data:{tenantId,no:'PO-ROUND',storeId:store.id,supplierId,expectedDate:new Date('2026-10-15Z'),totalAmount:6,createdById:actorId,status:'DELIVERING'}})
 const line=await db.purchaseOrderItem.create({data:{purchaseOrderId:po.id,productId,quantity:3,unitPrice:2,amount:6}})
 const delivery=await db.deliveryOrder.create({data:{tenantId,no:'DO-ROUND',storeId:store.id,supplierId,warehouseId,purchaseOrderId:po.id,status:'SHIPPED',createdById:actorId,actualTotalAmount:6}})
 await db.deliveryOrderItem.create({data:{deliveryOrderId:delivery.id,purchaseOrderItemId:line.id,productId,orderedQtySnapshot:3,shippedQty:3,unitPriceSnapshot:2,amount:6}})
 const sent=await recordBatchManualWarehouseOutbound({tenantId,warehouseId,userId:actorId,items:[{productId,inventoryQuantity:3}],effectiveAt:new Date('2026-10-15Z'),idempotencyKey:randomUUID(),reason:'配送发货'})
 const original=await db.warehouseLedgerMovement.update({where:{id:sent.movements[0].id},data:{sourceType:'DeliveryOrder',sourceId:delivery.id,sourceLineId:line.id}})
 const send=(key:string,quantity=1)=>db.$transaction((tx:any)=>reverseDeliveryOutboundInTransaction(tx,{tenantId,userId:actorId,source:'ReceiptRejection',sourceId:key,originalMovementId:original.id,quantity:new Prisma.Decimal(quantity),reason:'分批完好退回'}),{isolationLevel:'Serializable'})
 const ids=[]
 for(const key of ['first','second','last']){const r=await send(key);ids.push(r.movementId);expect(r.replayed).toBe(false)}
 const amounts=await db.warehouseLedgerMovement.findMany({where:{id:{in:ids}},orderBy:{postingSequence:'asc'}})
 expect(amounts.map((m:any)=>m.valueDelta.toString())).toEqual(['0.3767','0.3767','0.3766'])
 const before=await db.warehouseLedgerBalance.findUniqueOrThrow({where:{tenantId_warehouseId_productId:{tenantId,warehouseId,productId}}})
 expect(before.physicalQty.toString()).toBe('3');expect(before.inventoryValue.toString()).toBe('1.13')
 expect((await send('last')).replayed).toBe(true)
 await expect(send('too-many')).rejects.toThrow('累计冲回将超过原出库量')
 expect(await db.warehouseLedgerMovement.count({where:{tenantId,type:'REVERSAL'}})).toBe(3)
 const current=(await report('realtime')).json();expect(current.rows[0]).toMatchObject({qty:3,amount:1,price:0.333333,costStatus:'KNOWN'})
 const details=(await report('movements')).json();const incoming=details.rows.filter((r:any)=>ids.includes(r.id)).map((r:any)=>r.inAmount).sort();expect(incoming).toEqual([0.3333,0.3333,0.3334])
})
