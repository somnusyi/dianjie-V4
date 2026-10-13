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
