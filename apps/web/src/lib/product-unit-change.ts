import {parseSpecConversion, type FourUnitForm} from './supply-product-four-units'
/** Unit names never inherit a factor that was entered for a different unit pair. */
export function changeProductUnit<T extends FourUnitForm>(form:T,key:string,value:string):T {
  const next = {...form,[key]:value}
  if (['purchaseUnit','orderUnit','inventoryUnit'].includes(key) && value.trim() !== String(form[key as keyof T]).trim()) {
    if (key === 'inventoryUnit') {
      next.costUnit=value; next.inventoryUnitsPerCostUnit='1'
      next.inventoryUnitsPerPurchaseUnit=next.purchaseUnit.trim()===value.trim()?'1':''
      next.inventoryUnitsPerOrderUnit=next.orderUnit.trim()===value.trim()?'1':''
    } else if (key === 'purchaseUnit') {
      next.inventoryUnitsPerPurchaseUnit=value.trim()===next.inventoryUnit.trim()?'1':''
    } else {
      next.inventoryUnitsPerOrderUnit=value.trim()===next.inventoryUnit.trim()?'1':value.trim()===next.purchaseUnit.trim()?next.inventoryUnitsPerPurchaseUnit:''
    }
  }
  if (next.orderUnit.trim()===next.purchaseUnit.trim() && ['purchaseUnit','inventoryUnitsPerPurchaseUnit','inventoryUnit'].includes(key)) next.inventoryUnitsPerOrderUnit=next.inventoryUnitsPerPurchaseUnit
  if (['inventoryUnit','costUnit','inventoryUnitsPerPurchaseUnit','inventoryUnitsPerOrderUnit'].includes(key) && next.inventoryUnit.trim() && next.costUnit.trim() === next.inventoryUnit.trim()) next.inventoryUnitsPerCostUnit = '1'
  return next
}
/** A suggestion uses explicit package counts or known mass units, never changes the chosen units. */
export function productSpecUnitSuggestion(form:FourUnitForm & {spec:string}):number|null {
  const [pack,...parts]=form.spec.split('/')
  if (pack?.trim()!==form.purchaseUnit.trim() || !parts.length || !form.inventoryUnit.trim()) return null
  const body=parts.join('/').trim(), unit=form.inventoryUnit.trim()
  const segments=body.split(/[*×xX＊]/).map(value=>value.trim())
  const last=segments[segments.length-1]
  const explicit=/^(\d+(?:\.\d+)?)\s*(.+)$/.exec(last)
  if(explicit && explicit[2].trim()===unit) {
    const count=Number(explicit[1]);return count>0 && count<=1000000000 ? count:null
  }
  const parsed=parseSpecConversion(form.spec)
  if(!parsed)return null
  if(parsed.inventoryUnit===unit)return parsed.factor
  if(parsed.inventoryUnit==='g' && ['kg','公斤','千克'].includes(unit))return parsed.factor/1000
  if(parsed.inventoryUnit==='ml' && ['L','l','升'].includes(unit))return parsed.factor/1000
  return null
}
