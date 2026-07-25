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
  name: string
  spec?: string | null
  category?: string
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

/** 按已解析的订货单位价计算单行金额；未就绪时返回 null。 */
export function calculateRevisionLineAmount(
  quantity: number | string,
  pricing: RevisionCatalogPricing,
): string | null {
  if (pricing.status !== 'READY') return null
  return calculateOrderEntryLineAmount(quantity, pricing.orderUnitPrice)
}

/** 合计已经就绪的行金额；任一行未就绪时不返回可能误导的部分合计。 */
export { sumOrderEntryLineAmounts as sumRevisionLineAmounts }
