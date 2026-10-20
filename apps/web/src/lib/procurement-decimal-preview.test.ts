import {it,expect} from 'vitest'
import {procurementDecimalProduct} from './procurement-decimal-preview'
it('matches currency precision without hiding small amounts or floating point error',()=>{
 expect(procurementDecimalProduct('1','0.0001')).toBe('0.0001')
 expect(procurementDecimalProduct('0.1','0.2')).toBe('0.0200')
 expect(procurementDecimalProduct('1','0.00005')).toBe('0.0001')
 expect(procurementDecimalProduct('0.1234567','1')).toBe('0.1235')
 expect(procurementDecimalProduct('1e-6','5',6)).toBe('0.000005')
 expect(procurementDecimalProduct('','1')).toBe('—')
 expect(procurementDecimalProduct('-1','5')).toBe('—')
})

it('amount division retains six-place display price and quantity edits recompute the amount', async () => {
 const {procurementDecimalQuotient,procurementDecimalProportion}=await import('./procurement-decimal-preview')
 expect(procurementDecimalQuotient('100','3')).toBe('33.333333')
 expect(procurementDecimalProduct('4','33.333333')).toBe('133.3333')
 expect(procurementDecimalProportion('100','1','3')).toBe('33.3333')
 expect(procurementDecimalQuotient('1','0')).toBe('—')
})
