import Fastify from 'fastify'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { prisma, Prisma } from '@dianjie/db'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { replenishmentOrderRoutes } from '../../src/routes/replenishmentOrders'
import { deliveryRoutes } from '../../src/routes/deliveries'
import { recordManualWarehouseInbound } from '../../src/services/warehouseLedger'
import { auditWarehouseLedger } from '../../src/services/warehouseLedgerAudit'
import { resolveTenantWarehouseId } from '../../src/services/defaultWarehouse'
let f: any
const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
let serial = 0
async function cleanup() {
 if (!f?.tenantId) return
 const tenantId=f.tenantId
 await prisma.replenishmentStockHold.deleteMany({where:{tenantId}})
 for (const name of ['warehouseLedgerLotAllocation','warehouseLedgerLot','warehouseLedgerReservation','warehouseLedgerMovement','warehouseLedgerBalance','supplierStockReservation','supplierStockBatchAllocation','supplierStockBatch','supplierStockMovement','deliveryOrderEvent']) await (prisma as any)[name].deleteMany({where:{tenantId}})
 await prisma.deliveryOrderItem.deleteMany({where:{deliveryOrder:{tenantId}}})
 for(const name of ['deliveryOrder','purchaseOrderEvent','purchaseOrderRevision']) await (prisma as any)[name].deleteMany({where:{tenantId}})
 await prisma.replenishmentFulfillmentLink.deleteMany({where:{tenantId}});await prisma.replenishmentOrderEvent.deleteMany({where:{tenantId}});await prisma.replenishmentOrderItem.deleteMany({where:{replenishmentOrder:{tenantId}}});await prisma.replenishmentOrder.deleteMany({where:{tenantId}})
 await prisma.purchaseOrderItem.deleteMany({where:{purchaseOrder:{tenantId}}})
 for(const name of ['purchaseOrder','notification','opLog','businessSequence','warehouseStock','product','user','store','supplier','warehouse']) await (prisma as any)[name].deleteMany({where:{tenantId}})
 await prisma.tenant.delete({where:{id:tenantId}})
}
beforeEach(async()=>{
 const slug=`p01-isolated-${nonce}-${++serial}`
 const tenant=await prisma.tenant.create({data:{name:'采购协同验证',slug}})
 f={tenantId:tenant.id,slug};const tenantId=tenant.id
 f.warehouseId=await resolveTenantWarehouseId(prisma,tenantId,undefined)
 await prisma.warehouse.update({where:{id:f.warehouseId},data:{inventoryMode:'OFF',blockZeroStockAtOrderEntry:false}})
 const supplier=await prisma.supplier.create({data:{tenantId,no:'HEADQ',name:'总仓配送主体',sourceType:'HEADQ_WAREHOUSE',inventoryMode:'NOT_TRACKED'}});f.supplierId=supplier.id
 const external=await prisma.supplier.create({data:{tenantId,no:'EXT',name:'合作供货公司',sourceType:'MAIN_SUPPLIER',inventoryMode:'STRICT'}});f.externalId=external.id
 const store=await prisma.store.create({data:{tenantId,no:'S1',name:'一号门店'}});f.storeId=store.id
 const second=await prisma.store.create({data:{tenantId,no:'S2',name:'二号门店'}});f.secondStoreId=second.id
 for(const [key,role,extra] of [['storeUser','KITCHEN_LEAD',{storeId:store.id,storeIds:[store.id]}],['secondUser','KITCHEN_LEAD',{storeId:second.id,storeIds:[second.id]}],['supplyUser','SUPPLY_CHAIN',{}],['supplierUser','SUPPLIER_OWNER',{supplierId:external.id}]] as any[]) f[key]=await prisma.user.create({data:{tenantId,email:`${key}-${slug}@local.invalid`,name:'采购负责人',password:'$2b$10$invalid.fixture.hash.not.for.login',role,...extra}})
 const base={tenantId,category:'调味品',unit:'kg',purchaseUnit:'kg',orderUnit:'kg',inventoryUnit:'kg',costUnit:'kg',inventoryUnitsPerPurchaseUnit:1,inventoryUnitsPerOrderUnit:1,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED' as const,price:10,stock:0,minOrderQty:1,stepQty:1,status:'ENABLED' as const}
 f.product=await prisma.product.create({data:{...base,supplierId:f.supplierId,code:'P1',name:'常用调味品'}})
 f.extra=await prisma.product.create({data:{...base,supplierId:f.supplierId,code:'P2',name:'备用调味品'}})
 f.externalProduct=await prisma.product.create({data:{...base,supplierId:f.externalId,code:'E1',name:'整箱调味品',unit:'箱',purchaseUnit:'箱',orderUnit:'箱',costUnit:'箱',inventoryUnit:'袋',inventoryUnitsPerPurchaseUnit:3,inventoryUnitsPerOrderUnit:3,inventoryUnitsPerCostUnit:3,stock:10}})
 await prisma.supplierStockBatch.create({data:{tenantId,supplierId:f.externalId,productId:f.externalProduct.id,batchNo:'OPENING',kind:'OPENING',initialQty:10,remainingQty:10}})
 f.app=Fastify();f.app.decorate('authenticate',async(req:any)=>{
 const actor=String(req.headers['x-actor']||'store');const u=actor==='second'?f.secondUser:actor==='supplier'?f.supplierUser:actor==='supply'?f.supplyUser:f.storeUser
 req.user={tenantId,userId:u.id,role:u.role,supplierId:u.supplierId,storeId:u.storeId,storeIds:u.storeIds}
 });await f.app.register(purchaseOrderRoutes,{prefix:'/api/orders'});await f.app.register(deliveryRoutes,{prefix:'/api/deliveries'});await f.app.register(replenishmentOrderRoutes,{prefix:'/api/replenishment-orders'});await f.app.ready()
})
afterEach(async()=>{if(f?.app)await f.app.close();await new Promise(r=>setTimeout(r,120));await cleanup()})
async function call(method:string,url:string,payload?:any,actor='store'){return f.app.inject({method,url,payload,headers:{'x-actor':actor}})}
async function inbound(qty=20,productId=f.product.id){await recordManualWarehouseInbound({tenantId:f.tenantId,userId:f.supplyUser.id,productId,purchaseQuantity:qty,totalAmount:qty*10,effectiveAt:new Date('2026-10-01T00:00:00Z'),idempotencyKey:`stock-${productId}`})}
function body(qty=2,options:any={}){return{supplierId:f.supplierId,storeId:f.storeId,expectedDate:'2030-01-02',idempotencyKey:`order-${serial}-${Math.random()}`,items:[{productId:f.product.id,quantity:qty,unitPrice:999}],...options}}
async function order(qty=2,options:any={},actor='store'){const request=body(qty,options);request.items=request.items.map((item:any)=>({unitPrice:999,...item}));const r=await call('POST','/api/orders',request,actor);expect(r.statusCode,r.body).toBe(200);return r.json()}
async function balance(warehouseId=f.warehouseId,productId=f.product.id){return prisma.warehouseLedgerBalance.findUniqueOrThrow({where:{tenantId_warehouseId_productId:{tenantId:f.tenantId,warehouseId,productId}}})}
async function accept(id:string){const r=await call('PATCH',`/api/orders/${id}/confirm`,{},'supply');expect(r.statusCode,r.body).toBe(200)}
async function ship(id:string,key='shipment-first'){const r=await call('PATCH',`/api/orders/${id}/ship`,{idempotencyKey:key,pickerName:'仓库负责人'},'supply');expect(r.statusCode,r.body).toBe(200);return r.json()}
describe('P01 submitted stock lifecycle on isolated DB',()=>{
 it.each(['OFF','SHADOW','STRICT'] as const)('blocks zero and overstock in mode %s without creating orders',async(mode)=>{
  await prisma.warehouse.update({where:{id:f.warehouseId},data:{inventoryMode:mode}})
  const zero=await call('POST','/api/orders',body(1));expect(zero.statusCode,zero.body).toBe(409)
  await inbound(3);const excess=await call('POST','/api/orders',body(4));expect(excess.statusCode,excess.body).toBe(409)
  expect(await prisma.purchaseOrder.count({where:{tenantId:f.tenantId}})).toBe(0);expect(Number((await balance()).reservedQty)).toBe(0)
 })
 it.each(['OFF','SHADOW','STRICT'] as const)('reserves immediately and cancellation releases in mode %s',async(mode)=>{
  await prisma.warehouse.update({where:{id:f.warehouseId},data:{inventoryMode:mode}});await inbound(10);const o=await order(3)
  expect(o.submittedSnapshot.stockReservationPolicy).toBe('SUBMISSION_V1');expect(Number((await balance()).reservedQty)).toBe(3);expect(Number((await balance()).physicalQty)).toBe(10)
  const r=await call('PATCH',`/api/orders/${o.id}/cancel`,{reason:'采购计划调整'});expect(r.statusCode,r.body).toBe(200)
  expect(Number((await balance()).reservedQty)).toBe(0);expect(Number((await balance()).physicalQty)).toBe(10)
 })
 it('serializes concurrent demand from two stores, with one winner and no over-reservation',async()=>{
  await inbound(10);const responses=await Promise.all([call('POST','/api/orders',body(6)),call('POST','/api/orders',body(6,{storeId:f.secondStoreId}),'second')])
  expect(responses.map(x=>x.statusCode).sort()).toEqual([200,409]);expect(Number((await balance()).reservedQty)).toBe(6);expect(await prisma.purchaseOrder.count({where:{tenantId:f.tenantId}})).toBe(1)
 })
 it('replays submit and accept without creating duplicate reservations',async()=>{
  await inbound(10);const b=body(3);const first=await call('POST','/api/orders',b);expect(first.statusCode,first.body).toBe(200);const again=await call('POST','/api/orders',b);expect(again.json().id).toBe(first.json().id)
  await accept(first.json().id);expect(Number((await balance()).reservedQty)).toBe(3);expect(await prisma.warehouseLedgerReservation.count({where:{tenantId:f.tenantId,status:'ACTIVE'}})).toBe(1)
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId:f.tenantId,type:'ORDER_RESERVED'}})).toBe(1)
 })
 it('rejection of a submitted order releases its immediate reservation',async()=>{
  await inbound(10);const o=await order(3);const r=await call('PATCH',`/api/orders/${o.id}/reject`,{reason:'配送计划调整'},'supply');expect(r.statusCode,r.body).toBe(200);expect(Number((await balance()).reservedQty)).toBe(0)
 })
 it('internal direct revision adjusts only the delta and rolls back overstock changes',async()=>{
  await inbound(10);const o=await order(3)
  const r=await call('POST',`/api/orders/${o.id}/revisions`,{reason:'数量调整',baseRowVersion:0,requestKey:'direct-revision-1',items:[{productId:f.product.id,quantity:5}]},'supply');expect(r.statusCode,r.body).toBe(201);expect(Number((await balance()).reservedQty)).toBe(5)
  const current=await prisma.purchaseOrder.findUniqueOrThrow({where:{id:o.id}})
  const fail=await call('POST',`/api/orders/${o.id}/revisions`,{reason:'超量调整',baseRowVersion:current.rowVersion,requestKey:'direct-revision-2',items:[{productId:f.product.id,quantity:11}]},'supply');expect(fail.statusCode,fail.body).toBe(409);expect(Number((await balance()).reservedQty)).toBe(5)
 })
 it('supplier proposal changes reservations only when the store approves, and rejection preserves stock',async()=>{
  await prisma.product.update({where:{id:f.externalProduct.id},data:{stock:10}})
  const o=await order(2,{supplierId:f.externalId,items:[{productId:f.externalProduct.id,quantity:2}]})
  const propose=await call('POST',`/api/orders/${o.id}/revisions`,{reason:'调整数量',baseRowVersion:0,requestKey:'supplier-proposal-1',items:[{productId:f.externalProduct.id,quantity:4}]},'supplier');expect(propose.statusCode,propose.body).toBe(201)
  const before=await prisma.supplierStockReservation.findFirstOrThrow({where:{purchaseOrderId:o.id}});expect(Number(before.quantity)).toBe(2)
  const approved=await call('PATCH',`/api/orders/${o.id}/revisions/${propose.json().id}/approve`,{});expect(approved.statusCode,approved.body).toBe(200)
  expect(Number((await prisma.supplierStockReservation.findFirstOrThrow({where:{purchaseOrderId:o.id}})).quantity)).toBe(4)
  const latest=await prisma.purchaseOrder.findUniqueOrThrow({where:{id:o.id}});const second=await call('POST',`/api/orders/${o.id}/revisions`,{reason:'再次调整',baseRowVersion:latest.rowVersion,requestKey:'supplier-proposal-2',items:[{productId:f.externalProduct.id,quantity:5}]},'supplier');expect(second.statusCode,second.body).toBe(201);const rejected=await call('PATCH',`/api/orders/${o.id}/revisions/${second.json().id}/reject`,{note:'保留原计划'});expect(rejected.statusCode,rejected.body).toBe(200);expect(Number((await prisma.supplierStockReservation.findFirstOrThrow({where:{purchaseOrderId:o.id}})).quantity)).toBe(4)
 })
 it('operation group revision synchronizes all orders and remains atomic',async()=>{
  await inbound(20);const a=await order(2),b=await order(3);const list=await call('GET','/api/orders?status=SUBMITTED&pageSize=100',undefined,'supply');expect(list.statusCode,list.body).toBe(200)
  const g=list.json().items.find((x:any)=>x.id===a.id||x.id===b.id).operationGroup;expect(g.memberOrderIds).toEqual(expect.arrayContaining([a.id,b.id]))
  const r=await call('PATCH',`/api/orders/operation-groups/${g.id}/items`,{requestKey:'group-revision-1',orders:[{orderId:a.id,baseRowVersion:0,items:[{productId:f.product.id,quantity:4}]},{orderId:b.id,baseRowVersion:0,items:[{productId:f.product.id,quantity:5}]}]},'supply');expect(r.statusCode,r.body).toBe(200);expect(Number((await balance()).reservedQty)).toBe(9)
  const failed=await call('PATCH',`/api/orders/operation-groups/${g.id}/items`,{requestKey:'group-revision-2',orders:[{orderId:a.id,baseRowVersion:1,items:[{productId:f.product.id,quantity:12}]},{orderId:b.id,baseRowVersion:1,items:[{productId:f.product.id,quantity:13}]}]},'supply');expect(failed.statusCode,failed.body).toBe(409);expect(Number((await balance()).reservedQty)).toBe(9);expect(Number((await prisma.purchaseOrderItem.findFirstOrThrow({where:{purchaseOrderId:a.id,isActive:true}})).quantity)).toBe(4)
 })
 it('ships once and quantity correction/removal consistently reverse the same frozen stock ledger',async()=>{
  await inbound(10);const o=await order(3);await accept(o.id);const first=await ship(o.id);await ship(o.id)
  expect(Number((await balance()).physicalQty)).toBe(7);expect(Number((await balance()).reservedQty)).toBe(0)
  const d=await prisma.deliveryOrder.findUniqueOrThrow({where:{id:first.deliveryId},include:{items:true}})
  const changed=await call('PATCH',`/api/deliveries/${d.id}/item-quantity`,{itemId:d.items[0].id,targetQuantity:2,rowVersion:d.rowVersion,reason:'实发数量核对'},'supply');expect(changed.statusCode,changed.body).toBe(200);expect(Number((await balance()).physicalQty)).toBe(8)
  const fresh=await prisma.deliveryOrder.findUniqueOrThrow({where:{id:d.id}})
  const removed=await call('PATCH',`/api/deliveries/${d.id}/remove-item`,{itemId:d.items[0].id,rowVersion:fresh.rowVersion,reason:'撤去该商品'},'supply');expect(removed.statusCode,removed.body).toBe(200);expect(Number((await balance()).physicalQty)).toBe(10)
  const removedDelivery=await prisma.deliveryOrder.findUniqueOrThrow({where:{id:d.id}});const restored=await call('POST',`/api/deliveries/${d.id}/add-item`,{productId:f.product.id,quantity:1,rowVersion:removedDelivery.rowVersion,reason:'恢复商品'},'supply');expect(restored.statusCode,restored.body).toBe(200);expect(Number((await balance()).physicalQty)).toBe(9)
 })
 it('keeps external stock on legacy boxes through submit, shipment and correction despite bags inventory unit',async()=>{
  const o=await order(2,{supplierId:f.externalId,items:[{productId:f.externalProduct.id,quantity:2}]})
  const res=await prisma.supplierStockReservation.findFirstOrThrow({where:{purchaseOrderId:o.id}});expect(Number(res.quantity)).toBe(2);expect(res.stockUnitSnapshot).toBe('箱');expect(Number(res.stockUnitsPerOrderUnitSnapshot)).toBe(1)
  await accept(o.id);const sent=await ship(o.id);expect(Number((await prisma.product.findUniqueOrThrow({where:{id:f.externalProduct.id}})).stock)).toBe(8)
  const d=await prisma.deliveryOrder.findUniqueOrThrow({where:{id:sent.deliveryId},include:{items:true}})
  const changed=await call('PATCH',`/api/deliveries/${d.id}/item-quantity`,{itemId:d.items[0].id,targetQuantity:1,rowVersion:d.rowVersion,reason:'核对实发数量'},'supply');expect(changed.statusCode,changed.body).toBe(200);expect(Number((await prisma.product.findUniqueOrThrow({where:{id:f.externalProduct.id}})).stock)).toBe(9)
 })
 it('keeps the original warehouse through revision, shipment and cancellation after default changes',async()=>{
  await inbound(20);const a=await order(2),b=await order(3)
  await prisma.warehouse.update({where:{id:f.warehouseId},data:{isDefault:false}});const next=await prisma.warehouse.create({data:{tenantId:f.tenantId,code:'NEXT',name:'备用仓',isDefault:true,inventoryMode:'OFF'}})
  const rev=await call('POST',`/api/orders/${a.id}/revisions`,{reason:'调整原单',baseRowVersion:0,requestKey:'original-warehouse',items:[{productId:f.product.id,quantity:4}]},'supply');expect(rev.statusCode,rev.body).toBe(201);expect(Number((await balance()).reservedQty)).toBe(7)
  const cancel=await call('PATCH',`/api/orders/${b.id}/cancel`,{reason:'取消采购'});expect(cancel.statusCode,cancel.body).toBe(200);expect(Number((await balance()).reservedQty)).toBe(4)
  await accept(a.id);const sent=await ship(a.id);const d=await prisma.deliveryOrder.findUniqueOrThrow({where:{id:sent.deliveryId}});expect(d.warehouseId).toBe(f.warehouseId);expect(Number((await balance()).physicalQty)).toBe(16)
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId:f.tenantId,warehouseId:next.id}})).toBe(0)
 })
 it('uses the submitted frozen HEADQ conversion after product master conversion changes',async()=>{
  await prisma.product.update({where:{id:f.product.id},data:{unit:'箱',purchaseUnit:'箱',orderUnit:'箱',costUnit:'箱',inventoryUnit:'袋',inventoryUnitsPerPurchaseUnit:3,inventoryUnitsPerOrderUnit:3,inventoryUnitsPerCostUnit:3}})
  await inbound(10);const o=await order(2);expect(Number((await balance()).physicalQty)).toBe(30);expect(Number((await balance()).reservedQty)).toBe(6)
  await prisma.product.update({where:{id:f.product.id},data:{inventoryUnitsPerPurchaseUnit:7,inventoryUnitsPerOrderUnit:7,inventoryUnitsPerCostUnit:7}})
  await accept(o.id);await ship(o.id);expect(Number((await balance()).physicalQty)).toBe(24);expect(Number((await balance()).reservedQty)).toBe(0)
 })
 it('keeps genuinely untracked external supply explicit without manufacturing stock or reservations',async()=>{
  await prisma.supplier.update({where:{id:f.externalId},data:{inventoryMode:'NOT_TRACKED'}});await prisma.product.update({where:{id:f.externalProduct.id},data:{stock:0}});await prisma.supplierStockBatch.deleteMany({where:{tenantId:f.tenantId}})
  const o=await order(2,{supplierId:f.externalId,items:[{productId:f.externalProduct.id,quantity:2}]});expect(o.submittedSnapshot.stockReservationPolicy).toBeUndefined();expect(await prisma.supplierStockReservation.count({where:{purchaseOrderId:o.id}})).toBe(0)
  await accept(o.id);await ship(o.id);expect(Number((await prisma.product.findUniqueOrThrow({where:{id:f.externalProduct.id}})).stock)).toBe(0)
 })
 it('binds a replenishment-generated new HEADQ PO to the same stock policy without a duplicate reservation',async()=>{
  await inbound(10)
  const created=await call('POST','/api/replenishment-orders',{supplierId:f.supplierId,storeId:f.storeId,expectedDate:'2030-01-02',note:'追加采购',idempotencyKey:'replenishment-created',items:[{productId:f.product.id,quantity:2}]},'supply');expect(created.statusCode,created.body).toBe(201)
  const id=created.json().id;const submitted=await call('POST',`/api/replenishment-orders/${id}/submit`,{requestKey:'replenishment-submit'},'supply');expect(submitted.statusCode,submitted.body).toBe(200)
  const accepted=await call('POST',`/api/replenishment-orders/${id}/accept`,{requestKey:'replenishment-accept'},'supply');expect(accepted.statusCode,accepted.body).toBe(200)
  const replay=await call('POST',`/api/replenishment-orders/${id}/accept`,{requestKey:'replenishment-accept'},'supply');expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().purchaseOrderId).toBe(accepted.json().purchaseOrderId)
  const o=await prisma.purchaseOrder.findUniqueOrThrow({where:{id:accepted.json().purchaseOrderId}});expect((o.submittedSnapshot as any).stockReservationPolicy).toBe('SUBMISSION_V1');expect(Number((await balance()).reservedQty)).toBe(2)
  await ship(o.id);expect(Number((await balance()).physicalQty)).toBe(8)
 })
 it('accepts an operation group and replays it without reserving its orders again',async()=>{
  await inbound(10);const a=await order(2),b=await order(3);const listed=await call('GET','/api/orders?status=SUBMITTED&pageSize=100',undefined,'supply');const g=listed.json().items.find((row:any)=>row.id===a.id||row.id===b.id).operationGroup
  const payload={orderIds:[a.id,b.id],idempotencyKey:'group-accept-once'}
  const first=await call('POST',`/api/orders/operation-groups/${g.id}/confirm`,payload,'supply');expect(first.statusCode,first.body).toBe(200)
  const again=await call('POST',`/api/orders/operation-groups/${g.id}/confirm`,payload,'supply');expect(again.statusCode,again.body).toBe(200)
  expect(Number((await balance()).reservedQty)).toBe(5);expect(await prisma.warehouseLedgerReservation.count({where:{tenantId:f.tenantId,status:'ACTIVE'}})).toBe(2)
 })
 it('partial shipment releases unshipped demand and cannot consume the reserved stock twice',async()=>{
  await inbound(10);const o=await order(3);await accept(o.id);const item=await prisma.purchaseOrderItem.findFirstOrThrow({where:{purchaseOrderId:o.id}})
  const payload={idempotencyKey:'partial-shipment-once',pickerName:'仓库负责人',items:[{itemId:item.id,shippedQty:2}]}
  const first=await call('PATCH',`/api/orders/${o.id}/ship`,payload,'supply');expect(first.statusCode,first.body).toBe(200)
  const again=await call('PATCH',`/api/orders/${o.id}/ship`,payload,'supply');expect(again.statusCode,again.body).toBe(200)
  expect(Number((await balance()).physicalQty)).toBe(8);expect(Number((await balance()).reservedQty)).toBe(0)
  const res=await prisma.warehouseLedgerReservation.findUniqueOrThrow({where:{purchaseOrderItemId:item.id}});expect(Number(res.fulfilledInventoryQty)).toBe(2);expect(res.releasedAt).not.toBeNull()
 })
 it('keeps legacy confirmed OFF orders compatible without retroactive reservation or double deduction',async()=>{
  const original=await prisma.purchaseOrder.create({data:{tenantId:f.tenantId,no:'LEGACY',storeId:f.storeId,supplierId:f.supplierId,status:'CONFIRMED',expectedDate:new Date('2030-01-02'),totalAmount:20,createdById:f.storeUser.id,items:{create:{productId:f.product.id,quantity:2,unitPrice:10,amount:20,...{purchaseUnitSnapshot:'kg',orderUnitSnapshot:'kg',inventoryUnitSnapshot:'kg',costUnitSnapshot:'kg',unitConversionStatusSnapshot:'VERIFIED',inventoryUnitsPerPurchaseUnitSnapshot:1,inventoryUnitsPerOrderUnitSnapshot:1,inventoryUnitsPerCostUnitSnapshot:1}}}}})
  await ship(original.id);await ship(original.id);expect(await prisma.deliveryOrder.count({where:{purchaseOrderId:original.id}})).toBe(1);expect(await prisma.warehouseLedgerMovement.count({where:{tenantId:f.tenantId}})).toBe(0)
 })
})


async function draftReplenishment(qty: number, key: string) {
  const r = await call('POST', '/api/replenishment-orders', { supplierId: f.supplierId, storeId: f.storeId, expectedDate: '2030-01-02', idempotencyKey: key, items: [{ productId: f.product.id, quantity: qty }] }, 'supply')
  expect(r.statusCode, r.body).toBe(201); return r.json().id as string
}
async function submitReplenishment(id: string, key: string) {
  return call('POST', `/api/replenishment-orders/${id}/submit`, { requestKey: key }, 'supply')
}
describe('P01 independent replenishment submission holds on isolated DB', () => {
 it.each(['submit','cancel','accept'])('returns a retryable conflict rather than 500 after raw serialization failure in %s',async action=>{
  await inbound(10);const id=await draftReplenishment(2,`ro-exhaust-create-${action}`)
  if(action!=='submit')expect((await submitReplenishment(id,`ro-exhaust-submit-${action}`)).statusCode).toBe(200)
  const failure=Object.assign(new Error('could not serialize access due to concurrent update'),{code:'P2010',meta:{code:'40001'}})
  const transaction=vi.spyOn(prisma,'$transaction').mockRejectedValue(failure)
  try {
   const response=await call('POST',`/api/replenishment-orders/${id}/${action}`,{requestKey:`ro-exhaust-${action}`,...(action==='cancel'?{reason:'计划调整'}:{})},'supply')
   expect(response.statusCode,response.body).toBe(409)
   expect(transaction).toHaveBeenCalledTimes(action==='accept'?1:4)
  } finally {transaction.mockRestore()}
  expect((await prisma.replenishmentOrder.findUniqueOrThrow({where:{id}})).status).toBe(action==='submit'?'DRAFT':'SUBMITTED')
  expect(Number((await balance()).reservedQty)).toBe(action==='submit'?0:2)
  expect(await prisma.purchaseOrder.count({where:{tenantId:f.tenantId}})).toBe(0)
 })
 it('holds full stock on submit and transfers once to a single PO despite zero unreserved stock', async () => {
  await inbound(10); await prisma.warehouse.update({where:{id:f.warehouseId},data:{blockZeroStockAtOrderEntry:true}})
  const id = await draftReplenishment(10, 'ro-full-create'); const submitted = await submitReplenishment(id, 'ro-full-submit'); expect(submitted.statusCode,submitted.body).toBe(200)
  expect(Number((await balance()).reservedQty)).toBe(10); expect(Number((await balance()).physicalQty)).toBe(10)
  expect(await prisma.purchaseOrder.count({where:{tenantId:f.tenantId}})).toBe(0)
  expect((await auditWarehouseLedger(f.tenantId,prisma,f.warehouseId)).issues.filter(issue=>issue.code.startsWith('ACTIVE_RESERVATION'))).toEqual([])
  expect((await submitReplenishment(id,'ro-full-submit')).statusCode).toBe(200)
  const response=await call('POST',`/api/replenishment-orders/${id}/accept`,{requestKey:'ro-full-accept'},'supply');expect(response.statusCode,response.body).toBe(200)
  const poId=response.json().purchaseOrderId
  expect(Number((await balance()).reservedQty)).toBe(10)
  const hold=await prisma.replenishmentStockHold.findFirstOrThrow({where:{tenantId:f.tenantId,replenishmentOrderId:id}});expect(hold.status).toBe('TRANSFERRED');expect(hold.purchaseOrderId).toBe(poId)
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId:f.tenantId,type:'ORDER_RESERVED'}})).toBe(1)
  expect((await auditWarehouseLedger(f.tenantId,prisma,f.warehouseId)).issues.filter(issue=>issue.code.startsWith('ACTIVE_RESERVATION'))).toEqual([])
  expect((await call('POST',`/api/replenishment-orders/${id}/accept`,{requestKey:'ro-full-accept'},'supply')).json().purchaseOrderId).toBe(poId)
  expect((await call('POST',`/api/replenishment-orders/${id}/accept`,{requestKey:'ro-full-submit'},'supply')).statusCode).toBe(409)
  await ship(poId,'ro-full-ship');expect(Number((await balance()).physicalQty)).toBe(0);expect(Number((await balance()).reservedQty)).toBe(0)
 })
 it('rejects excess submission atomically, retaining an editable draft and its original lines',async()=>{
  await inbound(10);const id=await draftReplenishment(11,'ro-excess-create');const before=await prisma.replenishmentOrder.findUniqueOrThrow({where:{id},include:{items:true}})
  const r=await submitReplenishment(id,'ro-excess-submit');expect(r.statusCode,r.body).toBe(409)
  const after=await prisma.replenishmentOrder.findUniqueOrThrow({where:{id},include:{items:true}})
  expect(after.status).toBe('DRAFT');expect(after.rowVersion).toBe(before.rowVersion);expect(after.items.map(x=>x.id)).toEqual(before.items.map(x=>x.id));expect(after.stockReservationPolicy).toBe('LEGACY')
  expect(await prisma.replenishmentStockHold.count({where:{tenantId:f.tenantId}})).toBe(0);expect(await prisma.replenishmentOrderEvent.count({where:{replenishmentOrderId:id,eventType:'SUBMITTED'}})).toBe(0);expect(Number((await balance()).reservedQty)).toBe(0)
 })
 it('serializes two replenishment submissions competing for the same stock',async()=>{
  await inbound(10);const a=await draftReplenishment(6,'ro-race-create-a'),b=await draftReplenishment(6,'ro-race-create-b')
  const r=await Promise.all([submitReplenishment(a,'ro-race-submit-a'),submitReplenishment(b,'ro-race-submit-b')]);expect(r.map(x=>x.statusCode).sort()).toEqual([200,409])
  expect(Number((await balance()).reservedQty)).toBe(6);expect(await prisma.replenishmentStockHold.count({where:{tenantId:f.tenantId,status:'ACTIVE'}})).toBe(1)
 })
 it('shares the same stock limit between replenishment submission and an ordinary store order',async()=>{
  await inbound(10);const id=await draftReplenishment(6,'ro-store-race-create')
  const responses=await Promise.all([submitReplenishment(id,'ro-store-race-submit'),call('POST','/api/orders',body(6))])
  expect(responses.map(r=>r.statusCode).sort(),responses.map(r=>r.body).join(' / ')).toEqual([200,409])
  expect(Number((await balance()).reservedQty)).toBe(6)
  const [ro,po]=await Promise.all([prisma.replenishmentStockHold.count({where:{tenantId:f.tenantId,status:'ACTIVE'}}),prisma.warehouseLedgerReservation.count({where:{tenantId:f.tenantId,status:'ACTIVE'}})])
  expect(ro+po).toBe(1)
  expect((await auditWarehouseLedger(f.tenantId,prisma,f.warehouseId)).issues.filter(issue=>issue.code.startsWith('ACTIVE_RESERVATION'))).toEqual([])
 })
 it('releases on cancellation exactly once without changing physical stock or amount',async()=>{
  await inbound(10);const id=await draftReplenishment(2,'ro-cancel-create');expect((await submitReplenishment(id,'ro-cancel-submit')).statusCode).toBe(200)
  const payload={reason:'计划调整',requestKey:'ro-cancel-once'};const first=await call('POST',`/api/replenishment-orders/${id}/cancel`,payload,'supply');expect(first.statusCode,first.body).toBe(200)
  expect((await call('POST',`/api/replenishment-orders/${id}/cancel`,payload,'supply')).statusCode).toBe(200)
  const b=await balance();expect(Number(b.reservedQty)).toBe(0);expect(Number(b.physicalQty)).toBe(10);expect(Number(b.inventoryValue)).toBe(100)
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId:f.tenantId,type:'ORDER_RELEASED'}})).toBe(1)
 })
 it('lets only acceptance or cancellation win, never leaving both a PO and released stock',async()=>{
  await inbound(10);const id=await draftReplenishment(2,'ro-action-create');expect((await submitReplenishment(id,'ro-action-submit')).statusCode).toBe(200)
  const responses=await Promise.all([call('POST',`/api/replenishment-orders/${id}/accept`,{requestKey:'ro-action-accept'},'supply'),call('POST',`/api/replenishment-orders/${id}/cancel`,{requestKey:'ro-action-cancel',reason:'计划调整'},'supply')])
  expect(responses.map(x=>x.statusCode).sort()).toEqual([200,409])
  const ro=await prisma.replenishmentOrder.findUniqueOrThrow({where:{id}});const hold=await prisma.replenishmentStockHold.findFirstOrThrow({where:{replenishmentOrderId:id}})
  if(ro.status==='ACCEPTED'){expect(hold.status).toBe('TRANSFERRED');expect(Number((await balance()).reservedQty)).toBe(2);expect(await prisma.purchaseOrder.count({where:{tenantId:f.tenantId}})).toBe(1)}
  else {expect(ro.status).toBe('CANCELLED');expect(hold.status).toBe('RELEASED');expect(Number((await balance()).reservedQty)).toBe(0);expect(await prisma.purchaseOrder.count({where:{tenantId:f.tenantId}})).toBe(0)}
 })
 it('replays concurrent cancellation with the same request key without a second release',async()=>{
  await inbound(10);const id=await draftReplenishment(2,'ro-cancel-race-create');expect((await submitReplenishment(id,'ro-cancel-race-submit')).statusCode).toBe(200)
  const payload={requestKey:'ro-cancel-race-key',reason:'计划调整'}
  const responses=await Promise.all([call('POST',`/api/replenishment-orders/${id}/cancel`,payload,'supply'),call('POST',`/api/replenishment-orders/${id}/cancel`,payload,'supply')])
  expect(responses.map(r=>r.statusCode),responses.map(r=>r.body).join(' / ')).toEqual([200,200])
  expect(Number((await balance()).reservedQty)).toBe(0)
  expect(await prisma.warehouseLedgerMovement.count({where:{tenantId:f.tenantId,type:'ORDER_RELEASED'}})).toBe(1)
  expect(await prisma.replenishmentOrderEvent.count({where:{replenishmentOrderId:id,eventType:'CANCELLED'}})).toBe(1)
 })
 it('does not silently cancel a new policy request with missing stock hold, rolling back its status CAS',async()=>{
  await inbound(10);const id=await draftReplenishment(2,'ro-missing-create');expect((await submitReplenishment(id,'ro-missing-submit')).statusCode).toBe(200)
  await prisma.replenishmentStockHold.deleteMany({where:{replenishmentOrderId:id}}) // Deliberately corrupt only this isolated synthetic fixture.
  const r=await call('POST',`/api/replenishment-orders/${id}/cancel`,{requestKey:'ro-missing-cancel',reason:'计划调整'},'supply');expect(r.statusCode,r.body).toBe(409)
  expect((await prisma.replenishmentOrder.findUniqueOrThrow({where:{id}})).status).toBe('SUBMITTED');expect(Number((await balance()).reservedQty)).toBe(2)
  expect(await prisma.replenishmentOrderEvent.count({where:{replenishmentOrderId:id,eventType:'CANCELLED'}})).toBe(0)
 })
 it('keeps original warehouse and frozen conversion when the default or product master changes before acceptance',async()=>{
  await inbound(10);const id=await draftReplenishment(2,'ro-frozen-create');expect((await submitReplenishment(id,'ro-frozen-submit')).statusCode).toBe(200)
  await prisma.warehouse.update({where:{id:f.warehouseId},data:{isDefault:false}})
  const other=await prisma.warehouse.create({data:{tenantId:f.tenantId,code:'OTHER',name:'备用仓',isDefault:true,inventoryMode:'OFF'}})
  await prisma.product.update({where:{id:f.product.id},data:{orderUnit:'箱',inventoryUnitsPerOrderUnit:3}})
  const r=await call('POST',`/api/replenishment-orders/${id}/accept`,{requestKey:'ro-frozen-accept'},'supply');expect(r.statusCode,r.body).toBe(200)
  const reservation=await prisma.warehouseLedgerReservation.findFirstOrThrow({where:{purchaseOrderId:r.json().purchaseOrderId}})
  expect(reservation.warehouseId).toBe(f.warehouseId);expect(Number(reservation.conversionFactor)).toBe(1);expect(Number(reservation.inventoryQuantity)).toBe(2)
  expect(Number((await balance()).reservedQty)).toBe(2);expect(await prisma.warehouseLedgerBalance.count({where:{tenantId:f.tenantId,warehouseId:other.id}})).toBe(0)
 })
 it('accepts legacy submitted requests without backfilling a historical RO hold',async()=>{
  await inbound(10);const id=await draftReplenishment(2,'ro-legacy-create');await prisma.replenishmentOrder.update({where:{id},data:{status:'SUBMITTED',submittedAt:new Date(),submittedById:f.supplyUser.id}})
  const r=await call('POST',`/api/replenishment-orders/${id}/accept`,{requestKey:'ro-legacy-accept'},'supply');expect(r.statusCode,r.body).toBe(200)
  expect(await prisma.replenishmentStockHold.count({where:{replenishmentOrderId:id}})).toBe(0);expect(Number((await balance()).reservedQty)).toBe(2)
 })
})
