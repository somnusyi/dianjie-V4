import crypto from 'crypto'
import { Prisma } from '@dianjie/db'
import { z } from 'zod'

const optionalQuantity = z.union([
  z.number().finite().min(0).max(999_999_999_999),
  z.null(),
])

export const warehouseInventoryPolicyWriteSchema = z.object({
  warehouseId: z.string().trim().min(1).max(64).optional(),
  minQty: optionalQuantity,
  maxQty: optionalQuantity,
  stagnantDays: z.number().int().min(1).max(36500),
  active: z.boolean().default(true),
  rowVersion: z.number().int().min(0),
  requestId: z.string().trim().min(8).max(100),
  confirmUnitChange: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.minQty != null && value.maxQty != null && value.minQty > value.maxQty) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['maxQty'], message: '库存上限不能低于库存下限' })
  }
})

export type WarehouseInventoryPolicyWrite = z.infer<typeof warehouseInventoryPolicyWriteSchema>

export type PolicySnapshot = {
  inventoryUnitSnapshot: string
  minQty: number | null
  maxQty: number | null
  stagnantDays: number
  active: boolean
  rowVersion: number
}

export function inventoryPolicySnapshot(policy: {
  inventoryUnitSnapshot: string
  minQty: Prisma.Decimal | number | string | null
  maxQty: Prisma.Decimal | number | string | null
  stagnantDays: number
  active: boolean
  rowVersion: number
}): PolicySnapshot {
  return {
    inventoryUnitSnapshot: policy.inventoryUnitSnapshot,
    minQty: policy.minQty == null ? null : Number(policy.minQty),
    maxQty: policy.maxQty == null ? null : Number(policy.maxQty),
    stagnantDays: policy.stagnantDays,
    active: policy.active,
    rowVersion: policy.rowVersion,
  }
}

/** Stable business fingerprint; tokens and actor data are deliberately excluded. */
export function inventoryPolicyFingerprint(productId: string, warehouseId: string, value: WarehouseInventoryPolicyWrite) {
  return crypto.createHash('sha256').update(JSON.stringify({
    productId,
    warehouseId,
    minQty: value.minQty,
    maxQty: value.maxQty,
    stagnantDays: value.stagnantDays,
    active: value.active,
    rowVersion: value.rowVersion,
    confirmUnitChange: value.confirmUnitChange,
  })).digest('hex')
}

export type InventoryRuleProduct = {
  minStock: Prisma.Decimal | number | string
  inventoryUnitsPerOrderUnit: Prisma.Decimal | number | string | null
  unitConversionStatus: string
}

export type InventoryRulePolicy = {
  inventoryUnitSnapshot: string
  minQty: Prisma.Decimal | number | string | null
  maxQty: Prisma.Decimal | number | string | null
  stagnantDays: number
  active: boolean
} | null | undefined

export type ResolvedInventoryRule = {
  minQty: number | null
  maxQty: number | null
  stagnantDays: number
  source: 'configured' | 'legacy-fallback' | 'unconfigured' | 'unit-pending'
  unitMatches: boolean
}

/**
 * Configured limits are already stored in inventory units. Product.minStock is
 * only a read-only compatibility fallback and is converted only when verified.
 */
export function resolveInventoryRule(
  product: InventoryRuleProduct,
  policy: InventoryRulePolicy,
  inventoryUnit: string,
): ResolvedInventoryRule {
  if (policy) {
    if (!policy.active) {
      return { minQty: null, maxQty: null, stagnantDays: 30, source: 'unconfigured', unitMatches: true }
    }
    const unitMatches = policy.inventoryUnitSnapshot === inventoryUnit
    return {
      minQty: unitMatches && policy.minQty != null ? Number(policy.minQty) : null,
      maxQty: unitMatches && policy.maxQty != null ? Number(policy.maxQty) : null,
      stagnantDays: policy.stagnantDays,
      source: unitMatches ? 'configured' : 'unit-pending',
      unitMatches,
    }
  }
  const factor = Number(product.inventoryUnitsPerOrderUnit)
  const legacyMin = Number(product.minStock)
  const verified = product.unitConversionStatus === 'VERIFIED' && Number.isFinite(factor) && factor > 0
  if (!verified) return { minQty: null, maxQty: null, stagnantDays: 30, source: 'unit-pending', unitMatches: false }
  if (!(legacyMin > 0)) return { minQty: null, maxQty: null, stagnantDays: 30, source: 'unconfigured', unitMatches: true }
  return { minQty: legacyMin * factor, maxQty: null, stagnantDays: 30, source: 'legacy-fallback', unitMatches: true }
}

export function inventoryAlertStatus(quantity: Prisma.Decimal | number | string, rule: ResolvedInventoryRule) {
  const current = Number(quantity)
  if (current <= 0) return '缺货'
  if (!rule.unitMatches) return '单位待确认'
  if (rule.minQty == null && rule.maxQty == null) return '阈值未配置'
  if (rule.minQty != null && current < rule.minQty) return '低于下限'
  if (rule.maxQty != null && current > rule.maxQty) return '高于上限'
  return '正常'
}
