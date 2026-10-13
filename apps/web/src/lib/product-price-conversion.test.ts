import {it,expect} from 'vitest'
import {productPriceConversion,convertProductInputPrice} from './product-price-conversion'
const base={price:'10',priceBasis:'purchase' as const,minOrderQty:'2',purchaseUnit:'kg',inventoryUnit:'g',orderUnit:'kg',costUnit:'g',inventoryUnitsPerPurchaseUnit:'1000',inventoryUnitsPerOrderUnit:'1000',inventoryUnitsPerCostUnit:'1'}
it('10元/kg、起订2kg：0.01元/g、2000g、20元，95元/kg不丢三位小数',()=>{expect(productPriceConversion(base)).toMatchObject({error:null,costUnitPrice:'0.01',inventoryUnitPrice:'0.01',orderUnitPrice:'10',minimumOrderAmount:'20',minimumInventoryQuantity:'2000'});expect(productPriceConversion({...base,price:'95'})).toMatchObject({costUnitPrice:'0.095',minimumOrderAmount:'190'})})
it('订货包装与采购不同，使用订货比例计算起订数量金额',()=>{expect(productPriceConversion({...base,orderUnit:'袋',inventoryUnitsPerOrderUnit:'500',minOrderQty:'3'})).toMatchObject({orderUnitPrice:'5',minimumOrderAmount:'15',minimumInventoryQuantity:'1500'})})
it('切换计价单位保持同样的价值，最小单位输入不二次除1000',()=>{expect(convertProductInputPrice(base,'inventory')).toBe('0.01');expect(productPriceConversion({...base,price:'0.01',priceBasis:'inventory'})).toMatchObject({costUnitPrice:'0.01',minimumOrderAmount:'20'})})
it('缺换算、非法值、低于存储精度不伪造0或1；合法零价可显示',()=>{for(const change of [{inventoryUnitsPerPurchaseUnit:''},{price:''},{minOrderQty:'0'},{price:'0.000001'}])expect(productPriceConversion({...base,...change}).error).toBeTruthy();expect(productPriceConversion({...base,price:'0'})).toMatchObject({error:null,costUnitPrice:'0',minimumOrderAmount:'0'})})

it('非整除切换不能改原价，极低正价不能变成免费商品',()=>{expect(convertProductInputPrice({...base,inventoryUnitsPerPurchaseUnit:'3'},'inventory')).toBeNull();expect(convertProductInputPrice({...base,price:'0.000001'},'inventory')).toBeNull()})
it('起订金额与现有订货两位结算单价一致',()=>{expect(productPriceConversion({...base,price:'95',orderUnit:'g',inventoryUnitsPerOrderUnit:'1',minOrderQty:'3'})).toMatchObject({inventoryUnitPrice:'0.095',orderUnitPrice:'0.1',minimumOrderAmount:'0.3'})})
