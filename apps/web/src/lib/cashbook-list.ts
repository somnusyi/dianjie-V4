import { apiFetch } from './v2-auth'

type CashPage<T> = { items: T[]; total: number; page: number; pageSize: number }

/** Refuse partial local ledgers; offset pagination is not a transaction snapshot. */
export async function loadCashTransactions<T extends { id: string }>(accountId: string, month: string): Promise<T[]> {
  const result: T[] = []
  const seen = new Set<string>()
  let total: number | undefined
  for (let page = 1; page <= 1000; page++) {
    const query = new URLSearchParams({ accountId, month, page: String(page), pageSize: '100' })
    const data = await apiFetch<CashPage<T>>(`/api/cashbook/transactions?${query}`)
    if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
        data.page !== page || data.pageSize !== 100 || data.items.length > 100 ||
        (total !== undefined && data.total !== total)) {
      throw new Error('本地流水读取不完整或已变化，请重新导出')
    }
    total = data.total
    for (const row of data.items) {
      if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)) {
        throw new Error('本地流水分页重复或无效，请重新导出')
      }
      seen.add(row.id)
      result.push(row)
    }
    if (result.length === total) return result
    if (result.length > total || data.items.length < 100) throw new Error('本地流水读取不完整，请重新导出')
  }
  throw new Error('本地流水记录较多，未能完整读取，请联系管理员处理')
}
