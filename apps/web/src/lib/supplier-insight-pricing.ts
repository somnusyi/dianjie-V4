/**
 * 供应商洞察 · 滞销 SKU 价格展示
 *
 * 把 sku-rank 返回的 orderUnitPrice / valuationStatus / orderUnit
 * 格式化为前端展示文案。有效时显示"¥x.xx / 订货单位"，待核验时显示"货值待核验"。
 */
import {
  formatOrderUnitPriceLabel,
  isValuationPending,
  type StockValuationRow,
} from './supplier-stock-valuation'

type PricingKeys = 'orderUnitPrice' | 'valuationStatus' | 'orderUnit'
export type SkuRankPricingRow = {
  [K in PricingKeys]?: StockValuationRow[K]
}

export function formatSkuRankPriceLabel(row: SkuRankPricingRow): string {
  return formatOrderUnitPriceLabel(row as StockValuationRow)
}

export function isSkuRankValuationPending(row: SkuRankPricingRow): boolean {
  return isValuationPending(row as Parameters<typeof isValuationPending>[0])
}
