import { expect, it } from 'vitest'
import { warehouseDocumentDecimalChanged as changed } from './warehouse-document-decimal'
it('compares minimum increments and decrements at persisted decimal precision', () => {
  for (const [old, next, places] of [[1,1.000001,6],[1.000001,1,6],[0.000001,0.000002,6],[99999998.000001,99999998.000002,6],[1,1.0001,4],[0.0001,0.0002,4],[999999999.9899,999999999.99,4]] as const) {
    expect(changed(next, old, places)).toBe(true)
  }
})
it('normalizes API numbers with decimal half-up, ignores equivalent notation and subprecision', () => {
  expect(changed('1.0000004',1,6)).toBe(false)
  expect(changed('1.0000005',1,6)).toBe(true)
  expect(changed('1.00004',1,4)).toBe(false)
  expect(changed('1.00005',1,4)).toBe(true)
  expect(changed('1e-6',0.000001,6)).toBe(false)
  expect(changed('1.0000',1,4)).toBe(false)
  expect(changed('1.0000495',1,4)).toBe(false)
  expect(changed('0.00015',0.0001,4)).toBe(true)
  expect(changed('invalid',1,4)).toBe(true)
})
