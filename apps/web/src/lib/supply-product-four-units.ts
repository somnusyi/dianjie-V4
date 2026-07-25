/**
 * 内部供应链 · 商品四单位纯函数
 *
 * 负责旧商品回退、trim、三个正数有限因子校验、最多 6 位小数、
 * 编辑请求构建和可读换算摘要。
 *
 * 固定 API 合同：
 * - purchaseUnit, inventoryUnit, orderUnit, costUnit
 * - inventoryUnitsPerPurchaseUnit, inventoryUnitsPerOrderUnit, inventoryUnitsPerCostUnit
 * - 三个因子均表示“1 对应单位 = 多少库存单位”
 * - legacy `unit` 保留，取订货单位 orderUnit
 */

export type FourUnitForm = {
  purchaseUnit: string
  inventoryUnit: string
  orderUnit: string
  costUnit: string
  inventoryUnitsPerPurchaseUnit: string
  inventoryUnitsPerOrderUnit: string
  inventoryUnitsPerCostUnit: string
}

export type FourUnitValues = {
  purchaseUnit: string
  inventoryUnit: string
  orderUnit: string
  costUnit: string
  inventoryUnitsPerPurchaseUnit: number
  inventoryUnitsPerOrderUnit: number
  inventoryUnitsPerCostUnit: number
}

export const DEFAULT_FOUR_UNIT_FORM: FourUnitForm = {
  purchaseUnit: '件',
  inventoryUnit: '件',
  orderUnit: '件',
  costUnit: '件',
  inventoryUnitsPerPurchaseUnit: '1',
  inventoryUnitsPerOrderUnit: '1',
  inventoryUnitsPerCostUnit: '1',
}

export const FOUR_UNIT_NAME_MAX_LENGTH = 16
export const FOUR_UNIT_FACTOR_MAX = 1_000_000_000

export type LegacyProductUnit = {
  unit?: string | null
  inventoryUnit?: string | null
  inventoryUnitsPerPurchaseUnit?: number | string | null
}

export type ProductUnitSnapshot = LegacyProductUnit & {
  purchaseUnit?: string | null
  orderUnit?: string | null
  costUnit?: string | null
  inventoryUnitsPerOrderUnit?: number | string | null
  inventoryUnitsPerCostUnit?: number | string | null
}

/** 去除单位前后空白；空字符串保持空，由调用方决定是否回退。 */
export function normalizeUnit(value: string): string {
  return value.trim()
}

/** 把换算因子字符串解析为正有限数；不合规返回 null。 */
export function parseConversionFactor(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/** 计算有限正数的小数位数，用于“最多 6 位小数”校验。 */
export function countDecimals(n: number): number {
  if (!Number.isFinite(n)) return 0
  const [coefficient, exponentText] = Math.abs(n).toString().toLowerCase().split('e')
  const fractionLength = coefficient.split('.')[1]?.length ?? 0
  const exponent = Number(exponentText ?? 0)
  return Math.max(0, fractionLength - exponent)
}

/** 校验单个换算因子；返回错误文案或 null。 */
export function validateConversionFactor(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return '换算因子必填'
  const n = parseConversionFactor(value)
  if (n === null) {
    const asNumber = Number(value)
    if (asNumber === 0) return '换算因子必须大于 0'
    if (!Number.isFinite(asNumber)) return '换算因子必须是有限数字'
    return '换算因子必须是正数'
  }
  if (n > FOUR_UNIT_FACTOR_MAX) return '换算因子超过系统上限'
  if (countDecimals(n) > 6) return '换算因子最多 6 位小数'
  return null
}

/** 校验四单位表单；返回第一条错误文案或 null。 */
export function validateFourUnitForm(form: FourUnitForm): string | null {
  const units = [
    ['采购单位', normalizeUnit(form.purchaseUnit)],
    ['库存单位', normalizeUnit(form.inventoryUnit)],
    ['订货单位', normalizeUnit(form.orderUnit)],
    ['成本单位', normalizeUnit(form.costUnit)],
  ] as const
  for (const [label, unit] of units) {
    if (!unit) return `${label}必填`
    if (unit.length > FOUR_UNIT_NAME_MAX_LENGTH) {
      return `${label}不能超过 ${FOUR_UNIT_NAME_MAX_LENGTH} 个字符`
    }
    if (/^\d/.test(unit)) return `${label}不能以数字开头`
  }
  const errors = [
    validateConversionFactor(form.inventoryUnitsPerPurchaseUnit),
    validateConversionFactor(form.inventoryUnitsPerOrderUnit),
    validateConversionFactor(form.inventoryUnitsPerCostUnit),
  ].filter(Boolean)
  return (errors[0] as string | null) || null
}

/** 把表单字符串归一化为可计算/可提交的值。 */
export function buildFourUnitValues(form: FourUnitForm): FourUnitValues {
  return {
    purchaseUnit: normalizeUnit(form.purchaseUnit) || '件',
    inventoryUnit: normalizeUnit(form.inventoryUnit) || '件',
    orderUnit: normalizeUnit(form.orderUnit) || '件',
    costUnit: normalizeUnit(form.costUnit) || '件',
    inventoryUnitsPerPurchaseUnit: parseConversionFactor(form.inventoryUnitsPerPurchaseUnit) ?? 1,
    inventoryUnitsPerOrderUnit: parseConversionFactor(form.inventoryUnitsPerOrderUnit) ?? 1,
    inventoryUnitsPerCostUnit: parseConversionFactor(form.inventoryUnitsPerCostUnit) ?? 1,
  }
}

/** 缺新字段的旧商品：以 legacy `unit` 回退，保留既有采购换算。 */
export function fallbackFourUnitsFromLegacy(product: LegacyProductUnit): FourUnitForm {
  const purchaseUnit = normalizeUnit(product.unit || '件') || '件'
  const inventoryUnit = normalizeUnit(product.inventoryUnit || '') || purchaseUnit
  const factor = Number(product.inventoryUnitsPerPurchaseUnit)
  const purchaseFactorStr = Number.isFinite(factor) && factor > 0 ? String(factor) : '1'
  return {
    purchaseUnit,
    inventoryUnit,
    orderUnit: purchaseUnit,
    costUnit: purchaseUnit,
    inventoryUnitsPerPurchaseUnit: purchaseFactorStr,
    inventoryUnitsPerOrderUnit: purchaseFactorStr,
    inventoryUnitsPerCostUnit: purchaseFactorStr,
  }
}

function hasFourUnitFields(product: ProductUnitSnapshot): boolean {
  return (
    normalizeUnit(product.purchaseUnit || '').length > 0 ||
    normalizeUnit(product.orderUnit || '').length > 0 ||
    normalizeUnit(product.costUnit || '').length > 0 ||
    product.inventoryUnitsPerOrderUnit != null ||
    product.inventoryUnitsPerCostUnit != null
  )
}

/** 从 API 商品解析四单位表单；无新字段时安全回退到 legacy。 */
export function fourUnitFormFromProduct(product: ProductUnitSnapshot): FourUnitForm {
  if (!hasFourUnitFields(product)) {
    return fallbackFourUnitsFromLegacy(product)
  }
  const purchaseUnit = normalizeUnit(product.purchaseUnit || product.unit || '件') || '件'
  const inventoryUnit = normalizeUnit(product.inventoryUnit || '') || purchaseUnit
  const orderUnit = normalizeUnit(product.orderUnit || '') || purchaseUnit
  const costUnit = normalizeUnit(product.costUnit || '') || purchaseUnit
  return {
    purchaseUnit,
    inventoryUnit,
    orderUnit,
    costUnit,
    inventoryUnitsPerPurchaseUnit: formatFactor(product.inventoryUnitsPerPurchaseUnit),
    inventoryUnitsPerOrderUnit: formatFactor(product.inventoryUnitsPerOrderUnit),
    inventoryUnitsPerCostUnit: formatFactor(product.inventoryUnitsPerCostUnit),
  }
}

function formatFactor(value: number | string | null | undefined): string {
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return String(n)
  return '1'
}

function factorEquals(a: number, b: number | string | null | undefined): boolean {
  const bn = Number(b)
  if (!Number.isFinite(bn)) return a === 1
  return a === bn
}

/** 可读换算摘要，用于编辑表单底部提示。 */
export function formatConversionSummary(values: FourUnitValues): string {
  const lines: string[] = [`库存单位：${values.inventoryUnit}`]
  if (
    values.purchaseUnit !== values.inventoryUnit ||
    values.inventoryUnitsPerPurchaseUnit !== 1
  ) {
    lines.push(
      `1 ${values.purchaseUnit} = ${values.inventoryUnitsPerPurchaseUnit} ${values.inventoryUnit}`,
    )
  }
  if (values.orderUnit !== values.inventoryUnit || values.inventoryUnitsPerOrderUnit !== 1) {
    lines.push(`1 ${values.orderUnit} = ${values.inventoryUnitsPerOrderUnit} ${values.inventoryUnit}`)
  }
  if (values.costUnit !== values.inventoryUnit || values.inventoryUnitsPerCostUnit !== 1) {
    lines.push(`1 ${values.costUnit} = ${values.inventoryUnitsPerCostUnit} ${values.inventoryUnit}`)
  }
  if (lines.length === 1) {
    return `四单位均为 ${values.inventoryUnit}`
  }
  return lines.join('；')
}

/** 列表/摘要用紧凑换算文案，至少展示订货单位、库存单位及换算。 */
export function formatCompactUnitSummary(values: FourUnitValues): string {
  return `订货：${values.orderUnit}，库存：${values.inventoryUnit}（1 ${values.orderUnit} = ${values.inventoryUnitsPerOrderUnit} ${values.inventoryUnit}）`
}

/** 新增商品：返回完整四单位合同字段 + legacy unit。 */
export function buildFourUnitCreateBody(form: FourUnitForm): Record<string, unknown> {
  const values = buildFourUnitValues(form)
  return {
    purchaseUnit: values.purchaseUnit,
    inventoryUnit: values.inventoryUnit,
    orderUnit: values.orderUnit,
    costUnit: values.costUnit,
    inventoryUnitsPerPurchaseUnit: values.inventoryUnitsPerPurchaseUnit,
    inventoryUnitsPerOrderUnit: values.inventoryUnitsPerOrderUnit,
    inventoryUnitsPerCostUnit: values.inventoryUnitsPerCostUnit,
    unit: values.orderUnit,
  }
}

/** 编辑商品：仅返回发生变更的四单位字段；若四单位有变更，同时带回 legacy unit。 */
export function buildFourUnitEditBody(
  form: FourUnitForm,
  originalForm: FourUnitForm,
): Record<string, unknown> {
  const values = buildFourUnitValues(form)
  const original = buildFourUnitValues(originalForm)
  const body: Record<string, unknown> = {}

  if (values.purchaseUnit !== original.purchaseUnit) body.purchaseUnit = values.purchaseUnit
  if (values.inventoryUnit !== original.inventoryUnit) body.inventoryUnit = values.inventoryUnit
  if (values.orderUnit !== original.orderUnit) body.orderUnit = values.orderUnit
  if (values.costUnit !== original.costUnit) body.costUnit = values.costUnit
  if (!factorEquals(values.inventoryUnitsPerPurchaseUnit, original.inventoryUnitsPerPurchaseUnit)) {
    body.inventoryUnitsPerPurchaseUnit = values.inventoryUnitsPerPurchaseUnit
  }
  if (!factorEquals(values.inventoryUnitsPerOrderUnit, original.inventoryUnitsPerOrderUnit)) {
    body.inventoryUnitsPerOrderUnit = values.inventoryUnitsPerOrderUnit
  }
  if (!factorEquals(values.inventoryUnitsPerCostUnit, original.inventoryUnitsPerCostUnit)) {
    body.inventoryUnitsPerCostUnit = values.inventoryUnitsPerCostUnit
  }

  if (Object.keys(body).length > 0) {
    body.unit = values.orderUnit
  }

  return body
}
