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
  unitConversionStatus?: string | null
}

/** 四单位合同的核验状态。 */
export type UnitContractStatus = 'INFERRED' | 'VERIFIED' | 'PENDING'

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
export function validateFourUnitForm(
  form: FourUnitForm,
  opts?: { allowLegacyCostUnit?: boolean },
): string | null {
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
  const factorError = (errors[0] as string | null) || null
  if (factorError) return factorError

  const factorsByUnit = new Map<string, number>()
  const unitFactors: Array<[string, number]> = [
    [normalizeUnit(form.purchaseUnit), Number(form.inventoryUnitsPerPurchaseUnit)],
    [normalizeUnit(form.inventoryUnit), 1],
    [normalizeUnit(form.orderUnit), Number(form.inventoryUnitsPerOrderUnit)],
    [normalizeUnit(form.costUnit), Number(form.inventoryUnitsPerCostUnit)],
  ]
  for (const [unit, factor] of unitFactors) {
    const existing = factorsByUnit.get(unit)
    if (existing !== undefined && existing !== factor) {
      return `同名单位「${unit}」必须使用相同的库存换算因子`
    }
    factorsByUnit.set(unit, factor)
  }
  // 成本单位必须是最小单位：与库存单位一致（库存单位即基准最小单位，换算因子为 1），
  // 否则成本会按更粗的单位计算，与美团口径不符、对账出现倍数差异。
  // 例外：编辑既有商品且四单位未做任何改动时（allowLegacyCostUnit），允许保留
  // 建档时的历史口径（如 costUnit=箱）——96 个此类档案的价格精度（numeric(10,2)）
  // 无法折算成每克价，强制归一只会把它们锁死在编辑弹窗里。
  if (!opts?.allowLegacyCostUnit && normalizeUnit(form.costUnit) !== normalizeUnit(form.inventoryUnit)) {
    return '成本单位必须与库存单位一致（成本单位需为最小单位）'
  }
  return null
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

/** 成本单位锁定为最小单位：与库存单位保持一致，换算因子固定为 1。 */
export function lockCostUnitToMinimum(form: FourUnitForm): FourUnitForm {
  return {
    ...form,
    costUnit: form.inventoryUnit,
    inventoryUnitsPerCostUnit: '1',
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

/** 从商品快照推断四单位合同状态。 */
export function inferUnitContractStatus(product: ProductUnitSnapshot): UnitContractStatus {
  const persistedStatus = String(product.unitConversionStatus || '').trim()
  if (persistedStatus === 'PENDING') return 'PENDING'
  if (persistedStatus && !['INFERRED', 'VERIFIED'].includes(persistedStatus)) return 'PENDING'
  if (!hasFourUnitFields(product)) return 'INFERRED'

  const units = [
    normalizeUnit(product.purchaseUnit || ''),
    normalizeUnit(product.inventoryUnit || ''),
    normalizeUnit(product.orderUnit || ''),
    normalizeUnit(product.costUnit || ''),
  ]
  if (units.some(unit => !unit)) return 'PENDING'

  const factors = [
    parseConversionFactor(String(product.inventoryUnitsPerPurchaseUnit ?? '')),
    parseConversionFactor(String(product.inventoryUnitsPerOrderUnit ?? '')),
    parseConversionFactor(String(product.inventoryUnitsPerCostUnit ?? '')),
  ]
  if (factors.some(f => f === null)) return 'PENDING'

  return persistedStatus === 'INFERRED' ? 'INFERRED' : 'VERIFIED'
}

/** 只读折算：订货单位价格 = costUnit 价格 × orderFactor / costFactor。 */
export function computeOrderUnitPrice(
  costUnitPrice: number,
  values: FourUnitValues,
): number | null {
  if (!Number.isFinite(costUnitPrice) || costUnitPrice < 0) return null
  const orderFactor = values.inventoryUnitsPerOrderUnit
  const costFactor = values.inventoryUnitsPerCostUnit
  if (!Number.isFinite(orderFactor) || orderFactor <= 0) return null
  if (!Number.isFinite(costFactor) || costFactor <= 0) return null
  return (costUnitPrice * orderFactor) / costFactor
}

/** 格式化订货单位价格辅助信息；待核验或非法值返回“待核验”。 */
export function formatOrderUnitPriceHint(
  costUnitPrice: number,
  snapshot: ProductUnitSnapshot,
): string | null {
  const orderUnit = normalizeUnit(snapshot.orderUnit || '')
  const costUnit = normalizeUnit(snapshot.costUnit || '')
  if (!orderUnit || !costUnit) return null
  // 同单位 1:1 保持简洁，不重复噪音
  if (orderUnit === costUnit) return null

  const status = inferUnitContractStatus(snapshot)
  if (status === 'PENDING') return '待核验'

  const orderFactor = parseConversionFactor(String(snapshot.inventoryUnitsPerOrderUnit ?? ''))
  const costFactor = parseConversionFactor(String(snapshot.inventoryUnitsPerCostUnit ?? ''))
  if (orderFactor === null || costFactor === null) return '待核验'
  if (!Number.isFinite(costUnitPrice) || costUnitPrice < 0) return '待核验'

  const converted = (costUnitPrice * orderFactor) / costFactor
  if (!Number.isFinite(converted) || converted < 0) return '待核验'

  const amount = Number(converted.toFixed(6))
  return `约 ¥${amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${orderUnit}`
}

/** 规格解析结果：从规格文本推出的最小库存单位与「1 采购单位 = ? 库存单位」。 */
export type SpecConversion = {
  inventoryUnit: 'g' | 'ml'
  factor: number
}

const SPEC_UNIT_GRAMS: Record<string, { unit: 'g' | 'ml'; multiplier: number }> = {
  g: { unit: 'g', multiplier: 1 },
  克: { unit: 'g', multiplier: 1 },
  kg: { unit: 'g', multiplier: 1000 },
  千克: { unit: 'g', multiplier: 1000 },
  公斤: { unit: 'g', multiplier: 1000 },
  斤: { unit: 'g', multiplier: 500 },
  ml: { unit: 'ml', multiplier: 1 },
  毫升: { unit: 'ml', multiplier: 1 },
  l: { unit: 'ml', multiplier: 1000 },
  升: { unit: 'ml', multiplier: 1000 },
}

/**
 * 从规格文本解析「1 采购单位 = ? 最小库存单位」。
 *
 * 支持美团/供应商常见写法：`箱/150g*50包`（7500 g）、`箱/2.5kg*8袋`（20000 g）、
 * `件/1000g`（1000 g）、`箱/330ml*24瓶`（7920 ml）。斜杠后第一段必须是
 * 「数值+重量/体积单位」，后续段视为件数（可带 包/袋/盒/瓶 等量词）。
 * 解析不出（如 `箱/24瓶` 没有净含量）返回 null，绝不猜测。
 */
export function parseSpecConversion(spec: string | null | undefined): SpecConversion | null {
  if (!spec) return null
  const slash = spec.indexOf('/')
  if (slash < 0) return null
  const body = spec.slice(slash + 1).trim()
  if (!body) return null
  const segments = body.split(/[*×xX＊]/).map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return null

  const first = segments[0].match(/^(\d+(?:\.\d+)?)\s*(千克|公斤|kg|克|g|斤|毫升|ml|升|l|L)\s*(?:包|袋|盒|瓶|件|罐|桶)?$/i)
  if (!first) return null
  const unitInfo = SPEC_UNIT_GRAMS[first[2].toLowerCase()] || SPEC_UNIT_GRAMS[first[2]]
  if (!unitInfo) return null
  let factor = Number(first[1]) * unitInfo.multiplier
  for (const segment of segments.slice(1)) {
    const count = segment.match(/^(\d+(?:\.\d+)?)\s*(?:包|袋|盒|瓶|件|罐|桶)?$/)
    if (!count) return null
    factor *= Number(count[1])
  }
  if (!Number.isFinite(factor) || factor <= 0 || factor > FOUR_UNIT_FACTOR_MAX) return null
  return { inventoryUnit: unitInfo.unit, factor }
}

/** 「简化口径」判定：订货跟随采购、成本跟随库存——90% 商品属于此类，界面只需两问。 */
export function isSimpleFourUnitContract(values: FourUnitValues): boolean {
  return values.orderUnit === values.purchaseUnit
    && values.inventoryUnitsPerOrderUnit === values.inventoryUnitsPerPurchaseUnit
    && values.costUnit === values.inventoryUnit
    && values.inventoryUnitsPerCostUnit === 1
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
