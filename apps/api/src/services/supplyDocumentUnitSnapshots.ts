import type { Prisma } from '@dianjie/db'
import type { ProductInventoryUnitLike } from './inventoryUnits'
import { resolveProductFourUnits } from './inventoryUnits'

type Decimalish = number | string | Prisma.Decimal | null | undefined
export type FrozenUnitConversionStatus = 'PENDING' | 'INFERRED' | 'VERIFIED'

export type FrozenSupplyDocumentFourUnits = {
  purchaseUnitSnapshot: string | null
  inventoryUnitSnapshot: string | null
  orderUnitSnapshot: string | null
  costUnitSnapshot: string | null
  unitConversionStatusSnapshot: FrozenUnitConversionStatus | null
  inventoryUnitsPerPurchaseUnitSnapshot: Decimalish
  inventoryUnitsPerOrderUnitSnapshot: Decimalish
  inventoryUnitsPerCostUnitSnapshot: Decimalish
}

const unitSnapshotKeys = [
  'purchaseUnitSnapshot',
  'inventoryUnitSnapshot',
  'orderUnitSnapshot',
  'costUnitSnapshot',
] as const

const factorSnapshotKeys = [
  'inventoryUnitsPerPurchaseUnitSnapshot',
  'inventoryUnitsPerOrderUnitSnapshot',
  'inventoryUnitsPerCostUnitSnapshot',
] as const

/**
 * Freeze Product master data for a newly-created document line.
 *
 * This is the only helper that accepts Product master data. Downstream document
 * creation must use copyFrozenSupplyDocumentFourUnits instead.
 */
export function freezeProductFourUnitsForSupplyDocument(
  product: ProductInventoryUnitLike,
): FrozenSupplyDocumentFourUnits {
  const contract = resolveProductFourUnits(product)
  return {
    purchaseUnitSnapshot: contract.purchaseUnit,
    inventoryUnitSnapshot: contract.inventoryUnit,
    orderUnitSnapshot: contract.orderUnit,
    costUnitSnapshot: contract.costUnit,
    unitConversionStatusSnapshot: contract.status,
    inventoryUnitsPerPurchaseUnitSnapshot: contract.inventoryUnitsPerPurchaseUnit,
    inventoryUnitsPerOrderUnitSnapshot: contract.inventoryUnitsPerOrderUnit,
    inventoryUnitsPerCostUnitSnapshot: contract.inventoryUnitsPerCostUnit,
  }
}

/**
 * Copy only already-frozen document values. Null historical values stay null;
 * this helper never consults Product and therefore cannot silently rewrite a
 * historical unit relationship during shipment or receipt.
 */
export function copyFrozenSupplyDocumentFourUnits(
  source: Partial<FrozenSupplyDocumentFourUnits>,
): FrozenSupplyDocumentFourUnits {
  const status = String(source.unitConversionStatusSnapshot || '')
  return {
    purchaseUnitSnapshot: source.purchaseUnitSnapshot ?? null,
    inventoryUnitSnapshot: source.inventoryUnitSnapshot ?? null,
    orderUnitSnapshot: source.orderUnitSnapshot ?? null,
    costUnitSnapshot: source.costUnitSnapshot ?? null,
    unitConversionStatusSnapshot: ['PENDING', 'INFERRED', 'VERIFIED'].includes(status)
      ? status as FrozenUnitConversionStatus
      : null,
    inventoryUnitsPerPurchaseUnitSnapshot: source.inventoryUnitsPerPurchaseUnitSnapshot ?? null,
    inventoryUnitsPerOrderUnitSnapshot: source.inventoryUnitsPerOrderUnitSnapshot ?? null,
    inventoryUnitsPerCostUnitSnapshot: source.inventoryUnitsPerCostUnitSnapshot ?? null,
  }
}

export function hasCompleteFrozenSupplyDocumentFourUnits(
  source: Partial<FrozenSupplyDocumentFourUnits>,
): boolean {
  const unitsValid = unitSnapshotKeys.every(key => {
    const value = source[key]
    return typeof value === 'string' && value.trim().length > 0
  })
  const factorsValid = factorSnapshotKeys.every(key => {
    const value = Number(source[key])
    return Number.isFinite(value) && value > 0
  })
  const statusValid = ['PENDING', 'INFERRED', 'VERIFIED'].includes(
    String(source.unitConversionStatusSnapshot || ''),
  )
  return unitsValid && factorsValid && statusValid
}

/**
 * Read a document snapshot for rendering/JSON snapshots. Historical rows with
 * no frozen columns retain the existing safe Product fallback; persisted
 * downstream rows must not use this helper.
 */
export function frozenSupplyDocumentFourUnitsOrProductFallback(
  source: Partial<FrozenSupplyDocumentFourUnits>,
  product: ProductInventoryUnitLike,
): FrozenSupplyDocumentFourUnits {
  return hasCompleteFrozenSupplyDocumentFourUnits(source)
    ? copyFrozenSupplyDocumentFourUnits(source)
    : freezeProductFourUnitsForSupplyDocument(product)
}
