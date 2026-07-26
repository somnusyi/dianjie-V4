import { describe, expect, it } from 'vitest'
import {
  supplierCreateInputSchemaForRole,
  supplierReadSelectForRole,
  supplierUpdateInputSchemaForRole,
  toSupplyChainSupplierView,
} from '../../src/routes/suppliers'

describe('internal supply-chain supplier management boundary', () => {
  it('returns operational fields without bank or auto-payment data', () => {
    const select = supplierReadSelectForRole('SUPPLY_CHAIN')
    expect(select).toMatchObject({
      id: true,
      no: true,
      name: true,
      contactName: true,
      contactPhone: true,
      creditType: true,
      creditDays: true,
      status: true,
    })
    expect(select).not.toHaveProperty('bankAccount')
    expect(select).not.toHaveProperty('autoPay')

    expect(toSupplyChainSupplierView({
      id: 'supplier-1',
      no: 'SUP001',
      name: '供应商',
      contactName: '联系人',
      contactPhone: '13800000000',
      category: '食材',
      status: 'ENABLED',
      creditType: 'FIXED_DAYS',
      creditDays: 30,
      bankAccount: 'sensitive',
      autoPay: true,
    })).not.toHaveProperty('bankAccount')
  })

  it('rejects bank and auto-payment fields on create and update', () => {
    const base = { no: 'SUP001', name: '供应商' }
    expect(supplierCreateInputSchemaForRole('SUPPLY_CHAIN').safeParse(base).success).toBe(true)
    expect(supplierCreateInputSchemaForRole('SUPPLY_CHAIN').safeParse({
      ...base,
      bankAccount: 'sensitive',
    }).success).toBe(false)
    expect(supplierUpdateInputSchemaForRole('SUPPLY_CHAIN').safeParse({
      autoPay: true,
    }).success).toBe(false)
  })

  it('keeps bank fields available to finance', () => {
    expect(supplierCreateInputSchemaForRole('FINANCE').safeParse({
      no: 'SUP001',
      name: '供应商',
      bankAccount: 'finance-owned',
    }).success).toBe(true)
    expect(supplierReadSelectForRole('FINANCE')).toBeUndefined()
  })
})
