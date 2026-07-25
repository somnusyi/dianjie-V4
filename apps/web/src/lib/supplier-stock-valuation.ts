/**
 * 供应商库存货值展示纯函数
 *
 * 默认仓 summary/列表接口已把四单位折算后的订货单位价格（orderUnitPrice）
 * 和核验状态（valuationStatus）返给前端；本模块只做展示，不做二次折算。
 * 对 null、NaN、负数、未知状态统一回退为“货值待核验”。
 */

export type ValuationStatus = 'PENDING' | 'VALUED'

export type StockValuationRow = {
  orderUnitPrice: number | null | undefined
  valuationStatus: ValuationStatus | string | null | undefined
  orderUnit?: string | null | undefined
}

export function isValuationPending(
  row: Pick<StockValuationRow, 'orderUnitPrice'> & Partial<Pick<StockValuationRow, 'valuationStatus'>>,
): boolean {
  const status = String(row.valuationStatus ?? '').trim()
  if (status === 'PENDING') return true
  if (status !== 'VALUED') return true

  const price = row.orderUnitPrice
  if (price === null || price === undefined) return true
  if (!Number.isFinite(price) || price < 0) return true
  return false
}

/**
 * 格式化单个 SKU 的订货单位价格。
 * 返回 "¥x.xx / 订货单位"；不可货值时返回 "货值待核验"。
 */
export function formatOrderUnitPriceLabel(
  row: Pick<StockValuationRow, 'orderUnitPrice' | 'valuationStatus' | 'orderUnit'>,
): string {
  if (isValuationPending(row)) return '货值待核验'

  const orderUnit = String(row.orderUnit ?? '').trim() || ''
  const price = Number(row.orderUnitPrice)
  const amount = price.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return orderUnit ? `¥${amount} / ${orderUnit}` : `¥${amount}`
}

/**
 * 汇总区警告：有待核验 SKU 时提示其暂未计入货值。
 * 零待核验或非法计数时不产生噪音，返回 null。
 */
export function formatValuationPendingWarning(
  valuationPendingSku: number | null | undefined,
): string | null {
  const count = Number(valuationPendingSku ?? 0)
  if (!Number.isFinite(count) || count <= 0) return null
  return `${Math.floor(count)} 个四单位待核验 SKU 暂未计入货值`
}
