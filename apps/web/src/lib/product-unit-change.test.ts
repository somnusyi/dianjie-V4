import {it,expect} from 'vitest'
import {changeProductUnit as change,productSpecUnitSuggestion as suggest} from './product-unit-change'
import {productPriceConversion} from './product-price-conversion'
const base={purchaseUnit:'件',inventoryUnit:'件',orderUnit:'件',costUnit:'件',inventoryUnitsPerPurchaseUnit:'1',inventoryUnitsPerOrderUnit:'1',inventoryUnitsPerCostUnit:'1'}
it('改异名单位清空旧比例，不伪造1',()=>{const box=change(base,'purchaseUnit','箱');expect(box.inventoryUnitsPerPurchaseUnit).toBe('');const bag=change(box,'inventoryUnit','袋');expect(bag.inventoryUnitsPerPurchaseUnit).toBe('');expect(bag.inventoryUnitsPerOrderUnit).toBe('');expect(bag.costUnit).toBe('袋')})
it('起订同采购时共享同一真实换算',()=>{let form=change(base,'purchaseUnit','箱');form=change(form,'inventoryUnit','袋');form=change(form,'orderUnit','箱');form=change(form,'inventoryUnitsPerPurchaseUnit','16');expect(form.inventoryUnitsPerOrderUnit).toBe('16');expect(productPriceConversion({...form,price:'1152',minOrderQty:'1'})).toMatchObject({inventoryUnitPrice:'72',minimumOrderAmount:'1152',minimumInventoryQuantity:'16'})})
it('规格建议尊重已选袋/kg/g，绝不把袋静默改克',()=>{const form={...base,purchaseUnit:'箱',inventoryUnit:'袋',spec:'箱/1kg*16袋'};expect(suggest(form)).toBe(16);expect(suggest({...form,inventoryUnit:'g'})).toBe(16000);expect(suggest({...form,inventoryUnit:'kg'})).toBe(16);expect(suggest({...form,purchaseUnit:'kg'})).toBeNull();expect(suggest({...form,inventoryUnit:'盒'})).toBeNull()})
it('三个不同单位分别填写，修改基准不继承旧因子',()=>{const form={...base,purchaseUnit:'箱',inventoryUnit:'g',orderUnit:'kg',costUnit:'g',inventoryUnitsPerPurchaseUnit:'16000',inventoryUnitsPerOrderUnit:'1000'};expect(change(form,'purchaseUnit','袋').inventoryUnitsPerOrderUnit).toBe('1000');expect(change(form,'inventoryUnit','kg')).toMatchObject({inventoryUnitsPerPurchaseUnit:'',inventoryUnitsPerOrderUnit:'1',inventoryUnitsPerCostUnit:'1'})})

it('同名库存/成本补齐不可编辑的成本因子，不伪造其他比例',()=>{expect(change({...base,inventoryUnitsPerPurchaseUnit:'',inventoryUnitsPerOrderUnit:'',inventoryUnitsPerCostUnit:''},'inventoryUnitsPerPurchaseUnit','1')).toMatchObject({inventoryUnitsPerCostUnit:'1',inventoryUnitsPerPurchaseUnit:'1'})})

it('只改名称不补缺失历史换算',()=>{const old={...base,inventoryUnitsPerPurchaseUnit:'',inventoryUnitsPerOrderUnit:'',inventoryUnitsPerCostUnit:''};expect(change(old,'name','新名称')).toMatchObject({...old,name:'新名称'})})
