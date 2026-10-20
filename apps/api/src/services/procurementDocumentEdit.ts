import { receiptPricing } from '../domain/procurementAmounts'
import {Prisma} from '@dianjie/db'
import {z} from 'zod'
import {changeProcurementApproval,type ProcurementSourceKind} from './procurementApproval'
import {validatePurchaseReturnEditInTransaction} from './upstreamPurchaseReturns'
const number=z.number().finite().min(0).max(999999999)
const date=z.string().date().nullable().optional()
const line=z.object({id:z.string().min(1).max(64),quantity:number,unitPrice:number.optional(),payableAmount:z.union([number,z.string().regex(/^\d+(?:\.\d{1,4})?$/)]).optional(),arrivedQty:number.optional(),damagedQty:number.optional(),rejectedQty:number.optional(),batchNo:z.string().trim().max(80).nullable().optional(),manufactureDate:date,expiryDate:date,note:z.string().trim().max(500).nullable().optional()}).strict()
export const procurementEditBodySchema=z.object({approvalVersion:z.number().int().min(1),sourceVersion:z.number().int().min(0),requestId:z.string().min(8).max(100),note:z.string().trim().max(500).nullable().optional(),lines:z.array(line).min(1).max(500)}).strict()
const fail=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode})
const d=(value:any)=>new Prisma.Decimal(value||0)
function snapshot(row:any,kind:ProcurementSourceKind){return{note:row.note,lines:[...row.lines].sort((a:any,b:any)=>a.id.localeCompare(b.id)).map((value:any)=>kind==='RECEIPT'?{id:value.id,arrivedQty:value.arrivedQty,acceptedQty:value.acceptedQty,damagedQty:value.damagedQty,rejectedQty:value.rejectedQty,shortageQty:value.shortageQty,overageQty:value.overageQty,unitPrice:value.unitPrice,payableAmount:value.payableAmount,inventoryAcceptedQty:value.inventoryAcceptedQty,batchNo:value.batchNo,manufactureDate:value.manufactureDate,expiryDate:value.expiryDate,note:value.note}:{id:value.id,purchaseQuantity:value.purchaseQuantity,settlementUnitPrice:value.settlementUnitPrice,settlementAmount:value.settlementAmount,inventoryQuantity:value.inventoryQuantity,note:value.note})}}
export async function saveProcurementDocument(input:{tenantId:string;userId:string;kind:ProcurementSourceKind;sourceId:string;body:unknown}){
 const parsed=procurementEditBodySchema.safeParse(input.body)
 if(!parsed.success)throw fail(parsed.error.issues[0]?.message||'编辑字段不正确',400)
 const body=parsed.data
 if(body.note!==undefined)body.note=body.note||null
 body.lines=body.lines.map(row=>({...row,...(row.note!==undefined?{note:row.note||null}:{})}))
 if(new Set(body.lines.map(row=>row.id)).size!==body.lines.length)throw fail('商品行不能重复',400)
 return changeProcurementApproval({tenantId:input.tenantId,userId:input.userId,kind:input.kind,sourceId:input.sourceId,action:'save',approvalVersion:body.approvalVersion,sourceVersion:body.sourceVersion,requestId:body.requestId,editData:body}, {save:async(tx,source)=>{
   if(body.lines.length!==source.lines.length||body.lines.some(edit=>!source.lines.some((row:any)=>row.id===edit.id)))throw fail('只能修改本单原有商品行，不能更换来源或删减行',400)
   if(source.lines.some((row:any)=>row.ledgerMovementId))throw fail('商品已存在过账事实，不允许直接修改业务字段')
   if(source.lines.some((row:any)=>!d(row.inventoryUnitsPerPurchaseUnit).gt(0)))throw fail('单据缺少可靠单位换算，请先核对原单')
   const before=snapshot(source,input.kind)
   if(input.kind==='RETURN'){
     for(const edit of body.lines){
       const current=source.lines.find((row:any)=>row.id===edit.id)!
       if(edit.quantity<=0)throw fail('退货数量必须大于0',400)
       if((edit.note?.length||0)>240)throw fail('退货行备注最多240字',400)
       if(edit.unitPrice!==undefined&& !d(edit.unitPrice).eq(current.settlementUnitPrice))throw fail('退货单价沿用原收货结算价，不能修改',400)
       if(['payableAmount','arrivedQty','damagedQty','rejectedQty','batchNo','manufactureDate','expiryDate'].some(key=>(edit as any)[key]!==undefined))throw fail('退货单不支持修改收货或批次字段',400)
       const quantity=d(edit.quantity).toDecimalPlaces(6)
       if(!quantity.gt(0))throw fail('退货数量至少为0.000001',400)
       if(!quantity.times(current.inventoryUnitsPerPurchaseUnit).toDecimalPlaces(6).gt(0))throw fail('退货换算后的库存数量小于最小精度，请核对数量和换算',400)
       await tx.upstreamPurchaseReturnLine.update({where:{id:edit.id},data:{purchaseQuantity:quantity,inventoryQuantity:quantity.times(current.inventoryUnitsPerPurchaseUnit).toDecimalPlaces(6),settlementAmount:quantity.times(current.settlementUnitPrice).toDecimalPlaces(4),...(edit.note!==undefined?{note:edit.note}:{})}})
     }
     await validatePurchaseReturnEditInTransaction(tx,input.tenantId,source.id)
     const rows=await tx.upstreamPurchaseReturnLine.findMany({where:{tenantId:input.tenantId,returnId:source.id}})
     await tx.upstreamPurchaseReturn.update({where:{id:source.id},data:{settlementAmount:rows.reduce((sum,row)=>sum.plus(row.settlementAmount),d(0)),rowVersion:{increment:1},...(body.note!==undefined?{note:body.note}:{})}})
     const after=await tx.upstreamPurchaseReturn.findUniqueOrThrow({where:{id:source.id},include:{lines:true}})
     return {before,after:snapshot(after,input.kind)}
   }
   const orderLines=await tx.upstreamPurchaseOrderLine.findMany({where:{tenantId:input.tenantId,purchaseOrderId:source.purchaseOrderId}})
   const otherLines=await tx.upstreamReceiptLine.findMany({where:{tenantId:input.tenantId,receiptId:{not:source.id},purchaseOrderLineId:{in:source.lines.map((row:any)=>row.purchaseOrderLineId)},receipt:{status:{not:'REVERSED'}}},include:{receipt:{select:{status:true}}}})
   for(const edit of body.lines){
     const current=source.lines.find((row:any)=>row.id===edit.id)!,order=orderLines.find(row=>row.id===current.purchaseOrderLineId)
     if(!order)throw fail('原采购商品来源不存在')
     const quantity=d(edit.quantity).toDecimalPlaces(6),arrived=d(edit.arrivedQty??current.arrivedQty).toDecimalPlaces(6),damaged=d(edit.damagedQty??current.damagedQty).toDecimalPlaces(6),rejected=d(edit.rejectedQty??current.rejectedQty).toDecimalPlaces(6)
     if(edit.quantity>0&&!quantity.gt(0))throw fail('非零收货数量至少为0.000001',400)
     if(quantity.plus(damaged).plus(rejected).gt(arrived))throw fail('收货、破损和拒收数量之和不能超过实到数量',400)
     if(current.qualityResult==='FAIL'&&quantity.gt(0))throw fail('原单已记录拒收结果，不能直接改为入库数量',400)
     const unposted=otherLines.filter(row=>row.purchaseOrderLineId===current.purchaseOrderLineId&&row.receipt.status!=='POSTED').reduce((sum,row)=>sum.plus(row.acceptedQty),d(0))
     const max=(order.confirmedQty||order.orderedQty).times(d(1).plus(order.overTolerancePct))
     if(order.receivedQty.plus(unposted).plus(quantity).gt(max))throw fail('累计收货数量超过原采购单允许上限',400)
     const manufacture=edit.manufactureDate===undefined?current.manufactureDate:edit.manufactureDate?new Date(`${edit.manufactureDate}T00:00:00.000Z`):null
     const expiry=edit.expiryDate===undefined?current.expiryDate:edit.expiryDate?new Date(`${edit.expiryDate}T00:00:00.000Z`):null
     if(manufacture&&expiry&&expiry<manufacture)throw fail('到期日不能早于生产日期',400)
     const suppliedPrice=edit.unitPrice===undefined?current.unitPrice:edit.unitPrice
     if(suppliedPrice==null)throw fail('原单缺少可靠单价，请先核对原单',400)
     const unitPrice=d(suppliedPrice).toDecimalPlaces(6)
     const payableAmount=receiptPricing(quantity,unitPrice,edit.payableAmount).payableAmount
     const previouslyArrived=current.shipmentLineId?otherLines.filter(row=>row.shipmentLineId===current.shipmentLineId).reduce((sum,row)=>sum.plus(row.arrivedQty),d(0)):d(0)
     await tx.upstreamReceiptLine.update({where:{id:edit.id},data:{arrivedQty:arrived,acceptedQty:quantity,damagedQty:damaged,rejectedQty:rejected,unitPrice,payableAmount,inventoryAcceptedQty:quantity.times(current.inventoryUnitsPerPurchaseUnit).toDecimalPlaces(6),shortageQty:source.finalForShipment&&current.shippedQty!==null?Prisma.Decimal.max(0,d(current.shippedQty).minus(previouslyArrived).minus(arrived)):d(0),overageQty:current.shippedQty!==null?Prisma.Decimal.max(0,previouslyArrived.plus(arrived).minus(current.shippedQty)):d(0),...(edit.batchNo!==undefined?{batchNo:edit.batchNo}:{ }),manufactureDate:manufacture,expiryDate:expiry,...(edit.note!==undefined?{note:edit.note}:{})}})
   }
   const rows=await tx.upstreamReceiptLine.findMany({where:{tenantId:input.tenantId,receiptId:source.id}})
   await tx.upstreamReceipt.update({where:{id:source.id},data:{payableAmount:rows.reduce((sum,row)=>sum.plus(row.payableAmount),d(0)),rowVersion:{increment:1},...(body.note!==undefined?{note:body.note}:{})}})
   const after=await tx.upstreamReceipt.findUniqueOrThrow({where:{id:source.id},include:{lines:true}})
   return {before,after:snapshot(after,input.kind)}
 }})
}
