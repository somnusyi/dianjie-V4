import { describe, expect, it } from 'vitest'
import { Prisma } from '@dianjie/db'
import { receiptPricing, returnSettlementAmount } from '../../src/domain/procurementAmounts'
describe('authoritative receipt totals and conserved return amounts', () => {
 it('retains entered 100 instead of multiplying the approximate six-place price back',()=>{
   expect(receiptPricing('3','33.333333','100').payableAmount.toString()).toBe('100')
   expect(receiptPricing('3000','0.033333','100').payableAmount.toString()).toBe('100')
   expect(receiptPricing('4','33.333333','133.3333').payableAmount.toString()).toBe('133.3333')
 })
 it('legacy quantity/price callers retain their four-place product',()=>expect(receiptPricing('3','33.333333').payableAmount.toString()).toBe('100'))
 it('rejects inconsistent totals, nonzero amount at zero quantity and excess precision',()=>{
   expect(()=>receiptPricing('3','33.333333','101')).toThrow('不一致')
   expect(()=>receiptPricing('0','1','1')).toThrow('数量为0')
   expect(()=>receiptPricing('1','1','1.00001')).toThrow('最多4位')
 })
 it('three partial returns absorb rounding only on the final remaining quantity',()=>{
   let quantity=new Prisma.Decimal(0),amount=new Prisma.Decimal(0)
   const result=[]
   for(let i=0;i<3;i++){const value=returnSettlementAmount('3','100','1',quantity,amount);result.push(value.toString());quantity=quantity.plus(1);amount=amount.plus(value)}
   expect(result).toEqual(['33.3333','33.3333','33.3334'])
   expect(amount.toString()).toBe('100')
 })
 it('all-return uses original total, and rejects over-reserved source facts',()=>{
   expect(returnSettlementAmount('3','100','3').toString()).toBe('100')
   expect(()=>returnSettlementAmount('3','100','1','3','100')).toThrow('累计退货')
   expect(()=>returnSettlementAmount('3','100','1','1','101')).toThrow('累计退货')
 })
})

it('uses database decimal ceilings and rejects missing costs without inventing zero',()=>{
 expect(()=>receiptPricing('1','1000000000000','1')).toThrow()
 expect(()=>receiptPricing('1000000000000','1','1')).toThrow()
 expect(()=>receiptPricing('1','1','10000000000000000')).toThrow()
 expect(()=>receiptPricing('1',null as any,'1')).toThrow('无效')
 expect(()=>returnSettlementAmount('3',null as any,'1')).toThrow('无效')
})
