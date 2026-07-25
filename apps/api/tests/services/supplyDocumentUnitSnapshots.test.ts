import { describe, expect, it } from 'vitest'
import {
  copyFrozenSupplyDocumentFourUnits,
  freezeProductFourUnitsForSupplyDocument,
  hasCompleteFrozenSupplyDocumentFourUnits,
} from '../../src/services/supplyDocumentUnitSnapshots'
import { resolveReceiptInventoryBasis } from '../../src/services/receiptInventoryUnits'

const frozen = {
  purchaseUnitSnapshot: '箱',
  inventoryUnitSnapshot: 'g',
  orderUnitSnapshot: '袋',
  costUnitSnapshot: 'kg',
  unitConversionStatusSnapshot: 'VERIFIED',
  inventoryUnitsPerPurchaseUnitSnapshot: 12000,
  inventoryUnitsPerOrderUnitSnapshot: 500,
  inventoryUnitsPerCostUnitSnapshot: 1000,
}

describe('supply document four-unit snapshots', () => {
  it('freezes all master-data units and factors with one inventory-unit basis', () => {
    expect(freezeProductFourUnitsForSupplyDocument({
      unit: '袋',
      purchaseUnit: '箱',
      inventoryUnit: 'g',
      orderUnit: '袋',
      costUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 12000,
      inventoryUnitsPerOrderUnit: 500,
      inventoryUnitsPerCostUnit: 1000,
      unitConversionStatus: 'VERIFIED',
    })).toEqual(frozen)
  })

  it('copies only upstream frozen values and preserves historical nulls', () => {
    expect(copyFrozenSupplyDocumentFourUnits(frozen)).toEqual(frozen)
    expect(copyFrozenSupplyDocumentFourUnits({ orderUnitSnapshot: null })).toEqual({
      purchaseUnitSnapshot: null,
      inventoryUnitSnapshot: null,
      orderUnitSnapshot: null,
      costUnitSnapshot: null,
      unitConversionStatusSnapshot: null,
      inventoryUnitsPerPurchaseUnitSnapshot: null,
      inventoryUnitsPerOrderUnitSnapshot: null,
      inventoryUnitsPerCostUnitSnapshot: null,
    })
    expect(hasCompleteFrozenSupplyDocumentFourUnits(frozen)).toBe(true)
    expect(hasCompleteFrozenSupplyDocumentFourUnits({ ...frozen, inventoryUnitsPerCostUnitSnapshot: null })).toBe(false)
  })

  it('uses the frozen order factor for linked receipts even after Product changes', () => {
    const basis = resolveReceiptInventoryBasis({
      ...frozen,
      quantity: '3',
      unitPrice: '20',
      amount: '60',
      product: {
        name: '冻品',
        unit: '瓶',
        inventoryUnit: 'ml',
        inventoryUnitsPerPurchaseUnit: 24000,
        unitConversionStatus: 'VERIFIED',
      },
    })
    expect(basis).toEqual({
      source: 'DOCUMENT_SNAPSHOT',
      inventoryUnit: 'g',
      quantityFactor: 500,
      purchaseFactor: 12000,
    })
  })

  it('keeps the verified Product purchase-factor fallback for historical rows', () => {
    const basis = resolveReceiptInventoryBasis({
      ...copyFrozenSupplyDocumentFourUnits({}),
      quantity: '3',
      unitPrice: '20',
      amount: '60',
      product: {
        name: '历史冻品',
        unit: '斤',
        inventoryUnit: 'g',
        inventoryUnitsPerPurchaseUnit: 500,
        unitConversionStatus: 'VERIFIED',
      },
    })
    expect(basis).toEqual({
      source: 'LEGACY_PRODUCT_FALLBACK',
      inventoryUnit: 'g',
      quantityFactor: 500,
      purchaseFactor: 500,
    })
  })

  it('trusts the frozen verification state instead of later Product changes', () => {
    const basis = resolveReceiptInventoryBasis({
      ...frozen,
      quantity: '3',
      unitPrice: '20',
      amount: '60',
      product: {
        name: '冻品',
        unit: '瓶',
        inventoryUnit: 'ml',
        inventoryUnitsPerPurchaseUnit: 24000,
        unitConversionStatus: 'PENDING',
      },
    })
    expect(basis?.source).toBe('DOCUMENT_SNAPSHOT')

    expect(resolveReceiptInventoryBasis({
      ...frozen,
      unitConversionStatusSnapshot: 'PENDING',
      quantity: '3',
      unitPrice: '20',
      amount: '60',
      product: {
        name: '待核验冻品',
        unit: '瓶',
        inventoryUnit: 'ml',
        inventoryUnitsPerPurchaseUnit: 24000,
        unitConversionStatus: 'VERIFIED',
      },
    })).toBeNull()
  })
})
