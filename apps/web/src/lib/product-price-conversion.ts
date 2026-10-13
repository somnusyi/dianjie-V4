import type {FourUnitForm} from './supply-product-four-units'
export type PriceBasis='purchase'|'order'|'inventory'
type Input=FourUnitForm & {price:string;minOrderQty:string;priceBasis?:PriceBasis}
const SCALE=BigInt('1000000')
function fixed(raw:string,positive=false){if(!/^\d+(?:\.\d{1,6})?$/.test(raw.trim()))throw Error('数量、单价和换算率请填写有效数字，最多六位小数');const [whole,fraction='']=raw.trim().split('.');const n=BigInt(whole)*SCALE+BigInt(fraction.padEnd(6,'0'));if(positive&&n<=BigInt('0'))throw Error('请补齐大于零的起订量和单位换算率');return n}
function divide(n:bigint,d:bigint){return (n+d/BigInt('2'))/d}
function text(n:bigint){return `${n/SCALE}.${(n%SCALE).toString().padStart(6,'0')}`.replace(/\.?0+$/,'')||'0'}
function factor(input:Input,basis:PriceBasis){return basis==='inventory'?SCALE:fixed(basis==='purchase'?input.inventoryUnitsPerPurchaseUnit:input.inventoryUnitsPerOrderUnit,true)}
export function convertProductInputPrice(input:Input,next:PriceBasis){if(input.price.trim()==='')return '';try{const numerator=fixed(input.price)*factor(input,next),denominator=factor(input,input.priceBasis||'purchase');if(numerator%denominator!==BigInt('0'))return null;return text(numerator/denominator)}catch{return null}}
export function productPriceConversion(input:Input){
 try{
  if(![input.purchaseUnit,input.inventoryUnit,input.orderUnit,input.costUnit].every(unit=>unit.trim()))throw Error('请补齐单位')
  const price=fixed(input.price),source=factor(input,input.priceBasis||'purchase'),costFactor=fixed(input.inventoryUnitsPerCostUnit,true),orderFactor=fixed(input.inventoryUnitsPerOrderUnit,true),minimum=fixed(input.minOrderQty,true)
  fixed(input.inventoryUnitsPerPurchaseUnit,true)
  const costPrice=divide(price*costFactor,source)
  if(price>BigInt('0')&&costPrice===BigInt('0'))throw Error('折算单价太小，无法准确保存，请核对单位和换算率')
  if(costPrice>BigInt('99999999990000'))throw Error('折算单价超过允许范围')
  const inventoryPrice=divide(costPrice*SCALE,costFactor),orderPrice=divide(costPrice*orderFactor*BigInt(100),costFactor*SCALE)*BigInt(10000)
  if(costPrice>BigInt(0)&&orderPrice===BigInt(0))throw Error('订货单价太小，请核对订货单位和换算率')
  if(orderPrice>BigInt('99999999990000'))throw Error('订货单价超过允许范围')
  const minimumAmount=divide(orderPrice*minimum,BigInt(10000)*SCALE)*BigInt(10000)
  if(minimumAmount>BigInt('99999999990000'))throw Error('起订金额超过允许范围')
  return {error:null,costUnitPrice:text(costPrice),inventoryUnitPrice:text(inventoryPrice),orderUnitPrice:text(orderPrice),minimumOrderAmount:text(minimumAmount),minimumInventoryQuantity:text(divide(minimum*orderFactor,SCALE))}
 }catch(reason){return {error:reason instanceof Error?reason.message:'换算未完成',costUnitPrice:null,inventoryUnitPrice:null,orderUnitPrice:null,minimumOrderAmount:null,minimumInventoryQuantity:null}}
}
