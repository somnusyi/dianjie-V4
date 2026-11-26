import {beforeEach,afterEach,afterAll,it,expect,vi} from 'vitest'
import {Prisma,prisma} from '@dianjie/db'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import ExcelJS from 'exceljs'
import {randomUUID} from 'node:crypto'
import {recordManualWarehouseInbound,recordBatchManualWarehouseOutbound,adjustWarehouseMovementValue,reverseManualWarehouseInbound,reverseDeliveryOutboundInTransaction} from '../../src/services/warehouseLedger'
import {postUpstreamReceiptInTransaction} from '../../src/services/warehouseLedger'
import {createUpstreamPurchaseReturn,submitUpstreamPurchaseReturn,approveUpstreamPurchaseReturn,receiveUpstreamPurchaseReturn} from '../../src/services/upstreamPurchaseReturns'
import {inventoryReportRoutes} from '../../src/routes/inventoryReports'
const url=new URL(process.env.DATABASE_URL!);if(url.hostname!=='127.0.0.1'||url.port!=='15449'||url.pathname!=='/dianjie_four_gap_test')throw new Error('Dedicated synthetic database required')
const db:any=prisma;let tenantId='',warehouseId='',productId='',actorId='',supplierId='';let app:any
// Keep implicit reversal/return dates inside the October report fixture, regardless of the day tests run.
beforeEach(async()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-28T08:00:00Z'));tenantId='';tenantId=(await db.tenant.create({data:{name:'报表核定验证',slug:'p05-api-'+randomUUID()}})).id;warehouseId=(await db.warehouse.findFirst({where:{tenantId,isDefault:true}})).id;await db.warehouse.update({where:{id:warehouseId},data:{inventoryMode:'STRICT'}});supplierId=(await db.supplier.create({data:{tenantId,no:'S',name:'供应商',businessScopes:['WAREHOUSE_UPSTREAM']}})).id;productId=(await db.product.create({data:{tenantId,supplierId,code:'P',name:'商品',unit:'kg',price:10,pricingMode:'FIXED',inventoryUnit:'kg',purchaseUnit:'kg',orderUnit:'kg',costUnit:'kg',inventoryUnitsPerOrderUnit:1,inventoryUnitsPerPurchaseUnit:1,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED'}})).id;actorId=(await db.user.create({data:{tenantId,email:'p05-api-'+randomUUID()+'@local.invalid',name:'供应链',password:'synthetic-not-login',role:'SUPPLY_CHAIN'}})).id;app=Fastify();await app.register(jwt,{secret:'p05-api-synthetic-secret-only'});app.decorate('authenticate',async(req:any)=>{await req.jwtVerify()});await app.register(inventoryReportRoutes,{prefix:'/api/inventory-reports'});await app.ready()})
afterEach(async()=>{vi.useRealTimers();await app?.close();if(!tenantId)return;for(const c of await db.warehouseNetCostBasisConfirmation.findMany({where:{tenantId},orderBy:{version:'desc'}}))await db.warehouseNetCostBasisConfirmation.delete({where:{id:c.id}});await db.upstreamPurchaseReturnEvent.deleteMany({where:{tenantId}});await db.upstreamPurchaseReturnLine.deleteMany({where:{tenantId}});await db.upstreamPurchaseReturn.deleteMany({where:{tenantId}});await db.warehouseLedgerLotAllocation.deleteMany({where:{tenantId}});await db.warehouseLedgerLot.deleteMany({where:{tenantId}});await db.upstreamReceiptLine.updateMany({where:{tenantId},data:{ledgerMovementId:null}});await db.warehouseLedgerMovement.deleteMany({where:{tenantId}});await db.warehouseLedgerBalance.deleteMany({where:{tenantId}});await db.upstreamReceiptLine.deleteMany({where:{tenantId}});await db.upstreamReceipt.deleteMany({where:{tenantId}});await db.upstreamPurchaseOrderLine.deleteMany({where:{tenantId}});await db.upstreamPurchaseOrder.deleteMany({where:{tenantId}});await db.businessSequence.deleteMany({where:{tenantId}});await db.opLog.deleteMany({where:{tenantId}});await db.deliveryOrderItem.deleteMany({where:{deliveryOrder:{tenantId}}});await db.deliveryOrder.deleteMany({where:{tenantId}});await db.purchaseOrderItem.deleteMany({where:{purchaseOrder:{tenantId}}});await db.purchaseOrder.deleteMany({where:{tenantId}});await db.store.deleteMany({where:{tenantId}});await db.product.deleteMany({where:{tenantId}});await db.user.deleteMany({where:{tenantId}});await db.supplier.deleteMany({where:{tenantId}});await db.warehouse.deleteMany({where:{tenantId}});await db.tenant.delete({where:{id:tenantId}})})
afterAll(async()=>{await db.$disconnect()})
const headers=(role='SUPPLY_CHAIN',tenant=tenantId)=>({authorization:'Bearer '+app.jwt.sign({userId:actorId,tenantId:tenant,role})})
const inbound=(amount=113,quantity=10,date='2026-10-10Z')=>recordManualWarehouseInbound({tenantId,warehouseId,userId:actorId,productId,purchaseQuantity:quantity,totalAmount:amount,effectiveAt:new Date(date),idempotencyKey:randomUUID()})
const report=(id:string,extra='')=>app.inject({url:`/api/inventory-reports/${id}?start=2026-10-01&end=2026-10-31&warehouseId=${warehouseId}${extra}`,headers:headers()})
const confirm=(id:string,net='100',patch:any={})=>app.inject({url:`/api/inventory-reports/cost-basis/${id}`,method:'POST',headers:headers(),payload:{requestKey:randomUUID(),expectedVersion:0,basisType:'NET_DOCUMENT',netValueDelta:net,evidenceRefs:['document:LOCAL-COST-MATERIAL'],...patch}})
async function excel(result:any){const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(result.fileBase64,'base64') as any);return book.worksheets[0]}
it('uses identical documented net amounts in realtime, movement details, summary and every XLSX export',async()=>{
 const a=await inbound(),b=await inbound(106);for(const m of[a.movement,b.movement]){const r=await confirm(m.id);expect(r.statusCode,r.body).toBe(201)}
 const out=await recordBatchManualWarehouseOutbound({tenantId,warehouseId,userId:actorId,items:[{productId,inventoryQuantity:5}],effectiveAt:new Date('2026-10-15Z'),idempotencyKey:randomUUID(),reason:'日常领用'})
 const real=(await report('realtime')).json();expect(real.rows[0]).toMatchObject({qty:15,amount:150,price:10,netAmount:150,netPrice:10,costStatus:'KNOWN'})
 const summary=(await report('summary')).json();expect(summary.rows[0]).toMatchObject({openingQty:0,openingAmount:0,inQty:20,inAmount:200,outQty:5,outAmount:50,closingQty:15,closingAmount:150,closingPrice:10})
 const detail=(await report('movements')).json();expect(detail.rows.find((r:any)=>r.id===out.movements[0].id)).toMatchObject({outAmount:50,outPrice:10})
 for(const [kind,data,field,value]of[['realtime',real,'amount',150],['summary',summary,'closingAmount',150]]as const){const response=await report(kind,'&export=1');expect(response.statusCode,response.body).toBe(200);const sheet=await excel(response.json());expect(sheet.getRow(2).getCell(data.columns.findIndex((c:any)=>c.key===field)+1).value).toBe(value)}
 const exported=await excel((await report('movements','&export=1')).json());const outCol=detail.columns.findIndex((c:any)=>c.key==='outAmount')+1;const values=[];for(let i=2;i<=exported.rowCount;i++)values.push(exported.getRow(i).getCell(outCol).value);expect(values).toContain(50)
})
it('rejects finance and cross-tenant cost-material reads/writes and preserves safe scoped lists',async()=>{const {movement}=await inbound();for(const method of['GET','POST']){const r=await app.inject({method,url:`/api/inventory-reports/cost-basis/${movement.id}`,headers:headers('FINANCE'),...(method==='POST'?{payload:{}}:{})});expect(r.statusCode,r.body).toBe(403)}const foreign=await app.inject({url:`/api/inventory-reports/cost-basis/${movement.id}`,headers:headers('SUPPLY_CHAIN','foreign-'+randomUUID())});expect(foreign.statusCode,foreign.body).toBe(404);const list=await app.inject({url:`/api/inventory-reports/cost-basis/movements?warehouseId=${warehouseId}&productId=${productId}`,headers:headers('SUPPLY_CHAIN','foreign-'+randomUUID())});expect(list.statusCode,list.body).toBe(200);expect(list.json().total).toBe(0)})
it('returns a business conflict rather than an internal error for concurrent same-version confirmations',async()=>{
 const {movement}=await inbound();let unlock!:()=>void,ready!:(pid:number)=>void
 const released=new Promise<void>(r=>{unlock=r}),locked=new Promise<number>(r=>{ready=r})
 const blocker=db.$transaction(async(tx:any)=>{await tx.$queryRaw`SELECT id FROM warehouse_ledger_movements WHERE id=${movement.id} FOR UPDATE`;const p=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;ready(p[0].pid);await released},{timeout:10000})
 const pid=await locked;const left=Promise.resolve(confirm(movement.id)),right=Promise.resolve(confirm(movement.id,'99'))
 let bothWaiting=false
 try{for(let i=0;i<100;i++){const r=await db.$queryRaw`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))) SELECT count(*)::int AS n FROM blocked`;if(r[0].n>=2){bothWaiting=true;break}await new Promise(r=>setTimeout(r,20))}}finally{unlock();await blocker}
 const [a,b]=await Promise.all([left,right]);console.log('concurrent snapshots',bothWaiting,'statuses',a.statusCode,b.statusCode);expect(bothWaiting,'both snapshots must start before releasing source lock').toBe(true);expect([a.statusCode,b.statusCode].sort(),a.body+' / '+b.body).toEqual([201,409]);expect(await db.warehouseNetCostBasisConfirmation.count({where:{tenantId,movementId:movement.id}})).toBe(1)
})

it('honors business-date backfills without taking a future-effective cumulative snapshot as an earlier closing balance',async()=>{
 const future=await inbound(113,10,'2026-11-10Z');expect((await confirm(future.movement.id)).statusCode).toBe(201)
 await recordBatchManualWarehouseOutbound({tenantId,warehouseId,userId:actorId,items:[{productId,inventoryQuantity:5}],effectiveAt:new Date('2026-10-15Z'),idempotencyKey:randomUUID(),reason:'历史日期补录'})
 const october=(await report('summary')).json();expect(october.rows[0]).toMatchObject({openingAmount:0,inAmount:0,outAmount:50,closingAmount:-50})
 const current=(await report('realtime')).json();expect(current.rows[0].amount).toBe(50)
})

it('rejects removed tax-rate confirmation through the API without writing evidence',async()=>{
 const first=await inbound();
 for(const rate of ['0.13','0','1.13','-0.13','NaN']){const response=await confirm(first.movement.id,undefined as any,{basisType:'TAX_RATE',netValueDelta:undefined,taxRate:rate});expect(response.statusCode,response.body).toBe(400)}
 expect(await db.warehouseNetCostBasisConfirmation.count({where:{tenantId,movementId:first.movement.id}})).toBe(0)
})
it('keeps unknown pre-pool history while reports and exports use the confirmed current pool onward',async()=>{
 const original=await db.$transaction(async(tx:any)=>{const balance=await tx.warehouseLedgerBalance.create({data:{tenantId,warehouseId,productId,inventoryUnit:'kg'}});const m=await tx.warehouseLedgerMovement.create({data:{tenantId,warehouseId,productId,type:'MANUAL_INBOUND',physicalDelta:10,reservedDelta:0,valueDelta:0,physicalAfter:10,reservedAfter:0,valueAfter:0,averageUnitCostAfter:0,originalQuantity:10,originalUnit:'kg',conversionFactor:1,inventoryQuantity:10,inventoryUnit:'kg',inventoryUnitCost:0,sourceType:'HistoricalManual',sourceId:'OLD',sourceLineId:'old',idempotencyKey:randomUUID(),effectiveAt:new Date('2026-01-01Z')}});await tx.warehouseLedgerBalance.update({where:{id:balance.id},data:{physicalQty:10}});return m})
 const adjusted=await adjustWarehouseMovementValue({tenantId,warehouseId,userId:actorId,movementId:original.id,newAmount:113,reason:'依据原材料核定成本',idempotencyKey:randomUUID(),docId:'LOCAL-OLD',docNo:'OLD-1'});const anchor=adjusted.movement!
 const context=await app.inject({url:`/api/inventory-reports/cost-basis/${anchor.id}`,headers:headers()});expect(context.statusCode,context.body).toBe(200)
 const payload={requestKey:randomUUID(),expectedVersion:0,basisType:'POOL_DOCUMENT',netValueDelta:undefined,poolNetValueAfter:'100',expectedPostingSequence:context.json().expectedPostingSequence}
 const saved=await confirm(anchor.id,undefined as any,payload);expect(saved.statusCode,saved.body).toBe(201)
 await recordBatchManualWarehouseOutbound({tenantId,warehouseId,userId:actorId,items:[{productId,inventoryQuantity:5}],effectiveAt:new Date('2026-10-28Z'),idempotencyKey:randomUUID(),reason:'日常领用'})
 const current=(await report('realtime')).json();expect(current.rows[0]).toMatchObject({qty:5,amount:50,price:10,costStatus:'KNOWN'})
 const january=(await app.inject({url:`/api/inventory-reports/summary?start=2026-01-01&end=2026-01-31&warehouseId=${warehouseId}`,headers:headers()})).json();expect(january.rows[0].closingAmount).toBeNull()
 const oldExport=await app.inject({url:`/api/inventory-reports/summary?start=2026-01-01&end=2026-01-31&warehouseId=${warehouseId}&export=1`,headers:headers()});expect(oldExport.statusCode,oldExport.body).toBe(200);const oldSheet=await excel(oldExport.json());expect(oldSheet.getRow(2).getCell(january.columns.findIndex((c:any)=>c.key==='closingAmount')+1).value).toBe('待核算')
 const details=(await report('movements')).json();expect(details.rows.find((r:any)=>r.id===anchor.id).inAmount).toBeNull()
 const october=(await report('summary')).json();expect(october.rows[0].openingAmount).toBeNull();expect(october.rows[0].closingAmount).toBe(50)
 const exported=await excel((await report('summary','&export=1')).json());const closing=october.columns.findIndex((c:any)=>c.key==='closingAmount')+1;expect(exported.getRow(2).getCell(closing).value).toBe(50)
 const replay=await confirm(anchor.id,undefined as any,payload);expect(replay.statusCode,replay.body).toBe(200)
 const stale=await confirm(anchor.id,undefined as any,{...payload,requestKey:randomUUID(),expectedVersion:1});expect(stale.statusCode,stale.body).toBe(409)
})

it('keeps contract settlement and documented cost separate when income tax basis is unavailable',async()=>{
 const initial=await inbound();expect((await confirm(initial.movement.id)).statusCode).toBe(201)
 const store=await db.store.create({data:{tenantId,no:'D',name:'门店'}})
 const po=await db.purchaseOrder.create({data:{tenantId,no:'PO-NET',storeId:store.id,supplierId,expectedDate:new Date('2026-10-15Z'),totalAmount:150,createdById:actorId,status:'DELIVERING'}})
 const line=await db.purchaseOrderItem.create({data:{purchaseOrderId:po.id,productId,quantity:10,unitPrice:15,amount:150}})
 const delivery=await db.deliveryOrder.create({data:{tenantId,no:'DO-NET',storeId:store.id,supplierId,warehouseId,purchaseOrderId:po.id,status:'SHIPPED',createdById:actorId,actualTotalAmount:150}})
 await db.deliveryOrderItem.create({data:{deliveryOrderId:delivery.id,purchaseOrderItemId:line.id,productId,orderedQtySnapshot:10,shippedQty:10,unitPriceSnapshot:15,amount:150}})
 const sent=await recordBatchManualWarehouseOutbound({tenantId,warehouseId,userId:actorId,items:[{productId,inventoryQuantity:10}],effectiveAt:new Date('2026-10-15Z'),idempotencyKey:randomUUID(),reason:'配送发货'})
 const original=await db.warehouseLedgerMovement.update({where:{id:sent.movements[0].id},data:{sourceType:'DeliveryOrder',sourceId:delivery.id,sourceLineId:line.id}})
 const reversed=await db.$transaction((tx:any)=>reverseDeliveryOutboundInTransaction(tx,{tenantId,userId:actorId,source:'ReceiptRejection',sourceId:'partial-return',originalMovementId:original.id,quantity:new Prisma.Decimal(2),reason:'完好退回'}))
 const result=(await report('movements')).json(),row=result.rows.find((r:any)=>r.id===original.id),back=result.rows.find((r:any)=>r.id===reversed.movementId)
 expect(row).toMatchObject({outAmount:100,outPrice:10,outSettlementAmount:150,outSettlementPrice:15,outProfit:null,profitStatus:'PENDING_TAX_BASIS'})
 expect(back).toMatchObject({inAmount:20,inPrice:10,outSettlementAmount:-30,outSettlementPrice:15,outProfit:null,profitStatus:'PENDING_TAX_BASIS'})
 expect(result.note).toContain('原')
 expect(result.note).toContain('利润待核算')
 const sheet=await excel((await report('movements','&export=1')).json()),cols=result.columns
 const profit=cols.findIndex((c:any)=>c.key==='outProfit')+1,cost=cols.findIndex((c:any)=>c.key==='outAmount')+1,settlement=cols.findIndex((c:any)=>c.key==='outSettlementAmount')+1
 let exportRow:any
 for(let n=2;n<=sheet.rowCount;n++)if(sheet.getRow(n).getCell(settlement).value===150)exportRow=sheet.getRow(n)
 expect(exportRow).toBeDefined();expect(exportRow.getCell(cost).value).toBe(100);expect(exportRow.getCell(profit).value).toBe('待核算')
 const final=await db.$transaction((tx:any)=>reverseDeliveryOutboundInTransaction(tx,{tenantId,userId:actorId,source:'ReceiptRejection',sourceId:'final-return',originalMovementId:original.id,quantity:new Prisma.Decimal(8),reason:'剩余完好退回'}))
 const finalRows=(await report('movements')).json().rows
 expect(finalRows.find((r:any)=>r.id===final.movementId)).toMatchObject({inAmount:80,inPrice:10,outSettlementAmount:-120,outProfit:null,profitStatus:'PENDING_TAX_BASIS'})
 expect((await report('realtime')).json().rows[0]).toMatchObject({qty:10,amount:100,price:10,costStatus:'KNOWN'})
 await expect(db.$transaction((tx:any)=>reverseDeliveryOutboundInTransaction(tx,{tenantId,userId:actorId,source:'ReceiptRejection',sourceId:'extra-return',originalMovementId:original.id,quantity:new Prisma.Decimal(1),reason:'超额退回'}))).rejects.toThrow('累计冲回将超过原出库量')
})

it('shares signed documented net costs with other-summary and exports, leaving quantity-only alerts and stagnation unchanged',async()=>{
 const a=await inbound(),b=await inbound(106)
 for(const m of[a.movement,b.movement])expect((await confirm(m.id)).statusCode).toBe(201)
 await recordBatchManualWarehouseOutbound({tenantId,warehouseId,userId:actorId,items:[{productId,inventoryQuantity:5}],effectiveAt:new Date('2026-10-15Z'),idempotencyKey:randomUUID(),reason:'日常领用'})
 const known=(await report('other-summary')).json()
 expect(known.rows.find((r:any)=>r.type==='手工入库')).toMatchObject({quantity:20,amount:200,costStatus:'KNOWN'})
 expect(known.rows.find((r:any)=>r.type==='出库')).toMatchObject({quantity:-5,amount:-50,costStatus:'KNOWN'})
 const knownSheet=await excel((await report('other-summary','&export=1')).json()),amountCol=known.columns.findIndex((c:any)=>c.key==='amount')+1
 const amounts=[];for(let i=2;i<=knownSheet.rowCount;i++)amounts.push(knownSheet.getRow(i).getCell(amountCol).value)
 expect(amounts.sort((a:any,b:any)=>a-b)).toEqual([-50,200])
 expect((await report('alerts')).json().rows[0]).toMatchObject({qty:15,minQty:null,maxQty:null,alertStatus:'阈值未配置'})
 expect((await report('stagnant')).json().rows[0]).toMatchObject({qty:15,lastInQty:10,lastOutQty:5})
 await inbound(113)
 const pending=(await report('other-summary')).json()
 expect(pending.rows.find((r:any)=>r.type==='手工入库')).toMatchObject({quantity:30,amount:null,costStatus:'PENDING_COST'})
 expect(pending.rows.find((r:any)=>r.type==='出库')).toMatchObject({quantity:-5,amount:-50,costStatus:'KNOWN'})
 const pendingSheet=await excel((await report('other-summary','&export=1')).json()),pendingAmounts=[]
 for(let i=2;i<=pendingSheet.rowCount;i++)pendingAmounts.push(pendingSheet.getRow(i).getCell(amountCol).value)
 expect(pendingAmounts).toContain('待核算');expect(pendingAmounts).toContain(-50)
 expect((await report('alerts')).json().rows[0].qty).toBe(25)
 expect((await report('stagnant')).json().rows[0].qty).toBe(25)
})

it('closes fractional net cost to zero after full depletion and exports blank unit prices',async()=>{
 const initial=await inbound(1.13,3)
 const saved=await confirm(initial.movement.id,'1');expect(saved.statusCode,saved.body).toBe(201)
 const ids:string[]=[]
 for(let n=0;n<3;n++){
  const sent=await recordBatchManualWarehouseOutbound({tenantId,warehouseId,userId:actorId,items:[{productId,inventoryQuantity:1}],effectiveAt:new Date(`2026-10-${15+n}Z`),idempotencyKey:randomUUID(),reason:'零结余尾差验收'})
  ids.push(sent.movements[0].id)
 }
 const real=(await report('realtime')).json()
 expect(real.rows[0]).toMatchObject({qty:0,amount:0,netAmount:0,price:null,netPrice:null,costStatus:'KNOWN'})
 const summary=(await report('summary')).json()
 expect(summary.rows[0]).toMatchObject({inQty:3,inAmount:1,outQty:3,outAmount:1,closingQty:0,closingAmount:0,closingPrice:null})
 const detail=(await report('movements')).json()
 const amounts=ids.map(id=>detail.rows.find((r:any)=>r.id===id).outAmount)
 expect(amounts.reduce((a:number,b:number)=>a+b,0)).toBeCloseTo(1,4)
 expect(amounts[2]).toBeCloseTo(1-amounts[0]-amounts[1],4)
 for(const[kind,data,qty,money,price]of[['realtime',real,'qty','amount','price'],['summary',summary,'closingQty','closingAmount','closingPrice']]as const){
  const response=await report(kind,'&export=1');expect(response.statusCode,response.body).toBe(200)
  const sheet=await excel(response.json())
  const value=(key:string)=>sheet.getRow(2).getCell(data.columns.findIndex((c:any)=>c.key===key)+1).value
  expect(value(qty)).toBe(0);expect(value(money)).toBe(0);expect(value(price)).toBeNull()
 }
})

it('keeps historical zero-quantity residual value pending in realtime API and XLSX',async()=>{
 // Explicit historical inconsistency fixture, not an outcome produced by normal outbound posting.
 await db.warehouseLedgerBalance.create({data:{tenantId,warehouseId,productId,inventoryUnit:'kg',physicalQty:0,inventoryValue:1}})
 const response=await report('realtime');expect(response.statusCode,response.body).toBe(200)
 const data=response.json()
 expect(data.rows[0]).toMatchObject({qty:0,amount:null,netAmount:null,price:null,netPrice:null,costStatus:'PENDING_COST'})
 const exported=await report('realtime','&export=1');expect(exported.statusCode,exported.body).toBe(200)
 const sheet=await excel(exported.json())
 const value=(key:string)=>sheet.getRow(2).getCell(data.columns.findIndex((c:any)=>c.key===key)+1).value
 expect(value('qty')).toBe(0);expect(value('amount')).toBe('待核算');expect(value('price')).toBe('待核算')
})

it.each([true,false])('keeps frozen procurement amount/unit basis through receipt posting, supplier return and outbound (taxInclusive=%s)',async(taxInclusive)=>{
 await db.product.update({where:{id:productId},data:{purchaseUnit:'箱',inventoryUnitsPerPurchaseUnit:5}})
 const sources:any[]=[]
 for(const [index,rate]of[0.13,0.06].entries()){
  const amount=taxInclusive?100*(1+rate):100
  const order=await db.upstreamPurchaseOrder.create({data:{tenantId,no:`PO-TAX-${index}`,supplierId,warehouseId,status:'RECEIVED',taxInclusive,createdById:actorId,lines:{create:{lineNo:1,productId,productCodeSnapshot:'P',productNameSnapshot:'商品',purchaseUnit:'箱',inventoryUnit:'kg',inventoryUnitsPerPurchaseUnit:5,orderedQty:2,confirmedQty:2,receivedQty:2,unitPrice:amount/2,taxRate:rate,amountWithoutTax:100,taxAmount:100*rate,totalAmount:100*(1+rate)}}},include:{lines:true}})
  const receipt=await db.upstreamReceipt.create({data:{tenantId,no:`RC-TAX-${index}`,purchaseOrderId:order.id,supplierId,warehouseId,status:'POSTED',postedAt:new Date('2026-10-10Z'),createdById:actorId,payableAmount:amount,lines:{create:{purchaseOrderLineId:order.lines[0].id,productId,orderedQty:2,arrivedQty:2,acceptedQty:2,purchaseUnit:'箱',inventoryUnit:'kg',inventoryUnitsPerPurchaseUnit:5,inventoryAcceptedQty:10,unitPrice:amount/2,payableAmount:amount}}},include:{lines:true}})
  const input={tenantId,warehouseId,supplierId,supplierName:'供应商',receiptId:receipt.id,receiptNo:receipt.no,userId:actorId,effectiveAt:new Date('2026-10-10Z'),lines:[{receiptLineId:receipt.lines[0].id,productId,productName:'商品',purchaseQuantity:2,purchaseUnit:'箱',conversionFactor:5,inventoryQuantity:10,inventoryUnit:'kg',totalAmount:amount}]}
  const posted=await db.$transaction((tx:any)=>postUpstreamReceiptInTransaction(tx,input))
  expect((await db.$transaction((tx:any)=>postUpstreamReceiptInTransaction(tx,input))).replayed).toBe(true)
  sources.push({order,receipt,movement:posted.movements[0]})
 }
 expect((await report('realtime')).json().rows[0]).toMatchObject({qty:20,amount:200,price:10,costStatus:'KNOWN'})
 const details=(await report('movements')).json()
 for(const source of sources)expect(details.rows.find((r:any)=>r.id===source.movement.id)).toMatchObject({doc:source.receipt.no,upstream:source.order.no,inQty:2,inBaseQty:10,inAmount:100,inPrice:50})
 // Later catalog changes must not rewrite source receipt conversion or its frozen contract basis.
 await db.product.update({where:{id:productId},data:{inventoryUnitsPerPurchaseUnit:7}})
 const created=await createUpstreamPurchaseReturn({tenantId,userId:actorId,supplierId,warehouseId,reason:'采购成本链路验收',idempotencyKey:randomUUID(),lines:[{receiptLineId:sources[0].receipt.lines[0].id,purchaseQuantity:0.5}]})
 expect(created.purchaseReturn.lines[0].inventoryQuantity.toNumber()).toBe(2.5)
 expect(created.purchaseReturn.settlementAmount.toNumber()).toBeCloseTo(taxInclusive?28.25:25,4)
 await submitUpstreamPurchaseReturn(tenantId,created.purchaseReturn.id,actorId)
 expect((await report('realtime')).json().rows[0]).toMatchObject({qty:20,amount:200})
 await approveUpstreamPurchaseReturn(tenantId,created.purchaseReturn.id,actorId)
 expect((await approveUpstreamPurchaseReturn(tenantId,created.purchaseReturn.id,actorId)).replayed).toBe(true)
 expect((await report('realtime')).json().rows[0]).toMatchObject({qty:17.5,amount:175,price:10})
 await receiveUpstreamPurchaseReturn(tenantId,created.purchaseReturn.id,actorId,'验收签收')
 expect((await report('realtime')).json().rows[0]).toMatchObject({qty:17.5,amount:175,price:10})
 const movement=await db.warehouseLedgerMovement.findFirstOrThrow({where:{tenantId,sourceType:'UpstreamPurchaseReturn',sourceId:created.purchaseReturn.id}})
 const returned=(await report('movements')).json()
 expect(returned.rows.find((r:any)=>r.id===movement.id)).toMatchObject({doc:created.purchaseReturn.no,upstream:sources[0].receipt.no,upstreamType:'上游收货单',type:'采购退货',reason:'采购退货',outQty:0.5,outBaseQty:2.5,outAmount:25,outPrice:50})
 const movementSheet=await excel((await report('movements','&export=1')).json())
 const outCol=returned.columns.findIndex((c:any)=>c.key==='outAmount')+1,qtyCol=returned.columns.findIndex((c:any)=>c.key==='outQty')+1,priceCol=returned.columns.findIndex((c:any)=>c.key==='outPrice')+1
 const returnRows=[];for(let row=2;row<=movementSheet.rowCount;row++)if(movementSheet.getRow(row).getCell(outCol).value===25)returnRows.push(movementSheet.getRow(row))
 expect(returnRows).toHaveLength(1);expect(returnRows[0].getCell(qtyCol).value).toBe(0.5);expect(returnRows[0].getCell(priceCol).value).toBe(50)
 for(const[key,value]of[['doc',created.purchaseReturn.no],['upstream',sources[0].receipt.no],['upstreamType','上游收货单']])expect(returnRows[0].getCell(returned.columns.findIndex((c:any)=>c.key===key)+1).value).toBe(value)
 await recordBatchManualWarehouseOutbound({tenantId,warehouseId,userId:actorId,items:[{productId,inventoryQuantity:2.5}],effectiveAt:new Date(),idempotencyKey:randomUUID(),reason:'日常领用'})
 const real=(await report('realtime')).json(),summary=(await report('summary')).json()
 expect(real.rows[0]).toMatchObject({qty:15,amount:150,price:10,costStatus:'KNOWN'})
 expect(summary.rows[0]).toMatchObject({inQty:20,inAmount:200,outQty:5,outAmount:50,closingQty:15,closingAmount:150})
 for(const[kind,data,field]of[['realtime',real,'amount'],['summary',summary,'closingAmount']]as const){const exported=await report(kind,'&export=1');expect(exported.statusCode,exported.body).toBe(200);const sheet=await excel(exported.json());expect(sheet.getRow(2).getCell(data.columns.findIndex((c:any)=>c.key===field)+1).value).toBe(150)}
 expect(await db.warehouseNetCostBasisConfirmation.count({where:{tenantId}})).toBe(0)
 expect(await db.warehouseLedgerMovement.count({where:{tenantId,sourceId:created.purchaseReturn.id}})).toBe(1)
})

it.each([[124.3,'10',210,110],[101.7,'-10',190,90]])('reverses the current documented net value of a price-adjusted inbound while preserving other stock (%s)',async(newAmount,netDiff,total,removed)=>{
 const first=await inbound(),other=await inbound()
 for(const m of[first.movement,other.movement])expect((await confirm(m.id)).statusCode).toBe(201)
 const adjusted=await adjustWarehouseMovementValue({tenantId,warehouseId,userId:actorId,movementId:first.movement.id,newAmount,reason:'补充原单价税金额',idempotencyKey:randomUUID(),docId:'ADJUSTED-INBOUND',docNo:'IN-ADJUST'})
 expect(adjusted.movement!.physicalDelta.toNumber()).toBe(0)
 expect((await confirm(adjusted.movement!.id,netDiff as string)).statusCode).toBe(201)
 expect((await report('realtime')).json().rows[0]).toMatchObject({qty:20,amount:total,price:Number(total)/20})
 const input={tenantId,warehouseId,userId:actorId,movementId:first.movement.id,reason:'整笔冲销已调价入库',idempotencyKey:randomUUID()}
 const reversed=await reverseManualWarehouseInbound(input)
 expect(reversed.movement.valueDelta.toNumber()).toBe(-Number(newAmount))
 expect((await reverseManualWarehouseInbound(input)).replayed).toBe(true)
 const real=(await report('realtime')).json()
 expect(real.rows[0]).toMatchObject({qty:10,amount:100,price:10,costStatus:'KNOWN'})
 const detail=(await report('movements')).json()
 expect(detail.rows.find((r:any)=>r.id===reversed.movement.id)).toMatchObject({outQty:10,outAmount:removed,outPrice:Number(removed)/10})
 const summary=(await report('summary')).json()
 expect(summary.rows[0]).toMatchObject({inQty:20,outQty:10,closingQty:10,closingAmount:100})
 const sheet=await excel((await report('summary','&export=1')).json())
 expect(sheet.getRow(2).getCell(summary.columns.findIndex((c:any)=>c.key==='closingAmount')+1).value).toBe(100)
})
