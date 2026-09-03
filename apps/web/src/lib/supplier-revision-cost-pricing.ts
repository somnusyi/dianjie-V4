/**
 * 供应商 · 接单前改单/追加商品目录的成本价预览。
 *
 * Product.price 是每 costUnit 的价格；订单持久化的是每 orderUnit 的冻结单价。
 * 本文件只隔离“新增商品”在目录里的订货单位价计算，复用共享的
 * order-entry-cost-pricing.ts，避免与 Codex 双入口任务冲突。
 */

import {
  calculateOrderEntryLineAmount,
  OrderEntryProductSnapshot,
  resolveOrderEntryCostPricing,
  sumOrderEntryLineAmounts,
} from './order-entry-cost-pricing'

export type RevisionCatalogProduct = OrderEntryProductSnapshot & {
  id: string
  code?: string | null
  name: string
  spec?: string | null
  category?: string | null
  status: string
}

export type RevisionCatalogPricing =
  | {
      status: 'READY'
      orderUnitPrice: string
      orderUnit: string
      unitLabel: string
      costPriceSource: string
    }
  | {
      status: 'PENDING'
      message: string
    }

export type RevisionCustomProductDraft = {
  name: string
  spec: string
  unit: string
  unitPrice: string
  quantity: string
}

export type RevisionCustomProductItem = {
  customProduct: {
    name: string
    spec?: string
    unit: string
    unitPrice: number
  }
  quantity: number
}

export type RevisionCustomProductResult =
  | { status: 'READY'; item: RevisionCustomProductItem; lineAmount: string }
  | { status: 'INVALID'; message: string }

/**
 * 计算目录商品的订货单位价。
 *
 * - 旧商品只有 legacy unit 且无结构化四单位字段时，按 1:1 处理。
 * - 四个结构化单位同名且三个因子严格为 1 时，允许 PENDING 状态。
 * - 其它 PENDING、缺失单位/因子、非正因子均返回 PENDING 及原因。
 */
export function resolveRevisionCatalogPricing(
  product: RevisionCatalogProduct,
): RevisionCatalogPricing {
  return resolveOrderEntryCostPricing(product)
}

/** Match the warehouse product picker by product-name substring only. */
export function matchesWarehouseProductSearch(
  product: RevisionCatalogProduct,
  query: string,
): boolean {
  const term = query.trim().toLowerCase()
  if (!term) return true
  return String(product.name ?? '').toLowerCase().includes(term)
}

/** 按已解析的订货单位价计算单行金额；未就绪时返回 null。 */
export function calculateRevisionLineAmount(
  quantity: number | string,
  pricing: RevisionCatalogPricing,
): string | null {
  if (pricing.status !== 'READY') return null
  return calculateOrderEntryLineAmount(quantity, pricing.orderUnitPrice)
}

/**
 * Validate and normalize an internal-operation custom line before it reaches
 * the revision API. Keeping this as a pure function makes the request contract
 * testable without coupling it to the order-detail component.
 */
export function resolveRevisionCustomProductDraft(
  draft: RevisionCustomProductDraft,
): RevisionCustomProductResult {
  const name = draft.name.trim()
  const spec = draft.spec.trim()
  const unit = draft.unit.trim()
  const unitPrice = Number(draft.unitPrice)
  const quantity = Number(draft.quantity)

  if (!name) return { status: 'INVALID', message: '请填写自定义商品名称' }
  if (name.length > 80) return { status: 'INVALID', message: '自定义商品名称不能超过 80 字' }
  if (spec.length > 80) return { status: 'INVALID', message: '自定义商品规格不能超过 80 字' }
  if (!unit) return { status: 'INVALID', message: '请填写自定义商品单位' }
  if (unit.length > 16) return { status: 'INVALID', message: '自定义商品单位不能超过 16 字' }
  if (/^\d/.test(unit)) return { status: 'INVALID', message: '自定义商品单位不能以数字开头' }
  if (!draft.unitPrice.trim() || !Number.isFinite(unitPrice) || unitPrice < 0) {
    return { status: 'INVALID', message: '自定义商品单价必须大于或等于 0' }
  }
  if (unitPrice > 99_999_999.99 || Math.abs(unitPrice * 100 - Math.round(unitPrice * 100)) > 0.000001) {
    return { status: 'INVALID', message: '自定义商品单价最多 2 位小数且不能超过系统上限' }
  }
  if (!draft.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0) {
    return { status: 'INVALID', message: '自定义商品数量必须大于 0' }
  }
  if (quantity > 99_999_999.99 || Math.abs(quantity * 100 - Math.round(quantity * 100)) > 0.000001) {
    return { status: 'INVALID', message: '自定义商品数量最多 2 位小数且不能超过系统上限' }
  }

  return {
    status: 'READY',
    item: {
      customProduct: {
        name,
        ...(spec ? { spec } : {}),
        unit,
        unitPrice,
      },
      quantity,
    },
    lineAmount: (unitPrice * quantity).toFixed(2),
  }
}

/** 合计已经就绪的行金额；任一行未就绪时不返回可能误导的部分合计。 */
export { sumOrderEntryLineAmounts as sumRevisionLineAmounts }
