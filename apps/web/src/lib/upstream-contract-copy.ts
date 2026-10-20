/** Check precision before Number conversion or a six-place database could silently round it. */
export function validContractPrice(raw: string): boolean {
  const value = Number(raw)
  if (!raw.trim() || !Number.isFinite(value) || value <= 0) return false
  const match = raw.trim().match(/^\+?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i)
  if (!match || !(match[1] || match[2])) return false
  const fraction = match[2] || ''
  const digits = (match[1] || '') + fraction
  const trailingZeros = digits.length - digits.replace(/0+$/, '').length
  return fraction.length - Number(match[3] || 0) - trailingZeros <= 6
}

/** Only prices may change when copying an active contract. The API revalidates sources in its transaction. */
export type ContractCopySource = {
  id: string; supplierId: string; purchaseUnit: string; inventoryUnitsPerPurchaseUnit: string | number
  minOrderQty: string | number; leadTimeDays?: number
  product: { id: string; inventoryUnit?: string | null; unit: string }
}
export type ContractCopyOriginal = {
  id: string; supplierId: string; contractNo: string; title: string; status: string
  startsAt: string; endsAt?: string | null; settlementCycle: string; settlementDays: number
  taxInclusive: boolean; defaultTaxRate?: string | number | null; currency: string
  paymentMethod?: string | null; discrepancyRule?: unknown; attachments?: unknown
  lines: Array<{
    upstreamSourceId?: string | null; productId: string; productNameSnapshot: string
    purchaseUnit: string; inventoryUnit: string; inventoryUnitsPerPurchaseUnit: string | number
    minOrderQty: string | number; leadTimeDays: number; unitPrice: string | number
    taxRate: string | number; packageMultiple: string | number
    shortTolerancePct: string | number; overTolerancePct: string | number
    startsAt: string; endsAt?: string | null; isActive?: boolean
  }>
}
export function contractCopyPayload(original: ContractCopyOriginal, sources: ContractCopySource[], prices: Record<string, string>, idempotencyKey: string) {
  if (original.status !== 'ACTIVE' || !original.lines.length) throw new Error('只能复制包含商品的生效合同')
  const seen = new Set<string>()
  const lines = original.lines.map(line => {
    const id = line.upstreamSourceId
    const source = sources.find(item => item.id === id)
    if (!id || !source || seen.has(id) || line.isActive === false || source.supplierId !== original.supplierId || source.product.id !== line.productId) {
      throw new Error(`${line.productNameSnapshot}的供货关系已缺失、停用或重复，不能生成不完整版本`)
    }
    seen.add(id)
    if (source.purchaseUnit !== line.purchaseUnit || (source.product.inventoryUnit || source.product.unit) !== line.inventoryUnit
      || Number(source.inventoryUnitsPerPurchaseUnit) !== Number(line.inventoryUnitsPerPurchaseUnit)
      || Number(source.minOrderQty) !== Number(line.minOrderQty) || source.leadTimeDays !== line.leadTimeDays) {
      throw new Error(`${line.productNameSnapshot}的单位换算、起订量或交期已变化，请先核对，不能静默复制`)
    }
    const raw = prices[id]
    const price = Number(raw)
    if (!raw?.trim() || !Number.isFinite(price) || price <= 0) throw new Error(`${line.productNameSnapshot}的合同价格必须大于0，复制时不能删掉原商品`)
    if (!validContractPrice(raw)) throw new Error(`${line.productNameSnapshot}的合同价格最多六位小数，请核对后保存`)
    return {
      upstreamSourceId: id, unitPrice: price, taxRate: Number(line.taxRate),
      packageMultiple: Number(line.packageMultiple), shortTolerancePct: Number(line.shortTolerancePct), overTolerancePct: Number(line.overTolerancePct),
      startsAt: line.startsAt, ...(line.endsAt ? { endsAt: line.endsAt } : {}),
    }
  })
  return {
    copyFromContractId: original.id, supplierId: original.supplierId, contractNo: original.contractNo, title: original.title,
    startsAt: original.startsAt, ...(original.endsAt ? { endsAt: original.endsAt } : {}),
    settlementCycle: original.settlementCycle, settlementDays: original.settlementDays,
    taxInclusive: original.taxInclusive, ...(original.defaultTaxRate == null ? {} : { defaultTaxRate: Number(original.defaultTaxRate) }),
    currency: original.currency, ...(original.paymentMethod == null ? {} : { paymentMethod: original.paymentMethod }),
    ...(original.discrepancyRule == null ? {} : { discrepancyRule: original.discrepancyRule }),
    ...(original.attachments == null ? {} : { attachments: original.attachments }),
    idempotencyKey, lines,
  }
}
