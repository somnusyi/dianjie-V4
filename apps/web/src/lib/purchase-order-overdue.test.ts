import {describe,it,expect} from 'vitest'
import {purchaseOrderOverdueText as text} from './purchase-order-overdue'
const now=new Date('2026-10-18T16:00:00Z') // Shanghai Oct19
const order=(date:string,status='SHIPPED')=>({expectedArrivalAt:date,status})
describe('采购到货逾期按上海业务日且不输出NaN',()=>{
 it('兼容ISO与斜杠，跨上海日期准确',()=>{expect(text(order('2026-10-18T00:00:00.000Z'),now)).toBe('逾期 1 天');expect(text(order('2026/10/18'),now)).toBe('逾期 1 天')})
 it('缺少或非法日期不猜',()=>{for(const date of ['', 'invalid','2026-02-30','2026-13-01'])expect(text(order(date),now)).toBeNull()})
 it('当天未来终态不显示逾期',()=>{expect(text(order('2026-10-19'),now)).toBeNull();expect(text(order('2026-10-20'),now)).toBeNull();expect(text(order('2026-10-18','RECEIVED'),now)).toBeNull()})
 it('真实闰日有效',()=>expect(text(order('2024-02-29'),new Date('2024-03-01T04:00:00Z'))).toBe('逾期 1 天'))
})
