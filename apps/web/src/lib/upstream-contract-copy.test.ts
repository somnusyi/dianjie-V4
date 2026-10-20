import { describe, expect, it } from 'vitest'
import { contractCopyPayload, validContractPrice, type ContractCopyOriginal, type ContractCopySource } from './upstream-contract-copy'
const original: ContractCopyOriginal = {
  id:'contract-old',supplierId:'supplier-a',contractNo:'KJ1',title:'原合同',status:'ACTIVE',startsAt:'2026-01-01',endsAt:'2026-09-30',
  settlementCycle:'FIXED_DAYS',settlementDays:45,taxInclusive:false,defaultTaxRate:'0.13',currency:'USD',paymentMethod:'原付款条款',
  discrepancyRule:{shortage:'原约定'},attachments:[{name:'原附件',key:'test-only'}],
  lines:[{upstreamSourceId:'source-a',productId:'product-a',productNameSnapshot:'原商品',purchaseUnit:'箱',inventoryUnit:'袋',
    inventoryUnitsPerPurchaseUnit:'16',minOrderQty:2,leadTimeDays:4,unitPrice:1152,taxRate:'0.09',packageMultiple:2,
    shortTolerancePct:'0.01',overTolerancePct:'0.02',startsAt:'2026-01-02',endsAt:'2026-09-29',isActive:true}],
}
const source: ContractCopySource={id:'source-a',supplierId:'supplier-a',purchaseUnit:'箱',inventoryUnitsPerPurchaseUnit:16,minOrderQty:2,leadTimeDays:4,product:{id:'product-a',inventoryUnit:'袋',unit:'袋'}}
describe('contract copy price-only payload',()=>{
  it('retains every original clause and expired dates without mutation',()=>{
    const before=JSON.stringify(original)
    const result=contractCopyPayload(original,[source],{'source-a':'1200.25'},'copy-request-1')
    expect(result).toMatchObject({copyFromContractId:'contract-old',supplierId:'supplier-a',contractNo:'KJ1',settlementCycle:'FIXED_DAYS',settlementDays:45,
      taxInclusive:false,defaultTaxRate:.13,currency:'USD',endsAt:'2026-09-30',paymentMethod:'原付款条款',discrepancyRule:original.discrepancyRule,attachments:original.attachments,
      lines:[{upstreamSourceId:'source-a',unitPrice:1200.25,taxRate:.09,packageMultiple:2,shortTolerancePct:.01,overTolerancePct:.02,startsAt:'2026-01-02',endsAt:'2026-09-29'}]})
    expect(JSON.stringify(original)).toBe(before)
  })
  it.each([{sources:[]},{sources:[{...source,purchaseUnit:'kg'}]},{sources:[{...source,inventoryUnitsPerPurchaseUnit:1}]},{sources:[{...source,minOrderQty:1}]},{sources:[{...source,leadTimeDays:0}]},{sources:[{...source,supplierId:'supplier-b'}]}])('blocks missing or changed supply sources',({sources})=>{
    expect(()=>contractCopyPayload(original,sources,{'source-a':'1200'},'copy-request-1')).toThrow()
  })
  it.each(['','0','-1','NaN','Infinity'])('never silently drops an original line for price %s',price=>{
    expect(()=>contractCopyPayload(original,[source],{'source-a':price},'copy-request-1')).toThrow()
  })
  it('rejects duplicate, inactive, or unbound original lines',()=>{
    for(const lines of [[...original.lines,...original.lines],[{...original.lines[0],isActive:false}],[{...original.lines[0],upstreamSourceId:null}]]){
      expect(()=>contractCopyPayload({...original,lines},[source],{'source-a':'1200'},'copy-request-1')).toThrow()
    }
  })
})


it('prevents silently rounding new or copied contract prices beyond the stored six places', () => {
  for (const raw of ['41.2345678', '0.0000001', '1e-7', '-1', '', 'Infinity']) expect(validContractPrice(raw)).toBe(false)
  for (const raw of ['41.234567', '0.000001', '1e-6', '.5', '41.2345670', '123000e-8', '40']) expect(validContractPrice(raw)).toBe(true)
  expect(() => contractCopyPayload(original,[source],{'source-a':'41.2345678'},'copy-request-1')).toThrow('最多六位小数')
  expect(contractCopyPayload(original,[source],{'source-a':'41.234567'},'copy-request-1').lines[0].unitPrice).toBe(41.234567)
})
