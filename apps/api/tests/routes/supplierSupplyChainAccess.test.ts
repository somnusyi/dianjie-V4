import { describe, expect, it } from 'vitest'
import {
  supplierCreateInputSchemaForRole,
  supplierCreateDataForRole,
  supplierListQuerySchema,
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
      businessScopes: true,
    })
    expect(select).not.toHaveProperty('bankAccount')
    expect(select).not.toHaveProperty('autoPay')

    const view = toSupplyChainSupplierView({
      id: 'supplier-1',
      no: 'SUP001',
      name: '供应商',
      contactName: '联系人',
      contactPhone: '13800000000',
      category: '食材',
      status: 'ENABLED',
      creditType: 'FIXED_DAYS',
      creditDays: 30,
      businessScopes: ['WAREHOUSE_UPSTREAM'],
      bankAccount: 'sensitive',
      autoPay: true,
    })
    expect(view).not.toHaveProperty('bankAccount')
    expect(view.businessScopes).toEqual(['WAREHOUSE_UPSTREAM'])
  })

  it('accepts an explicit upstream scope filter and rejects unknown scopes', () => {
    expect(supplierListQuerySchema.safeParse({ businessScope: 'WAREHOUSE_UPSTREAM' }).success).toBe(true)
    expect(supplierListQuerySchema.safeParse({ businessScope: 'NOT_A_SCOPE' }).success).toBe(false)
  })

  it('forces supply-chain-created profiles into the warehouse-upstream scope', () => {
    expect(supplierCreateDataForRole('SUPPLY_CHAIN', { no: 'UP001', name: '上游供应商' })).toEqual({
      no: 'UP001',
      name: '上游供应商',
      businessScopes: ['WAREHOUSE_UPSTREAM'],
    })
    expect(supplierCreateDataForRole('FINANCE', { no: 'SUP001', name: '履约供应商' })).toEqual({
      no: 'SUP001',
      name: '履约供应商',
    })
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
    expect(supplierCreateInputSchemaForRole('SUPPLY_CHAIN').safeParse({
      ...base,
      businessScopes: ['STORE_FULFILLER'],
    }).success).toBe(false)
  })

  it('keeps bank fields available to finance', () => {
    expect(supplierCreateInputSchemaForRole('FINANCE').safeParse({
      no: 'SUP001',
      name: '供应商',
      bankAccount: 'finance-owned',
      businessScopes: ['WAREHOUSE_UPSTREAM'],
    }).success).toBe(true)
    expect(supplierReadSelectForRole('FINANCE')).toBeUndefined()
  })
})
