import {procurementDecimalSum} from './procurement-decimal-preview'
import type {ReportCell,TableReport} from './table-report'
type Amount=string|number|null
type Source={no:string;createdAt?:string;supplier:{name:string};warehouse?:{name:string};organizationName?:string|null;note?:string|null;reason?:string;lines:Array<{
  purchaseUnit:string;acceptedQty?:Amount;purchaseQuantity?:Amount;unitPrice?:Amount;settlementUnitPrice?:Amount;payableAmount?:Amount;settlementAmount?:Amount;batchNo?:string|null;manufactureDate?:string|null;expiryDate?:string|null;note?:string|null;
  product?:{code:string;name:string;spec?:string|null};purchaseOrderLine?:{productCodeSnapshot?:string;productNameSnapshot?:string;productSpecSnapshot?:string|null};receiptLine?:{receipt:{no:string}};
}>}
/** Print saved source values identically from list detail and the common editor. */
export function procurementDocumentReport(kind:'RECEIPT'|'RETURN',source:Source):TableReport{
 const receipt=kind==='RECEIPT'
 const headers=['序号','物品编码','物品名称','规格','单位','数量','单价','金额',...(receipt?['批次号','生产日期','到期日期']:['原收货单']),'备注']
 const rows:ReportCell[][]=source.lines.map((line,index)=>[
   index+1,line.purchaseOrderLine?.productCodeSnapshot||line.product?.code,line.purchaseOrderLine?.productNameSnapshot||line.product?.name,line.purchaseOrderLine?.productSpecSnapshot||line.product?.spec,line.purchaseUnit,
   receipt?line.acceptedQty:line.purchaseQuantity,receipt?line.unitPrice:line.settlementUnitPrice,receipt?line.payableAmount:line.settlementAmount,
   ...(receipt?[line.batchNo,line.manufactureDate?.slice(0,10),line.expiryDate?.slice(0,10)]:[line.receiptLine?.receipt.no]),line.note,
 ])
 return {...(receipt?{footerRows:[headers.map((header,index)=>index===0?'合计':header==='金额'?procurementDecimalSum(source.lines.map(line=>String(line.payableAmount??''))):'')],footerNote:'收货人签字：____________    日期：____________',printTemplate:{key:'purchase-receipt' as const,documentNo:source.no,fields:{documentNo:source.no,supplier:source.supplier.name,warehouse:source.warehouse?.name||'',organization:source.organizationName||'',date:source.createdAt&&Number.isFinite(Date.parse(source.createdAt))?new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(source.createdAt)):'',note:source.note||''}}}:{}),title:`${receipt?'采购入库单':'采购退货单'} ${source.no}`,subtitle:[source.organizationName,source.supplier.name,source.warehouse?.name,source.reason?`退货原因：${source.reason}`:null,source.note?`备注：${source.note}`:null].filter(Boolean).join(' · '),headers,rows}
}
