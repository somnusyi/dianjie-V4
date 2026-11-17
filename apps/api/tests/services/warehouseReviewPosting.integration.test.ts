import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,expect,it} from 'vitest'
import {prisma} from '@dianjie/db'
import {createReviewInbound,createReviewOutbound} from '../../src/services/warehouseReviewPosting'
import {recordBatchManualWarehouseInbound,serializableWithRetry} from '../../src/services/warehouseLedger'
import {confirmWarehouseDoc,reviewWarehouseDoc,ensureWarehouseDocInTransaction,unconfirmWarehouseDoc,unreviewWarehouseDoc,editWarehouseDoc} from '../../src/services/warehouseDocs'
import {createWarehouseStocktake,getWarehouseStocktake,saveWarehouseStocktakeSection,submitWarehouseStocktake,approveWarehouseStocktake,reviewWarehouseStocktake} from '../../src/services/warehouseStocktake'
let tenantId:string,userId:string,warehouseId:string,supplierId:string,productId:string
beforeAll(async()=>{
 const key=randomUUID();tenantId=(await prisma.tenant.create({data:{slug:`review-gate-${key}`,name:'仓库流程验证'}})).id
 const warehouse=await prisma.warehouse.findFirst({where:{tenantId,isDefault:true}});warehouseId=warehouse!.id;await prisma.warehouse.update({where:{id:warehouseId},data:{inventoryMode:'STRICT'}})
 userId=(await prisma.user.create({data:{tenantId,email:`${key}@local.invalid`,name:'供应链',role:'SUPPLY_CHAIN',password:'disabled-local-fixture'}})).id
 supplierId=(await prisma.supplier.create({data:{tenantId,no:'A01',name:'山野食材',businessScopes:['WAREHOUSE_UPSTREAM'],status:'ENABLED'}})).id
 productId=(await prisma.product.create({data:{tenantId,code:'X01',name:'香菇',unit:'袋',purchaseUnit:'箱',inventoryUnit:'袋',orderUnit:'箱',costUnit:'袋',inventoryUnitsPerPurchaseUnit:3,inventoryUnitsPerOrderUnit:3,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED',price:10}})).id
})
afterAll(()=>prisma.$disconnect())
const common=()=>({tenantId,userId,warehouseId,effectiveAt:new Date('2026-11-03T03:00:00Z')})
const balance=()=>prisma.warehouseLedgerBalance.findFirst({where:{tenantId,warehouseId,productId}})
async function ledger(){return JSON.stringify({balance:await balance(),movements:await prisma.warehouseLedgerMovement.findMany({where:{tenantId,productId},orderBy:{id:'asc'}}),lots:await prisma.warehouseLedgerLot.findMany({where:{tenantId,productId},orderBy:{id:'asc'}})})}
it('submission and audit do not post; concurrent review posts exactly once and review is terminal',async()=>{
 const key=randomUUID(),input={...common(),supplierId,idempotencyKey:key,documentKey:`inbound-draft:${key}`,items:[{productId,purchaseQuantity:10,totalAmount:300}]}
 const before=await ledger(),first=await serializableWithRetry(tx=>createReviewInbound(tx,input));const docId=first.doc.id
 expect(await ledger()).toBe(before)
 expect((await serializableWithRetry(tx=>createReviewInbound(tx,input))).created).toBe(false)
 await expect(serializableWithRetry(tx=>createReviewInbound(tx,{...input,items:[{productId,purchaseQuantity:11,totalAmount:300}]}))).rejects.toThrow('不同单据内容')
 await expect(reviewWarehouseDoc({tenantId,userId,docId})).rejects.toThrow('先完成')
 await confirmWarehouseDoc({tenantId,userId,docId});expect(await ledger()).toBe(before)
 const reviewed=await Promise.all([reviewWarehouseDoc({tenantId,userId,docId}),reviewWarehouseDoc({tenantId,userId,docId})])
 expect(reviewed.filter(value=>value.changed)).toHaveLength(1)
 expect((await balance())!.physicalQty.toString()).toBe('30')
 expect((await balance())!.inventoryValue.toString()).toBe('300')
 expect(await prisma.warehouseLedgerMovement.count({where:{tenantId,productId}})).toBe(1)
 await expect(unconfirmWarehouseDoc({tenantId,userId,docId,reason:'核对单据'})).rejects.toThrow('流程已结束')
 await expect(unreviewWarehouseDoc({tenantId,userId,docId})).rejects.toThrow('不支持取消复审')
})
it('an unposted document can be edited without stock adjustments, then reviewed using edited amounts',async()=>{
 const key=randomUUID();const result=await serializableWithRetry(tx=>createReviewInbound(tx,{...common(),supplierId,idempotencyKey:key,documentKey:`inbound-draft:${key}`,items:[{productId,purchaseQuantity:2,totalAmount:60,batchNo:'LOT-A'}]}))
 const before=await ledger();await editWarehouseDoc({tenantId,userId,docId:result.doc.id,editReason:'核对数量金额',lines:[{lineId:result.doc.lines[0].id,quantity:3,amount:90}]});expect(await ledger()).toBe(before)
 await confirmWarehouseDoc({tenantId,userId,docId:result.doc.id});expect(await ledger()).toBe(before)
 await reviewWarehouseDoc({tenantId,userId,docId:result.doc.id});expect((await balance())!.physicalQty.toString()).toBe('39')
})
it('self loss and manual outbound wait for review; insufficient stock leaves review and ledger unchanged',async()=>{
 for(const businessType of ['SELF_LOSS','GENERIC'] as const){
  const key=randomUUID(),doc=(await serializableWithRetry(tx=>createReviewOutbound(tx,{...common(),idempotencyKey:key,documentKey:`${businessType==='SELF_LOSS'?'self-loss':'manual-outbound'}:${key}`,businessType,reason:'日常损耗核对',items:[{productId,inventoryQuantity:2}]}))).doc
  const before=await ledger();await confirmWarehouseDoc({tenantId,userId,docId:doc.id});expect(await ledger()).toBe(before)
  await reviewWarehouseDoc({tenantId,userId,docId:doc.id});expect((await balance())!.inventoryValue.toNumber()).toBe((await balance())!.physicalQty.toNumber()*10)
 }
 const key=randomUUID(),doc=(await serializableWithRetry(tx=>createReviewOutbound(tx,{...common(),idempotencyKey:key,documentKey:`manual-outbound:${key}`,reason:'调出核对',items:[{productId,inventoryQuantity:999}]}))).doc
 await confirmWarehouseDoc({tenantId,userId,docId:doc.id});const before=await ledger()
 await expect(reviewWarehouseDoc({tenantId,userId,docId:doc.id})).rejects.toThrow()
 expect(await ledger()).toBe(before);expect((await prisma.warehouseDoc.findUniqueOrThrow({where:{id:doc.id}})).reviewStatus).toBe('UNREVIEWED')
})
it('stocktake audit changes status only; final review adjusts stock once',async()=>{
 const current=await balance();const created=await createWarehouseStocktake({tenantId,userId,warehouseId,countDate:'2026-11-03',requestKey:randomUUID(),sections:[{name:'总仓',assignedToId:userId,productIds:[productId]}]})
 let count=await getWarehouseStocktake(tenantId,created.stocktake.id);const section=count.sections[0]
 await saveWarehouseStocktakeSection({tenantId,userId,stocktakeId:count.id,sectionId:section.id,rowVersion:section.rowVersion,submit:true,items:[{itemId:section.items[0].id,countedQuantity:current!.physicalQty.minus(1).toString(),reason:'复核差异'}]})
 count=await getWarehouseStocktake(tenantId,count.id);await submitWarehouseStocktake({tenantId,userId,id:count.id,rowVersion:count.rowVersion});const before=await ledger()
 await approveWarehouseStocktake({tenantId,userId,id:count.id});expect(await ledger()).toBe(before)
 expect(await prisma.warehouseStocktakeAdjustment.count({where:{stocktakeId:count.id}})).toBe(0)
 await reviewWarehouseStocktake({tenantId,userId,id:count.id});expect((await balance())!.physicalQty.toString()).toBe(current!.physicalQty.minus(1).toString())
 const after=await ledger();expect((await reviewWarehouseStocktake({tenantId,userId,id:count.id})).replayed).toBe(true);expect(await ledger()).toBe(after)
})

it('reviewing a historical already-posted document never posts it again',async()=>{
 const key=randomUUID()
 const doc=await serializableWithRetry(async tx=>{
  const result=await recordBatchManualWarehouseInbound({...common(),supplierId,idempotencyKey:key,items:[{productId,purchaseQuantity:1,totalAmount:30}]},tx)
  return (await ensureWarehouseDocInTransaction(tx,{...common(),supplierId,supplierName:'山野食材',type:'MANUAL_INBOUND',idempotencyKey:`legacy:${key}`,lines:[{productId,productName:'香菇',quantity:1,unit:'箱',unitPrice:30,amount:30,inventoryQuantity:3,inventoryUnit:'袋',movementId:result.movements[0].id}]})).doc
 })
 expect(doc.postingPolicy).toBe('LEGACY')
 const before=await ledger();await confirmWarehouseDoc({tenantId,userId,docId:doc.id});await reviewWarehouseDoc({tenantId,userId,docId:doc.id})
 expect(await ledger()).toBe(before)
})
